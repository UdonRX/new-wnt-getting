import summaryV2184 from '../lib/summary-v2184.mjs';
import summaryBatchV2188 from '../lib/summary-batch-v2188.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';
import {
  buildDevErrorSummary,
  cleanDebugText,
  diagnosticForMissing,
  diagnosticFromFetchError,
  inspectSummaryText
} from '../lib/summary-dev-debug-v2189.mjs';

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;

function clean(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
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

function descriptionLooksReal(title, description) {
  const text = clean(description);
  if (text.length < 70 || GENERIC_RE.test(text)) return false;
  const t = compact(title);
  const d = compact(text);
  if (t.length >= 12 && d.length < 220 && (d === t || d.startsWith(t) || d.includes(t.slice(0, Math.min(36, t.length))))) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 55;
}

function bodyOf(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function withRoute(diagnostic, route) {
  return diagnostic ? { ...diagnostic, route: route || diagnostic.route || 'single' } : null;
}

async function prepareBodyValue(raw = {}, { route = 'single' } = {}) {
  const body = { ...(raw || {}) };
  const title = clean(body.title);
  const description = clean(body.description);
  const url = clean(body.url || body.link);
  const rssDiagnostic = inspectSummaryText(description, {
    route,
    stage: 'rss',
    url,
    fallbackEvidence: description || title
  });

  if (descriptionLooksReal(title, description) && !rssDiagnostic) {
    body.description = first500(description);
    body.preparedSource = 'rss';
    body.summaryDevDiagnostic = null;
    return body;
  }

  let articleDiagnostic = null;
  if (url) {
    try {
      const article = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 2200 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('summary article timeout')), 8500))
      ]);
      const rawArticleText = cleanDebugText(article?.text || '', 2200);
      const articleDiagnosticCandidate = inspectSummaryText(rawArticleText, {
        route,
        stage: article?.sourceType === 'pdf' ? 'pdf' : 'article',
        url,
        fallbackEvidence: rawArticleText || description || title
      });
      const text = first500(rawArticleText);
      if (text.length >= 70 && !GENERIC_RE.test(text) && !articleDiagnosticCandidate) {
        body.description = text;
        body.title = clean(article?.title || title) || title;
        body.preparedSource = article?.sourceType === 'pdf' ? 'pdf' : 'article';
        body.summaryDevDiagnostic = null;
        return body;
      }
      articleDiagnostic = articleDiagnosticCandidate || diagnosticForMissing({
        route,
        stage: article?.sourceType === 'pdf' ? 'pdf' : 'article',
        url,
        fallbackEvidence: rawArticleText || description || title
      });
    } catch (error) {
      articleDiagnostic = diagnosticFromFetchError(error, {
        route,
        stage: 'article-fetch',
        url,
        fallbackEvidence: description || title
      });
      console.warn('[summary-v2189-dev] article prepare failed', {
        route,
        url,
        message: error?.message || error,
        code: articleDiagnostic?.code
      });
    }
  }

  // Keep a short RSS fallback only when the diagnostic inspection still says it
  // is meaningful enough. Text below the normal threshold is intentionally not
  // sent to Gemini during this temporary debugging period.
  const shortDescription = description.length >= 45 && !GENERIC_RE.test(description) ? first500(description) : '';
  const shortDiagnostic = shortDescription
    ? inspectSummaryText(shortDescription, { route, stage: 'rss-short', url, fallbackEvidence: shortDescription })
    : null;

  if (shortDescription && !shortDiagnostic && shortDescription.length >= 70) {
    body.description = shortDescription;
    body.preparedSource = 'rss-short';
    body.summaryDevDiagnostic = null;
    return body;
  }

  body.description = '';
  body.preparedSource = 'missing';
  body.summaryDevDiagnostic = withRoute(
    articleDiagnostic
      || shortDiagnostic
      || rssDiagnostic
      || diagnosticForMissing({ route, stage: url ? 'article+rss' : 'rss', url, fallbackEvidence: description || title }),
    route
  );
  return body;
}

function isolateSummaryWork(body = {}) {
  const originalMode = clean(body.mode) || 'auto';
  const material = [clean(body.title), first500(body.description), clean(body.preparedSource)].join('\n');
  const { summaryDevDiagnostic, ...safeBody } = body;
  return {
    ...safeBody,
    clientMode: originalMode,
    mode: `${originalMode}#${fingerprint(material)}`.slice(0, 32)
  };
}

function devErrorResult(prepared = {}, index = 0) {
  const diagnostic = prepared.summaryDevDiagnostic || diagnosticForMissing({
    route: 'batch',
    stage: prepared.preparedSource || 'prepare',
    url: prepared.url || prepared.link,
    fallbackEvidence: prepared.description || prepared.title
  });
  return {
    index,
    url: clean(prepared.url || prepared.link),
    mode: clean(prepared.mode) || 'auto',
    summary: null,
    preparedSource: prepared.preparedSource || 'missing',
    devError: buildDevErrorSummary({ ...diagnostic, route: 'batch' })
  };
}

async function handleBatch(req, res) {
  const raw = bodyOf(req);
  const incoming = Array.isArray(raw.items) ? raw.items.slice(0, 10) : [];
  if (!incoming.length) return summaryBatchV2188(req, res);

  // TEMP v2.18.9 diagnostics: inspect every future-card item before Gemini.
  // This prevents menu/paywall/empty text from becoming a plausible-looking
  // batch summary and preserves a structured reason for later investigation.
  const preparedRows = await Promise.all(incoming.map((item, index) =>
    prepareBodyValue(item, { route: 'batch' }).then(prepared => ({ index, prepared }))
  ));
  const validRows = preparedRows.filter(row => !row.prepared.summaryDevDiagnostic);

  if (!validRows.length) {
    return res.status(200).json({
      results: preparedRows.map(row => devErrorResult(row.prepared, row.index)),
      batch: 'v2188+dev-v2189',
      generated: 0,
      cached: 0,
      devErrors: preparedRows.length
    });
  }

  req.body = { ...raw, items: validRows.map(row => {
    const { summaryDevDiagnostic, preparedSource, ...prepared } = row.prepared;
    return { ...prepared, description: prepared.description || '', preparedSource };
  }) };

  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (!Array.isArray(payload?.results)) return originalJson(payload);
    const validResults = payload.results;
    const merged = new Array(preparedRows.length).fill(null);

    validRows.forEach((row, validIndex) => {
      const result = validResults[validIndex] || {};
      merged[row.index] = { ...result, index: row.index };
    });
    preparedRows.forEach(row => {
      if (row.prepared.summaryDevDiagnostic) merged[row.index] = devErrorResult(row.prepared, row.index);
    });

    return originalJson({
      ...payload,
      results: merged.filter(Boolean),
      batch: `${payload.batch || 'v2188'}+dev-v2189`,
      devErrors: preparedRows.length - validRows.length
    });
  };

  return summaryBatchV2188(req, res);
}

export default async function handler(req, res) {
  if (req.method === 'POST' && String(req.query?.batch || '') === '1') {
    return handleBatch(req, res);
  }

  if (req.method === 'POST') {
    const prepared = await prepareBodyValue(bodyOf(req), { route: 'single' });
    res.setHeader('X-Summary-Prepared-Source', prepared.preparedSource || 'unknown');

    // TEMP v2.18.9 diagnostics: return a visible, non-cacheable report instead
    // of asking Gemini to summarize unusable input. Remove after root cause fix.
    if (prepared.summaryDevDiagnostic) {
      const diagnostic = { ...prepared.summaryDevDiagnostic, route: 'single' };
      res.setHeader('X-Summary-Dev-Error', diagnostic.code || 'UNKNOWN_EXTRACTION');
      return res.status(200).json(buildDevErrorSummary(diagnostic));
    }

    req.body = isolateSummaryWork(prepared);
  }
  return summaryV2184(req, res);
}
