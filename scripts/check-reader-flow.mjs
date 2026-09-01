import assert from 'node:assert/strict';
import fs from 'node:fs';
import { articleIdentity, clampReaderIndex, nextPrefetchIndices, readerFlowSnapshot, canApplyArticleResult } from '../src/features/reader/reader-flow.js';
import { buildInstantUxRows } from '../src/features/reader/summary-instant-ux.js';
import { buildRssOnlyAiBody } from '../src/features/reader/reader-summary-accelerator.js';

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

const instantRows = buildInstantUxRows({
  title: '就職先の選定「SNSを参考にした」83％ 27年春の大卒生「閲覧で入社意欲増した」',
  description: '就職先の選定「SNSを参考にした」83％、27年春の大卒生「閲覧で入社意欲増した」',
  source: 'ITmedia NEWS',
  category: 'ニュース:IT系'
});
assert.equal(instantRows.length, 3, '短いRSSでも即時カードは必ず3件');
assert.equal(instantRows.some(row => !String(row?.text || '').trim()), false, '即時3カードに空欄を作らない');
assert.equal(instantRows.some(row => /AI確認中|確認しています/.test(String(row?.text || ''))), false, '待機文を即時カードへ残さない');
assert.match(instantRows[0].text, /83％/, '短いRSSから具体的数値を即時抽出');

const forcedRssBody = buildRssOnlyAiBody({
  title: 'RSS限定比較テスト',
  description: `${'情報'.repeat(190)}この末尾は送信されない`,
  url: 'https://example.com/full-article',
  link: 'https://example.com/full-article',
  preferFullText: true,
  fast: false
});
assert.equal(Array.from(forcedRssBody.description).length, 380, '本番RSS要約では説明文を最大380文字へ短縮');
assert.equal(forcedRssBody.description.includes('この末尾は送信されない'), false, '380文字を超えるRSS説明文を送信しない');
assert.equal(forcedRssBody.url, '', '本番RSS要約では元記事URLを要約APIへ渡さない');
assert.equal(forcedRssBody.link, '', '本番RSS要約では元記事リンクを要約APIへ渡さない');
assert.equal(forcedRssBody.preferFullText, false, '本番RSS要約では元記事本文取得を要求しない');
assert.equal(forcedRssBody.fast, true, '本番RSS要約は380文字・220トークンの高速Geminiを使う');
assert.equal('rssOnlyExperiment' in forcedRssBody, false, '一時実験用フィールドを本番リクエストへ残さない');

const preparedResearchBody = buildRssOnlyAiBody({
  title: '技術リサーチ',
  description: `技術リサーチ: Web調査済み ｜ 対象企業/組織名: テスト機関 ｜ カテゴリ: 論文・研究 ｜ 概要: ${'研究結果。'.repeat(100)} ｜ 応用着眼点: 工程改善に活用できます。 ｜ 媒体: 公式サイト`
});
assert.equal(Array.from(preparedResearchBody.description).length > 380, true, '技術リサーチはRSS内の構造化3カード材料を欠落させない');
assert.match(preparedResearchBody.description, /応用着眼点:/, '技術リサーチの影響・展望材料を保持');

const focusSource = fs.readFileSync(new URL('../src/features/reader/reader-focus.js', import.meta.url), 'utf8');
assert.equal(focusSource.includes("/api/summary?batch=1&client=reader-focus"), false, 'Reader focusからGemini 10件バッチを除去');
assert.equal(focusSource.includes('SUMMARY_CHUNK_SIZE'), false, '10件チャンク境界を除去');
assert.equal(focusSource.includes('pendingBatch'), false, '表示中記事が先読みPromiseを待たない');
assert.match(focusSource, /purpose:\s*'active'/, '表示中記事は単発summary経路を使う');
assert.match(focusSource, /actualCount:\s*1/, '先読みは1記事に制限');
assert.match(focusSource, /summaryPromises\.has\(key\)/, '先読み済み記事は同じarticleIdのPromiseを再利用する');

const acceleratorSource = fs.readFileSync(new URL('../src/features/reader/reader-summary-accelerator.js', import.meta.url), 'utf8');
assert.equal(acceleratorSource.includes('FORCE_ALL_ARTICLES_RSS_ONLY'), false, '一時比較スイッチを本番コードから除去');
assert.match(acceleratorSource, /production:\s*true/, 'Reader限定のRSS本番経路を明示');
assert.match(acceleratorSource, /localStorage\.removeItem\(SUMMARY_STORAGE_KEY\)/, '本番移行時に旧本文由来の要約キャッシュを一度だけ破棄');

const instantSource = fs.readFileSync(new URL('../src/features/reader/summary-instant-ux.js', import.meta.url), 'utf8');
assert.match(instantSource, /INSTANT_RENDER_RETRY_MS/, 'activeカード確定まで即時UXを短時間再試行');
assert.match(instantSource, /data-reader-progress/, '即時要点が出たら大きい進捗UIを除去');
assert.equal(instantSource.includes('AI確認中'), false, '即時UXにAI待機ラベルを出さない');
assert.match(instantSource, /instantPayloads/, '先読み時の即時要点材料をarticleIdごとに保持する');
assert.match(instantSource, /rememberParsed\(parsed\)/, '新規fetchだけでなく先読みpayloadも記録する');
assert.match(instantSource, /MutationObserver/, 'activeカード切替を監視して先読み済み記事にも即時UXを適用する');
assert.match(instantSource, /renderStoredActiveUx/, '先読みPromise再利用時は保存済みpayloadから即時3カードを描く');

const readerDataSource = fs.readFileSync(new URL('../src/features/reader/reader-data.js', import.meta.url), 'utf8');
assert.match(readerDataSource, /technologyResearchInFlight/, '技術リサーチの同時取得を1本へ集約する');
assert.equal(readerDataSource.includes('const second = await fetchOnce(true)'), false, '件数不足だけで技術リサーチを即時再取得しない');
assert.match(readerDataSource, /cache:\s*refresh\s*\?\s*'no-store'\s*:\s*'default'/, '技術リサーチは通常取得でHTTP\/CDNキャッシュを許可する');
assert.match(readerDataSource, /__PDV2_READER_WARM_CACHE_ONLY/, 'ホームprewarmはReaderキャッシュを即返しできる');
assert.match(readerDataSource, /scheduleReaderBackgroundRefresh/, 'キャッシュ即表示後も最新取得をバックグラウンド継続');
assert.match(readerDataSource, /readerBackgroundRefreshes/, 'バックグラウンド更新を同一取得単位で重複排除');

const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert.match(mainSource, /preloadFeature\('reader',\{warm:true\}\);/, 'Reader prewarmをidle待ちせず開始');
assert.equal(mainSource.includes("idle(()=>preloadFeature('reader',{warm:true}),80)"), false, 'Reader prewarmの80ms idle待ちを撤去');

const rssSource = fs.readFileSync(new URL('../src/shared/rss.js', import.meta.url), 'utf8');
assert.match(rssSource, /cache:\s*force\s*\?\s*'no-store'\s*:\s*'default'/, '通常RSS取得はキャッシュを利用し手動更新時だけ破棄する');
assert.match(rssSource, /url\.origin === location\.origin && url\.pathname === '\/'/, 'Safari ROOT REQUEST対策を維持');

const technologySource = fs.readFileSync(new URL('../lib/technology-source-collectors.mjs', import.meta.url), 'utf8');
assert.match(technologySource, /VirtualConsole/, 'Science Portal HTML解析でjsdom内部CSSエラーを標準ログへ流さない');
assert.match(technologySource, /stripStyleBlocks/, 'Science Portal HTML解析前にstyleブロックを除去する');

console.log('reader 30-article flow regression check: OK');
console.log('checked: instant 3-card UX including prefetch→active promotion, cache-first warm, background refresh dedupe, ROOT REQUEST guard');
console.log('technology research caching / duplicate fetch / jsdom CSS guards: OK');
