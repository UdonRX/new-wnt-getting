import { generateGemini } from '../lib/gemini.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';

/*
 * Personal Dashboard v2.18.0 — Reader summary quality pass
 *
 * Main changes:
 * - Do not accept title-only / boilerplate “summaries”.
 * - Reject broken quote fragments and incomplete Japanese sentences.
 * - Prefer article-body extraction whenever the RSS description is thin or low-quality.
 * - Keep Gemini circuit breaking short so one 429 does not poison summaries for an hour.
 * - Cache only summaries that passed quality validation.
 */

const FAST_INPUT_LIMIT = 10_000;
const PAPER_INPUT_LIMIT = 20_000;
const EXTRACT_TEXT_LIMIT = 70_000;
const CACHE_LIMIT = 180;
const NEWS_CACHE_TTL = 6 * 60 * 60 * 1000;
const PAPER_CACHE_TTL = 24 * 60 * 60 * 1000;
const GEMINI_QUOTA_BLOCK_MS = 25 * 1000;
const GEMINI_ERROR_BLOCK_MS = 8 * 1000;

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

function decodeBasicEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function clean(value, max = FAST_INPUT_LIMIT) {
  return decodeBasicEntities(String(value || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
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
  return latin >= 24 && latin > ja * 1.35;
}

const GENERIC_SUMMARY_RE = /(?:についての記事です|について紹介(?:する|しています)|背景や特徴.*(?:整理|確認)|影響や今後.*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?で確認|要約を(?:取得|作成)できません|詳しくは元記事|続報の確認が必要)/i;
const TRAILING_FRAGMENT_RE = /(?:は|が|を|に|へ|で|と|の|や|から|まで|より|ため|ので|こと|もの|など|として|について|により|によって|また|さらに|一方|しかし|および|ならびに|または|もしくは)$/;
const OPEN_QUOTE_RE = /[「『（【〈《]$/;
const CLOSE_QUOTE_START_RE = /^[」』）】〉》]/;

function quoteBalanceLooksBroken(value = '') {
  const text = stripMarkdown(value).trim();
  if (!text) return true;
  if (CLOSE_QUOTE_START_RE.test(text) || OPEN_QUOTE_RE.test(text)) return true;
  const pairs = [['「','」'],['『','』'],['（','）'],['【','】'],['〈','〉'],['《','》']];
  return pairs.some(([open, close]) => {
    const a = (text.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const b = (text.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    return Math.abs(a - b) > 1;
  });
}

function sentenceCandidates(value = '') {
  const text = clean(value, PAPER_INPUT_LIMIT)
    .replace(/([。！？!?])(?=[^」』）】〉》])/g, '$1\n')
    .replace(/\n+/g, '\n');
  if (!text) return [];

  const rows = text.split(/\n+/)
    .flatMap(row => row.match(/[^。！？!?]+[。！？!?]+(?:[」』）】〉》])?/g) || [])
    .map(row => row.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const normalized = row.replace(/\s+/g, ' ');
    const key = normalized.replace(/[。、，,.!！?？\s]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= 60) break;
  }
  return out;
}

function suspiciousEnding(value = '') {
  const plain = stripMarkdown(value).replace(/[。！？!?]+[」』）】〉》]?$/, '').trim();
  return TRAILING_FRAGMENT_RE.test(plain);
}

function isMeaningfulSentence(value = '', { allowEnglish = true } = {}) {
  const text = clean(stripMarkdown(value), 700).trim();
  if (!text || Array.from(text).length < 12) return false;
  if (GENERIC_SUMMARY_RE.test(text)) return false;
  if (quoteBalanceLooksBroken(text)) return false;
  if (suspiciousEnding(text)) return false;
  if (!/[。！？!?][」』）】〉》]?$/.test(text)) return false;
  if (!allowEnglish && looksMostlyEnglish(text)) return false;
  const contentChars = (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return contentChars >= 10;
}

function normalizeSentence(value = '', { hardMax = 96, allowEnglish = true } = {}) {
  let text = clean(value, 900)
    .replace(/^[・●\-–—\s]+/, '')
    .replace(/(?:…|\.{3,})+\s*$/g, '')
    .trim();
  if (!text) return '';

  if (Array.from(stripMarkdown(text)).length > hardMax) {
    const complete = sentenceCandidates(text)
      .find(row => Array.from(stripMarkdown(row)).length <= hardMax && isMeaningfulSentence(row, { allowEnglish }));
    if (!complete) return '';
    text = complete;
  }

  if (!/[。！？!?][」』）】〉》]?$/.test(stripMarkdown(text))) text += '。';
  return isMeaningfulSentence(text, { allowEnglish }) ? text : '';
}

function normalizeHeadline(value = '', fallback = '') {
  let text = clean(stripMarkdown(value), 180).replace(/(?:…|\.{3,})+\s*$/g, '').trim();
  if (!text) text = clean(stripMarkdown(fallback), 180);
  if (!text) return '記事のポイント';
  if (/日本語タイトルを(?:要約|整理|生成)中/.test(text)) text = clean(stripMarkdown(fallback), 180) || '記事のポイント';
  if (Array.from(text).length <= 48) return text;
  const firstSentence = text.match(/^.{16,48}?[。！？!?]/)?.[0];
  if (firstSentence) return firstSentence.replace(/[。！？!?]+$/, '');
  for (const separator of ['｜', '|', '：', ':', '—', ' - ', '・']) {
    const part = text.split(separator)[0]?.trim();
    if (part && Array.from(part).length >= 10 && Array.from(part).length <= 48) return part;
  }
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
  if (/\d|%|％|世界初|国内初|業界初|最大|最小|増|減|開始|発表|決定|開発|導入|実証|結果|示した|明らか|達成|比較/.test(text)) score += 8;
  if (role === 'background' && /背景|ため|技術|方法|研究|開発|仕組|従来|課題|対象|用いて|解析|実験|モデル/.test(text)) score += 7;
  if (role === 'impact' && /今後|見込|期待|影響|可能|目指|予定|拡大|改善|削減|実用|応用|示唆|寄与/.test(text)) score += 7;
  const titleTokens = clean(title, 120).split(/[\s、。・:：\-—|｜（）()]+/).filter(token => token.length >= 2).slice(0, 10);
  score += titleTokens.filter(token => text.includes(token)).length * 1.2;
  const length = Array.from(text).length;
  if (length >= 22 && length <= 84) score += 3;
  return score;
}

function pickExtractiveLines(description, title, { forceJapanese = false } = {}) {
  const rows = uniqueLines(sentenceCandidates(description)
    .map(row => normalizeSentence(row, { hardMax: 110, allowEnglish: !forceJapanese }))
    .filter(Boolean));
  if (!rows.length) return [];

  const pick = (pool, role) => [...pool]
    .sort((a, b) => scoreSentence(b, title, role) - scoreSentence(a, title, role))[0];
  const first = pick(rows, 'conclusion');
  const rest1 = rows.filter(row => row !== first);
  const background = pick(rest1, 'background');
  const rest2 = rest1.filter(row => row !== background);
  const impact = pick(rest2, 'impact');
  return [first, background, impact].filter(Boolean);
}

function insufficientSummary({ title, reason, contentSource, mode, category, source }) {
  const headline = normalizeHeadline(title, '記事のポイント');
  const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);
  const lines = [
    '本文の取得量が不足しているため、正確な3項目要約をまだ作成できません。',
    'タイトルだけから内容を推測せず、本文取得またはAI要約の再試行を優先します。',
    '元記事を開くと、現在取得できていない詳細を確認できます。'
  ];
  return {
    headline,
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    tags,
    short: lines[0], points: lines.slice(1), why: '',
    provider: 'insufficient', model: '', contentSource,
    extractedLength: 0, aiInputLength: 0,
    fastPath: 'insufficient-v2180', fallbackReason: reason,
    resolvedTitle: clean(title, 500), cacheable: false
  };
}

function localSummary({ title, description, reason = 'local', forceJapanese = false, contentSource = 'rss', mode = '', category = '', source = '' }) {
  const titleText = clean(title, 500) || '記事のポイント';
  const picked = pickExtractiveLines(description, titleText, { forceJapanese });
  if (picked.length < 3) {
    return insufficientSummary({ title: titleText, reason, contentSource, mode, category, source });
  }

  const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);
  const lines = picked.slice(0, 3).map(emphasizeImportant);
  return {
    headline: normalizeHeadline(titleText, '記事のポイント'),
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    tags,
    short: stripMarkdown(lines[0]),
    points: lines.slice(1).map(stripMarkdown),
    why: '', provider: 'extractive', model: '', contentSource,
    extractedLength: String(description || '').length, aiInputLength: 0,
    fastPath: 'extractive-v2180', fallbackReason: reason,
    resolvedTitle: titleText, cacheable: false
  };
}

const responseSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '本文の核心が分かる自然な日本語見出し。18〜46文字程度。' },
    conclusion: { type: 'string', description: '本文に書かれた最重要の具体的事実・結果。完結した日本語1文。' },
    background: { type: 'string', description: '背景、方法、対象、従来との差のいずれかを具体的に示す完結した日本語1文。' },
    impact: { type: 'string', description: '本文に根拠のある影響、意味、用途、今後の展望を具体的に示す完結した日本語1文。' },
    tags: { type: 'array', maxItems: 3, items: { type: 'string', description: '#から始まる短い日本語タグ' } }
  },
  required: ['headline', 'conclusion', 'background', 'impact', 'tags'],
  additionalProperties: false
};

function normalizeAiSummary(parsed, { title, mode, category, source, contentSource, extractedLength, aiInputLength, model, fastPath }) {
  const headline = normalizeHeadline(parsed?.headline, title || '記事のポイント');
  const conclusion = normalizeSentence(parsed?.conclusion || '', { hardMax: 100, allowEnglish: false });
  const background = normalizeSentence(parsed?.background || '', { hardMax: 100, allowEnglish: false });
  const impact = normalizeSentence(parsed?.impact || '', { hardMax: 100, allowEnglish: false });
  const lines = [conclusion, background, impact];

  if (lines.some(line => !line)) throw Object.assign(new Error('AI要約に不完全・抽象的な文が含まれています'), { code: 'SUMMARY_QUALITY' });
  if (lines.some(line => GENERIC_SUMMARY_RE.test(stripMarkdown(line)))) throw Object.assign(new Error('AI要約が定型文です'), { code: 'SUMMARY_QUALITY' });
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
  return [mode || 'auto', clean(body.url || body.link, 500), clean(title, 180), hashString(description.slice(0, 3200)), 'v2180'].join('::');
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

function descriptionQuality(description, title) {
  const desc = clean(description, 4000);
  if (!desc) return { score: 0, sentenceCount: 0, titleEcho: true };
  const completed = sentenceCandidates(desc).filter(row => isMeaningfulSentence(row));
  const head = clean(title, 180).replace(/[\s、。・:：\-—|｜]/g, '');
  const compactDesc = desc.replace(/[\s、。・:：\-—|｜]/g, '');
  const titleEcho = head.length >= 14 && compactDesc.includes(head.slice(0, Math.min(36, head.length)));
  let score = completed.length;
  if (desc.length >= 800) score += 1;
  if (titleEcho) score -= 1;
  if (GENERIC_SUMMARY_RE.test(desc)) score -= 1;
  return { score, sentenceCount: completed.length, titleEcho };
}

async function maybeExtract({ url, mode, preferFullText, description, title }) {
  const quality = descriptionQuality(description, title);
  const shouldExtract = Boolean(url) && (mode === 'papers' || preferFullText || quality.score < 3 || quality.sentenceCount < 3);
  if (!shouldExtract) {
    return { title, text: description, contentSource: 'rss', extractedLength: String(description || '').length, extractError: '' };
  }

  try {
    const extracted = await withTimeout(
      extractArticleFromUrl(url, { maxTextLength: EXTRACT_TEXT_LIMIT }),
      mode === 'papers' ? 5000 : 3500,
      '本文取得'
    );
    const text = clean(extracted?.text || '', mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);
    if (!text || descriptionQuality(text, extracted?.title || title).sentenceCount < 2) throw new Error('本文が十分に取得できませんでした');
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

  if (!title && !description && !url) throw Object.assign(new Error('要約する情報がありません'), { statusCode: 400 });

  const extracted = await maybeExtract({
    url,
    mode,
    preferFullText: Boolean(body.preferFullText),
    description,
    title
  });
  const inputTitle = extracted.title || title;
  const inputText = clean(extracted.text || description || inputTitle, mode === 'papers' ? PAPER_INPUT_LIMIT : FAST_INPUT_LIMIT);

  if (!allowAi || Date.now() < geminiBlockedUntil) {
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: !allowAi ? 'client-ai-disabled' : 'short-circuit-open',
      forceJapanese,
      contentSource: extracted.contentSource,
      mode, category, source
    });
  }

  const prompt = [
    `タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    extracted.contentSource ? `本文取得元: ${extracted.contentSource}` : '',
    '',
    '記事本文・抄録:',
    inputText || inputTitle,
    '',
    '上の本文だけを根拠に、日本語で3項目要約してください。',
    '',
    '必須ルール:',
    '1. 「〜についての記事です」のようなタイトル言い換えは禁止。本文中の具体的な事実・結果を書く。',
    '2. 「背景を整理しています」「影響を確認できます」など、何も説明していない定型文は禁止。',
    '3. conclusion / background / impact は内容を重複させない。',
    '4. 各文には、可能な限り対象・方法・数値・結果・固有名詞のいずれかを含める。',
    '5. 引用符の途中、助詞の途中、見出しの途中で文を切らない。',
    '6. 英語本文でも出力は自然な日本語にする。',
    '7. 本文にない推測・一般論・感想は追加しない。',
    '8. headline は本文の核心が分かる18〜46文字程度の日本語にする。原題をそのまま長く貼らない。',
    '9. 本文が本当に不足している場合も、タイトルだけから内容を捏造しない。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: 'モバイル向けニュース編集者。本文に書かれた具体情報だけを使い、短くても中身のある日本語3文へ圧縮する。抽象的な定型文、タイトルの言い換え、途中で切れた引用文は禁止。',
      maxOutputTokens: fastMode ? 430 : 620,
      responseSchema,
      timeoutMs: fastMode ? 6500 : 9000
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
        fastPath: fastMode ? 'active-card-ai-v2180' : `${extracted.contentSource}-ai-v2180`
      });
    } catch (qualityError) {
      console.warn('[summary-v2180] AI quality fallback:', qualityError?.message);
      return localSummary({ title: inputTitle, description: inputText, reason: 'ai-quality-fallback', forceJapanese, contentSource: extracted.contentSource, mode, category, source });
    }
  } catch (error) {
    if (isQuotaError(error)) geminiBlockedUntil = Date.now() + GEMINI_QUOTA_BLOCK_MS;
    else geminiBlockedUntil = Math.max(geminiBlockedUntil, Date.now() + GEMINI_ERROR_BLOCK_MS);
    console.warn('[summary-v2180] Gemini unavailable -> extractive fallback', error?.statusCode, error?.message);
    return localSummary({
      title: inputTitle,
      description: inputText,
      reason: isQuotaError(error) ? 'quota' : 'gemini-unavailable',
      forceJapanese,
      contentSource: extracted.contentSource,
      mode, category, source
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
    return res.status(200).json(insufficientSummary({
      title,
      reason: 'summary-server-fallback',
      contentSource: 'rss',
      mode,
      category: clean(body.category, 100),
      source: clean(body.source, 180)
    }));
  }
}
