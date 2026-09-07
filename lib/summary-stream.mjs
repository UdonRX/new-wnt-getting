import { extractArticleFromUrl } from './article-reader.mjs';

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const INPUT_CHAR_LIMIT = 500;
const CACHE_LIMIT = 240;
const memoryCache = new Map();
const inFlight = new Map();
let startTail = Promise.resolve();
let lastStartAt = 0;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value = '', max = 5000) {
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

function firstChars(value = '', limit = INPUT_CHAR_LIMIT) {
  return Array.from(clean(value, 4000)).slice(0, limit).join('');
}

function cacheKey(body = {}) {
  const url = clean(body.url || body.link, 1800);
  const title = clean(body.title, 500);
  const mode = clean(body.mode, 32) || 'auto';
  return `${url || title}::${mode}::v2184`;
}

function cachePut(key, value) {
  memoryCache.delete(key);
  memoryCache.set(key, value);
  while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function reserveStartSlot() {
  const run = startTail.then(async () => {
    const wait = Math.max(0, 420 - (Date.now() - lastStartAt));
    if (wait) await sleep(wait);
    lastStartAt = Date.now();
  });
  startTail = run.catch(() => {});
  await run;
}

async function resolveInput(body) {
  const title = clean(body.title, 500);
  const description = clean(body.description, 1800);
  if (description.length >= 60) {
    return { title, text: firstChars(description), contentSource: 'rss' };
  }

  const url = clean(body.url || body.link, 2400);
  if (url) {
    try {
      const extracted = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 1800 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('article-fast-timeout')), 3200))
      ]);
      const text = firstChars(extracted?.text || description || title);
      if (text.length >= 40) {
        return {
          title: clean(extracted?.title || title, 500) || title,
          text,
          contentSource: extracted?.sourceType === 'pdf' ? 'pdf' : 'article'
        };
      }
    } catch {}
  }

  return { title, text: firstChars(description || title), contentSource: description ? 'rss' : 'title' };
}

function promptFor({ title, text, source, category }) {
  return [
    `タイトル: ${title || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    `記事冒頭（最大${INPUT_CHAR_LIMIT}文字）:`,
    text || title || '情報なし',
    '',
    '上の文章だけを根拠に、日本語で要約してください。',
    '必ず次の4行だけを出力してください。ラベル名・記号は変えないでください。',
    'タイトル: 18〜42文字の自然な日本語タイトル',
    '結論/事実: 16〜80文字で最重要の具体的事実を1文',
    '背景/特徴: 16〜80文字で背景・特徴・方法を1文',
    '影響/展望: 16〜80文字で意味・影響・今後を1文',
    '3文は内容を重複させず、すべて句点で完結させる。',
    '本文にない推測、一般論、前置き、Markdown、箇条書き記号は禁止。'
  ].filter(Boolean).join('\n');
}

function modelList() {
  return [...new Set([PRIMARY_MODEL, 'gemini-3.5-flash-lite', FALLBACK_MODEL].filter(Boolean))];
}

function apiError(status, data = {}) {
  const error = new Error(data?.error?.message || `Gemini API ${status}`);
  error.statusCode = status;
  error.apiData = data;
  return error;
}

function visibleTextFromCandidate(data = {}) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter(part => part?.thought !== true).map(part => part?.text || '').join('');
}

function parseTagged(text, fallbackTitle = '') {
  const source = String(text || '').replace(/\r/g, '').trim();
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const values = {};
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const startMatch = new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'm').exec(source);
    if (!startMatch) continue;
    const start = startMatch.index + startMatch[0].length;
    let end = source.length;
    for (let j = i + 1; j < labels.length; j += 1) {
      const next = new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`, 'm').exec(source.slice(start));
      if (next) { end = start + next.index; break; }
    }
    values[label] = clean(source.slice(start, end), 260);
  }
  return buildSummaryObject({
    headline: values['タイトル'] || fallbackTitle,
    conclusion: values['結論/事実'],
    background: values['背景/特徴'],
    impact: values['影響/展望']
  });
}

function normalizeSentence(value = '') {
  let text = clean(value, 220).replace(/^[・●\-–—\s]+/, '').trim();
  if (!text) return '';
  if (!/[。！？!?]$/.test(text)) text += '。';
  return text;
}

function looksMostlyEnglish(value = '') {
  const text = String(value || '');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 20 && latin > ja * 1.2;
}

function buildSummaryObject({ headline, conclusion, background, impact }) {
  const lines = [conclusion, background, impact].map(normalizeSentence);
  if (lines.some(line => Array.from(line).length < 12)) throw new Error('AI要約が短すぎます');
  if (new Set(lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size !== 3) throw new Error('AI要約が重複しています');
  if (lines.some(looksMostlyEnglish)) throw new Error('AI要約が日本語になっていません');
  return {
    headline: clean(headline, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    short: lines[0],
    points: lines.slice(1)
  };
}

function streamEventBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\n+/);
  return { blocks: blocks.slice(0, -1), tail: blocks.at(-1) || '' };
}

function parseSseBlock(block) {
  const rows = String(block || '').split('\n').filter(row => row.startsWith('data:'));
  const out = [];
  for (const row of rows) {
    const raw = row.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try { out.push(JSON.parse(raw)); } catch {}
  }
  return out;
}

async function streamModel(model, prompt, onDelta = () => {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません'), { statusCode: 500 });
  await reserveStartSlot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_500);
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 300,
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const data = await response.json().catch(() => ({}));
    throw apiError(response.status, data);
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new Error('Geminiストリームを開始できませんでした');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = streamEventBlocks(buffer);
      buffer = split.tail;
      for (const block of split.blocks) {
        for (const data of parseSseBlock(block)) {
          const delta = visibleTextFromCandidate(data);
          if (!delta) continue;
          result += delta;
          onDelta(delta);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const data of parseSseBlock(buffer)) {
        const delta = visibleTextFromCandidate(data);
        if (!delta) continue;
        result += delta;
        onDelta(delta);
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch {}
  }
  if (!result.trim()) throw new Error('Geminiのストリーム応答が空でした');
  return result.trim();
}

const responseSchema = {
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

async function structuredModel(model, prompt) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません'), { statusCode: 500 });
  await reserveStartSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_500);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 320,
          thinkingConfig: { thinkingLevel: 'minimal' },
          responseMimeType: 'application/json',
          responseJsonSchema: responseSchema
        }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError(response.status, data);
    const raw = visibleTextFromCandidate(data).trim();
    if (!raw) throw new Error('GeminiのJSON応答が空でした');
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
    return buildSummaryObject(parsed);
  } finally {
    clearTimeout(timer);
  }
}

function actualSentences(text = '') {
  return clean(text, 1800)
    .match(/[^。！？!?]{10,}[。！？!?]/g)?.map(row => normalizeSentence(row)).filter(Boolean) || [];
}

function extractiveFallback(input, body, reason = 'fallback') {
  const rows = actualSentences(input.text);
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    const key = row.replace(/[\s。、，,.!！?？]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= 3) break;
  }
  if (unique.length < 3) {
    return {
      headline: clean(input.title || body.title, 100) || '記事のポイント',
      lines: [], short: '', points: [], provider: 'unavailable', model: '',
      contentSource: input.contentSource, cacheable: false, fallbackReason: reason
    };
  }
  return {
    headline: clean(input.title || body.title, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: unique[0] },
      { label: '背景/特徴', text: unique[1] },
      { label: '影響/展望', text: unique[2] }
    ],
    short: unique[0], points: unique.slice(1), provider: 'extractive-v2184', model: '',
    contentSource: input.contentSource, cacheable: false, fallbackReason: reason
  };
}

async function buildSummary(body, onDelta = () => {}) {
  const input = await resolveInput(body);
  const prompt = promptFor({
    title: input.title || clean(body.title, 500),
    text: firstChars(input.text),
    source: clean(body.source, 120),
    category: clean(body.category, 120)
  });

  const errors = [];
  for (const model of modelList()) {
    try {
      const raw = await streamModel(model, prompt, onDelta);
      const summary = parseTagged(raw, input.title || body.title);
      return {
        ...summary,
        provider: 'gemini-stream-v2184', model, contentSource: input.contentSource,
        cacheable: true, fastPath: 'summary-v2184-stream-500'
      };
    } catch (streamError) {
      errors.push(`${model}:stream:${streamError?.statusCode || ''}:${streamError?.message || streamError}`);
      try {
        const summary = await structuredModel(model, prompt);
        return {
          ...summary,
          provider: 'gemini-structured-v2184', model, contentSource: input.contentSource,
          cacheable: true, fastPath: 'summary-v2184-json-500'
        };
      } catch (structuredError) {
        errors.push(`${model}:json:${structuredError?.statusCode || ''}:${structuredError?.message || structuredError}`);
      }
    }
  }

  console.warn('[summary-v2184] all Gemini routes failed', errors.slice(-6));
  return extractiveFallback(input, body, errors.at(-1) || 'all-gemini-routes-failed');
}

async function cachedBuild(body, onDelta) {
  const key = cacheKey(body);
  const hit = memoryCache.get(key);
  if (hit) return { ...hit, cache: 'memory-v2184' };
  if (!inFlight.has(key)) inFlight.set(key, buildSummary(body, onDelta).finally(() => inFlight.delete(key)));
  const value = await inFlight.get(key);
  if (value?.cacheable !== false) cachePut(key, value);
  return value;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = bodyOf(req);
  const streaming = String(req.query?.stream || '') === '1';
  if (!streaming) {
    try {
      return res.status(200).json(await cachedBuild(body, () => {}));
    } catch (error) {
      return res.status(500).json({ error: String(error?.message || error), provider: 'unavailable', cacheable: false });
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = payload => { try { res.write(`${JSON.stringify(payload)}\n`); } catch {} };

  try {
    const key = cacheKey(body);
    const cached = memoryCache.get(key);
    if (cached) {
      write({ type: 'done', summary: { ...cached, cache: 'memory-v2184' } });
      return res.end();
    }
    const value = await cachedBuild(body, delta => write({ type: 'delta', text: delta }));
    write({ type: 'done', summary: value });
    return res.end();
  } catch (error) {
    write({ type: 'error', error: String(error?.message || error) });
    return res.end();
  }
}
