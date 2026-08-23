import assert from 'node:assert/strict';
import { prepareSummaryBody } from '../api/summary.mjs';
import { generateStructuredSingle } from '../lib/summary-dispatch-v2195.mjs';

const rssDescription = [
  'ロシアとイギリスを巡る安全保障環境について、政府関係者の発言や最近のサイバー攻撃、',
  '外交上の緊張などを説明する記事の紹介文です。これは長さ判定では十分なRSS本文に見える想定です。'
].join('');

let extractorCalls = 0;
const prepared = await prepareSummaryBody({
  title: '【解説】ロシアはなぜイギリスを脅すのか',
  url: 'https://news.google.com/rss/articles/test',
  source: 'Googleニュース 政治報道',
  description: rssDescription,
  preferFullText: true
}, {
  articleTimeoutMs: 200,
  extractor: async () => {
    extractorCalls += 1;
    return {
      title: 'BBCの元記事タイトル',
      sourceType: 'html',
      text: 'BBCの記事ではロシアによるサイバー攻撃や政治工作について具体例を挙げています。イギリス政府は安全保障上の対応を強化しています。外交関係への影響や今後の対応についても具体的に説明しています。'
    };
  }
});

assert.equal(extractorCalls, 1, 'preferFullText / Googleニュースでは元記事取得を必ず試す');
assert.equal(prepared.preparedSource, 'article');
assert.equal(prepared.prepareReason, 'preferred-full-text');
assert.match(prepared.description, /BBCの記事では/);

let normalExtractorCalls = 0;
const normalRss = await prepareSummaryBody({
  title: '通常RSSの記事',
  url: 'https://example.com/article',
  source: '通常RSS',
  description: '製品開発の現場では新しい加熱方式が導入され、温度制御の精度向上と消費電力の削減が確認されました。量産工程でも評価を進めており、今後は複数モデルへの展開を検討しています。'
}, {
  articleTimeoutMs: 200,
  extractor: async () => {
    normalExtractorCalls += 1;
    throw new Error('should not be called');
  }
});

assert.equal(normalExtractorCalls, 0, '十分な通常RSS本文は高速経路を維持する');
assert.equal(normalRss.preparedSource, 'rss');

process.env.GEMINI_API_KEY = 'regression-test-key';
const originalFetch = globalThis.fetch;
let geminiCalls = 0;
globalThis.fetch = async () => {
  geminiCalls += 1;
  if (geminiCalls === 1) {
    const error = new Error('primary timed out');
    error.name = 'AbortError';
    throw error;
  }

  const payload = {
    headline: 'ロシアによる対英圧力の背景と今後',
    conclusion: 'ロシアはサイバー攻撃など複数の手段でイギリスへの圧力を強めています。',
    background: '両国の緊張は安全保障や外交を巡る長期的な対立を背景にしています。',
    impact: 'イギリスは防御策を強化し、今後の外交関係にも影響が及ぶ見通しです。'
  };
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

try {
  const summary = await generateStructuredSingle({
    title: 'BBCの元記事タイトル',
    description: prepared.description,
    preparedSource: prepared.preparedSource,
    source: 'BBC'
  });
  assert.equal(geminiCalls, 2, '主モデルがAbortしてもフォールバックモデルを試す');
  assert.equal(summary.provider, 'gemini-structured-v2195');
  assert.equal(summary.validated, true);
  assert.equal(summary.lines.length, 3);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('summary single preparation regression check: OK');
