import { generateGemini } from './gemini.mjs';
import { extractArticleFromUrl } from './article-reader.mjs';

const FAST_LIMIT = 12_000;
const PAPER_LIMIT = 22_000;
const EXTRACT_LIMIT = 70_000;
const CACHE_LIMIT = 180;
const memoryCache = new Map();
const inFlight = new Map();
let geminiTail = Promise.resolve();
let lastGeminiStartedAt = 0;

const GENERIC_RE = /(?:についての記事です|について紹介(?:する|しています)|背景や特徴.*(?:整理|確認)|影響や今後.*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?で確認|詳しくは元記事|続報の確認が必要|本文を十分に取得できず|タイトルだけから内容を推測)/i;
const BAD_END_RE = /(?:は|が|を|に|へ|で|と|の|や|から|まで|より|ため|ので|こと|もの|など|として|について|により|によって|また|さらに|一方|しかし|および|ならびに|または|もしくは)$/;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value = '', max = FAST_LIMIT) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripMarkdown(value = '') { return String(value || '').replace(/\*\*/g, '').trim(); }
function stripFence(value = '') {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}
function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.35;
}
function sentenceCandidates(value = '') {
  const text = clean(value, PAPER_LIMIT).replace(/([。！？!?])(?=[^」』）】〉》])/g, '$1\n');
  const rows = text.split(/\n+/)
    .flatMap(row => row.match(/[^。！？!?]+[。！？!?]+(?:[」』）】〉》])?/g) || [])
    .map(row => row.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = row.replace(/[。、，,.!！?？\s]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(row);
    if (out.length >= 80) break;
  }
  return out;
}
function quoteBalanceBroken(value = '') {
  const text = stripMarkdown(value);
  if (/^[」』）】〉》]/.test(text) || /[「『（【〈《]$/.test(text)) return true;
  return [['「','」'],['『','』'],['（','）'],['【','】'],['〈','〉'],['《','》']].some(([a,b]) =>
    Math.abs((text.split(a).length - 1) - (text.split(b).length - 1)) > 1);
}
function normalizeSentence(value = '', { allowEnglish = false, hardMax = 116 } = {}) {
  let text = clean(value, 1000).replace(/^[・●\-–—\s]+/, '').replace(/(?:…|\.{3,})+\s*$/g, '').trim();
  if (!text) return '';
  if (Array.from(stripMarkdown(text)).length > hardMax) {
    text = sentenceCandidates(text).find(row => Array.from(stripMarkdown(row)).length <= hardMax) || '';
  }
  if (!text) return '';
  if (!/[。！？!?][」』）】〉》]?$/.test(stripMarkdown(text))) text += '。';
  const plain = stripMarkdown(text);
  if (Array.from(plain).length < 12 || GENERIC_RE.test(plain) || quoteBalanceBroken(plain)) return '';
  const core = plain.replace(/[。！？!?][」』）】〉》]?$/, '').trim();
  if (BAD_END_RE.test(core) || (!allowEnglish && looksMostlyEnglish(plain))) return '';
  return text;
}
function normalizeHeadline(value = '', fallback = '') {
  let text = clean(stripMarkdown(value), 180) || clean(stripMarkdown(fallback), 180) || '記事のポイント';
  if (/日本語タイトルを(?:要約|整理|生成)中/.test(text)) text = clean(stripMarkdown(fallback), 180) || '記事のポイント';
  if (Array.from(text).length <= 48) return text;
  const first = text.match(/^.{16,48}?[。！？!?]/)?.[0];
  if (first) return first.replace(/[。！？!?]+$/, '');
  for (const separator of ['｜','|','：',':','—',' - ']) {
    const part = text.split(separator)[0]?.trim();
    if (part && Array.from(part).length >= 10 && Array.from(part).length <= 48) return part;
  }
  return Array.from(text).slice(0, 48).join('');
}
function emphasize(value = '') {
  const re = /(?<!\*)([+＋\-−]?\d[\d,.]*(?:\.\d+)?(?:%|％|倍|件|人|年|円|ドル|万|億|兆|℃|度|nm|μm|mm|cm|km|GB|TB|W|kW|MW|GW)?|世界初|国内初|業界初|史上初|世界最大|国内最大|過去最高|新記録)(?!\*)/giu;
  return String(value || '').replace(re, '**$1**');
}
function comparable(value = '') { return stripMarkdown(value).replace(/[。、，,.!！?？\s]/g, '').toLowerCase(); }
function validThree(lines) { return Array.isArray(lines) && lines.length === 3 && lines.every(Boolean) && new Set(lines.map(comparable)).size === 3; }
function tag(value = '') { const raw = clean(value, 60).replace(/^#+/, '').replace(/\s+/g, ''); return raw ? `#${raw}` : ''; }

function buildResponse({ headline, lines, provider, model = '', mode, source, category, contentSource, cacheable = true, fallbackReason = '' }) {
  const tags = [...new Set([
    category ? tag(category) : mode === 'papers' ? '#研究' : mode === 'knowledge' ? '#専門知識' : '#最新ニュース',
    source ? tag(source) : ''
  ].filter(Boolean))].slice(0, 3);
  return {
    headline,
    lines: [
      { label: '結論/事実', text: lines[0] },
      { label: '背景/特徴', text: lines[1] },
      { label: '影響/展望', text: lines[2] }
    ],
    tags,
    short: stripMarkdown(lines[0]),
    points: lines.slice(1).map(stripMarkdown),
    why: '', provider, model, contentSource,
    fastPath: `summary-v2182-${provider}`,
    fallbackReason,
    resolvedTitle: headline,
    cacheable
  };
}
function insufficientSummary({ title, mode, source, category, contentSource = 'rss', reason = 'insufficient' }) {
  return buildResponse({
    headline: normalizeHeadline(title),
    lines: [
      '本文を十分に取得できず、正確な3項目要約を作成できませんでした。',
      'タイトルだけから内容を推測する表示は行わず、本文の取得結果を優先しています。',
      '元記事を開くと、現在取得できていない詳細を確認できます。'
    ],
    provider: 'insufficient', mode, source, category, contentSource, cacheable: false, fallbackReason: reason
  });
}
function scoreSentence(sentence, title = '', role = 'general') {
  const text = stripMarkdown(sentence);
  let score = 0;
  if (/\d|%|％|世界初|国内初|業界初|最大|最小|増|減|開始|発表|決定|開発|導入|実証|結果|示した|明らか|達成|比較/.test(text)) score += 8;
  if (role === 'background' && /背景|ため|技術|方法|研究|開発|仕組|従来|課題|対象|用いて|解析|実験|モデル/.test(text)) score += 7;
  if (role === 'impact' && /今後|見込|期待|影響|可能|目指|予定|拡大|改善|削減|実用|応用|示唆|寄与/.test(text)) score += 7;
  const tokens = clean(title, 140).split(/[\s、。・:：\-—|｜（）()]+/).filter(token => token.length >= 2).slice(0, 10);
  score += tokens.filter(token => text.includes(token)).length * 1.2;
  return score;
}
function extractiveSummary({ title, text, mode, source, category, contentSource, reason, forceJapanese }) {
  if (forceJapanese && looksMostlyEnglish(text)) return insufficientSummary({ title, mode, source, category, contentSource, reason: `${reason}-english` });
  const unique = [];
  const seen = new Set();
  for (const row of sentenceCandidates(text).map(row => normalizeSentence(row, { allowEnglish: !forceJapanese })).filter(Boolean)) {
    const key = comparable(row); if (!key || seen.has(key)) continue; seen.add(key); unique.push(row);
  }
  const pick = (pool, role) => [...pool].sort((a,b) => scoreSentence(b,title,role) - scoreSentence(a,title,role))[0];
  const first = pick(unique, 'conclusion');
  const second = pick(unique.filter(row => row !== first), 'background');
  const third = pick(unique.filter(row => row !== first && row !== second), 'impact');
  const lines = [first, second, third].filter(Boolean);
  if (!validThree(lines)) return insufficientSummary({ title, mode, source, category, contentSource, reason });
  return buildResponse({ headline: normalizeHeadline(title), lines: lines.map(emphasize), provider: 'extractive', mode, source, category, contentSource, cacheable: false, fallbackReason: reason });
}

function isTransient(error) {
  const status = Number(error?.statusCode || 0);
  const message = `${error?.message || ''} ${error?.publicError?.error || ''} ${error?.publicError?.detail || ''}`;
  return status === 429 || [408,425,500,502,503,504].includes(status) || /quota|rate limit|resource_exhausted|too many requests|timeout|temporar|overload|unavailable|network|fetch failed/i.test(message);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function scheduleGemini(task) {
  const run = async () => {
    const wait = Math.max(0, 1250 - (Date.now() - lastGeminiStartedAt));
    if (wait) await sleep(wait);
    lastGeminiStartedAt = Date.now();
    return task();
  };
  const result = geminiTail.then(run, run);
  geminiTail = result.catch(() => {});
  return result;
}

function descriptionQuality(text = '') {
  const plain = clean(text, PAPER_LIMIT);
  return { length: plain.length, sentences: sentenceCandidates(plain).length };
}
async function getInput({ url, title, description, mode }) {
  const q = descriptionQuality(description);
  const paperEnough = mode === 'papers' && q.length >= 520 && q.sentences >= 2;
  const fastEnough = mode !== 'papers' && q.length >= 180;
  if (fastEnough || paperEnough || !url) return { title, text: description || title, contentSource: 'rss' };
  try {
    const extracted = await extractArticleFromUrl(url, { maxTextLength: EXTRACT_LIMIT });
    const limit = mode === 'papers' ? PAPER_LIMIT : FAST_LIMIT;
    const text = clean(extracted?.text || '', limit);
    if (text.length < 120) throw new Error('本文が短すぎます');
    return { title: clean(extracted?.title || title, 500) || title, text, contentSource: extracted?.sourceType === 'pdf' ? 'pdf' : 'article' };
  } catch (error) {
    console.warn('[summary-v2182] article extraction fallback:', error?.message || error);
    return { title, text: description || title, contentSource: 'rss' };
  }
}

const responseSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    conclusion: { type: 'string' },
    background: { type: 'string' },
    impact: { type: 'string' }
  },
  required: ['headline','conclusion','background','impact'],
  additionalProperties: false
};

async function generateAi({ prompt, mode, inputTitle }) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await scheduleGemini(() => generateGemini({
        prompt,
        systemInstruction: 'モバイル向けニュース編集者。与えられた本文の具体情報だけを使い、3項目を自然な日本語で完結させる。抽象的な定型文は禁止。',
        maxOutputTokens: mode === 'papers' ? 620 : 500,
        responseSchema,
        timeoutMs: mode === 'papers' ? 10_000 : 8_000
      }));
      const parsed = JSON.parse(stripFence(result.text));
      const lines = [
        normalizeSentence(parsed?.conclusion, { allowEnglish: false }),
        normalizeSentence(parsed?.background, { allowEnglish: false }),
        normalizeSentence(parsed?.impact, { allowEnglish: false })
      ];
      if (!validThree(lines)) {
        const quality = new Error('AI要約の品質条件を満たしません');
        quality.code = 'QUALITY';
        throw quality;
      }
      return { result, parsed, lines };
    } catch (error) {
      lastError = error;
      if (attempt >= 1) break;
      if (error?.code === 'QUALITY') await sleep(700);
      else if (isTransient(error)) await sleep(1500);
      else throw error;
    }
  }
  throw lastError || new Error(`AI要約に失敗しました: ${inputTitle}`);
}

function cacheKey(body, title, description, mode) {
  const seed = `${mode}|${clean(body.url || body.link, 1000)}|${title}|${description.slice(0,2500)}|v2182`;
  let hash = 2166136261;
  for (const ch of seed) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

async function buildSummary(body) {
  const mode = clean(body.mode, 32);
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const category = clean(body.category, 120);
  const limit = mode === 'papers' ? PAPER_LIMIT : FAST_LIMIT;
  const description = clean(body.description, limit);
  const url = clean(body.url || body.link, 3000);
  const forceJapanese = Boolean(body.forceJapanese) || looksMostlyEnglish(`${title}\n${description}`);
  if (!title && !description && !url) { const error = new Error('要約する情報がありません'); error.statusCode = 400; throw error; }

  const input = await getInput({ url, title, description, mode });
  const inputTitle = input.title || title;
  const inputText = clean(input.text || description || inputTitle, limit);
  if (body.allowAi === false) return extractiveSummary({ title: inputTitle, text: inputText, mode, source, category, contentSource: input.contentSource, reason: 'ai-disabled', forceJapanese });

  const prompt = [
    `タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    '', '本文またはRSS抄録:', inputText || inputTitle, '',
    'この情報だけを根拠に、必ず自然な日本語でJSONを作成してください。',
    'conclusion: 最重要の具体的事実・結果を完結した1文。',
    'background: 背景・方法・対象・従来との差を完結した1文。',
    'impact: 本文に根拠のある影響・意味・用途・今後を完結した1文。',
    'headline: 核心が分かる18〜46文字程度。',
    '禁止: 「〜についての記事です」「背景を整理しています」「元記事で確認できます」などの定型文、本文にない推測、途中で切れた文。'
  ].filter(Boolean).join('\n');

  try {
    const { result, parsed, lines } = await generateAi({ prompt, mode, inputTitle });
    return buildResponse({
      headline: normalizeHeadline(parsed?.headline, inputTitle),
      lines: lines.map(emphasize), provider: 'gemini', model: result.model,
      mode, source, category, contentSource: input.contentSource, cacheable: true
    });
  } catch (error) {
    console.warn('[summary-v2182] article fallback:', error?.statusCode, error?.message);
    return extractiveSummary({
      title: inputTitle, text: inputText, mode, source, category, contentSource: input.contentSource,
      reason: isTransient(error) ? 'transient-gemini-v2182' : 'gemini-quality-v2182', forceJapanese
    });
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
  const body = bodyOf(req);
  const mode = clean(body.mode, 32);
  const title = clean(body.title, 500);
  const description = clean(body.description, mode === 'papers' ? PAPER_LIMIT : FAST_LIMIT);
  const key = cacheKey(body, title, description, mode);
  const hit = memoryCache.get(key);
  if (hit) return res.status(200).json({ ...hit, cache: 'server-memory-v2182' });
  try {
    if (!inFlight.has(key)) inFlight.set(key, buildSummary(body).finally(() => inFlight.delete(key)));
    const value = await inFlight.get(key);
    if (value?.cacheable !== false) {
      memoryCache.set(key, value);
      while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
    }
    return res.status(200).json(value);
  } catch (error) {
    if (Number(error?.statusCode) === 400) return res.status(400).json({ error: error.message });
    console.error('[summary-v2182] handler:', error);
    return res.status(200).json(insufficientSummary({ title, mode, source: clean(body.source,180), category: clean(body.category,120), reason: 'server-fallback-v2182' }));
  }
}
