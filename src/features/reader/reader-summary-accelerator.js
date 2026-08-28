import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const LABELS = ['結論/事実', '背景/特徴', '影響/展望'];
const MISSING = [
  'RSSには結論として要約できる追加情報が記載されていません。',
  'RSSには背景・特徴の詳細が記載されていません。',
  'RSSには影響・今後の詳細が記載されていません。'
];

function clean(value = '', max = 3000) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function keyOf(value = '') {
  return clean(value).replace(/[\s。、，,.!！?？:：;；・｜|／/—–\-「」『』（）()]/g, '').toLowerCase();
}

function sentence(value = '') {
  const text = clean(value, 260).replace(/[、,;；:：\s]+$/g, '').trim();
  return !text ? '' : /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function addFact(rows, seen, value) {
  const raw = sentence(value);
  const semantic = keyOf(raw);
  if (Array.from(semantic).length < 3) return;
  const text = Array.from(raw).length >= 12
    ? raw
    : `RSSには「${raw.replace(/[。！？!?]+$/g, '')}」と記載されています。`;
  const key = keyOf(text);
  if (!key || seen.has(key)) return;
  seen.add(key);
  rows.push(text);
}

export function rssFactCandidates(description = '') {
  const source = clean(description, 1800);
  if (!source) return [];
  const rows = [];
  const seen = new Set();
  const sentences = source.match(/[^。！？!?]+[。！？!?]?/g) || [];
  for (const part of sentences) {
    addFact(rows, seen, part);
    if (rows.length >= 6) return rows;
  }
  if (rows.length < 3 && sentences.length <= 1) {
    for (const part of source.split(/\s*[｜|]\s*|\s*[；;]\s*|\s{2,}/g)) {
      addFact(rows, seen, part);
      if (rows.length >= 6) break;
    }
  }
  return rows;
}

export function isSufficientRss(body = {}) {
  const description = clean(body?.description || '', 1800);
  if (/技術リサーチ:\s*Web調査済み/i.test(description)) return true;
  return Array.from(description).length >= 90 && rssFactCandidates(description).length >= 3;
}

function titleFact(body = {}) {
  const title = clean(body?.title || '', 300);
  if (!title) return MISSING[0];
  const value = sentence(title);
  return Array.from(value).length >= 12 ? value : `RSSの見出しは「${title}」です。`;
}

export function buildGroundedShortSummary(body = {}) {
  const facts = rssFactCandidates(body?.description || '');
  const conclusion = facts[0] || titleFact(body);
  const background = facts[1] || MISSING[1];
  const impact = facts[2] || MISSING[2];
  return {
    headline: clean(body?.title || '', 100) || '記事のポイント',
    lines: [
      { label: LABELS[0], text: conclusion },
      { label: LABELS[1], text: background },
      { label: LABELS[2], text: impact }
    ],
    short: conclusion,
    points: [background, impact],
    provider: 'rss-short-grounded-v1',
    model: 'local-grounded',
    contentSource: 'rss-short',
    cacheable: true,
    validated: true,
    fastPath: 'reader-rss-short-no-inference'
  };
}

function parseSummaryPost(input, init = {}) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); } catch { return null; }
  if (url.pathname !== SUMMARY_PATH || url.searchParams.has('batch') || url.searchParams.has('stream')) return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  const articleId = String(body?.articleId || '').trim();
  return articleId ? { body, articleId } : null;
}

function activeArticleId() {
  return String(document.querySelector('.reader-swipe-card.is-active[data-article-id]')?.dataset?.articleId || '');
}

function jsonResponse(payload, route) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Summary-Route': route }
  });
}

function disabledPrefetch(parsed) {
  return jsonResponse({
    articleId: parsed.articleId,
    requestType: 'prefetch',
    provider: 'unavailable',
    cacheable: false,
    validated: false,
    fallbackReason: 'reader-prefetch-disabled-rss-only'
  }, 'reader-prefetch-disabled-rss-only');
}

function shortResponse(parsed) {
  const summary = buildGroundedShortSummary(parsed.body);
  readerTrace('summary-rss-short-grounded', {
    articleId: parsed.articleId,
    descriptionChars: Array.from(clean(parsed.body?.description || '')).length,
    factCount: rssFactCandidates(parsed.body?.description || '').length
  });
  return jsonResponse({ ...summary, articleId: parsed.articleId, requestType: 'display', requestId: `rss-short-${Date.now()}` }, 'reader-rss-short-grounded-v1');
}

function rssOnlyAi(input, init, parsed) {
  const body = {
    ...parsed.body,
    description: Array.from(clean(parsed.body?.description || '', 1800)).slice(0, 500).join(''),
    url: '',
    link: '',
    preferFullText: false,
    rssOnly: true
  };
  readerTrace('summary-rss-only-ai', { articleId: parsed.articleId, descriptionChars: Array.from(body.description).length });
  return upstreamFetch(input, { ...init, body: JSON.stringify(body) });
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_RSS_ONLY_SUMMARY_INSTALLED) {
  window.__PDV2_READER_RSS_ONLY_SUMMARY_INSTALLED = true;
  globalThis.fetch = function readerRssOnlySummaryFetch(input, init = {}) {
    const parsed = parseSummaryPost(input, init);
    if (!parsed) return upstreamFetch(input, init);

    if (activeArticleId() !== parsed.articleId) {
      readerTrace('summary-prefetch-disabled', { articleId: parsed.articleId, activeArticleId: activeArticleId() });
      return Promise.resolve(disabledPrefetch(parsed));
    }
    if (!isSufficientRss(parsed.body)) return Promise.resolve(shortResponse(parsed));
    return rssOnlyAi(input, init, parsed);
  };

  window.__PDV2_READER_RSS_ONLY_SUMMARY = {
    sufficient: body => isSufficientRss(body),
    grounded: body => buildGroundedShortSummary(body)
  };
}
