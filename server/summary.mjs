import summaryV2184 from '../lib/summary-v2184.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';
import { technologyResearchFeed } from '../lib/technology-research.mjs';
import paperTitles from '../lib/paper-titles.mjs';
import { summaryBatchV2195, summarySingleV2195 } from '../lib/summary-dispatch-v2195.mjs';
import { setAsciiHeader, summaryServerErrorCode } from '../lib/http-response-safe.mjs';

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;
const ARTICLE_PREPARE_TIMEOUT_MS = 7500;
const FAST_ARTICLE_PREPARE_TIMEOUT_MS = 1400;
const FAST_RSS_MIN_CHARS = 160;
const FAST_RSS_MIN_SENTENCES = 2;
const RESEARCH_ARTICLE_TIMEOUT_MS = 5000;
const RESEARCH_NOISE_RE = /(?:Cookie|クッキー|JavaScript|ログイン|会員登録|お問い合わせ|プライバシーポリシー|利用規約|関連記事|おすすめ記事|広告|Copyright|無断転載|メニュー|サイト内検索|シェア(?:する|はこちら)?|ホームへ|トップページ)/i;
const RSS_BOILERPLATE_RE = /(?:続きを読む(?:…|\.{3})?|続き(?:はこちら|を読む)|詳細(?:はこちら|を見る)|全文(?:はこちら|を読む)|記事(?:はこちら|を読む)|元記事(?:はこちら|を読む|で確認)|Read\s*more|More\s*details?)/gi;

function clean(value = '', max = 6000) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function first500(value = '') { return Array.from(clean(value)).slice(0, 500).join(''); }
function compact(value = '') { return clean(value).replace(/[\s、。・:：\-—|｜「」『』（）()]/g, '').toLowerCase(); }
function fingerprint(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) { hash ^= ch.codePointAt(0) || 0; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function rawBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}
function researchField(description, label, nextLabels = []) {
  const source = clean(description);
  const marker = `${label}:`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const valueStart = start + marker.length;
  let end = source.length;
  for (const nextLabel of nextLabels) {
    const index = source.indexOf(`｜ ${nextLabel}:`, valueStart);
    if (index >= 0 && index < end) end = index;
  }
  return source.slice(valueStart, end).replace(/^\s+|\s+$/g, '').trim();
}
function cleanResearchText(value = '', max = 5000) {
  return clean(value, max)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/%[0-9a-f]{2}/gi, ' ')
    .replace(/\b(?:Title|Description|QYResearch)\s*[:：]?/gi, ' ')
    .replace(/(?:^|\s)#{1,6}\s*/g, ' ')
    .replace(/\bM-?\d+(?:-\d+)?(?:h\d+v\d+)?(?:\.svg)?\b/gi, ' ')
    .replace(/(?:…|\.{3,})+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function researchSentenceCandidates(value = '') {
  const text = cleanResearchText(value, 5000);
  const sentences = text.match(/[^。！？!?]{18,260}[。！？!?]/g) || [];
  return sentences
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 18 && !RESEARCH_NOISE_RE.test(sentence));
}
function finishResearchSentence(value = '') {
  const text = cleanResearchText(value, 360)
    .replace(/[、,;；:：\s]+$/g, '')
    .trim();
  if (!text) return '';
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}
function completeResearchText(value = '', max = 145) {
  const sentences = researchSentenceCandidates(value);
  let combined = '';
  for (const sentence of sentences) {
    const next = `${combined}${sentence}`;
    if (Array.from(next).length <= max) {
      combined = next;
      continue;
    }
    if (combined) break;
    const chars = Array.from(sentence);
    if (chars.length <= max + 35) return finishResearchSentence(sentence);
    const prefix = chars.slice(0, max).join('');
    const boundaries = ['。', '！', '？', '、', '；', ';', '：', ':'];
    const index = Math.max(...boundaries.map(mark => prefix.lastIndexOf(mark)));
    if (index >= Math.floor(max * 0.55)) {
      return finishResearchSentence(prefix.slice(0, index + 1));
    }
  }
  if (combined) return finishResearchSentence(combined);

  const text = cleanResearchText(value, max * 3);
  const chars = Array.from(text);
  if (!chars.length) return '';
  const prefix = chars.slice(0, max).join('');
  const boundaries = ['。', '！', '？', '、', '；', ';', '：', ':', '｜'];
  const index = Math.max(...boundaries.map(mark => prefix.lastIndexOf(mark)));
  if (index >= Math.floor(max * 0.55)) return finishResearchSentence(prefix.slice(0, index + 1));
  return '';
}
function researchFallbackOverview(title = '', category = '') {
  const cleanedTitle = cleanResearchText(title, 92).replace(/[「」『』]+/g, '').trim();
  if (!cleanedTitle) return `${category || '生産技術'}に関わる技術・事例を扱った記事です。`;
  return `「${cleanedTitle}」では、${category || '生産技術'}に関わる技術・事例を扱っています。`;
}
async function researchOverviewText(body, overview, acquisition, category) {
  const fallback = completeResearchText(overview, 145);
  const url = clean(body.url || body.link, 1600);
  const shouldReadArticle = /Tavily/i.test(acquisition)
    || /(?:…|\.{3,})/.test(String(overview || ''))
    || researchSentenceCandidates(overview).length === 0;

  if (url && shouldReadArticle) {
    try {
      const article = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 4200, preferPdf: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('technology research article timeout')), RESEARCH_ARTICLE_TIMEOUT_MS))
      ]);
      const articleText = cleanResearchText(article?.text || '', 4200);
      const fromArticle = completeResearchText(articleText, 145);
      if (fromArticle && !RESEARCH_NOISE_RE.test(fromArticle)) return fromArticle;
    } catch (error) {
      console.warn('[summary] technology research article fallback', clean(error?.message || error, 160));
    }
  }

  return fallback || researchFallbackOverview(body.title, category);
}
function researchSelectionReason(category = '') {
  const map = {
    '生技基礎': '用語・計算・使い分けを整理でき、生産技術の判断軸を増やせる内容だから選びました。',
    '改善事例': '課題から対策、効果までの考え方を自工程へ置き換えやすい内容だから選びました。',
    '技術革新': '新しい仕組みや工法を、製造や新規開発へ流用する着眼点がある内容だから選びました。',
    '論文・研究': '研究結果や評価方法を、生産技術の仮説・検証へ置き換えやすい内容だから選びました。',
    '製品・製造技術': '製品機能や量産工程に近く、新規開発・工程設計のヒントになる内容だから選びました。',
    '異業種横展開': '他業種の改善原理を、自工程へ横展開するヒントが得られる内容だから選びました。'
  };
  return map[category] || '生産技術の知識・改善・技術着想につながる具体性があるため選びました。';
}
async function researchSummaryFromBody(body = {}) {
  const description = clean(body.description);
  if (!/技術リサーチ:\s*Web調査済み/.test(description)) return null;
  const organization = researchField(description, '対象企業/組織名', ['カテゴリ', '日付精度', '公開年', '概要', '応用着眼点', '媒体']);
  const category = researchField(description, 'カテゴリ', ['日付精度', '公開年', '概要', '応用着眼点', '媒体']);
  const overview = researchField(description, '概要', ['応用着眼点', '媒体']);
  const application = researchField(description, '応用着眼点', ['媒体']);
  const selectionReason = researchField(description, '選別理由', ['トピック', '取得方式']);
  const acquisition = researchField(description, '取得方式');
  if (!organization || !category || !overview || !application) return null;

  const overviewText = await researchOverviewText(body, overview, acquisition, category);
  const reason = /機械採点|score|検索関連度|カテゴリ語|条件に合致/i.test(selectionReason)
    ? researchSelectionReason(category)
    : completeResearchText(selectionReason, 96) || researchSelectionReason(category);
  const applicationText = completeResearchText(application, 110)
    || '手法・原理・効果を自工程の課題へ置き換え、改善や新規技術探索の着眼点として使えます。';

  return {
    headline: clean(body.title) || '技術リサーチ',
    lines: [
      { label: '概要', text: overviewText },
      { label: '選んだ理由', text: reason },
      { label: '生技への応用', text: applicationText }
    ],
    short: overviewText,
    points: [reason, applicationText],
    provider: 'technology-research-prepared-v9',
    model: 'prepared',
    contentSource: /Tavily/i.test(acquisition) ? 'article+web-research' : 'web-research',
    cacheable: true,
    validated: true,
    fastPath: 'technology-research-prepared-v9'
  };
}
function descriptionLooksReal(title, description) {
  const text = clean(description);
  if (text.length < 70 || GENERIC_RE.test(text)) return false;
  const t = compact(title), d = compact(text);
  if (t.length >= 12 && d.length < 220 && (d === t || d.startsWith(t) || d.includes(t.slice(0, Math.min(36, t.length))))) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 55;
}
function stripRssBoilerplate(value = '') {
  return clean(String(value || '').replace(RSS_BOILERPLATE_RE, ' '));
}
function informativeChars(value = '') {
  return (String(value || '').match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
}
function isTitleEcho(title, value) {
  const titleKey = compact(title), valueKey = compact(value);
  if (titleKey.length < 2 || !valueKey || !valueKey.includes(titleKey)) return false;
  return valueKey.split(titleKey).join('').length < 40;
}
function specificRssSentences(title, description) {
  return (description.match(/[^。！？!?.]{12,}[。！？!?.]?/g) || [])
    .map(sentence => clean(sentence))
    .filter(sentence => informativeChars(sentence) >= 18)
    .filter(sentence => !GENERIC_RE.test(sentence) && !isTitleEcho(title, sentence));
}
function descriptionLooksFastEnough(title, description) {
  const text = stripRssBoilerplate(description);
  if (text.length < FAST_RSS_MIN_CHARS || isTitleEcho(title, text)) return false;
  return specificRssSentences(title, text).length >= FAST_RSS_MIN_SENTENCES;
}
function isGoogleNewsInput(body = {}, url = '') {
  const source = clean(body.source || body.feedName || '');
  if (/Google\s*ニュース|Google\s*News/i.test(source)) return true;
  try { return new URL(url).hostname.toLowerCase() === 'news.google.com'; } catch { return false; }
}
export async function prepareSummaryBody(raw = {}, { extractor = extractArticleFromUrl, articleTimeoutMs = ARTICLE_PREPARE_TIMEOUT_MS } = {}) {
  const body = { ...(raw || {}) };
  const title = clean(body.title), description = clean(body.description), url = clean(body.url || body.link);
  const googleNews = isGoogleNewsInput(body, url);
  const fastRequest = body.fast === true || String(body.fast || '').toLowerCase() === 'true';
  const requestedFullText = body.preferFullText === true || String(body.preferFullText || '').toLowerCase() === 'true';
  const fastRss = fastRequest && descriptionLooksFastEnough(title, description);
  const preferFullText = !fastRss && (requestedFullText || googleNews);
  if (fastRss || (!preferFullText && descriptionLooksReal(title, description))) {
    body.description = first500(fastRss ? stripRssBoilerplate(description) : description); body.preparedSource = 'rss'; body.prepareReason = fastRss ? 'fast-rss-description-sufficient' : 'rss-description-sufficient'; return body;
  }
  if (url) {
    const requestedTimeout = Number(articleTimeoutMs);
    const effectiveArticleTimeoutMs = fastRequest
      ? Math.max(500, Math.min(FAST_ARTICLE_PREPARE_TIMEOUT_MS, Number.isFinite(requestedTimeout) ? requestedTimeout : FAST_ARTICLE_PREPARE_TIMEOUT_MS))
      : Math.max(2500, Number.isFinite(requestedTimeout) ? requestedTimeout : ARTICLE_PREPARE_TIMEOUT_MS);
    try {
      const article = await Promise.race([
        extractor(url, { maxTextLength: fastRequest ? 1200 : 2200, preferPdf: !fastRequest }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('summary article timeout')), effectiveArticleTimeoutMs))
      ]);
      const text = first500(article?.text || '');
      if (text.length >= 70 && !GENERIC_RE.test(text)) {
        body.description = text; body.title = clean(article?.title || title) || title; body.preparedSource = article?.sourceType === 'pdf' ? 'pdf' : 'article'; body.prepareReason = preferFullText ? 'preferred-full-text' : 'article-fallback'; return body;
      }
      body.prepareError = `article-text-insufficient:${text.length}`;
    } catch (error) { body.prepareError = clean(error?.message || error, 160); console.warn('[summary] article prepare failed', body.prepareError); }
  }
  body.description = description.length >= 45 && !GENERIC_RE.test(description) ? first500(description) : '';
  body.preparedSource = body.description ? 'rss-short' : 'missing';
  body.prepareReason = body.description ? 'article-unavailable-rss-fallback' : 'article-and-rss-insufficient';
  return body;
}
function isolateSummaryWork(body = {}) {
  const originalMode = clean(body.mode) || 'auto';
  const material = [clean(body.title), first500(body.description), clean(body.preparedSource)].join('\n');
  return { ...body, clientMode: originalMode, mode: `${originalMode}#${fingerprint(material)}`.slice(0, 32) };
}
async function articleOnlyDiagnostic(req, res) {
  const startedAt = Date.now(), incoming = rawBody(req);
  const prepared = await prepareSummaryBody({ ...incoming, preferFullText: true });
  const preparedChars = Array.from(clean(prepared.description || '')).length;
  const articleOk = ['article', 'pdf'].includes(String(prepared.preparedSource || ''));
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Summary-Route', 'diagnostic-article-only-v2195');
  return res.status(200).json({ diagnostic: 'article-only-v2195', ok: articleOk, preparedSource: clean(prepared.preparedSource || 'missing', 80), prepareReason: clean(prepared.prepareReason || 'unknown', 120), prepareError: clean(prepared.prepareError || '', 160), preparedChars, inputDescriptionChars: Array.from(clean(incoming.description || '')).length, elapsedMs: Date.now() - startedAt });
}
async function routeSummaryRequest(req, res) {
  if (req.method === 'GET' && String(req.query?.technologyResearch || '') === '1') return technologyResearchFeed(req, res);
  if (req.method === 'POST' && String(req.query?.paperTitles || '') === '1') return paperTitles(req, res);
  if (req.method === 'POST' && String(req.query?.diagnostic || '') === 'article') return articleOnlyDiagnostic(req, res);
  if (req.method === 'POST' && String(req.query?.batch || '') === '1') return summaryBatchV2195(req, res);
  if (req.method === 'POST') {
    const incoming = rawBody(req);
    const preparedResearch = await researchSummaryFromBody(incoming);
    if (preparedResearch) {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Summary-Prepared-Source', 'web-research'); res.setHeader('X-Summary-Route', 'technology-research-prepared-v9');
      return res.status(200).json(preparedResearch);
    }
    const prepared = await prepareSummaryBody(incoming);
    req.body = isolateSummaryWork(prepared);
    setAsciiHeader(res, 'X-Summary-Prepared-Source', prepared.preparedSource || 'unknown');
    setAsciiHeader(res, 'X-Summary-Prepare-Reason', prepared.prepareReason || 'unknown');
    setAsciiHeader(res, 'X-Summary-Prepare-Error', prepared.prepareError || '');
    res.setHeader('X-Summary-Prepared-Chars', String(Array.from(clean(prepared.description || '')).length));
    res.setHeader('X-Summary-Prefer-Full-Text', String(Boolean(incoming?.preferFullText)));
    if (prepared.prepareError) console.warn('[summary] prepared with fallback', { articleId: clean(incoming?.articleId, 180), preparedSource: prepared.preparedSource || 'unknown', prepareReason: prepared.prepareReason || 'unknown', prepareError: prepared.prepareError });
    if (String(req.query?.stream || '') === '1') return summaryV2184(req, res);
    return summarySingleV2195(req, res);
  }
  return summaryV2184(req, res);
}
export default async function handler(req, res) {
  try { return await routeSummaryRequest(req, res); }
  catch (error) {
    const incoming = rawBody(req), errorCode = summaryServerErrorCode(error);
    console.error('[summary-api] unhandled error', { errorCode, name: String(error?.name || 'Error'), code: String(error?.code || ''), message: String(error?.message || error).slice(0, 800), method: String(req?.method || ''), articleId: clean(incoming?.articleId, 180), requestId: clean(incoming?.requestId, 180), query: req?.query || {} });
    if (res.headersSent) { try { return res.end(); } catch { return undefined; } }
    try {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Summary-Route', 'server-error-v2195'); res.setHeader('X-Summary-Error-Code', errorCode);
      setAsciiHeader(res, 'X-Summary-Request-Id', incoming?.requestId || ''); setAsciiHeader(res, 'X-Summary-Article-Id', incoming?.articleId || '');
    } catch (headerError) { console.error('[summary-api] failed to set safe error headers', headerError); }
    return res.status(503).json({ provider: 'unavailable', cacheable: false, validated: false, errorCode, articleId: clean(incoming?.articleId, 600), requestId: clean(incoming?.requestId, 240), requestType: ['display', 'prefetch'].includes(String(incoming?.requestType || '')) ? incoming.requestType : 'display' });
  }
}
