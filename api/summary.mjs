import { generateGemini } from '../lib/gemini.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';

/*
 * Personal Dashboard v2.14.17 — fast / quota-safe Reader summary
 *
 * Goals:
 * - Gemini 429 / quota / timeout must never be shown as a Reader error.
 * - News / knowledge summarize RSS text directly for speed.
 * - Full article/PDF extraction is reserved for papers or explicitly requested short RSS.
 * - Warm-instance cache + in-flight de-duplication avoid duplicate Gemini calls.
 * - If Gemini is unavailable, return HTTP 200 with a readable local fallback.
 */

const FAST_INPUT_LIMIT = 5200;
const PAPER_INPUT_LIMIT = 15000;
const EXTRACT_TEXT_LIMIT = 55000;
const CACHE_LIMIT = 180;
const NEWS_CACHE_TTL = 6 * 60 * 60 * 1000;
const PAPER_CACHE_TTL = 24 * 60 * 60 * 1000;
const GEMINI_QUOTA_BLOCK_MS = 60 * 60 * 1000;
const GEMINI_ERROR_BLOCK_MS = 2 * 60 * 1000;

const memoryCache = new Map();
const inFlight = new Map();
let geminiBlockedUntil = 0;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value, max = FAST_INPUT_LIMIT) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripFence(value = '') {
  return String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function stripMarkdown(value = '') {
  return String(value || '').replace(/\*\*/g, '').trim();
}

function normalizeTag(value = '') {
  const raw = stripMarkdown(clean(value, 60)).replace(/^#+/, '').replace(/[\s　]+/g, '');
  return raw ? `#${raw}` : '';
}

function categoryTag(mode = '', category = '') {
  if (String(category || '').trim()) return normalizeTag(category);
  if (mode === 'papers') return '#研究';
  if (mode === 'knowledge') return '#専門知識';
  return '#最新ニュース';
}

function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.4;
}

function sentenceCandidates(value = '') {
  const text = clean(value, PAPER_INPUT_LIMIT);
  if (!text) return [];
  const rows = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  return rows
    .map(row => row.trim())
    .filter(row => row.length >= 5)
    .slice(0, 24);
}

function naturalClamp(value = '', max = 40) {
  let text = clean(stripMarkdown(value), 600).replace(/^[・●\-–—\s]+/, '').trim();
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length <= max) return text;

  const head = chars.slice(0, max).join('');
  const preferred = [];
  const patterns = [
    /[。！？!?]/g,
    /[、，,；;：:]/g,
    /(?:ため|ので|一方|ただし|しかし|さらに|また|では|には|から|まで|より|は|が|を|で|に|へ|も|と)/g
  ];

  patterns.forEach((pattern, priority) => {
    for (const match of head.matchAll(pattern)) {
      const index = match.index + match[0].length;
      if (index < Math.floor(max * .55)) continue;
      preferred.push({ index, score: 100 - priority * 20 + index / max });
    }
  });

  preferred.sort((a, b) => b.score - a.score);
  const cut = preferred[0]?.index || max;
  text = Array.from(head).slice(0, cut).join('').replace(/[、，,；;：:\s]+$/g, '').trim();
  if (text && !/[。！？!?]$/.test(text)) text += '。';
  return text;
}

function emphasizeNumbers(value = '') {
  return String(value || '').replace(
    /(?<!\*)([0-9０-９]+(?:[.,．，][0-9０-９]+)?(?:%|％|倍|件|人|年|円|ドル|万|億|兆|℃|度|nm|mm|cm|km|GB|TB|W|kW|MW|GW)?)(?!\*)/g,
    '**$1**'
  );
}

function localSummary({
  title,
  description,
  reason = 'local',
  forceJapanese = false,
  contentSource = 'rss',
  mode = '',
  category = '',
  source = ''
}) {
  const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);
  const titleText = clean(title, 500) || '記事のポイント';

  if (forceJapanese && looksMostlyEnglish(`${title}\n${description}`)) {
    return {
      headline: '記事のポイント',
      lines: [
        { label: '結論/事実', text: '日本語要約を準備できないため、原文情報を表示します。' },
        { label: '背景/特徴', text: 'AI利用枠の回復後は、自動で日本語要約を再取得できます。' },
        { label: '影響/展望', text: '元記事ボタンから、記事本文をすぐ確認できます。' }
      ],
      tags,
      short: '日本語要約を準備できないため、原文情報を表示します。',
      points: [
        'AI利用枠の回復後は、自動で日本語要約を再取得できます。',
        '元記事ボタンから、記事本文をすぐ確認できます。'
      ],
      why: '',
      provider: 'local',
      model: '',
      contentSource,
      extractedLength: String(description || '').length,
      aiInputLength: 0,
      fastPath: 'japanese-safe-fallback',
      fallbackReason: reason,
      resolvedTitle: titleText,
      limits: { headline: 35, line: 40, tags: 3 }
    };
  }

  const sentences = sentenceCandidates(description);
  const headline = naturalClamp(titleText, 35) || '記事のポイント';
  const conclusion = naturalClamp(emphasizeNumbers(sentences[0] || titleText), 40) || '記事の中心となる内容を確認できます。';
  const background = naturalClamp(emphasizeNumbers(sentences[1] || '背景や特徴は元記事で詳しく確認できます。'), 40);
  const impact = naturalClamp(emphasizeNumbers(sentences[2] || '今後の動きや影響に注目が必要です。'), 40);

  return {
    headline,
    lines: [
      { label: '結論/事実', text: conclusion },
      { label: '背景/特徴', text: background },
      { label: '影響/展望', text: impact }
    ],
    tags,
    short: stripMarkdown(conclusion),
    points: [background, impact].map(stripMarkdown),
    why: '',
    provider: 'local',
    model: '',
    contentSource,
    extractedLength: String(description || '').length,
    aiInputLength: 0,
    fastPath: 'instant-local-fallback',
    fallbackReason: reason,
    resolvedTitle: titleText,
    limits: { headline: 35, line: 40, tags: 3 }
  };
}

const responseSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '35文字以内の自然な日本語タイトル。文の途中で切らない。' },
    conclusion: { type: 'string', description: '40文字以内。結論または事実を1文で完結させる。' },
    background: { type: 'string', description: '40文字以内。背景または特徴を1文で完結させる。' },
    impact: { type: 'string', description: '40文字以内。影響または展望を1文で完結させる。' },
    tags: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', description: '#から始まる短い日本語タグ' }
    }
  },
  required: ['headline', 'conclusion', 'background', 'impact', 'tags'],
  additionalProperties: false
};

function normalizeAiSummary(parsed, { title, mode, category, source, contentSource, extractedLength, aiInputLength, model, fastPath }) {
  const headline = naturalClamp(parsed?.headline || title || '記事のポイント', 35) || '記事のポイント';
  const conclusion = naturalClamp(parsed?.conclusion || '', 40) || '記事の中心となる内容を確認できます。';
  const background = naturalClamp(parsed?.background || '', 40) || '背景や特徴を短く整理しています。';
  const impact = naturalClamp(parsed?.impact || '', 40) || '今後の動きや影響に注目が必要です。';
  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const tags = [...new Set([
    categoryTag(mode, category),
    ...rawTags.map(normalizeTag).filter(Boolean),
    source ? normalizeTag(source) : ''
  ].filter(Boolean))].slice(0, 3);

  return {
    headline,
    lines: [
      { label: '結論/事実', text: conclusion },
      { label: '背景/特徴', text: background },
      { label: '影響/展望', text: impact }
    ],
    tags,
    short: stripMarkdown(conclusion),
    points: [background, impact].map(stripMarkdown),
    why: '',
    provider: 'gemini',
    model: model || '',
    contentSource,
    extractedLength,
    aiInputLength,
    fastPath,
    fallbackReason: '',
    resolvedTitle: clean(title, 500),
    limits: { headline: 35, line: 40, tags: 3 }
  };
}

function isQuotaError(error) {
  return Number(error?.statusCode) === 429 || /quota|rate limit|resource_exhausted|too many requests|exceeded/i.test(
    `${error?.message || ''} ${error?.publicError?.error || ''} ${error?.publicError?.detail || ''}`
  );
}

function hashString(value = '') {
  let hash = 2166136261;
  for (const ch of String(value)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKeyFor(body, title, description, mode) {
  return [
    mode || 'auto',
    clean(body.url || body.link, 500),
    clean(title, 180),
    hashString(description.slice(0, 2200)),
    'v21417'
  ].join('::');
}

function getCached(key, mode) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  const ttl = mode === 'papers' ? PAPER_CACHE_TTL : NEWS_CACHE_TTL;
  if (Date.now() - hit.at > ttl) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
}

function putCached(key, value) {
  memoryCache.set(key, { at: Date.now(), value });
  while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
  return value;
}

async function withTimeout(promise, ms, label = '処理') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label}がタイムアウトしました`), { name: 'TimeoutError' })), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function maybeExtract({ url, mode, preferFullText, description, title }) {
  const shouldExtract = Boolean(url) && (
    mode === 'papers' ||
    (preferFullText && String(description || '').length < 220)
  );

  if (!shouldExtract) {
    return {
      title,
      text: description,
      contentSource: 'rss',
      extractedLength: String(description || '').length,
      extractError: ''
    };
  }

  try {
    const extracted = await withTimeout(
      extractArticleFromUrl(url, { maxTextLength: EXTRACT_TEXT_LIMIT }),
      mode === 'papers' ? 6500 : 3000,
      '本文取得'
    );
    const text = clean(extracted?.text || '', mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);
    if (!text) throw new Error('本文が空です');
    return {
      title: clean(extracted?.title || title, 500) || title,
      text,
      contentSource: extracted?.sourceType === 'pdf' ? 'pdf' : 'article',
      extractedLength: Number(extracted?.originalLength || extracted?.text?.length || text.length),
      extractError: ''
    };
  } catch (error) {
    return {
      title,
      text: description,
      contentSource: 'rss',
      extractedLength: String(description || '').length,
      extractError: String(error?.message || error || '')
    };
  }
}

async function buildSummary(body) {
  const mode = clean(body.mode, 32);
  const fastMode = mode !== 'papers' && body.fast !== false;
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const category = clean(body.category, 100);
  const description = clean(body.description, mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);
  const url = clean(body.url || body.link, 3000);
  const forceJapanese = Boolean(body.forceJapanese) || looksMostlyEnglish(`${title}\n${description}`);
  const allowAi = body.allowAi !== false;

  if (!title && !description && !url) {
    const error = new Error('要約する情報がありません');
    error.statusCode = 400;
    throw error;
  }

  const extracted = await maybeExtract({
    url,
    mode,
    preferFullText: Boolean(body.preferFullText),
    description,
    title
  });

  const inputTitle = extracted.title || title;
  const inputText = clean(
    extracted.text || description || inputTitle,
    mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT
  );

  if (!allowAi) {
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: 'client-ai-budget',
      forceJapanese,
      contentSource: extracted.contentSource,
      mode,
      category,
      source
    });
  }

  if (Date.now() < geminiBlockedUntil) {
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: 'quota-circuit-open',
      forceJapanese,
      contentSource: extracted.contentSource,
      mode,
      category,
      source
    });
  }

  const prompt = [
    `タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    '',
    '記事本文・抄録:',
    inputText || inputTitle,
    '',
    '上の情報だけを根拠に、日本語で要約してください。',
    'headlineは35文字以内。',
    'conclusion/background/impactは各40文字以内の完結した1文。',
    '省略記号や文の途中での切断は禁止。',
    '最も重要な数値・固有名詞は**太字**にしてよい。',
    '前置き、一般論、重複、本文にない推測は不要。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: 'モバイル向けニュース編集者。短く、平易で、完結した日本語3行要約を返す。事実を増やさない。',
      maxOutputTokens: fastMode ? 300 : 430,
      responseSchema,
      timeoutMs: fastMode ? 4800 : 9500
    });

    let parsed;
    try {
      parsed = JSON.parse(stripFence(result.text));
    } catch {
      return localSummary({
        title: inputTitle,
        description: inputText,
        reason: 'invalid-ai-json',
        forceJapanese,
        contentSource: extracted.contentSource,
        mode,
        category,
        source
      });
    }

    return normalizeAiSummary(parsed, {
      title: inputTitle,
      mode,
      category,
      source,
      contentSource: extracted.contentSource,
      extractedLength: extracted.extractedLength,
      aiInputLength: inputText.length,
      model: result.model,
      fastPath: fastMode ? 'rss-fast-ai-v21417' : `${extracted.contentSource}-ai-v21417`
    });
  } catch (error) {
    if (isQuotaError(error)) {
      geminiBlockedUntil = Date.now() + GEMINI_QUOTA_BLOCK_MS;
    } else {
      geminiBlockedUntil = Math.max(geminiBlockedUntil, Date.now() + GEMINI_ERROR_BLOCK_MS);
    }

    console.warn('[summary-v21417] Gemini unavailable -> local fallback', error?.statusCode, error?.message);

    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: isQuotaError(error) ? 'quota' : 'gemini-unavailable',
      forceJapanese,
      contentSource: extracted.contentSource,
      mode,
      category,
      source
    });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = bodyOf(req);
  const mode = clean(body.mode, 32);
  const title = clean(body.title, 500);
  const description = clean(body.description, mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);
  const key = cacheKeyFor(body, title, description, mode);

  const cached = getCached(key, mode);
  if (cached) return res.status(200).json({ ...cached, cache: 'server-memory' });

  try {
    if (!inFlight.has(key)) {
      const promise = buildSummary(body)
        .then(value => putCached(key, value))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }

    const value = await inFlight.get(key);
    return res.status(200).json(value);
  } catch (error) {
    if (Number(error?.statusCode) === 400) {
      return res.status(400).json({ error: error.message });
    }

    // Reader must remain readable even on unexpected server errors.
    const fallback = localSummary({
      title,
      description,
      reason: 'summary-server-fallback',
      forceJapanese: looksMostlyEnglish(`${title}\n${description}`),
      contentSource: 'rss',
      mode,
      category: clean(body.category, 100),
      source: clean(body.source, 180)
    });
    return res.status(200).json(fallback);
  }
}
