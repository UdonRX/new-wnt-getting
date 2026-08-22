import { extractArticleFromUrl } from './article-reader.mjs';

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_ITEMS = 10;
const INPUT_LIMIT = 500;
const CACHE_LIMIT = 320;
const memoryCache = new Map();

function clean(value = '', max = 6000) {
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
function firstChars(value = '', limit = INPUT_LIMIT) { return Array.from(clean(value, 5000)).slice(0, limit).join(''); }
function fingerprint(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) { hash ^= ch.codePointAt(0) || 0; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function compact(value = '') { return clean(value).replace(/[\s、。・:：\-—|｜「」『』（）()]/g, '').toLowerCase(); }

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;

function descriptionLooksReal(title, description) {
  const text = clean(description);
  if (text.length < 70 || GENERIC_RE.test(text)) return false;
  const t = compact(title), d = compact(text);
  if (t.length >= 12 && d.length < 220 && (d === t || d.startsWith(t) || d.includes(t.slice(0, Math.min(36, t.length))))) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 55;
}

function cacheKey(item = {}) {
  const url = clean(item.url || item.link, 1800), title = clean(item.title, 500), mode = clean(item.mode, 48) || 'auto';
  const text = firstChars(item.text || item.description);
  return `${url || title}::${mode}::${fingerprint(`${title}\n${text}`)}`;
}
function putCache(key, summary) {
  if (!summary?.cacheable) return;
  memoryCache.delete(key); memoryCache.set(key, summary);
  while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
}

function contentErrorCode(error) {
  const msg = clean(error?.message || error, 240);
  const status = msg.match(/\((\d{3})\)/)?.[1];
  if (/timeout|タイムアウト/i.test(msg)) return 'RDR-CONTENT-TIMEOUT';
  if (/Googleニュース/i.test(msg)) return 'RDR-CONTENT-GNEWS';
  if (/PDF/i.test(msg)) return 'RDR-CONTENT-PDF';
  if (/本文を抽出できません/i.test(msg)) return 'RDR-CONTENT-EMPTY';
  if (status) return `RDR-CONTENT-HTTP${status}`;
  if (/名前解決|DNS/i.test(msg)) return 'RDR-CONTENT-DNS';
  if (/URL|プロトコル|公開アドレス|プライベートIP/i.test(msg)) return 'RDR-CONTENT-URL';
  return 'RDR-CONTENT-FETCH';
}

async function prepareItem(raw = {}) {
  const title = clean(raw.title, 500), description = clean(raw.description, 2400), url = clean(raw.url || raw.link, 2400);
  const base = { url, title, source: clean(raw.source, 160), category: clean(raw.category, 160), mode: clean(raw.mode, 48) || 'auto' };
  if (!title) return { ...base, text: '', preparedSource: 'missing', diagnostic: { code: 'RDR-CONTENT-NO-TITLE', stage: 'input', detail: 'title missing' } };
  if (descriptionLooksReal(title, description)) {
    const text = firstChars(description);
    return { ...base, text, preparedSource: 'rss', diagnostic: { code: 'RDR-OK-RSS', stage: 'prepare', source: 'rss', chars: Array.from(text).length } };
  }

  let articleError = null;
  if (url) {
    try {
      const article = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 1800 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('batch article timeout')), 4200))
      ]);
      const text = firstChars(article?.text || '');
      if (text.length >= 70 && !GENERIC_RE.test(text)) {
        const source = article?.sourceType === 'pdf' ? 'pdf' : 'article';
        return {
          ...base,
          title: clean(article?.title || title, 500) || title,
          text,
          preparedSource: source,
          diagnostic: {
            code: source === 'pdf' ? 'RDR-OK-PDF' : 'RDR-OK-ARTICLE', stage: 'prepare', source,
            chars: Array.from(text).length, method: clean(article?.extractionMethod || '', 60)
          }
        };
      }
      articleError = new Error(`article text too short (${Array.from(text).length})`);
    } catch (error) {
      articleError = error;
      console.warn('[summary-batch-v2190] article prepare failed', error?.message || error);
    }
  } else {
    articleError = new Error('article url missing');
  }

  const fallback = description.length >= 45 && !GENERIC_RE.test(description) ? firstChars(description) : '';
  if (fallback) {
    return {
      ...base, text: fallback, preparedSource: 'rss-short',
      diagnostic: { code: 'RDR-OK-RSS-SHORT', stage: 'prepare', source: 'rss-short', chars: Array.from(fallback).length, prior: contentErrorCode(articleError), detail: clean(articleError?.message || '', 180) }
    };
  }
  return {
    ...base, text: '', preparedSource: 'missing',
    diagnostic: { code: contentErrorCode(articleError) || 'RDR-CONTENT-NONE', stage: 'prepare', source: 'missing', chars: 0, detail: clean(articleError?.message || 'no usable article text', 180) }
  };
}

function modelList() { return [...new Set([PRIMARY_MODEL, 'gemini-3.5-flash-lite', FALLBACK_MODEL].filter(Boolean))]; }
function visibleText(data = {}) { return (data?.candidates?.[0]?.content?.parts || []).filter(part => part?.thought !== true).map(part => part?.text || '').join('').trim(); }
function normalizeSentence(value = '') { let text = clean(value, 220).replace(/^[・●\-–—\s]+/, '').trim(); if (text && !/[。！？!?]$/.test(text)) text += '。'; return text; }
function mostlyEnglish(value = '') { const text = String(value || ''); const latin = (text.match(/[A-Za-z]/g) || []).length; const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length; return latin >= 20 && latin > ja * 1.2; }

function buildSummary(row = {}, prepared = {}) {
  const lines = [row.conclusion, row.background, row.impact].map(normalizeSentence);
  if (lines.some(line => Array.from(line).length < 12)) return { summary: null, reason: 'too-short' };
  if (lines.some(mostlyEnglish)) return { summary: null, reason: 'not-japanese' };
  if (new Set(lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size !== 3) return { summary: null, reason: 'duplicate-lines' };
  return { summary: {
    headline: clean(row.headline, 100) || clean(prepared.title, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    short: lines[0], points: lines.slice(1), provider: 'gemini-batch-v2190', model: clean(row.model || '', 80),
    contentSource: prepared.preparedSource, cacheable: true, fastPath: 'summary-batch-v2190-10x1'
  }, reason: '' };
}

const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: { summaries: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { index: { type: 'integer' }, headline: { type: 'string' }, conclusion: { type: 'string' }, background: { type: 'string' }, impact: { type: 'string' } },
    required: ['index', 'headline', 'conclusion', 'background', 'impact'] } } }, required: ['summaries']
};

function promptFor(items) {
  const blocks = items.map(({ batchIndex, prepared }) => [
    `--- ARTICLE ${batchIndex} ---`, `タイトル: ${prepared.title || '不明'}`, prepared.source ? `媒体: ${prepared.source}` : '', prepared.category ? `カテゴリ: ${prepared.category}` : '', '記事冒頭:', prepared.text
  ].filter(Boolean).join('\n'));
  return [
    '以下の複数記事を、それぞれ独立に日本語で要約してください。', '各記事は与えられた本文だけを根拠にし、別の記事の情報を混ぜないでください。',
    'headlineは18〜42文字。conclusion/background/impactは各16〜80文字の1文で、必ず句点で完結させてください。',
    '推測、一般論、本文にない補完は禁止です。indexはARTICLE番号をそのまま返してください。', '', ...blocks
  ].join('\n');
}

function geminiDiagnostic(error) {
  const msg = clean(error?.message || error, 240), status = Number(error?.statusCode || 0);
  if (error?.name === 'AbortError' || /abort|timeout|タイムアウト/i.test(msg)) return { code: 'RDR-GEMINI-TIMEOUT', stage: 'gemini', status: status || 0, detail: msg };
  if (status === 429 || /429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) return { code: 'RDR-GEMINI-429', stage: 'gemini', status: 429, detail: msg };
  if (status === 401 || status === 403) return { code: `RDR-GEMINI-${status}`, stage: 'gemini', status, detail: msg };
  if (status === 400 || status === 404) return { code: `RDR-GEMINI-${status}`, stage: 'gemini', status, detail: msg };
  if (status >= 500) return { code: `RDR-GEMINI-${status}`, stage: 'gemini', status, detail: msg };
  if (/empty|空/i.test(msg)) return { code: 'RDR-GEMINI-EMPTY', stage: 'gemini', status: 0, detail: msg };
  if (/JSON|Unexpected token|parse/i.test(msg)) return { code: 'RDR-GEMINI-JSON', stage: 'gemini', status: 0, detail: msg };
  if (/GEMINI_API_KEY/i.test(msg)) return { code: 'RDR-GEMINI-NO-KEY', stage: 'gemini', status: 0, detail: msg };
  return { code: 'RDR-GEMINI-FAILED', stage: 'gemini', status: status || 0, detail: msg };
}

async function generateBatch(items) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません'), { diagnostic: { code: 'RDR-GEMINI-NO-KEY', stage: 'gemini' } });
  const prompt = promptFor(items); let lastError = null;
  for (const model of modelList()) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 14_000);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2200, thinkingConfig: { thinkingLevel: 'minimal' }, responseMimeType: 'application/json', responseJsonSchema: responseSchema } }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const e = new Error(data?.error?.message || `Gemini batch ${response.status}`); e.statusCode = response.status; throw e; }
      const raw = visibleText(data);
      if (!raw) throw new Error('Gemini batch response empty');
      let parsed;
      try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); }
      catch (error) { throw new Error(`Gemini batch JSON parse: ${error?.message || error}`); }
      return { rows: Array.isArray(parsed?.summaries) ? parsed.summaries : [], model };
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
  }
  if (lastError) lastError.diagnostic = geminiDiagnostic(lastError);
  throw lastError || new Error('Gemini batch failed');
}

export default async function summaryBatchV2190(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const raw = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const incoming = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
  if (!incoming.length) return res.status(200).json({ results: [], batch: 'v2190', generated: 0, cached: 0, diagnostic: { code: 'RDR-BATCH-NO-ITEMS', stage: 'input' } });

  const prepared = await Promise.all(incoming.map(prepareItem));
  const results = new Array(prepared.length).fill(null), missing = []; let cachedCount = 0;
  prepared.forEach((item, index) => {
    const key = cacheKey(item), hit = memoryCache.get(key);
    if (hit) {
      results[index] = { index, url: item.url, mode: item.mode, summary: { ...hit, cache: 'batch-memory-v2190' }, diagnostic: { code: 'RDR-OK-SERVER-CACHE', stage: 'cache', source: item.preparedSource, chars: Array.from(item.text).length } };
      cachedCount += 1; return;
    }
    if (item.text.length >= 40) missing.push({ batchIndex: index, prepared: item, key });
    else results[index] = { index, url: item.url, mode: item.mode, summary: null, preparedSource: item.preparedSource, diagnostic: item.diagnostic || { code: 'RDR-CONTENT-NONE', stage: 'prepare', chars: item.text.length } };
  });

  let generated = 0;
  if (missing.length) {
    try {
      const { rows, model } = await generateBatch(missing), byIndex = new Map(rows.map(row => [Number(row?.index), row]));
      for (const entry of missing) {
        const row = byIndex.get(entry.batchIndex);
        if (!row) {
          results[entry.batchIndex] = { index: entry.batchIndex, url: entry.prepared.url, mode: entry.prepared.mode, summary: null, preparedSource: entry.prepared.preparedSource,
            diagnostic: { code: 'RDR-GEMINI-MISSING-ROW', stage: 'gemini-validate', source: entry.prepared.preparedSource, chars: Array.from(entry.prepared.text).length, model } };
          continue;
        }
        const built = buildSummary({ ...row, model }, entry.prepared);
        if (!built.summary) {
          results[entry.batchIndex] = { index: entry.batchIndex, url: entry.prepared.url, mode: entry.prepared.mode, summary: null, preparedSource: entry.prepared.preparedSource,
            diagnostic: { code: 'RDR-GEMINI-INVALID-SUMMARY', stage: 'gemini-validate', source: entry.prepared.preparedSource, chars: Array.from(entry.prepared.text).length, model, detail: built.reason } };
          continue;
        }
        putCache(entry.key, built.summary);
        results[entry.batchIndex] = { index: entry.batchIndex, url: entry.prepared.url, mode: entry.prepared.mode, summary: built.summary,
          diagnostic: { code: 'RDR-OK-BATCH', stage: 'done', source: entry.prepared.preparedSource, chars: Array.from(entry.prepared.text).length, model } };
        generated += 1;
      }
    } catch (error) {
      const diagnostic = error?.diagnostic || geminiDiagnostic(error);
      console.warn('[summary-batch-v2190] generate failed', diagnostic, error?.message || error);
      for (const entry of missing) {
        if (results[entry.batchIndex]) continue;
        results[entry.batchIndex] = { index: entry.batchIndex, url: entry.prepared.url, mode: entry.prepared.mode, summary: null, preparedSource: entry.prepared.preparedSource,
          diagnostic: { ...diagnostic, source: entry.prepared.preparedSource, chars: Array.from(entry.prepared.text).length } };
      }
    }
  }

  prepared.forEach((item, index) => {
    if (results[index]) return;
    results[index] = { index, url: item.url, mode: item.mode, summary: null, preparedSource: item.preparedSource,
      diagnostic: item.diagnostic || { code: 'RDR-BATCH-UNKNOWN', stage: 'finalize', source: item.preparedSource, chars: Array.from(item.text).length } };
  });
  return res.status(200).json({ results, batch: 'v2190', generated, cached: cachedCount });
}
