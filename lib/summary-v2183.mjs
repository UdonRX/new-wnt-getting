import { extractArticleFromUrl } from './article-reader.mjs';

const SUMMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const INPUT_CHAR_LIMIT = 500;
const CACHE_LIMIT = 220;
const memoryCache = new Map();
const inFlight = new Map();
let modelTail = Promise.resolve();
let lastModelStartAt = 0;

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
  const url = clean(body.url || body.link, 2000);
  const title = clean(body.title, 500);
  const mode = clean(body.mode, 32) || 'auto';
  return `${url || title}::${mode}::v2183`;
}
function cachePut(key, value) {
  memoryCache.delete(key);
  memoryCache.set(key, value);
  while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function startModelSlot() {
  const run = modelTail.then(async () => {
    const wait = Math.max(0, 650 - (Date.now() - lastModelStartAt));
    if (wait) await sleep(wait);
    lastModelStartAt = Date.now();
  });
  modelTail = run.catch(() => {});
  await run;
}

async function resolveInput(body) {
  const title = clean(body.title, 500);
  const description = clean(body.description, 3000);
  if (description.length >= 80) {
    return { title, text: firstChars(description), contentSource: 'rss' };
  }
  const url = clean(body.url || body.link, 2500);
  if (url) {
    try {
      const extracted = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 1800 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('article-fast-timeout')), 5500))
      ]);
      const text = firstChars(extracted?.text || description || title);
      if (text.length >= 40) return {
        title: clean(extracted?.title || title, 500) || title,
        text,
        contentSource: extracted?.sourceType === 'pdf' ? 'pdf' : 'article'
      };
    } catch {}
  }
  return { title, text: firstChars(description || title), contentSource: description ? 'rss' : 'title' };
}

function makePrompt({ title, text, source, category }) {
  return [
    `タイトル: ${title || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    `記事冒頭（最大${INPUT_CHAR_LIMIT}文字）:`,
    text || title || '情報なし',
    '',
    '上の文章だけを根拠に、スマホで一瞬で読める日本語要約を作る。',
    '出力形式は必ず次の4行。ラベル名は変えない。',
    'タイトル: 18〜42文字の自然な日本語タイトル',
    '結論/事実: 最重要の具体的事実を1文',
    '背景/特徴: 背景・特徴・方法を1文',
    '影響/展望: 意味・影響・今後を1文',
    '各文は短く完結させる。本文にない推測、前置き、箇条書き記号、Markdownは禁止。'
  ].filter(Boolean).join('\n');
}

function geminiError(status, data = {}) {
  const error = new Error(data?.error?.message || `Gemini API ${status}`);
  error.statusCode = status;
  return error;
}
function extractStreamText(data = {}) {
  if (data?.delta?.type === 'text' && typeof data.delta.text === 'string') return data.delta.text;
  const candidateText = (data?.candidates?.[0]?.content?.parts || []).map(part => part?.text || '').join('');
  if (candidateText) return candidateText;
  return '';
}

async function streamGemini(prompt, onDelta = () => {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません'), { statusCode: 500 });
  await startModelSlot();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(SUMMARY_MODEL)}:streamGenerateContent?alt=sse`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 260, temperature: 0.2 }
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw geminiError(response.status, data);
  }
  if (!response.body) throw new Error('Geminiストリームを開始できませんでした');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n+/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const rows = block.split(/\r?\n/).filter(line => line.startsWith('data:'));
      for (const row of rows) {
        const raw = row.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        const delta = extractStreamText(data);
        if (!delta) continue;
        result += delta;
        onDelta(delta);
      }
    }
  }
  return result.trim();
}

function normalizeSentence(value = '') {
  let text = clean(value, 240).replace(/^[・●\-–—\s]+/, '').trim();
  if (!text) return '';
  if (!/[。！？!?]$/.test(text)) text += '。';
  return text;
}
function parseTagged(text, fallbackTitle = '') {
  const source = String(text || '').replace(/\r/g, '').trim();
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const values = {};
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const startMatch = new RegExp(`${label}\\s*[:：]`).exec(source);
    if (!startMatch) continue;
    const start = startMatch.index + startMatch[0].length;
    let end = source.length;
    for (let j = i + 1; j < labels.length; j += 1) {
      const next = new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`, 'm').exec(source.slice(start));
      if (next) { end = start + next.index; break; }
    }
    values[label] = clean(source.slice(start, end), 260);
  }
  const headline = clean(values['タイトル'] || fallbackTitle || '記事のポイント', 100);
  const lines = [
    normalizeSentence(values['結論/事実']),
    normalizeSentence(values['背景/特徴']),
    normalizeSentence(values['影響/展望'])
  ];
  if (lines.some(line => line.length < 8)) throw new Error('AI要約の形式が不完全です');
  return {
    headline,
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    short: lines[0],
    points: lines.slice(1),
    provider: 'gemini-stream',
    model: SUMMARY_MODEL,
    cacheable: true,
    fastPath: 'summary-v2183-stream-500'
  };
}

function extractiveFallback(input, body, reason = 'fallback') {
  const sentences = clean(input.text, 1200)
    .split(/(?<=[。！？!?])\s*/)
    .map(normalizeSentence)
    .filter(line => line.length >= 10);
  const title = clean(input.title || body.title || '記事のポイント', 100);
  const safe = sentences.slice(0, 3);
  while (safe.length < 3) {
    const base = clean(input.text || title, 110);
    if (!base) break;
    const labels = ['冒頭では主要な事実を説明しています', '背景や特徴は冒頭部分から確認できます', '詳しい影響は本文後半に続きます'];
    safe.push(normalizeSentence(`${base.slice(0, 55)}。${labels[safe.length] || ''}`));
  }
  return {
    headline: title,
    lines: ['結論/事実','背景/特徴','影響/展望'].map((label, i) => ({ label, text: safe[i] || '本文の取得を続けています。' })),
    short: safe[0] || '',
    points: safe.slice(1),
    provider: 'extractive',
    model: '',
    contentSource: input.contentSource,
    cacheable: false,
    fallbackReason: reason,
    fastPath: 'summary-v2183-fallback'
  };
}

async function buildSummary(body, onDelta) {
  const input = await resolveInput(body);
  const prompt = makePrompt({
    title: input.title || clean(body.title, 500),
    text: firstChars(input.text),
    source: clean(body.source, 120),
    category: clean(body.category, 120)
  });
  try {
    const raw = await streamGemini(prompt, onDelta);
    const value = parseTagged(raw, input.title || body.title);
    value.contentSource = input.contentSource;
    return value;
  } catch (error) {
    console.warn('[summary-v2183] fallback', error?.statusCode || '', error?.message || error);
    return extractiveFallback(input, body, `gemini-${error?.statusCode || 'error'}`);
  }
}

async function cachedBuild(body, onDelta) {
  const key = cacheKey(body);
  const hit = memoryCache.get(key);
  if (hit) return { ...hit, cache: 'memory-v2183' };
  if (!inFlight.has(key)) {
    inFlight.set(key, buildSummary(body, onDelta).finally(() => inFlight.delete(key)));
  }
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
    const value = await cachedBuild(body, () => {});
    return res.status(200).json(value);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = payload => {
    try { res.write(`${JSON.stringify(payload)}\n`); } catch {}
  };

  try {
    const key = cacheKey(body);
    const cached = memoryCache.get(key);
    if (cached) {
      write({ type: 'done', summary: { ...cached, cache: 'memory-v2183' } });
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
