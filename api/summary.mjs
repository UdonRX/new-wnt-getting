import { generateGemini } from '../lib/gemini.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';

/*
 * Personal Dashboard v2.15.0 — Reader summary
 *
 * - 40文字で機械的に切るnaturalClampを廃止。
 * - 不完全な文・重複する3項目は採用しない。
 * - RSS本文が薄い場合は本文取得を試す。
 * - Gemini失敗時は完結した原文文を選ぶextractive fallback。
 * - fallbackはcacheable:falseにし、AI復旧後に再取得できるようにする。
 */

const FAST_INPUT_LIMIT = 9000;
const PAPER_INPUT_LIMIT = 18000;
const EXTRACT_TEXT_LIMIT = 65000;
const CACHE_LIMIT = 160;
const NEWS_CACHE_TTL = 6 * 60 * 60 * 1000;
const PAPER_CACHE_TTL = 24 * 60 * 60 * 1000;
const GEMINI_QUOTA_BLOCK_MS = 60 * 60 * 1000;
const GEMINI_ERROR_BLOCK_MS = 90 * 1000;

const memoryCache = new Map();
const inFlight = new Map();
let geminiBlockedUntil = 0;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); }
    catch { return {}; }
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
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}
function stripMarkdown(value = '') { return String(value || '').replace(/\*\*/g, '').trim(); }
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
  // 終止記号がある「完結した文」だけを候補にする。末尾の切れた断片は使わない。
  return (text.match(/[^。！？!?]+[。！？!?]+/g) || [])
    .map(row => row.trim())
    .filter(row => row.length >= 8)
    .slice(0, 40);
}

function suspiciousEnding(value = '') {
  const plain = stripMarkdown(value).replace(/[。！？!?]+$/, '').trim();
  return /(?:は|が|を|に|へ|で|と|の|や|から|まで|より|ため|ので|こと|もの|など|として|について|により|によって|また|さらに|一方|しかし)$/.test(plain);
}

function normalizeSentence(value = '', { hardMax = 88 } = {}) {
  let text = clean(value, 700)
    .replace(/^[・●\-–—\s]+/, '')
    .replace(/(?:…|\.{3,})+\s*$/g, '')
    .trim();
  if (!text) return '';

  const plain = stripMarkdown(text);
  if (plain.length < 7 || suspiciousEnding(text)) return '';

  if (Array.from(plain).length > hardMax) {
    const complete = sentenceCandidates(text)
      .map(row => row.trim())
      .find(row => Array.from(stripMarkdown(row)).length <= hardMax);
    if (!complete) return '';
    text = complete;
  }

  if (!/[。！？!?]$/.test(stripMarkdown(text))) {
    if (suspiciousEnding(text)) return '';
    text += '。';
  }
  return text;
}

function normalizeHeadline(value = '', fallback = '') {
  let text = clean(stripMarkdown(value), 180).replace(/(?:…|\.{3,})+\s*$/g, '').trim();
  if (!text) text = clean(stripMarkdown(fallback), 180);
  if (!text) return '記事のポイント';
  if (Array.from(text).length <= 56) return text;
  const firstSentence = text.match(/^.{18,56}?[。！？!?]/)?.[0];
  if (firstSentence) return firstSentence.replace(/[。！？!?]+$/, '');
  for (const separator of ['｜', '|', '：', ':', '—', ' - ', '・']) {
    const part = text.split(separator)[0]?.trim();
    if (part && Array.from(part).length >= 12 && Array.from(part).length <= 56) return part;
  }
  // CSS側で2行clamp。ここでは文中で文字列を強制切断しない。
  return text;
}

function emphasizeImportant(value = '') {
  const re = /(?<!\*)([+＋\-−]?\d[\d,.]*(?:\.\d+)?(?:%|％|倍|件|人|年|円|ドル|万|億|兆|℃|度|nm|μm|mm|cm|km|GB|TB|W|kW|MW|GW)?|世界初|国内初|業界初|史上初|世界最大|国内最大|過去最高|新記録)(?!\*)/giu;
  return String(value || '').replace(re, '**$1**');
}

function normalizedComparable(value = '') {
  return stripMarkdown(value).replace(/[。、，,.!！?？\s]/g, '').toLowerCase();
}
function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const normalized = normalizedComparable(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(line);
  }
  return out;
}

function scoreSentence(sentence, title = '', role = 'general') {
  const text = stripMarkdown(sentence);
  let score = 0;
  if (/\d|%|％|世界初|国内初|業界初|最大|最小|増|減|開始|発表|決定|開発|導入|実証/.test(text)) score += 6;
  if (role === 'background' && /背景|ため|技術|方法|研究|開発|仕組|一方|従来|課題/.test(text)) score += 5;
  if (role === 'impact' && /今後|見込|期待|影響|可能|目指|予定|拡大|改善|削減|実用/.test(text)) score += 5;
  const titleTokens = clean(title, 120).split(/[\s、。・:：\-—|｜（）()]+/).filter(token => token.length >= 2).slice(0, 8);
  score += titleTokens.filter(token => text.includes(token)).length * 1.5;
  const length = Array.from(text).length;
  if (length >= 18 && length <= 76) score += 2;
  return score;
}

function pickExtractiveLines(description, title) {
  const rows = uniqueLines(sentenceCandidates(description)
    .map(row => normalizeSentence(row, { hardMax: 100 }))
    .filter(Boolean));
  if (!rows.length) return [];
  const first = [...rows].sort((a, b) => scoreSentence(b, title, 'conclusion') - scoreSentence(a, title, 'conclusion'))[0];
  const rest1 = rows.filter(row => row !== first);
  const background = [...rest1].sort((a, b) => scoreSentence(b, title, 'background') - scoreSentence(a, title, 'background'))[0];
  const rest2 = rest1.filter(row => row !== background);
  const impact = [...rest2].sort((a, b) => scoreSentence(b, title, 'impact') - scoreSentence(a, title, 'impact'))[0];
  return [first, background, impact].filter(Boolean);
}

function localSummary({ title, description, reason = 'local', forceJapanese = false, contentSource = 'rss', mode = '', category = '', source = '' }) {
  const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);
  const titleText = clean(title, 500) || '記事のポイント';

  if (forceJapanese && looksMostlyEnglish(`${title}\n${description}`)) {
    const lines = [
      '日本語AI要約を一時的に取得できませんでした。',
      '英語原文の内容は元記事から確認できます。',
      '次回表示時にAI要約を自動で再取得します。'
    ];
    return {
      headline: normalizeHeadline(titleText, '記事のポイント'),
      lines: [
        { label: '結論/事実', text: lines[0] },
        { label: '背景/特徴', text: lines[1] },
        { label: '影響/展望', text: lines[2] }
      ],
      tags,
      short: lines[0],
      points: [lines[1], lines[2]],
      why: '', provider: 'extractive', model: '', contentSource,
      extractedLength: String(description || '').length, aiInputLength: 0,
      fastPath: 'english-ai-retry-fallback-v2150', fallbackReason: reason,
      resolvedTitle: titleText, cacheable: false
    };
  }

  const picked = pickExtractiveLines(description, titleText);
  const fallbackLines = [
    picked[0] || normalizeSentence(titleText, { hardMax: 100 }) || '記事の主要な内容を確認できます。',
    picked[1] || '背景や特徴は元記事本文で確認できます。',
    picked[2] || '今後の動きや影響は続報の確認が必要です。'
  ].map(emphasizeImportant);

  return {
    headline: normalizeHeadline(titleText, '記事のポイント'),
    lines: [
      { label: '結論/事実', text: fallbackLines[0] },
      { label: '背景/特徴', text: fallbackLines[1] },
      { label: '影響/展望', text: fallbackLines[2] }
    ],
    tags,
    short: stripMarkdown(fallbackLines[0]),
    points: fallbackLines.slice(1).map(stripMarkdown),
    why: '', provider: 'extractive', model: '', contentSource,
    extractedLength: String(description || '').length, aiInputLength: 0,
    fastPath: 'extractive-fallback-v2150', fallbackReason: reason,
    resolvedTitle: titleText, cacheable: false
  };
}

const responseSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '日本語の短い見出し。24〜46文字程度。文中で切らない。' },
    conclusion: { type: 'string', description: '結論または最重要事実。34〜58文字程度の完結した1文。' },
    background: { type: 'string', description: '背景・方法・特徴。34〜58文字程度の完結した1文。' },
    impact: { type: 'string', description: '影響・意味・今後。34〜58文字程度の完結した1文。' },
    tags: { type: 'array', maxItems: 3, items: { type: 'string', description: '#から始まる短い日本語タグ' } }
  },
  required: ['headline', 'conclusion', 'background', 'impact', 'tags'],
  additionalProperties: false
};

function normalizeAiSummary(parsed, { title, mode, category, source, contentSource, extractedLength, aiInputLength, model, fastPath }) {
  const headline = normalizeHeadline(parsed?.headline, title || '記事のポイント');
  const conclusion = normalizeSentence(parsed?.conclusion || '', { hardMax: 88 });
  const background = normalizeSentence(parsed?.background || '', { hardMax: 88 });
  const impact = normalizeSentence(parsed?.impact || '', { hardMax: 88 });
  const lines = [conclusion, background, impact];
  if (lines.some(line => !line)) throw Object.assign(new Error('AI要約に不完全な文が含まれています'), { code: 'SUMMARY_QUALITY' });
  if (new Set(lines.map(normalizedComparable)).size !== 3) throw Object.assign(new Error('AI要約の3項目が重複しています'), { code: 'SUMMARY_QUALITY' });

  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const tags = [...new Set([
    categoryTag(mode, category),
    ...rawTags.map(normalizeTag).filter(Boolean),
    source ? normalizeTag(source) : ''
  ].filter(Boolean))].slice(0, 3);
  const emphasized = lines.map(emphasizeImportant);

  return {
    headline,
    lines: [
      { label: '結論/事実', text: emphasized[0] },
      { label: '背景/特徴', text: emphasized[1] },
      { label: '影響/展望', text: emphasized[2] }
    ],
    tags,
    short: stripMarkdown(emphasized[0]),
    points: emphasized.slice(1).map(stripMarkdown),
    why: '', provider: 'gemini', model: model || '', contentSource,
    extractedLength, aiInputLength, fastPath, fallbackReason: '',
    resolvedTitle: clean(title, 500), cacheable: true
  };
}

function isQuotaError(error) {
  return Number(error?.statusCode) === 429 || /quota|rate limit|resource_exhausted|too many requests|exceeded/i.test(`${error?.message || ''} ${error?.publicError?.error || ''} ${error?.publicError?.detail || ''}`);
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
  return [mode || 'auto', clean(body.url || body.link, 500), clean(title, 180), hashString(description.slice(0, 2600)), 'v2150'].join('::');
}
function getCached(key, mode) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  const ttl = mode === 'papers' ? PAPER_CACHE_TTL : NEWS_CACHE_TTL;
  if (Date.now() - hit.at > ttl) { memoryCache.delete(key); return null; }
  return hit.value;
}
function putCached(key, value) {
  if (value?.cacheable === false) return value;
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
  } finally { clearTimeout(timer); }
}

function descriptionLooksThin(description, title) {
  const desc = clean(description, 1200);
  const head = clean(title, 180);
  if (desc.length < 520) return true;
  if (!head) return false;
  const compactTitle = head.replace(/[\s、。・:：\-—|｜]/g, '');
  const compactDesc = desc.replace(/[\s、。・:：\-—|｜]/g, '');
  return compactTitle.length >= 16 && compactDesc.includes(compactTitle.slice(0, Math.min(36, compactTitle.length)));
}

async function maybeExtract({ url, mode, preferFullText, description, title }) {
  const shouldExtract = Boolean(url) && (mode === 'papers' || preferFullText || descriptionLooksThin(description, title));
  if (!shouldExtract) return { title, text: description, contentSource: 'rss', extractedLength: String(description || '').length, extractError: '' };
  try {
    const extracted = await withTimeout(
      extractArticleFromUrl(url, { maxTextLength: EXTRACT_TEXT_LIMIT }),
      mode === 'papers' ? 3800 : 2200,
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
    return { title, text: description, contentSource: 'rss', extractedLength: String(description || '').length, extractError: String(error?.message || error || '') };
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

  if (!title && !description && !url) throw Object.assign(new Error('要約する情報がありません'), { statusCode: 400 });

  const extracted = await maybeExtract({ url, mode, preferFullText: Boolean(body.preferFullText), description, title });
  const inputTitle = extracted.title || title;
  const inputText = clean(extracted.text || description || inputTitle, mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);

  if (!allowAi || Date.now() < geminiBlockedUntil) {
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: !allowAi ? 'client-ai-disabled' : 'quota-circuit-open',
      forceJapanese, contentSource: extracted.contentSource, mode, category, source
    });
  }

  const prompt = [
    `タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    '', '記事本文・抄録:', inputText || inputTitle, '',
    '上の情報だけを根拠に、日本語で3項目要約してください。', '',
    '重要なルール:',
    '1. タイトルの言い換えだけで終わらず、本文の具体的な事実を要約する。',
    '2. conclusion/background/impact は互いに違う内容にする。',
    '3. 各項目は34〜58文字程度を目安に、必ず意味が完結した1文にする。',
    '4. 「…」や途中で切れた文章、助詞で終わる文章は禁止。',
    '5. 本文にない推測・一般論・感想は書かない。',
    '6. 重要な数値・固有名詞・「世界初」などは **太字** にしてよい。',
    '7. headlineは24〜46文字程度。本文の核心が分かる自然な日本語にする。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: 'モバイル向けニュース編集者。本文を読んで情報を圧縮し、重複のない完結した日本語3文を返す。文の途中で切らない。事実を増やさない。',
      maxOutputTokens: fastMode ? 360 : 500,
      responseSchema,
      timeoutMs: fastMode ? 4800 : 7600
    });

    let parsed;
    try { parsed = JSON.parse(stripFence(result.text)); }
    catch {
      return localSummary({ title: inputTitle, description: inputText, reason: 'invalid-ai-json', forceJapanese, contentSource: extracted.contentSource, mode, category, source });
    }

    try {
      return normalizeAiSummary(parsed, {
        title: inputTitle, mode, category, source,
        contentSource: extracted.contentSource,
        extractedLength: extracted.extractedLength,
        aiInputLength: inputText.length,
        model: result.model,
        fastPath: fastMode ? 'active-card-ai-v2150' : `${extracted.contentSource}-ai-v2150`
      });
    } catch (qualityError) {
      console.warn('[summary-v2150] quality fallback:', qualityError?.message);
      return localSummary({ title: inputTitle, description: inputText, reason: 'ai-quality-fallback', forceJapanese, contentSource: extracted.contentSource, mode, category, source });
    }
  } catch (error) {
    if (isQuotaError(error)) geminiBlockedUntil = Date.now() + GEMINI_QUOTA_BLOCK_MS;
    else geminiBlockedUntil = Math.max(geminiBlockedUntil, Date.now() + GEMINI_ERROR_BLOCK_MS);
    console.warn('[summary-v2150] Gemini unavailable -> extractive fallback', error?.statusCode, error?.message);
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: isQuotaError(error) ? 'quota' : 'gemini-unavailable',
      forceJapanese, contentSource: extracted.contentSource, mode, category, source
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
      const promise = buildSummary(body).then(value => putCached(key, value)).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }
    return res.status(200).json(await inFlight.get(key));
  } catch (error) {
    if (Number(error?.statusCode) === 400) return res.status(400).json({ error: error.message });
    return res.status(200).json(localSummary({
      title,
      description,
      reason: 'summary-server-fallback',
      forceJapanese: looksMostlyEnglish(`${title}\n${description}`),
      contentSource: 'rss', mode,
      category: clean(body.category, 100),
      source: clean(body.source, 180)
    }));
  }
}
