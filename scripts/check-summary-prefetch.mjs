import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSummaryRequestCoordinator } from '../src/features/reader/summary-request-coordinator.js';
import { waitForStableReaderNetworkGate } from '../src/features/reader/summary-fetch-gate.js';
import { prepareSummaryBody } from '../server/summary.mjs';

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

// Test 4: 明示的な開始間隔を与えた場合は従来どおり直列・間隔を維持。
const rapidStartIndex = starts.length;
const rapid = ['rapid-A', 'rapid-B', 'rapid-C', 'rapid-D'].map(id => queuedArticle(id, 'display', { duration: 1 }).promise);
await Promise.all(rapid);
const rapidStarts = starts.slice(rapidStartIndex);
assert.equal(rapidStarts.length, 4);
for (let index = 1; index < rapidStarts.length; index += 1) {
  assert.ok(rapidStarts[index].at - rapidStarts[index - 1].at >= 100, '明示的な開始間隔を維持');
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

// Test 9 (v2.19.12): client既定値では4.3秒を追加しない。直列化だけ維持し、RPM保護はserver側へ一元化。
let uxClock = 0;
let uxSleepMs = 0;
const uxStarts = [];
const uxCoordinator = createSummaryRequestCoordinator({
  now: () => uxClock,
  sleepFn: async ms => { uxSleepMs += ms; uxClock += ms; }
});
const uxA = uxCoordinator.getOrCreate('ux-A::news', { articleId: 'ux-A', requestType: 'display' }, async () => {
  uxStarts.push(uxClock);
  uxClock += 35;
});
const uxB = uxCoordinator.getOrCreate('ux-B::news', { articleId: 'ux-B', requestType: 'display' }, async () => {
  uxStarts.push(uxClock);
  uxClock += 20;
});
await Promise.all([uxA.promise, uxB.promise]);
assert.deepEqual(uxStarts, [0, 35], 'clientは前リクエスト完了後すぐ次へ進む');
assert.equal(uxSleepMs, 0, 'client既定値で追加sleepを入れない');

// Test 10 (v2.19.12): 十分なRSS本文ならpreferFullText=trueでも記事HTML取得を省略する。
let fastExtractorCalls = 0;
const fastDescription = [
  '新製品は従来方式より消費電力を20％削減し、量産ラインへの導入を開始しました。',
  '開発では温度制御と部品配置を見直し、同じ筐体サイズを維持しています。',
  '今後は国内工場で生産能力を増やし、海外向けモデルにも展開する予定です。',
  '評価工程では耐久試験と安全確認も実施し、既存設備との互換性を確保しました。',
  'サプライヤーとの部材共通化も進め、調達リスクと製造コストの抑制を狙っています。'
].join('').repeat(2);
const fastPrepared = await prepareSummaryBody({
  title: '省電力化した新製品の量産を開始',
  description: fastDescription,
  url: 'https://example.com/article',
  source: 'テスト媒体',
  mode: 'news',
  fast: true,
  preferFullText: true
}, {
  extractor: async () => {
    fastExtractorCalls += 1;
    return { text: '呼ばれてはいけない本文です。', title: 'unexpected' };
  }
});
assert.equal(fastExtractorCalls, 0, '十分なfast RSSでは外部記事取得をしない');
assert.equal(fastPrepared.preparedSource, 'rss');
assert.equal(fastPrepared.prepareReason, 'fast-rss-description-sufficient');
assert.ok(Array.from(fastPrepared.description).length <= 500, 'Gemini入力は最大500文字');

// Test 11: 160文字以上・タイトル反復ではない具体文2つなら、定型リンク文を除いてRSSを即利用する。
let compactFastExtractorCalls = 0;
const compactFastDescription = [
  '新型炊飯器は加熱制御を見直し、従来機より消費電力を抑えながら炊き上がりの温度差を小さくしました。',
  '量産工程では温度センサーの検査条件を統一し、複数ラインで同じ判定基準を使用できるようにしました。'
].join('').repeat(2) + ' 詳細はこちら';
const compactFastPrepared = await prepareSummaryBody({
  title: '加熱制御を改善した新型炊飯器',
  description: compactFastDescription,
  url: 'https://example.com/compact-fast',
  source: 'テスト媒体',
  mode: 'news',
  fast: true,
  preferFullText: true
}, {
  extractor: async () => {
    compactFastExtractorCalls += 1;
    return { text: '呼ばれてはいけない本文です。', title: 'unexpected' };
  }
});
assert.equal(compactFastExtractorCalls, 0, '160文字以上かつ具体文2つのfast RSSは元記事取得を省略');
assert.equal(compactFastPrepared.preparedSource, 'rss');
assert.equal(compactFastPrepared.description.includes('詳細はこちら'), false, 'RSS定型リンク文をGemini入力から除去');

let titleEchoExtractorCalls = 0;
const repeatedTitle = '新製品の量産開始に関するニュース';
await prepareSummaryBody({
  title: repeatedTitle,
  description: `${repeatedTitle}。`.repeat(10),
  url: 'https://example.com/title-echo',
  mode: 'news',
  fast: true,
  preferFullText: true
}, {
  articleTimeoutMs: 200,
  extractor: async () => {
    titleEchoExtractorCalls += 1;
    return { text: '元記事には量産開始の時期と対象工場が具体的に記載されています。品質確認の方法と今後の生産計画についても説明されています。', title: repeatedTitle };
  }
});
assert.equal(titleEchoExtractorCalls, 1, 'タイトル反復だけのRSSは元記事取得を省略しない');

let boilerplateExtractorCalls = 0;
await prepareSummaryBody({
  title: 'RSS定型文だけの記事',
  description: '続きを読む。詳細はこちら。全文はこちら。記事はこちら。'.repeat(12),
  url: 'https://example.com/boilerplate-only',
  mode: 'news',
  fast: true,
  preferFullText: true
}, {
  articleTimeoutMs: 200,
  extractor: async () => {
    boilerplateExtractorCalls += 1;
    return { text: '元記事には製品仕様と量産時期が具体的に記載されています。評価方法と今後の展開についても説明されています。', title: 'RSS定型文だけの記事' };
  }
});
assert.equal(boilerplateExtractorCalls, 1, '続きを読む・詳細はこちらだけのRSSは元記事取得を省略しない');

let oneSentenceExtractorCalls = 0;
await prepareSummaryBody({
  title: '具体文が一つだけの記事',
  description: `製造工程では新しい検査方法を導入し、品質判定のばらつきを抑えました${'追加情報'.repeat(35)}。`,
  url: 'https://example.com/one-sentence',
  mode: 'news',
  fast: true,
  preferFullText: true
}, {
  articleTimeoutMs: 200,
  extractor: async () => {
    oneSentenceExtractorCalls += 1;
    return { text: '元記事では検査方法の変更点が説明されています。量産ラインへの展開計画も具体的に記載されています。', title: '具体文が一つだけの記事' };
  }
});
assert.equal(oneSentenceExtractorCalls, 1, '160文字以上でも具体文が一つだけなら元記事取得を省略しない');

const gateSource = fs.readFileSync(new URL('../src/features/reader/summary-fetch-gate.js', import.meta.url), 'utf8');
assert.match(gateSource, /prefetch-outside-active-next-slot/, 'フォーカス外prefetchを抑止');
assert.match(gateSource, /prefetch-active-summary-not-successful/, '表示記事失敗後はprefetchしない');
assert.match(gateSource, /requestId/, 'requestIdログを保持');
assert.match(gateSource, /requestType/, 'display\/prefetchを区別');
assert.match(gateSource, /article-id-mismatch/, 'articleId不一致を破棄');
assert.match(gateSource, /__PDV2_GEMINI_REQUEST_COUNT/, '実リクエスト回数を計測');
assert.match(gateSource, /gemini-snap-recovered/, 'Safari snap安定待ちをログ化');
assert.match(gateSource, /gemini-client-suppression-retry/, '表示中articleIdだけclient suppressionを1回再投入');
assert.match(gateSource, /summary-instant-preview/, 'Gemini前にRSS由来の即時要点を表示');
assert.match(gateSource, /FAST_PREFETCH_SETTLE_ATTEMPTS/, '古いprefetchの待機を短縮');

const coordinatorSource = fs.readFileSync(new URL('../src/features/reader/summary-request-coordinator.js', import.meta.url), 'utf8');
assert.match(coordinatorSource, /DEFAULT_MIN_START_GAP_MS = 0/, 'client側4.3秒固定待ちを撤去');

const dispatchSource = fs.readFileSync(new URL('../lib/summary-dispatch-v2195.mjs', import.meta.url), 'utf8');
assert.match(dispatchSource, /waitForGeminiStartSlot/, '単発summaryも共通Gemini開始スロットを利用');
assert.equal(dispatchSource.includes('sleep(220)'), false, '429後の場当たり的220ms再試行を撤去');
assert.match(dispatchSource, /\[GEMINI START\]/);
assert.match(dispatchSource, /\[GEMINI ERROR\]/);
assert.match(dispatchSource, /X-Summary-Upstream-Status/);

const geminiSource = fs.readFileSync(new URL('../lib/gemini.mjs', import.meta.url), 'utf8');
assert.match(geminiSource, /GEMINI_MIN_START_GAP_MS = 4300/, 'Gemini無料枠保護の4.3秒間隔はserver側に維持');

console.log('summary prefetch/state regression check: OK');
console.log('covered: dedupe, failure cleanup, Safari snap recovery, Chrome stable path, prefetch promotion, instant preview, client no-gap, server fast RSS');
