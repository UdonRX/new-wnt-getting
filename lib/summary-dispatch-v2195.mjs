import summaryBatch from './summary-batch.mjs';

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_BATCH_ITEMS = 10;
const MICRO_BATCH_SIZE = 5;
const SINGLE_INPUT_LIMIT = 500;

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
      fallbackReason: reason
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
    fallbackReason: reason
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

async function generateStructuredSingle(body = {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  const text = firstChars(body.description);
  if (text.length < 40) return extractiveFallback(body, 'prepared-text-too-short');

  const prompt = singlePrompt({ ...body, description: text });
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean))];
  const errors = [];

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
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
      return buildSummaryObject(parsed, body, model);
    } catch (error) {
      errors.push(`${model}:${error?.statusCode || error?.name || ''}:${error?.message || error}`);
      if (error?.name === 'AbortError') break;
    } finally {
      clearTimeout(timer);
    }
  }

  return extractiveFallback(body, errors.at(-1) || 'structured-single-failed');
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

async function runChunkResilient(items = [], depth = 0) {
  if (!items.length) return [];
  if (items.length === 1) {
    const body = { ...items[0], description: firstChars(items[0]?.description), preparedSource: items[0]?.preparedSource || 'batch-single-fallback' };
    const summary = await generateStructuredSingle(body).catch(() => null);
    return [{ index: 0, url: items[0]?.url || '', mode: items[0]?.mode || '', summary: validSummary(summary) ? summary : null, preparedSource: body.preparedSource }];
  }

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
  if (!missing.length || depth >= 2) return normalized;

  const missingItems = missing.map(index => ({ originalIndex: index, item: items[index] }));
  const smallerSize = Math.max(1, Math.ceil(missingItems.length / 2));
  const groups = [];
  for (let i = 0; i < missingItems.length; i += smallerSize) groups.push(missingItems.slice(i, i + smallerSize));

  const recovered = await Promise.all(groups.map(async group => {
    const rows = await runChunkResilient(group.map(entry => entry.item), depth + 1);
    return rows.map((row, index) => ({ originalIndex: group[index].originalIndex, row }));
  }));

  for (const group of recovered) {
    for (const { originalIndex, row } of group) {
      if (validSummary(row?.summary)) normalized[originalIndex] = { ...normalized[originalIndex], ...row, index: originalIndex };
    }
  }
  return normalized;
}

export async function dispatchSummaryBatchItems(items = [], runner = runChunkResilient) {
  const chunks = splitSummaryBatchItems(items);
  const settled = await Promise.allSettled(chunks.map(chunk => runner(chunk.items)));
  const results = [];
  let failedChunks = 0;

  settled.forEach((result, chunkIndex) => {
    const chunk = chunks[chunkIndex];
    if (result.status !== 'fulfilled') {
      failedChunks += 1;
      chunk.items.forEach((item, localIndex) => results.push({
        index: chunk.offset + localIndex,
        url: item?.url || '',
        mode: item?.mode || '',
        summary: null,
        preparedSource: ''
      }));
      return;
    }
    const rows = Array.isArray(result.value) ? result.value : [];
    chunk.items.forEach((item, localIndex) => {
      const row = rows.find(entry => Number(entry?.index) === localIndex) || rows[localIndex] || {};
      results.push({
        index: chunk.offset + localIndex,
        url: row.url || item?.url || '',
        mode: row.mode || item?.mode || '',
        summary: validSummary(row.summary) ? row.summary : null,
        preparedSource: row.preparedSource || ''
      });
    });
  });

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
    batch: 'summary-batch-v2195-micro5',
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
  return res.status(200).json(summary);
}
