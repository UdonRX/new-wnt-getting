import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const SUMMARY_STORAGE_KEY = 'reader-summary-cache-v2180';
const SOURCE_RECOVERY_MIGRATION_KEY = 'reader-summary-source-recovery-v2';
const RSS_ONLY_PRODUCTION_CACHE_RESET_KEY = 'reader-summary-rss-only-production-v1';
const LEGACY_RESEARCH_SUMMARY_MIGRATION_KEY = 'reader-summary-legacy-research-cards-v1';
const LABELS = ['結論/事実', '背景/特徴', '影響/展望'];
const MISSING = [
  'RSSには結論として要約できる追加情報が記載されていません。',
  'RSSには背景・特徴の詳細が記載されていません。',
  'RSSには影響・今後の詳細が記載されていません。'
];
const BOILERPLATE_RE = /(?:続きを読む(?:…|\.{3})?|続き(?:はこちら|を読む)|詳細(?:はこちら|を見る)|全文(?:はこちら|を読む)|記事(?:はこちら|を読む)|Read\s*more|More\s*details?)/gi;
const LEGACY_RESEARCH_LABEL_RE = /^(?:概要|選んだ理由|選定理由|選別理由|生技への応用|対象企業\/組織名|カテゴリ・概要|応用着眼点)$/;
const LEGACY_RESEARCH_SELECTION_TEXT_RE = /(?:選んだ理由|選定理由|選別理由|(?:だから|ため|ので)選びました|選定しました|選別しました)/;

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

function stripResearchSelectionMetadata(value = '') {
  const text = clean(value, 1800);
  if (!/技術リサーチ:\s*Web調査済み/i.test(text)) return text;
  return text
    .replace(/\s*[｜|]\s*(?:選別理由|選定理由|選んだ理由)\s*[:：]\s*[^｜|]*/gi, ' ')
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

function addFact(rows, seen, value) {
  const raw = sentence(value);
  if (!raw || BOILERPLATE_RE.test(raw) || informativeChars(raw) < 10) {
    BOILERPLATE_RE.lastIndex = 0;
    return;
  }
  BOILERPLATE_RE.lastIndex = 0;
  const key = keyOf(raw);
  if (key.length < 8 || seen.has(key)) return;
  seen.add(key);
  rows.push(Array.from(raw).length >= 12 ? raw : `RSSには「${raw.replace(/[。！？!?]+$/g, '')}」と記載されています。`);
}

export function rssFactCandidates(description = '') {
  const source = stripBoilerplate(description);
  if (!source) return [];
  const rows = [];
  const seen = new Set();
  for (const part of source.match(/[^。！？!?]+[。！？!?]?/g) || []) {
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
  const titleKey = keyOf(title);
  const descriptionKey = keyOf(description);
  const titleEcho = Boolean(titleKey.length >= 12 && descriptionKey && (
    descriptionKey === titleKey || (descriptionKey.startsWith(titleKey) && descriptionKey.length - titleKey.length < 24)
  ));
  return {
    title,
    description,
    titleEcho,
    facts: rssFactCandidates(description),
    chars: informativeChars(description)
  };
}

function hostnameOf(value = '') {
  try { return new URL(String(value || ''), location.href).hostname.toLowerCase(); }
  catch { return ''; }
}

export function sourceRecoveryKind(body = {}) {
  const meta = clean([body?.source, body?.feedName, body?.category].filter(Boolean).join(' '), 600);
  const host = hostnameOf(body?.url || body?.link || '');
  if (/Google\s*ニュース|Google\s*News/i.test(meta) || host === 'news.google.com') return 'google-news';
  if (/EE\s*Times(?:\s*Japan)?/i.test(meta) || host === 'eetimes.itmedia.co.jp') return 'eetimes';
  return '';
}

export function isSufficientRss(body = {}) {
  const raw = clean(body?.description || '', 1800);
  if (/技術リサーチ:\s*Web調査済み/i.test(raw)) return true;
  const evidence = rssEvidence(body);
  if (!evidence.description || evidence.titleEcho) return false;
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
  const facts = rssEvidence(body).facts;
  const lines = [facts[0] || titleFact(body), facts[1] || MISSING[1], facts[2] || MISSING[2]];
  return {
    headline: clean(body?.title || '', 100) || '記事のポイント',
    lines: LABELS.map((label, index) => ({ label, text: lines[index] })),
    short: lines[0],
    points: lines.slice(1),
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
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }
  if (url.pathname !== SUMMARY_PATH || url.searchParams.has('batch') || url.searchParams.has('stream')) return null;
  let body;
  try { body = JSON.parse(init.body); }
  catch { return null; }
  const articleId = String(body?.articleId || '').trim();
  return articleId ? { body, articleId } : null;
}

function activeArticleId() {
  return String(document.querySelector('.reader-swipe-card.is-active[data-article-id]')?.dataset?.articleId || '');
}

function readerCardExists(articleId = '') {
  if (!articleId || typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll('.reader-swipe-card[data-article-id]'))
    .some(card => String(card?.dataset?.articleId || '') === articleId);
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

export function buildRssOnlyAiBody(sourceBody = {}) {
  const evidence = rssEvidence(sourceBody);
  // 技術リサーチはRSS内の構造化フィールドをサーバー側で3カードへ整形する。
  // Geminiへは送られないため、各フィールドが380文字で欠けないようRSS記述を保持する。
  const preparedResearch = /技術リサーチ:\s*Web調査済み/i.test(evidence.description);
  const description = preparedResearch ? stripResearchSelectionMetadata(evidence.description) : evidence.description;
  return {
    ...sourceBody,
    description: Array.from(description).slice(0, preparedResearch ? 1800 : 380).join(''),
    url: '',
    link: '',
    preferFullText: false,
    rssOnly: true,
    fast: true
  };
}

function rssOnlyAi(input, init, parsed) {
  const body = buildRssOnlyAiBody(parsed.body);
  const evidence = rssEvidence(parsed.body);
  readerTrace('summary-rss-only-ai', { articleId: parsed.articleId, descriptionChars: body.description.length, factCount: evidence.facts.length });
  return upstreamFetch(input, { ...init, body: JSON.stringify(body) });
}

function sourceRecoveryAi(input, init, parsed, kind) {
  const evidence = rssEvidence(parsed.body);
  const body = {
    ...parsed.body,
    description: Array.from(evidence.description).slice(0, 500).join(''),
    // Google Newsは中間URLの解決、EE Timesは記事本文取得が必要。
    // この2系統だけ既存の本文抽出を復活させ、抽出後は冒頭500文字だけをGeminiへ渡す。
    preferFullText: true,
    rssOnly: false,
    fast: false,
    readerSourceRecovery: kind
  };
  readerTrace('summary-source-recovery-ai', {
    articleId: parsed.articleId,
    kind,
    source: clean(parsed.body?.source || parsed.body?.feedName || '', 160),
    urlHost: hostnameOf(parsed.body?.url || parsed.body?.link || ''),
    rssDescriptionChars: evidence.chars
  });
  return upstreamFetch(input, { ...init, body: JSON.stringify(body) });
}

export function isLegacyResearchSummary(summary = {}) {
  const rows = Array.isArray(summary?.lines) ? summary.lines : [];
  if (!rows.length) return false;
  const labels = rows.map(row => clean(row?.label || '', 80));
  if (labels.some(label => LEGACY_RESEARCH_LABEL_RE.test(label))) return true;
  return rows.some(row => LEGACY_RESEARCH_SELECTION_TEXT_RE.test(clean(row?.text || '', 260)));
}

function purgeBadSummaryCacheOnce() {
  try {
    if (localStorage.getItem(SOURCE_RECOVERY_MIGRATION_KEY) === '1') return;
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      let changed = false;
      for (const [key, entry] of Object.entries(raw)) {
        const value = entry?.value || {};
        const legacySparse = String(value?.provider || '') === 'rss-short-grounded-v1'
          || String(value?.fastPath || '') === 'reader-rss-short-no-inference'
          || String(value?.contentSource || '') === 'rss-short';
        const targetSource = /(?:news\.google\.com|eetimes\.itmedia\.co\.jp)/i.test(String(key || ''));
        if (!legacySparse && !targetSource) continue;
        delete raw[key];
        changed = true;
      }
      if (changed) localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(raw));
    }
    localStorage.setItem(SOURCE_RECOVERY_MIGRATION_KEY, '1');
  } catch {}
}

function purgeSummaryCacheForRssOnlyProductionOnce() {
  try {
    if (localStorage.getItem(RSS_ONLY_PRODUCTION_CACHE_RESET_KEY) === '1') return;
    localStorage.removeItem(SUMMARY_STORAGE_KEY);
    localStorage.setItem(RSS_ONLY_PRODUCTION_CACHE_RESET_KEY, '1');
  } catch {}
}

function purgeLegacyResearchSummaryCacheOnce() {
  try {
    if (localStorage.getItem(LEGACY_RESEARCH_SUMMARY_MIGRATION_KEY) === '1') return;
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      let changed = false;
      for (const [key, entry] of Object.entries(raw)) {
        if (!isLegacyResearchSummary(entry?.value || {})) continue;
        delete raw[key];
        changed = true;
      }
      if (changed) localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(raw));
    }
    localStorage.setItem(LEGACY_RESEARCH_SUMMARY_MIGRATION_KEY, '1');
  } catch {}
}

if (typeof window !== 'undefined') {
  purgeBadSummaryCacheOnce();
  purgeSummaryCacheForRssOnlyProductionOnce();
  purgeLegacyResearchSummaryCacheOnce();
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_RSS_ONLY_SUMMARY_INSTALLED) {
  window.__PDV2_READER_RSS_ONLY_SUMMARY_INSTALLED = true;
  globalThis.fetch = function readerRssOnlySummaryFetch(input, init = {}) {
    const parsed = parseSummaryPost(input, init);
    if (!parsed) return upstreamFetch(input, init);

    // Readerに実際に存在するカードのsummaryだけを本番RSS経路へ通す。
    // 他画面・他機能が同じ /api/summary を使っても横取りしない。
    if (!readerCardExists(parsed.articleId)) {
      readerTrace('summary-rss-only-bypass-non-reader', { articleId: parsed.articleId });
      return upstreamFetch(input, init);
    }

    if (activeArticleId() !== parsed.articleId) {
      readerTrace('summary-prefetch-disabled', { articleId: parsed.articleId, activeArticleId: activeArticleId() });
      return Promise.resolve(disabledPrefetch(parsed));
    }

    // Google NewsのRSSリンクは出版社URLではなくnews.google.comの中間URL。
    // 通常RSSと同じ「URLを消してRSS本文だけ」の経路へ入れると、短い見出ししか残らず
    // 全件 unavailable になる。Google Newsだけ既存のURL解決→本文抽出経路へ戻す。
    // それ以外のRSSは従来の高速経路を維持するため、表示速度には干渉しない。
    const recoveryKind = sourceRecoveryKind(parsed.body);
    if (recoveryKind === 'google-news') {
      readerTrace('summary-google-news-recovery', { articleId: parsed.articleId });
      return sourceRecoveryAi(input, init, parsed, recoveryKind);
    }

    return rssOnlyAi(input, init, parsed);
  };

  window.__PDV2_READER_RSS_ONLY_SUMMARY = {
    sufficient: body => isSufficientRss(body),
    grounded: body => buildGroundedShortSummary(body),
    evidence: body => rssEvidence(body),
    sourceRecoveryKind: body => sourceRecoveryKind(body),
    production: true
  };
}
