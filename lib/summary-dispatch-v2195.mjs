import summaryBatch from './summary-batch.mjs';
import { waitForGeminiStartSlot } from './gemini.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_BATCH_ITEMS = 10;
const MICRO_BATCH_SIZE = 5;
const SINGLE_INPUT_LIMIT = 500;
const FAST_SINGLE_INPUT_LIMIT = 380;
const SINGLE_MODEL_TIMEOUT_MS = 5000;
const FAST_SINGLE_MODEL_TIMEOUT_MS = 2800;
const SINGLE_OUTPUT_TOKEN_LIMIT = 420;
const FAST_SINGLE_OUTPUT_TOKEN_LIMIT = 220;
const SUMMARY_MIN_CHARS = 12;
const FAST_SUMMARY_TARGET_MAX_CHARS = 55;
const SUMMARY_HARD_MAX_CHARS = 90;

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
  if (!/[。！？.!?]$/.test(text)) text += '。';
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
  if (lines.length !== 3 || lines.some(line => sentenceContentLength(line) < SUMMARY_MIN_CHARS)) return false;
  if (lines.some(mostlyEnglish)) return false;
  return new Set(lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size === 3;
}

function sentenceContentLength(value = '') {
  return Array.from(String(value || '').replace(/[。！？.!?]+$/, '')).length;
}

function repairableError(message, failureStage = 'validation', details = {}) {
  const error = new Error(message);
  error.name = failureStage === 'parse' ? 'SummaryParseError' : 'SummaryValidationError';
  error.repairable = true;
  error.failureStage = failureStage;
  Object.assign(error, details);
  return error;
}

function naturalBoundaryIndex(prefix = '', minIndex = 0) {
  const strongMarks = ['。', '！', '？', '!', '?'];
  const softMarks = ['、', '，', ',', '；', ';', '：', ':'];
  const strong = Math.max(...strongMarks.map(mark => prefix.lastIndexOf(mark)));
  if (strong >= minIndex) return strong;
  const soft = Math.max(...softMarks.map(mark => prefix.lastIndexOf(mark)));
  if (soft >= minIndex) return soft;
  const space = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('　'));
  return space >= minIndex ? space : -1;
}

function compactSentenceNaturally(value = '', { targetMax = FAST_SUMMARY_TARGET_MAX_CHARS, hardMax = SUMMARY_HARD_MAX_CHARS } = {}) {
  const normalized = normalizeSentence(value);
  if (!normalized) return '';
  const terminal = normalized.match(/[。！？.!?]+$/)?.[0] || '。';
  const content = normalized.replace(/[。！？.!?]+$/, '').trim();
  const chars = Array.from(content);
  if (chars.length <= targetMax) return normalized;

  const targetPrefix = chars.slice(0, targetMax).join('');
  const targetBoundary = naturalBoundaryIndex(targetPrefix, Math.max(SUMMARY_MIN_CHARS, Math.floor(targetMax * 0.52)));
  if (targetBoundary >= 0) {
    const clipped = targetPrefix.slice(0, targetBoundary + 1).replace(/[、，,；;：:\s]+$/g, '').trim();
    if (Array.from(clipped).length >= SUMMARY_MIN_CHARS) return normalizeSentence(clipped);
  }

  // 56〜90文字は生成目標を少し超えていても捨てない。
  if (chars.length <= hardMax) return normalized;

  const hardPrefix = chars.slice(0, hardMax).join('');
  const hardBoundary = naturalBoundaryIndex(hardPrefix, Math.max(SUMMARY_MIN_CHARS, Math.floor(hardMax * 0.55)));
  if (hardBoundary >= 0) {
    const clipped = hardPrefix.slice(0, hardBoundary + 1).replace(/[、，,；;：:\s]+$/g, '').trim();
    if (Array.from(clipped).length >= SUMMARY_MIN_CHARS) return normalizeSentence(clipped);
  }

  // 最後の保険。90文字超だけを上限内へ収め、通常の56文字程度は切らない。
  const clipped = chars.slice(0, Math.max(SUMMARY_MIN_CHARS, hardMax - 1)).join('').trim();
  return `${clipped.replace(/[。！？.!?]+$/g, '')}${/[.!?]$/.test(terminal) ? terminal : '。'}`;
}

function buildSummaryObject(row = {}, body = {}, model = '', { fastRequest = false } = {}) {
  const sourceLines = fastRequest
    ? [row.c, row.b, row.i]
    : [row.conclusion, row.background, row.impact];
  const normalized = sourceLines.map(normalizeSentence);
  const originalLengths = normalized.map(sentenceContentLength);

  if (normalized.some((line, index) => !line || originalLengths[index] < SUMMARY_MIN_CHARS)) {
    throw repairableError('AI要約の必須項目が不足または短すぎます', 'validation', { lineLengths: originalLengths });
  }
  if (normalized.some(mostlyEnglish)) {
    throw repairableError('AI要約が日本語になっていません', 'validation', { lineLengths: originalLengths });
  }
  if (new Set(normalized.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size !== 3) {
    throw repairableError('AI要約が重複しています', 'validation', { lineLengths: originalLengths });
  }

  const lines = normalized.map(line => compactSentenceNaturally(line, {
    targetMax: fastRequest ? FAST_SUMMARY_TARGET_MAX_CHARS : 80,
    hardMax: SUMMARY_HARD_MAX_CHARS
  }));
  const lineLengths = lines.map(sentenceContentLength);

  return {
    headline: clean(fastRequest ? row.h : row.headline, 100) || clean(body.title, 100) || '記事のポイント',
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
    fastPath: 'summary-v2195-structured-single',
    lineLengths
  };
}

function actualSentences(value = '') {
  return clean(value, 1800)
    .match(/[^。！？.!?]{10,}[。！？.!?]/g)
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
    unique.push(compactSentenceNaturally(row, { targetMax: 80, hardMax: SUMMARY_HARD_MAX_CHARS }));
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
    prepareReason: clean(body.prepareReason || '', 120),
    lineLengths: unique.map(sentenceContentLength)
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

const fastSingleSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    h: { type: 'string' },
    c: { type: 'string' },
    b: { type: 'string' },
    i: { type: 'string' }
  },
  required: ['h', 'c', 'b', 'i']
};

function singlePrompt(body = {}, { fastRequest = false, inputLimit = SINGLE_INPUT_LIMIT } = {}) {
  return [
    `タイトル: ${clean(body.title, 500) || '不明'}`,
    body.source ? `媒体: ${clean(body.source, 160)}` : '',
    body.category ? `カテゴリ: ${clean(body.category, 160)}` : '',
    `記事冒頭（最大${inputLimit}文字）:`,
    firstChars(body.description, inputLimit),
    '',
    '上の文章だけを根拠に、日本語で要約してください。',
    fastRequest
      ? 'hは16〜32文字。c/b/iは各20〜55文字を目標に1文で、必ず句点で完結させてください。'
      : 'headlineは18〜42文字。conclusion/background/impactは各16〜80文字の1文で、必ず句点で完結させてください。',
    fastRequest
      ? 'cは最重要の具体的事実、bは背景・方法・特徴、iは意味・影響・今後を記述してください。'
      : 'conclusionは最重要の具体的事実、backgroundは背景・方法・特徴、impactは意味・影響・今後を記述してください。',
    '本文にない推測、一般論、補完は禁止です。'
  ].filter(Boolean).join('\n');
}

function repairPrompt(basePrompt = '', reason = '', { fastRequest = false } = {}) {
  return [
    basePrompt,
    '',
    '前回の出力は形式または品質チェックで不採用になりました。1回だけ作り直してください。',
    `不採用理由: ${clean(reason, 180) || '出力形式不正'}`,
    fastRequest
      ? '必ずJSONの h / c / b / i をすべて埋め、c/b/iは互いに重複しない自然な日本語1文にしてください。20〜55文字は目標であり、情報を欠落させるための無理な短縮は不要です。'
      : '必ずJSONの headline / conclusion / background / impact をすべて埋め、3項目は互いに重複しない自然な日本語1文にしてください。',
    'Markdownや説明文は付けず、指定JSONだけを返してください。'
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

function summaryLineLengths(summary = {}) {
  if (Array.isArray(summary?.lineLengths) && summary.lineLengths.length === 3) return summary.lineLengths.map(Number);
  return (Array.isArray(summary?.lines) ? summary.lines : []).map(row => sentenceContentLength(row?.text || ''));
}

function attachRequestMeta(summary = {}, meta = {}, attempts = [], body = {}, failureStage = 'none') {
  const lastAttempt = attempts.at(-1) || {};
  const queueWaitMs = attempts.reduce((sum, row) => sum + (Number(row.queueWaitMs) || 0), 0);
  const geminiMs = attempts.reduce((sum, row) => sum + (Number(row.elapsedMs) || 0), 0);
  const lineLengths = summaryLineLengths(summary);
  return {
    ...summary,
    articleId: meta.articleId,
    requestId: meta.requestId,
    requestType: meta.requestType,
    upstreamStatus: Number(lastAttempt.status || 0) || 0,
    queueWaitMs,
    articlePrepareMs: Number(body.articlePrepareMs || 0) || 0,
    geminiMs,
    preparedSource: clean(body.preparedSource || summary?.contentSource || 'missing', 80),
    preparedChars: Number(body.preparedChars || Array.from(clean(body.description || '')).length) || 0,
    lineLengths,
    failureStage: clean(failureStage || 'none', 80),
    repaired: attempts.some(row => row.repair === true && row.ok === true),
    geminiAttempts: attempts.map(row => ({
      model: clean(row.model, 80),
      status: Number(row.status || 0) || 0,
      ok: Boolean(row.ok),
      elapsedMs: Number(row.elapsedMs || 0) || 0,
      queueWaitMs: Number(row.queueWaitMs || 0) || 0,
      repair: Boolean(row.repair),
      failureStage: clean(row.failureStage || '', 80),
      errorName: clean(row.errorName, 80),
      errorMessage: clean(row.errorMessage, 260)
    }))
  };
}

function parseStructuredPayload(raw = '') {
  try {
    return JSON.parse(String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  } catch (error) {
    throw repairableError(`Gemini JSONを解析できません: ${error?.message || error}`, 'parse');
  }
}

export async function generateStructuredSingle(body = {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  const meta = requestMeta(body);
  const fastRequest = body.fast === true || String(body.fast || '').toLowerCase() === 'true';
  const inputLimit = fastRequest ? FAST_SINGLE_INPUT_LIMIT : SINGLE_INPUT_LIMIT;
  const text = firstChars(body.description, inputLimit);
  if (text.length < 40) {
    return attachRequestMeta(extractiveFallback(body, 'prepared-text-too-short'), meta, [], body, 'prepare');
  }

  const prompt = singlePrompt({ ...body, description: text }, { fastRequest, inputLimit });
  const models = [...new Set((fastRequest ? [PRIMARY_MODEL] : [PRIMARY_MODEL, FALLBACK_MODEL]).filter(Boolean))];
  const modelTimeoutMs = fastRequest ? FAST_SINGLE_MODEL_TIMEOUT_MS : SINGLE_MODEL_TIMEOUT_MS;
  const errors = [];
  const attempts = [];
  let repairUsed = false;
  let lastFailureStage = 'gemini';

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    let repairReason = '';

    for (let pass = 0; pass < 2; pass += 1) {
      const isRepair = pass === 1;
      if (isRepair && (!repairReason || repairUsed)) break;
      if (isRepair) repairUsed = true;

      const slot = await waitForGeminiStartSlot({ requestType: meta.requestType, requestId: meta.requestId });
      const queueWaitMs = Number(slot?.queueWaitMs || 0) || 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), modelTimeoutMs);
      const startedAt = Date.now();
      let upstreamStatus = 0;
      const activePrompt = isRepair ? repairPrompt(prompt, repairReason, { fastRequest }) : prompt;

      console.info('[GEMINI START]', {
        requestId: meta.requestId,
        articleId: meta.articleId,
        requestType: meta.requestType,
        model,
        repair: isRepair,
        queueWaitMs,
        startGapMs: Number(slot?.startGapMs || 0) || 0,
        startTime: new Date(startedAt).toISOString()
      });

      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: activePrompt }] }],
            generationConfig: {
              maxOutputTokens: fastRequest ? FAST_SINGLE_OUTPUT_TOKEN_LIMIT : SINGLE_OUTPUT_TOKEN_LIMIT,
              thinkingConfig: { thinkingLevel: 'minimal' },
              responseMimeType: 'application/json',
              responseJsonSchema: fastRequest ? fastSingleSchema : singleSchema
            }
          }),
          signal: controller.signal
        });
        upstreamStatus = response.status;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data?.error?.message || `Gemini single ${response.status}`);
          error.statusCode = response.status;
          error.failureStage = 'gemini-api';
          throw error;
        }
        const raw = visibleText(data);
        if (!raw) throw repairableError('Gemini single response empty', 'response');
        const parsed = parseStructuredPayload(raw);
        const summary = buildSummaryObject(parsed, body, model, { fastRequest });
        const elapsedMs = Date.now() - startedAt;
        attempts.push({ model, status: response.status, ok: true, elapsedMs, queueWaitMs, repair: isRepair, failureStage: 'none' });
        console.info('[GEMINI SUCCESS]', {
          requestId: meta.requestId,
          articleId: meta.articleId,
          requestType: meta.requestType,
          model,
          repair: isRepair,
          status: response.status,
          queueWaitMs,
          elapsedMs,
          lineLengths: summary.lineLengths,
          response: {
            candidateCount: Array.isArray(data?.candidates) ? data.candidates.length : 0,
            textChars: Array.from(raw).length
          }
        });
        return attachRequestMeta(summary, meta, attempts, body, 'none');
      } catch (error) {
        const status = Number(error?.statusCode || upstreamStatus || 0) || 0;
        const elapsedMs = Date.now() - startedAt;
        const errorName = String(error?.name || 'Error');
        const errorMessage = String(error?.message || error);
        const failureStage = clean(error?.failureStage || (error?.name === 'AbortError' ? 'gemini-timeout' : 'gemini'), 80);
        lastFailureStage = failureStage || 'gemini';
        errors.push(`${model}:${status || errorName}:${errorMessage}`);
        attempts.push({
          model,
          status,
          ok: false,
          elapsedMs,
          queueWaitMs,
          repair: isRepair,
          failureStage,
          errorName,
          errorMessage
        });
        console.warn('[GEMINI ERROR]', {
          requestId: meta.requestId,
          articleId: meta.articleId,
          requestType: meta.requestType,
          model,
          repair: isRepair,
          status,
          queueWaitMs,
          elapsedMs,
          failureStage,
          lineLengths: Array.isArray(error?.lineLengths) ? error.lineLengths : [],
          errorName,
          errorMessage: errorMessage.slice(0, 500)
        });

        if (error?.repairable === true && !repairUsed && !isRepair) {
          repairReason = errorMessage;
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
        console.info('[GEMINI FINALLY]', {
          requestId: meta.requestId,
          articleId: meta.articleId,
          requestType: meta.requestType,
          model,
          repair: isRepair,
          finishTime: new Date().toISOString()
        });
      }
    }
  }

  return attachRequestMeta(
    extractiveFallback(body, errors.at(-1) || 'structured-single-failed'),
    meta,
    attempts,
    body,
    lastFailureStage || 'gemini'
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
  res.setHeader('X-Summary-Queue-Wait-Ms', String(summary?.queueWaitMs || 0));
  res.setHeader('X-Summary-Article-Prepare-Ms', String(summary?.articlePrepareMs || 0));
  res.setHeader('X-Summary-Gemini-Ms', String(summary?.geminiMs || 0));
  res.setHeader('X-Summary-Prepared-Chars', String(summary?.preparedChars || 0));
  res.setHeader('X-Summary-Line-Lengths', Array.isArray(summary?.lineLengths) ? summary.lineLengths.join(',') : '');
  setAsciiHeader(res, 'X-Summary-Model', summary?.model || '');
  setAsciiHeader(res, 'X-Summary-Content-Source', summary?.contentSource || body?.preparedSource || '');
  setAsciiHeader(res, 'X-Summary-Prepared-Source', summary?.preparedSource || body?.preparedSource || '');
  setAsciiHeader(res, 'X-Summary-Fallback-Reason', summary?.fallbackReason || '');
  setAsciiHeader(res, 'X-Summary-Failure-Stage', summary?.failureStage || 'none');
  res.setHeader('X-Summary-Validated', String(Boolean(summary?.validated)));
  setAsciiHeader(res, 'X-Summary-Request-Id', summary?.requestId || body?.requestId || '');
  setAsciiHeader(res, 'X-Summary-Article-Id', summary?.articleId || body?.articleId || '');
  setAsciiHeader(res, 'X-Summary-Request-Type', summary?.requestType || body?.requestType || '');
  res.setHeader('X-Summary-Upstream-Status', String(summary?.upstreamStatus || 0));

  console.info('[SUMMARY DIAG]', {
    requestId: summary?.requestId || body?.requestId || '',
    articleId: summary?.articleId || body?.articleId || '',
    requestType: summary?.requestType || body?.requestType || 'display',
    provider: summary?.provider || '',
    model: summary?.model || '',
    queueWaitMs: Number(summary?.queueWaitMs || 0),
    articlePrepareMs: Number(summary?.articlePrepareMs || 0),
    geminiMs: Number(summary?.geminiMs || 0),
    preparedSource: summary?.preparedSource || body?.preparedSource || 'missing',
    preparedChars: Number(summary?.preparedChars || 0),
    lineLengths: Array.isArray(summary?.lineLengths) ? summary.lineLengths : [],
    failureStage: summary?.failureStage || 'none',
    repaired: Boolean(summary?.repaired),
    fallbackReason: summary?.fallbackReason || '',
    prepareError: body?.prepareError || ''
  });

  return res.status(200).json(summary);
}
