import assert from 'node:assert/strict';
import { dispatchSummaryBatchItems, splitSummaryBatchItems } from '../lib/summary-dispatch-v2195.mjs';

function fakeSummary(label) {
  return {
    headline: `テスト記事${label}の要点を確認するタイトル`,
    lines: [
      { label: '結論/事実', text: `テスト記事${label}では具体的な事実を正しく取得できています。` },
      { label: '背景/特徴', text: `テスト記事${label}の背景と特徴を別の文章として整理できています。` },
      { label: '影響/展望', text: `テスト記事${label}の影響と今後の意味も独立して表示できています。` }
    ],
    short: `テスト記事${label}では具体的な事実を正しく取得できています。`,
    points: [
      `テスト記事${label}の背景と特徴を別の文章として整理できています。`,
      `テスト記事${label}の影響と今後の意味も独立して表示できています。`
    ],
    provider: 'test',
    model: 'mock',
    cacheable: true
  };
}

const articles = Array.from({ length: 20 }, (_, index) => ({
  id: `article-${index + 1}`,
  title: `記事${index + 1}`,
  url: `https://example.com/article-${index + 1}`,
  description: `記事${index + 1}の本文を想定した十分な長さの説明文です。背景と具体的な内容を含んでいます。`,
  mode: 'news'
}));

const firstChunks = splitSummaryBatchItems(articles.slice(0, 10));
assert.deepEqual(firstChunks.map(chunk => chunk.items.length), [5, 5], '1〜10件目は5件ずつに分割する');

const calls = [];
const mockRunner = async chunk => {
  // 旧実装の10件一括を仮想的に失敗させる条件。
  // 修正後はここへ6件以上が来てはいけない。
  assert.ok(chunk.length <= 5, `Geminiへ一度に${chunk.length}件送っています`);
  calls.push(chunk.map(item => item.id));
  return chunk.map((item, index) => ({
    index,
    url: item.url,
    mode: item.mode,
    summary: fakeSummary(item.id),
    preparedSource: 'mock'
  }));
};

const firstTen = await dispatchSummaryBatchItems(articles.slice(0, 10), mockRunner);
assert.equal(firstTen.results.length, 10);
assert.ok(firstTen.results.every(row => row.summary), '1〜10件目が全件要約される');

// 「10件目を見た後」に次の10件を先読みする状態を再現。
const afterTen = await dispatchSummaryBatchItems(articles.slice(10, 20), mockRunner);
assert.equal(afterTen.results.length, 10);
assert.ok(afterTen.results[0]?.summary, '11件目の要約が取得できる');
assert.equal(afterTen.results[0]?.url, 'https://example.com/article-11');
assert.ok(afterTen.results.every(row => row.summary), '11〜20件目も全件要約される');

// Bento一覧から未要約記事を直接開くケース。
const bentoTargetIndex = 3; // このグループ内の14件目
assert.ok(afterTen.results[bentoTargetIndex]?.summary, 'Bentoから直接開いた未要約記事にも要約がある');
assert.equal(afterTen.results[bentoTargetIndex]?.url, 'https://example.com/article-14');

assert.deepEqual(calls.map(chunk => chunk.length), [5, 5, 5, 5]);
console.log('summary flow regression check: OK (1-10, 11-20, Bento direct open)');
