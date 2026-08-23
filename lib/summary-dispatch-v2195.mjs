import summaryBatch from './summary-batch.mjs';
import { waitForGeminiStartSlot } from './gemini.mjs';

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_BATCH_ITEMS = 10;
const MICRO_BATCH_SIZE = 5;
const SINGLE_INPUT_LIMIT = 500;
const SINGLE_MODEL_TIMEOUT_MS = 5000;

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

function firstChars(value = '', limit = SINGLE_INPUT_LIMIT) {
  return Array.from(clean(value, 5000)).slice(0, limit).join('');
}

function rawBody(req) {
  if (typeof req?.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req?.body || {};
}

function normalizeSentence(value = '') {
  let text = clean(value, 220).replace(/^[・●\-–—\s]+/, '').trim();
  if (!text) return '';
  if (!/[。！？!?]$/.test(text)) text += '。';
  return text;
}

function mostlyEnglish(value = '') {
  const text = String(value || '');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 20 && latin > ja * 1.2;
}

function validSummary(summary) {
  const lines = Array.isArray(summary?.lines) ? summary.lines.map(row => normalizeSentence(row?.text || '')) : [];
  if (lines.length !== 3 || lines.some(line => Array.from(line).length < 12)) return false;
  if (lines.some(mostlyEnglish)) return false;
  return new Set(lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size === 3;
}

function buildSummaryObject(row = {}, body = {}, model = '') {
  const lines = [row.conclusion, row.background, row.impact].map(normalizeSentence);
  if (lines.some(line => Array.from(line).length < 12)) throw new Error('AI要約が短すぎます');
  if (lines.some(mostlyEnglish)) throw new Error('AI要約が日本語になっていません');
  if (new Set(lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size !== 3) {
    throw new Error('AI要約が重複しています');
  }
  return {
    headline: clean(row.headline, 100) || clean(body.title, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    short: lines[0],
    points: lines.slice(1),
    provider: 'gemini-structured-v2195',
    model: clean(model, 80),
    contentSource: clean(body.preparedSource || body.contentSource || 'prepared', 80),
    cacheable: true,
    validated: true,
    fastPath: 'summary-v2195-structured-single'
  };
}

function actualSentences(value = '') {
  return clean(value, 1800)
    .match(/[^。！？!?]{10,}[。！？!?]/g)
    ?.map(normalizeSentence)
    .filter(Boolean) || [];
}

function extractiveFallback(body = {}, reason = 'fallback') {
  const unique = [];
  const seen = new Set();
  for (const row of actualSentences(body.description)) {
    const key = row.replace(/[\s。、，,.!！?？]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= 3) break;
  }
  if (unique.length < 3) {
    return {
      headline: clean(body.title, 100) || '記事のポイント',
      lines: [],
      short: '',
      points: [],
      provider: 'unavailable',
      model: '',
      contentSource: clean(body.preparedSource || 'missing', 80),
      cacheable: false,
      validated: false,
      fallbackReason: reason,
      prepareReason: clean(body.prepareReason || '', 120),
      prepareError: clean(body.prepareError || '', 160)
    };
  }
  return {
    headline: clean(body.title, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: unique[0] },
      { label: '背景/特徴', text: unique[1] },
      { label: '影響/展望', text: unique[2] }
    ],
    short: unique[0],
    points: unique.slice(1),
    provider: 'extractive-v2195',
    model: '',
    contentSource: clean(body.preparedSource || 'prepared', 80),
    cacheable: false,
    validated: true,
    fallbackReason: reason,
    prepareReason: clean(body.prepareReason || '', 120)
  };
}

const singleSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    conclusion: { type: 'string' },
    background: { type: 'string' },
    impact: { type: 'string' }
  },
  required: ['headline', 'conclusion', 'background', 'impact']
};

function singlePrompt(body = {}) {
  return [
    `タイトル: ${clean(body.title, 500) || '不明'}`,
    body.source ? `媒体: ${clean(body.source, 160)}` : '',
    body.category ? `カテゴリ: ${clean(body.category, 160)}` : '',
    `記事冒頭（最大${SINGLE_INPUT_LIMIT}文字）:`,
    firstChars(body.description),
    '',
    '上の文章だけを根拠に、日本語で要約してください。',
    'headlineは18〜42文字。conclusion/background/impactは各16〜80文字の1文で、必ず句点で完結させてください。',
    'conclusionは最重要の具体的事実、backgroundは背景・方法・特徴、impactは意味・影響・今後を記述してください。',
    '本文にない推測、一般論、補完は禁止です。'
  ].filter(Boolean).join('\n');
}

function visibleText(data = {}) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => part?.thought !== true)
    .map(part => part?.text || '')
    .join('')
    .trim();
}

function requestMeta(body = {}) {
  const articleId = clean(body.articleId, 600);
  const requestType = ['display', 'prefetch'].includes(String(body.requestType || ''))
    ? String(body.requestType)
    : 'display';
  const requestId = clean(body.requestId, 240)
    || `${clean(articleId || body.title || 'article', 80)}-${requestType}-${Date.now()}`;
  return { articleId, requestId, requestType };
}

function attachRequestMeta(summary = {}, meta = {}, attempts = []) {
  const lastAttempt = attempts.at(-1) || {};
  return {
    ...summary,
    articleId: meta.articleId,
    requestId: meta.requestId,
    requestType: meta.requestType,
    upstreamStatus: Number(lastAttempt.status || 0) || 0,
    geminiAttempts: attempts.map(row => ({
      model: clean(row.model, 80),
      status: Number(row.status || 0) || 0,
      ok: Boolean(row.ok),
      elapsedMs: Number(row.elapsedMs || 0) || 0,
      errorName: clean(row.errorName, 80),
      errorMessage: clean(row.errorMessage, 260)
    }))
  };
}

export async function generateStructuredSingle(body = {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  const meta = requestMeta(body);
  const text = firstChars(body.description);
  if (text.length < 40) return attachRequestMeta(extractiveFallback(body, 'prepared-text-too-short'), meta, []);

  const prompt = singlePrompt({ ...body, description: text });
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean))];
  const errors = [];
  const attempts = [];

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    await waitForGeminiStartSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SINGLE_MODEL_TIMEOUT_MS);
    const startedAt = Date.now();
    console.info('[GEMINI START]', {
      requestId: meta.requestId,
      articleId: meta.articleId,
      requestType: meta.requestType,
      model,
      startTime: new Date(startedAt).toISOString()
    });
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 420,
            thinkingConfig: { thinkingLevel: 'minimal' },
            responseMimeType: 'application/json',
            responseJsonSchema: singleSchema
          }
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.error?.message || `Gemini single ${response.status}`);
        error.statusCode = response.status;
        throw error;
      }
      const raw = visibleText(data);
      if (!raw) throw new Error('Gemini single response empty');
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
      const summary = buildSummaryObject(parsed, body, model);
      const elapsedMs = Date.now() - startedAt;
      attempts.push({ model, status: response.status, ok: true, elapsedMs });
      console.info('[GEMINI SUCCESS]', {
        requestId: meta.requestId,
        articleId: meta.articleId,
        requestType: meta.requestType,
        model,
        status: response.status,
        elapsedMs,
        response: {
          candidateCount: Array.isArray(data?.candidates) ? data.candidates.length : 0,
          textChars: Array.from(raw).length
        }
      });
      return attachRequestMeta(summary, meta, attempts);
    } catch (error) {
      const status = Number(error?.statusCode || 0) || 0;
      const elapsedMs = Date.now() - startedAt;
      const errorName = String(error?.name || 'Error');
      const errorMessage = String(error?.message || error);
      errors.push(`${model}:${status || errorName}:${errorMessage}`);
      attempts.push({ model, status, ok: false, elapsedMs, errorName, errorMessage });
      console.warn('[GEMINI ERROR]', {
        requestId: meta.requestId,
        articleId: meta.articleId,
        requestType: meta.requestType,
        model,
        status,
        elapsedMs,
        errorName,
        errorMessage: errorMessage.slice(0, 500)
      });
      // The next model attempt passes through the shared Gemini start scheduler.
      // Do not fire an immediate 220ms retry after 429/5xx/timeout.
    } finally {
      clearTimeout(timer);
      console.info('[GEMINI FINALLY]', {
        requestId: meta.requestId,
        articleId: meta.articleId,
        requestType: meta.requestType,
        model,
        finishTime: new Date().toISOString()
      });
    }
  }

  return attachRequestMeta(
    extractiveFallback(body, errors.at(-1) || 'structured-single-failed'),
    meta,
    attempts
  );
}

function captureResponse() {
  let payload = null;
  let statusCode = 200;
  const headers = new Map();
  const res = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); return this; },
    status(code) { statusCode = Number(code) || 200; return this; },
    json(value) { payload = value; return value; },
    send(value) { payload = value; return value; },
    end(value) { if (value !== undefined) payload = value; return value; }
  };
  return { res, read: () => ({ payload, statusCode, headers }) };
}

async function callLegacyBatch(items = []) {
  const capture = captureResponse();
  await summaryBatch({ method: 'POST', body: { items } }, capture.res);
  return capture.read();
}

export function splitSummaryBatchItems(items = [], size = MICRO_BATCH_SIZE) {
  const rows = Array.isArray(items) ? items.slice(0, MAX_BATCH_ITEMS) : [];
  const chunkSize = Math.max(1, Math.min(MICRO_BATCH_SIZE, Number(size) || MICRO_BATCH_SIZE));
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    chunks.push({ offset, items: rows.slice(offset, offset + chunkSize) });
  }
  return chunks;
}

async function runChunkResilient(items = []) {
  if (!items.length) return [];

  const { payload, statusCode } = await callLegacyBatch(items);
  const baseResults = statusCode >= 200 && statusCode < 300 && Array.isArray(payload?.results)
    ? payload.results
    : [];
  const normalized = items.map((item, index) => {
    const row = baseResults.find(entry => Number(entry?.index) === index) || baseResults[index];
    return {
      index,
      url: item?.url || '',
      mode: item?.mode || '',
      summary: validSummary(row?.summary) ? row.summary : null,
      preparedSource: row?.preparedSource || ''
    };
  });

  const missing = normalized.filter(row => !row.summary).map(row => row.index);
  if (!missing.length || items.length === 1) return normalized;

  const midpoint = Math.max(1, Math.ceil(missing.length / 2));
  const groups = [missing.slice(0, midpoint), missing.slice(midpoint)].filter(group => group.length);

  for (const group of groups) {
    const rows = await runChunkResilient(group.map(index => items[index]));
    rows.forEach((row, localIndex) => {
      const originalIndex = group[localIndex];
      if (validSummary(row?.summary)) {
        normalized[originalIndex] = { ...normalized[originalIndex], ...row, index: originalIndex };
      }
    });
  }
  return normalized;
}

export async function dispatchSummaryBatchItems(items = [], runner = runChunkResilient) {
  const chunks = splitSummaryBatchItems(items);
  const results = [];
  let failedChunks = 0;

  for (const chunk of chunks) {
    try {
      const rows = await runner(chunk.items);
      chunk.items.forEach((item, localIndex) => {
        const row = (Array.isArray(rows) ? rows : []).find(entry => Number(entry?.index) === localIndex)
          || rows?.[localIndex]
          || {};
        results.push({
          index: chunk.offset + localIndex,
          url: row.url || item?.url || '',
          mode: row.mode || item?.mode || '',
          summary: validSummary(row.summary) ? row.summary : null,
          preparedSource: row.preparedSource || ''
        });
      });
    } catch {
      failedChunks += 1;
      chunk.items.forEach((item, localIndex) => results.push({
        index: chunk.offset + localIndex,
        url: item?.url || '',
        mode: item?.mode || '',
        summary: null,
        preparedSource: ''
      }));
    }
  }

  results.sort((a, b) => a.index - b.index);
  return { results, chunks: chunks.length, failedChunks };
}

export async function summaryBatchV2195(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const raw = rawBody(req);
  const incoming = Array.isArray(raw.items) ? raw.items.slice(0, MAX_BATCH_ITEMS) : [];
  if (!incoming.length) return res.status(200).json({ results: [], batch: 'summary-batch-v2195', generated: 0, cached: 0, chunks: 0, failedChunks: 0 });

  const startedAt = Date.now();
  const dispatched = await dispatchSummaryBatchItems(incoming);
  const generated = dispatched.results.filter(row => validSummary(row.summary)).length;
  const failed = dispatched.results.length - generated;
  res.setHeader('X-Summary-Route', 'micro-batch-v2195');
  res.setHeader('X-Summary-Batch-Chunks', String(dispatched.chunks));
  res.setHeader('X-Summary-Batch-Failed', String(failed));
  res.setHeader('X-Summary-Elapsed-Ms', String(Date.now() - startedAt));
  return res.status(200).json({
    results: dispatched.results,
    batch: 'summary-batch-v2195-micro5-sequential',
    generated,
    cached: 0,
    chunks: dispatched.chunks,
    failedChunks: dispatched.failedChunks,
    failed
  });
}

export async function summarySingleV2195(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const startedAt = Date.now();
  const body = rawBody(req);
  const summary = await generateStructuredSingle(body);
  res.setHeader('X-Summary-Route', 'structured-single-v2195');
  res.setHeader('X-Summary-Elapsed-Ms', String(Date.now() - startedAt));
  res.setHeader('X-Summary-Model', String(summary?.model || ''));
  res.setHeader('X-Summary-Content-Source', String(summary?.contentSource || body?.preparedSource || ''));
  res.setHeader('X-Summary-Fallback-Reason', String(summary?.fallbackReason || ''));
  res.setHeader('X-Summary-Validated', String(Boolean(summary?.validated)));
  res.setHeader('X-Summary-Request-Id', String(summary?.requestId || body?.requestId || ''));
  res.setHeader('X-Summary-Article-Id', String(summary?.articleId || body?.articleId || ''));
  res.setHeader('X-Summary-Request-Type', String(summary?.requestType || body?.requestType || ''));
  res.setHeader('X-Summary-Upstream-Status', String(summary?.upstreamStatus || 0));
  return res.status(200).json(summary);
}
