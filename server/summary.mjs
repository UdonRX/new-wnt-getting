import summaryV2184 from '../lib/summary-v2184.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';
import { technologyResearchFeed } from '../lib/technology-research.mjs';
import paperTitles from '../lib/paper-titles.mjs';
import { summaryBatchV2195, summarySingleV2195 } from '../lib/summary-dispatch-v2195.mjs';
import { setAsciiHeader, summaryServerErrorCode } from '../lib/http-response-safe.mjs';

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;
const ARTICLE_PREPARE_TIMEOUT_MS = 7500;
const FAST_ARTICLE_PREPARE_TIMEOUT_MS = 1400;
const FAST_RSS_MIN_CHARS = 320;

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

function first500(value = '') {
  return Array.from(clean(value)).slice(0, 500).join('');
}

function compact(value = '') {
  return clean(value).replace(/[\s、。・:：\-—|｜「」『』（）()]/g, '').toLowerCase();
}

function fingerprint(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rawBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
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

function researchSummaryFromBody(body = {}) {
  const description = clean(body.description);
  if (!/技術リサーチ:\s*Web調査済み/.test(description)) return null;
  const organization = researchField(description, '対象企業/組織名', ['カテゴリ', '概要', '応用着眼点', '媒体']);
  const category = researchField(description, 'カテゴリ', ['概要', '応用着眼点', '媒体']);
  const overview = researchField(description, '概要', ['応用着眼点', '媒体']);
  const application = researchField(description, '応用着眼点', ['媒体']);
  if (!organization || !category || !overview || !application) return null;
  const sentence = value => /[。！？!?]$/.test(value) ? value : `${value}。`;
  return {
    headline: clean(body.title) || '技術リサーチ',
    lines: [
      { label: '対象企業/組織名', text: sentence(`${organization}を対象にした情報です`) },
      { label: 'カテゴリ・概要', text: sentence(`［${category}］${overview}`) },
      { label: '応用着眼点', text: sentence(application) }
    ],
    short: sentence(`${organization}を対象にした情報です`),
    points: [sentence(`［${category}］${overview}`), sentence(application)],
    provider: 'gemini-grounded-research-v2195',
    model: 'grounded-search',
    contentSource: 'web-research',
    cacheable: true,
    validated: true,
    fastPath: 'technology-research-prepared'
  };
}

function descriptionLooksReal(title, description) {
  const text = clean(description);
  if (text.length < 70 || GENERIC_RE.test(text)) return false;
  const t = compact(title);
  const d = compact(text);
  if (t.length >= 12 && d.length < 220 && (d === t || d.startsWith(t) || d.includes(t.slice(0, Math.min(36, t.length))))) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 55;
}

function descriptionLooksFastEnough(title, description) {
  const text = clean(description);
  if (text.length < FAST_RSS_MIN_CHARS || !descriptionLooksReal(title, text)) return false;
  const sentences = text.match(/[^。！？!?.]{12,}[。！？!?.]/g) || [];
  return sentences.length >= 3;
}

function isGoogleNewsInput(body = {}, url = '') {
  const source = clean(body.source || body.feedName || '');
  if (/Google\s*ニュース|Google\s*News/i.test(source)) return true;
  try { return new URL(url).hostname.toLowerCase() === 'news.google.com'; }
  catch { return false; }
}

export async function prepareSummaryBody(raw = {}, {
  extractor = extractArticleFromUrl,
  articleTimeoutMs = ARTICLE_PREPARE_TIMEOUT_MS
} = {}) {
  const body = { ...(raw || {}) };
  const title = clean(body.title);
  const description = clean(body.description);
  const url = clean(body.url || body.link);
  const googleNews = isGoogleNewsInput(body, url);
  const fastRequest = body.fast === true || String(body.fast || '').toLowerCase() === 'true';
  const requestedFullText = body.preferFullText === true
    || String(body.preferFullText || '').toLowerCase() === 'true';
  // news/knowledgeは、Google Newsを含めRSS本文が十分ならURL解決を待たず500文字以内で即時要約する。
  // RSSが足りない場合だけ短時間の本文取得を試し、papersの重い本文/PDF取得は従来どおり維持する。
  const fastRss = fastRequest && descriptionLooksFastEnough(title, description);
  const preferFullText = !fastRss && (requestedFullText || googleNews);

  if (fastRss || (!preferFullText && descriptionLooksReal(title, description))) {
    body.description = first500(description);
    body.preparedSource = 'rss';
    body.prepareReason = fastRss ? 'fast-rss-description-sufficient' : 'rss-description-sufficient';
    return body;
  }

  if (url) {
    const requestedTimeout = Number(articleTimeoutMs);
    const effectiveArticleTimeoutMs = fastRequest
      ? Math.max(500, Math.min(FAST_ARTICLE_PREPARE_TIMEOUT_MS, Number.isFinite(requestedTimeout) ? requestedTimeout : FAST_ARTICLE_PREPARE_TIMEOUT_MS))
      : Math.max(2500, Number.isFinite(requestedTimeout) ? requestedTimeout : ARTICLE_PREPARE_TIMEOUT_MS);
    try {
      const article = await Promise.race([
        extractor(url, {
          maxTextLength: fastRequest ? 1200 : 2200,
          preferPdf: !fastRequest
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('summary article timeout')),
          effectiveArticleTimeoutMs
        ))
      ]);
      const text = first500(article?.text || '');
      if (text.length >= 70 && !GENERIC_RE.test(text)) {
        body.description = text;
        body.title = clean(article?.title || title) || title;
        body.preparedSource = article?.sourceType === 'pdf' ? 'pdf' : 'article';
        body.prepareReason = preferFullText ? 'preferred-full-text' : 'article-fallback';
        return body;
      }
      body.prepareError = `article-text-insufficient:${text.length}`;
    } catch (error) {
      body.prepareError = clean(error?.message || error, 160);
      console.warn('[summary] article prepare failed', body.prepareError);
    }
  }

  body.description = description.length >= 45 && !GENERIC_RE.test(description) ? first500(description) : '';
  body.preparedSource = body.description ? 'rss-short' : 'missing';
  body.prepareReason = body.description ? 'article-unavailable-rss-fallback' : 'article-and-rss-insufficient';
  return body;
}

function isolateSummaryWork(body = {}) {
  const originalMode = clean(body.mode) || 'auto';
  const material = [clean(body.title), first500(body.description), clean(body.preparedSource)].join('\n');
  return {
    ...body,
    clientMode: originalMode,
    mode: `${originalMode}#${fingerprint(material)}`.slice(0, 32)
  };
}

async function articleOnlyDiagnostic(req, res) {
  const startedAt = Date.now();
  const incoming = rawBody(req);
  const prepared = await prepareSummaryBody({ ...incoming, preferFullText: true });
  const preparedChars = Array.from(clean(prepared.description || '')).length;
  const articleOk = ['article', 'pdf'].includes(String(prepared.preparedSource || ''));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Summary-Route', 'diagnostic-article-only-v2195');
  return res.status(200).json({
    diagnostic: 'article-only-v2195',
    ok: articleOk,
    preparedSource: clean(prepared.preparedSource || 'missing', 80),
    prepareReason: clean(prepared.prepareReason || 'unknown', 120),
    prepareError: clean(prepared.prepareError || '', 160),
    preparedChars,
    inputDescriptionChars: Array.from(clean(incoming.description || '')).length,
    elapsedMs: Date.now() - startedAt
  });
}

async function routeSummaryRequest(req, res) {
  if (req.method === 'GET' && String(req.query?.technologyResearch || '') === '1') {
    return technologyResearchFeed(req, res);
  }

  if (req.method === 'POST' && String(req.query?.paperTitles || '') === '1') {
    return paperTitles(req, res);
  }

  if (req.method === 'POST' && String(req.query?.diagnostic || '') === 'article') {
    return articleOnlyDiagnostic(req, res);
  }

  if (req.method === 'POST' && String(req.query?.batch || '') === '1') {
    return summaryBatchV2195(req, res);
  }

  if (req.method === 'POST') {
    const incoming = rawBody(req);
    const preparedResearch = researchSummaryFromBody(incoming);
    if (preparedResearch) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Summary-Prepared-Source', 'web-research');
      res.setHeader('X-Summary-Route', 'technology-research-prepared');
      return res.status(200).json(preparedResearch);
    }

    const prepared = await prepareSummaryBody(incoming);
    req.body = isolateSummaryWork(prepared);
    setAsciiHeader(res, 'X-Summary-Prepared-Source', prepared.preparedSource || 'unknown');
    setAsciiHeader(res, 'X-Summary-Prepare-Reason', prepared.prepareReason || 'unknown');
    setAsciiHeader(res, 'X-Summary-Prepare-Error', prepared.prepareError || '');
    res.setHeader('X-Summary-Prepared-Chars', String(Array.from(clean(prepared.description || '')).length));
    res.setHeader('X-Summary-Prefer-Full-Text', String(Boolean(incoming?.preferFullText)));

    if (prepared.prepareError) {
      console.warn('[summary] prepared with fallback', {
        articleId: clean(incoming?.articleId, 180),
        preparedSource: prepared.preparedSource || 'unknown',
        prepareReason: prepared.prepareReason || 'unknown',
        prepareError: prepared.prepareError
      });
    }

    if (String(req.query?.stream || '') === '1') return summaryV2184(req, res);
    return summarySingleV2195(req, res);
  }

  return summaryV2184(req, res);
}

export default async function handler(req, res) {
  try {
    return await routeSummaryRequest(req, res);
  } catch (error) {
    const incoming = rawBody(req);
    const errorCode = summaryServerErrorCode(error);
    console.error('[summary-api] unhandled error', {
      errorCode,
      name: String(error?.name || 'Error'),
      code: String(error?.code || ''),
      message: String(error?.message || error).slice(0, 800),
      method: String(req?.method || ''),
      articleId: clean(incoming?.articleId, 180),
      requestId: clean(incoming?.requestId, 180),
      query: req?.query || {}
    });

    if (res.headersSent) {
      try { return res.end(); } catch { return undefined; }
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Summary-Route', 'server-error-v2195');
      res.setHeader('X-Summary-Error-Code', errorCode);
      setAsciiHeader(res, 'X-Summary-Request-Id', incoming?.requestId || '');
      setAsciiHeader(res, 'X-Summary-Article-Id', incoming?.articleId || '');
    } catch (headerError) {
      console.error('[summary-api] failed to set safe error headers', headerError);
    }

    return res.status(503).json({
      provider: 'unavailable',
      cacheable: false,
      validated: false,
      errorCode,
      articleId: clean(incoming?.articleId, 600),
      requestId: clean(incoming?.requestId, 240),
      requestType: ['display', 'prefetch'].includes(String(incoming?.requestType || '')) ? incoming.requestType : 'display'
    });
  }
}
