import assert from 'node:assert/strict';
import fs from 'node:fs';
import { articleIdentity, clampReaderIndex, nextPrefetchIndices, readerFlowSnapshot, canApplyArticleResult } from '../src/features/reader/reader-flow.js';

const rows = Array.from({ length: 30 }, (_, index) => ({
  id: `article-${index + 1}`,
  link: `https://example.com/article-${index + 1}`,
  title: `テスト記事${index + 1}`,
  feedName: `Feed-${(index % 3) + 1}`
}));

assert.equal(rows.length, 30);
assert.equal(clampReaderIndex(-1, rows.length), 0);
assert.equal(clampReaderIndex(30, rows.length), 29);

const forward = [];
for (let index = 0; index < rows.length; index += 1) {
  const snapshot = readerFlowSnapshot(rows, index);
  assert.equal(snapshot.currentIndex, index);
  assert.equal(snapshot.currentArticleId, `article-${index + 1}`);
  assert.equal(snapshot.currentTitle, `テスト記事${index + 1}`);
  assert.deepEqual(snapshot.nextPrefetch, index < 29 ? [index + 1] : []);
  forward.push(snapshot.currentArticleId);
}
assert.deepEqual(forward, rows.map(articleIdentity), '1→30で同じ記事・巻き戻り・欠落がない');

const reverse = [];
for (let index = rows.length - 1; index >= 0; index -= 1) {
  const snapshot = readerFlowSnapshot(rows, index);
  assert.equal(snapshot.currentIndex, index);
  assert.equal(snapshot.currentArticleId, `article-${index + 1}`);
  reverse.push(snapshot.currentArticleId);
}
assert.deepEqual(reverse, rows.map(articleIdentity).reverse(), '30→1でindexが壊れない');

for (const index of [7, 8, 9, 10, 11, 17, 18, 19, 20, 21, 28, 29]) {
  const snapshot = readerFlowSnapshot(rows, index);
  assert.equal(snapshot.currentArticleId, `article-${index + 1}`, `境界 index=${index} の記事ID`);
}

assert.deepEqual(nextPrefetchIndices(8, 30, 10), [9], '9件目でも先読みは次の1件だけ');
assert.deepEqual(nextPrefetchIndices(9, 30, 10), [10], '10→11境界でも10件チャンクを作らない');
assert.deepEqual(nextPrefetchIndices(19, 30, 10), [20], '20→21境界でも10件チャンクを作らない');
assert.equal(canApplyArticleResult('article-11', rows[10]), true);
assert.equal(canApplyArticleResult('article-11', rows[11]), false, '記事11の要約を記事12へ適用しない');

const focusSource = fs.readFileSync(new URL('../src/features/reader/reader-focus.js', import.meta.url), 'utf8');
assert.equal(focusSource.includes("/api/summary?batch=1&client=reader-focus"), false, 'Reader focusからGemini 10件バッチを除去');
assert.equal(focusSource.includes('SUMMARY_CHUNK_SIZE'), false, '10件チャンク境界を除去');
assert.equal(focusSource.includes('pendingBatch'), false, '表示中記事が先読みPromiseを待たない');
assert.match(focusSource, /purpose:\s*'active'/, '表示中記事は単発summary経路を使う');
assert.match(focusSource, /actualCount:\s*1/, '先読みは1記事に制限');

const readerDataSource = fs.readFileSync(new URL('../src/features/reader/reader-data.js', import.meta.url), 'utf8');
assert.match(readerDataSource, /technologyResearchInFlight/, '技術リサーチの同時取得を1本へ集約する');
assert.equal(readerDataSource.includes('const second = await fetchOnce(true)'), false, '件数不足だけで技術リサーチを即時再取得しない');
assert.match(readerDataSource, /cache:\s*refresh\s*\?\s*'no-store'\s*:\s*'default'/, '技術リサーチは通常取得でHTTP/CDNキャッシュを許可する');

const rssSource = fs.readFileSync(new URL('../src/shared/rss.js', import.meta.url), 'utf8');
assert.match(rssSource, /cache:\s*force\s*\?\s*'no-store'\s*:\s*'default'/, '通常RSS取得はキャッシュを利用し手動更新時だけ破棄する');

const technologySource = fs.readFileSync(new URL('../lib/technology-source-collectors.mjs', import.meta.url), 'utf8');
assert.match(technologySource, /VirtualConsole/, 'Science Portal HTML解析でjsdom内部CSSエラーを標準ログへ流さない');
assert.match(technologySource, /stripStyleBlocks/, 'Science Portal HTML解析前にstyleブロックを除去する');

console.log('reader 30-article flow regression check: OK');
console.log('checked boundaries: 8→9→10→11→12 and 18→19→20→21, forward 1→30, reverse 30→1');
console.log('technology research caching / duplicate fetch / jsdom CSS guards: OK');
