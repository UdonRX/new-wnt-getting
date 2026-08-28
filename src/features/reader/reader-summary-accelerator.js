import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const SUMMARY_STORAGE_KEY = 'reader-summary-cache-v2180';
const LABELS = ['結論/事実', '背景/特徴', '影響/展望'];
const MISSING = [
  'RSSには結論として要約できる追加情報が記載されていません。',
  'RSSには背景・特徴の詳細が記載されていません。',
  'RSSには影響・今後の詳細が記載されていません。'
];
const BOILERPLATE_RE = /(?:続きを読む(?:…|\.{3})?|続き(?:はこちら|を読む)|詳細(?:はこちら|を見る)|全文(?:はこちら|を読む)|記事(?:はこちら|を読む)|Read\s*more|More\s*details?)/gi;
const LEGACY_SPARSE_PROVIDERS = new Set(['rss-short-grounded-v1']);

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

function stripBoilerplate(value = '') {
  return clean(String(value || '').replace(BOILERPLATE_RE, ' '), 1800)
    .replace(/[（(]?\s*(?:PR|広告|Sponsored)\s*[）)]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyOf(value = '') {
  return clean(value).replace(/[\s。、，,.!！?？:：;；・｜|／/—–\-「」『』（）()]/g, '').toLowerCase();
}

function informativeChars(value = '') {
  return (String(value || '').match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
}

function sentence(value = '') {
  const text = clean(value, 260).replace(/[、,;；:：\s]+$/g, '').trim();
  return !text ? '' : /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function isBoilerplateFact(value = '') {
  const text = clean(value, 260);
  if (!text) return true;
  if (BOILERPLATE_RE.test(text)) {
    BOILERPLATE_RE.lastIndex = 0;
    return true;
  }
  BOILERPLATE_RE.lastIndex = 0;
  return /^(?:こちら|詳細|記事|全文|続き)(?:へ|です|はこちら)?[。！？!?]*$/i.test(text);
}

function addFact(rows, seen, value) {
  const raw = sentence(value);
  if (isBoilerplateFact(raw) || informativeChars(raw) < 10) return;
  const semantic = keyOf(raw);
  if (Array.from(semantic).length < 8) return;
  const text = Array.from(raw).length >= 12
    ? raw
    : `RSSには「${raw.replace(/[。！？!?]+$/g, '')}」と記載されています。`;
  const key = keyOf(text);
  if (!key || seen.has(key)) return;
  seen.add(key);
  rows.push(text);
}

export function rssFactCandidates(description = '') {
  const source = stripBoilerplate(description);
  if (!source) return [];
  const rows = [];
  const seen = new Set();
  const sentences = source.match(/[^。！？!?]+[。！？!?]?/g) || [];
  for (const part of sentences) {
    addFact(rows, seen, part);
    if (rows.length >= 6) return rows;
  }
  if (rows.length < 3) {
    for (const part of source.split(/\s*[｜|]\s*|\s*[；;]\s*|[、，,]\s*(?=[^、，,]{10,})|\s{2,}/g)) {
      addFact(rows, seen, part);
      if (rows.length >= 6) break;
    }
  }
  return rows;
}

function rssEvidence(body = {}) {
  const title = clean(body?.title || '', 300);
  const description = stripBoilerplate(body?.description || '');
  const descriptionKey = keyOf(description);
  const titleKey = keyOf(title);
  const facts = rssFactCandidates(description);
  const chars = informativeChars(description);
  const titleEcho = Boolean(
    titleKey.length >= 12
    && descriptionKey
    && (
      descriptionKey === titleKey
      || (descriptionKey.startsWith(titleKey) && descriptionKey.length - titleKey.length < 24)
    )
  );
  return { title, description, facts, chars, titleEcho };
}

export function isSufficientRss(body = {}) {
  const raw = clean(body?.description || '', 1800);
  if (/技術リサーチ:\s*Web調査済み/i.test(raw)) return true;

  const evidence = rssEvidence(body);
  if (!evidence.description || evidence.titleEcho) return false;

  // 1〜2文でも具体的な事実が十分に含まれるRSSはGeminiに渡す。
  // 「3文以上でなければ不足」とは判定せず、実質的に情報が少ない時だけローカルフォールバックへ回す。
  if (evidence.chars >= 52) return true;
  if (evidence.chars >= 36 && evidence.facts.length >= 2) return true;
  return false;
}

function titleFact(body = {}) {
  const title = clean(body?.title || '', 300);
  if (!title) return MISSING[0];
  const value = sentence(title);
  return Array.from(value).length >= 12 ? value : `RSSの見出しは「${title}」です。`;
}

export function buildGroundedShortSummary(body = {}) {
  const evidence = rssEvidence(body);
  const facts = evidence.facts;
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
    provider: 'rss-low-information-grounded-v2',
    model: 'local-grounded',
    contentSource: 'rss-low-information',
    cacheable: true,
    validated: true,
    fastPath: 'reader-rss-low-information-no-inference-v2'
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
  const evidence = rssEvidence(parsed.body);
  readerTrace('summary-rss-low-information-grounded', {
    articleId: parsed.articleId,
    descriptionChars: evidence.chars,
    factCount: evidence.facts.length,
    titleEcho: evidence.titleEcho
  });
  return jsonResponse({ ...summary, articleId: parsed.articleId, requestType: 'display', requestId: `rss-low-${Date.now()}` }, 'reader-rss-low-information-grounded-v2');
}

function rssOnlyAi(input, init, parsed) {
  const evidence = rssEvidence(parsed.body);
  const body = {
    ...parsed.body,
    description: Array.from(evidence.description).slice(0, 500).join(''),
    url: '',
    link: '',
    preferFullText: false,
    rssOnly: true
  };
  readerTrace('summary-rss-only-ai', {
    articleId: parsed.articleId,
    descriptionChars: Array.from(body.description).length,
    factCount: evidence.facts.length
  });
  return upstreamFetch(input, { ...init, body: JSON.stringify(body) });
}

function purgeLegacySparseSummaryCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return;
    let changed = false;
    for (const [key, entry] of Object.entries(raw)) {
      const value = entry?.value || {};
      const legacy = LEGACY_SPARSE_PROVIDERS.has(String(value?.provider || ''))
        || String(value?.fastPath || '') === 'reader-rss-short-no-inference'
        || String(value?.contentSource || '') === 'rss-short';
      if (!legacy) continue;
      delete raw[key];
      changed = true;
    }
    if (changed) localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(raw));
  } catch {}
}

if (typeof window !== 'undefined') purgeLegacySparseSummaryCache();

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
    grounded: body => buildGroundedShortSummary(body),
    evidence: body => rssEvidence(body)
  };
}
