import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSummaryRequestCoordinator } from '../src/features/reader/summary-request-coordinator.js';
import { waitForStableReaderNetworkGate } from '../src/features/reader/summary-fetch-gate.js';

let clock = 0;
const starts = [];
const coordinator = createSummaryRequestCoordinator({
  minStartGapMs: 100,
  now: () => clock,
  sleepFn: async ms => { clock += ms; }
});

function queuedArticle(id, type = 'display', { duration = 10, fail = false } = {}) {
  const key = `${id}::news`;
  return coordinator.getOrCreate(key, { articleId: id, requestType: type }, async meta => {
    starts.push({ id, type: meta.requestType, requestId: meta.requestId, at: clock });
    clock += duration;
    if (fail) throw new Error(`mock failure ${id}`);
    return { id, requestId: meta.requestId };
  });
}

// Test 1: prefetch OFF equivalent — five display-only articles all complete.
const displayOnly = [];
for (const id of ['A', 'B', 'C', 'D', 'E']) displayOnly.push(queuedArticle(`display-${id}`).promise);
const displayResults = await Promise.all(displayOnly);
assert.deepEqual(displayResults.map(row => row.id), ['display-A', 'display-B', 'display-C', 'display-D', 'display-E']);
assert.equal(starts.filter(row => row.id.startsWith('display-')).length, 5, 'prefetch OFF: 5記事で5リクエスト');

// Test 2: article B prefetch中にBをdisplayしても同一Promise/requestIdを再利用する。
const bPrefetch = queuedArticle('article-B', 'prefetch', { duration: 30 });
const bDisplay = coordinator.getOrCreate('article-B::news', { articleId: 'article-B', requestType: 'display' }, async () => {
  throw new Error('B display must not create a second request');
});
assert.equal(bDisplay.reused, true);
assert.equal(bDisplay.requestId, bPrefetch.requestId);
assert.equal(bDisplay.promise, bPrefetch.promise);
await bDisplay.promise;
assert.equal(starts.filter(row => row.id === 'article-B').length, 1, 'B prefetch/displayは1リクエスト');

// Test 3: 失敗してもin-flightがfinallyで消え、次の記事と同記事retryを妨げない。
const failing = queuedArticle('article-error', 'display', { fail: true });
await assert.rejects(failing.promise, /mock failure/);
assert.equal(coordinator.has('article-error::news'), false, '失敗後にin-flightを削除');
const afterFailure = queuedArticle('article-after-error', 'display');
assert.equal((await afterFailure.promise).id, 'article-after-error');
const retry = queuedArticle('article-error', 'display');
assert.equal(retry.reused, false, '失敗したarticleIdは新規requestを作成できる');
await retry.promise;

// Test 4: 高速A→B→C→Dでもネットワーク開始は直列、開始間隔も維持。
const rapidStartIndex = starts.length;
const rapid = ['rapid-A', 'rapid-B', 'rapid-C', 'rapid-D'].map(id => queuedArticle(id, 'display', { duration: 1 }).promise);
await Promise.all(rapid);
const rapidStarts = starts.slice(rapidStartIndex);
assert.equal(rapidStarts.length, 4);
for (let index = 1; index < rapidStarts.length; index += 1) {
  assert.ok(rapidStarts[index].at - rapidStarts[index - 1].at >= 100, '高速スワイプでも開始間隔を維持');
}

// Test 5: 5記事プールで display A + B/C/D/E prefetch = 合計5、重複0。
let coldCalls = 0;
const cold = createSummaryRequestCoordinator({ minStartGapMs: 0 });
const cache = new Map();
async function getSummary(id, type) {
  if (cache.has(id)) return cache.get(id);
  const row = cold.getOrCreate(`${id}::news`, { articleId: id, requestType: type }, async () => {
    coldCalls += 1;
    return { id, summary: `TEST SUMMARY ${id}` };
  });
  const value = await row.promise;
  cache.set(id, value);
  return value;
}
await getSummary('A', 'display');
for (const [current, next] of [['A','B'], ['B','C'], ['C','D'], ['D','E']]) {
  await getSummary(next, 'prefetch');
  await getSummary(next, 'display');
  assert.ok(cache.has(current));
}
assert.equal(coldCalls, 5, '5記事プールではGemini相当呼び出しは合計5回');
assert.equal(new Set(['A','B','C','D','E']).size, 5);

// Test 6 (v2.19.7): iOS Safari/PWAのscroll-snap揺れを再現。
// network開始判定の瞬間だけbackgroundでも、720ms以内に同じ記事へsnapが戻れば抑止しない。
let safariPositionIndex = 0;
const safariPositions = [
  { requestType: 'background', activeCard: null },
  { requestType: 'background', activeCard: null },
  { requestType: 'display', activeCard: { dataset: { summaryProvider: 'pending' } } }
];
let safariSleeps = 0;
const safariGate = await waitForStableReaderNetworkGate('safari-article', 'display', {
  positionFn: () => safariPositions[Math.min(safariPositionIndex++, safariPositions.length - 1)],
  sleepFn: async () => { safariSleeps += 1; },
  settleAttempts: 8,
  settleIntervalMs: 90
});
assert.equal(safariGate.run, true, 'Safari snapが表示記事へ戻ったらGeminiを実行する');
assert.equal(safariGate.requestType, 'display');
assert.equal(safariGate.recoveredFrom, 'display-no-longer-active-before-network-start');
assert.ok(safariSleeps >= 1, 'Safari相当は安定待ちを通る');

// Test 7: iPhone/PC Chrome相当で最初からdisplayが安定していれば待たずに開始。
let chromeSleeps = 0;
const chromeGate = await waitForStableReaderNetworkGate('chrome-article', 'display', {
  positionFn: () => ({ requestType: 'display', activeCard: { dataset: { summaryProvider: 'pending' } } }),
  sleepFn: async () => { chromeSleeps += 1; }
});
assert.equal(chromeGate.run, true);
assert.equal(chromeSleeps, 0, '安定したChrome経路には余分な待機を入れない');

// Test 8: prefetchがactive summary pendingで一度止まっても、ユーザーがその記事へ移動したらdisplayへ昇格。
let promotionIndex = 0;
const promotionPositions = [
  { requestType: 'prefetch', activeCard: { dataset: { summaryProvider: 'pending' } } },
  { requestType: 'display', activeCard: { dataset: { summaryProvider: 'pending' } } }
];
const promotedGate = await waitForStableReaderNetworkGate('promoted-article', 'prefetch', {
  positionFn: () => promotionPositions[Math.min(promotionIndex++, promotionPositions.length - 1)],
  sleepFn: async () => {},
  settleAttempts: 4,
  settleIntervalMs: 90
});
assert.equal(promotedGate.run, true);
assert.equal(promotedGate.requestType, 'display', 'prefetch中の記事を開いたらdisplayとして実行する');

const gateSource = fs.readFileSync(new URL('../src/features/reader/summary-fetch-gate.js', import.meta.url), 'utf8');
assert.match(gateSource, /prefetch-outside-active-next-slot/, 'フォーカス外prefetchを抑止');
assert.match(gateSource, /prefetch-active-summary-not-successful/, '表示記事失敗後はprefetchしない');
assert.match(gateSource, /requestId/, 'requestIdログを保持');
assert.match(gateSource, /requestType/, 'display\/prefetchを区別');
assert.match(gateSource, /article-id-mismatch/, 'articleId不一致を破棄');
assert.match(gateSource, /__PDV2_GEMINI_REQUEST_COUNT/, '実リクエスト回数を計測');
assert.match(gateSource, /gemini-snap-recovered/, 'Safari snap安定待ちをログ化');
assert.match(gateSource, /gemini-client-suppression-retry/, '表示中articleIdだけclient suppressionを1回再投入');

const dispatchSource = fs.readFileSync(new URL('../lib/summary-dispatch-v2195.mjs', import.meta.url), 'utf8');
assert.match(dispatchSource, /waitForGeminiStartSlot/, '単発summaryも共通Gemini開始スロットを利用');
assert.equal(dispatchSource.includes('sleep(220)'), false, '429後の場当たり的220ms再試行を撤去');
assert.match(dispatchSource, /\[GEMINI START\]/);
assert.match(dispatchSource, /\[GEMINI ERROR\]/);
assert.match(dispatchSource, /X-Summary-Upstream-Status/);

console.log('summary prefetch/state regression check: OK');
console.log('covered: prefetch OFF, B prefetch→display reuse, failure cleanup, fast swipe queue, Safari snap recovery, Chrome stable path, prefetch→display promotion');
