import { generateGemini } from '../lib/gemini.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';

const MAX_RSS_INPUT = 7200;
const MAX_AI_INPUT = 30000;
const MAX_EXTRACT = 180000;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value, max = MAX_RSS_INPUT) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function splitSentences(text = '') {
  const normalized = clean(text, MAX_AI_INPUT);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?])\s+|(?:\n+)|(?<=。)(?=[^」』])/)
    .map(v => v.trim())
    .filter(v => v.length >= 12)
    .slice(0, 24);
}

function fullSentence(value = '') {
  // v2.14.2: 文字数で文章の途中を切って「…」を付けない。
  // 要約に採用した1文は最後までそのまま表示する。
  return clean(value, MAX_AI_INPUT);
}

function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.4;
}

function localSummary({ title, description, reason = 'local', forceJapanese = false, contentSource = 'rss' }) {
  if (forceJapanese && looksMostlyEnglish(`${title}\n${description}`)) {
    return {
      short: '日本語要約の生成に一時的に失敗しました。再取得するとAI翻訳をもう一度試します。',
      points: [],
      why: '',
      provider: 'local',
      model: '',
      contentSource,
      extractedLength: String(description || '').length,
      aiInputLength: 0,
      fastPath: 'japanese-safe-fallback',
      fallbackReason: reason,
      resolvedTitle: clean(title, 1000)
    };
  }

  const sentences = splitSentences(description);
  const fallbackTitle = clean(title, 500);
  const short = fullSentence(sentences[0] || fallbackTitle || '要約できる本文がありません。');

  const points = [];
  for (const sentence of sentences.slice(1)) {
    const point = fullSentence(sentence);
    if (!point || points.includes(point) || point === short) continue;
    points.push(point);
    if (points.length >= 4) break;
  }

  if (!points.length && fallbackTitle && fallbackTitle !== short) points.push(fullSentence(fallbackTitle));

  return {
    short,
    points,
    why: '',
    provider: 'local',
    model: '',
    contentSource,
    extractedLength: String(description || '').length,
    aiInputLength: 0,
    fastPath: 'local-fast',
    fallbackReason: reason,
    resolvedTitle: clean(title, 1000)
  };
}

function pageText(page) {
  if (typeof page === 'string') return page;
  return String(page?.text || page?.content || '');
}

function sampledPdfText(extracted) {
  const pages = Array.isArray(extracted?.pages) ? extracted.pages : [];
  if (!pages.length) return clean(extracted?.text, MAX_AI_INPUT);

  const picked = new Set();
  const add = index => {
    if (index >= 0 && index < pages.length) picked.add(index);
  };

  // Abstract/冒頭を厚めに。
  for (let i = 0; i < Math.min(5, pages.length); i += 1) add(i);

  // 結論・考察・結果らしきページ。
  pages.forEach((page, index) => {
    const text = pageText(page);
    if (/abstract|要旨|概要|results?|結果|discussion|考察|conclusions?|結論|summary|まとめ/i.test(text)) add(index);
  });

  // 長い論文でも中間を均等サンプリング。
  if (pages.length > 10) {
    for (const ratio of [.28, .5, .72]) add(Math.floor((pages.length - 1) * ratio));
  }

  // 終盤。
  for (let i = Math.max(0, pages.length - 4); i < pages.length; i += 1) add(i);

  let out = '';
  for (const index of [...picked].sort((a, b) => a - b)) {
    const text = clean(pageText(pages[index]), 8500);
    if (!text) continue;
    const piece = `\n\n[PDF ${index + 1}ページ]\n${text}`;
    if (out.length + piece.length > MAX_AI_INPUT) break;
    out += piece;
  }
  return out.trim() || clean(extracted?.text, MAX_AI_INPUT);
}

function sampledArticleText(extracted) {
  if (extracted?.sourceType === 'pdf' || Array.isArray(extracted?.pages)) return sampledPdfText(extracted);
  const text = String(extracted?.text || '');
  if (text.length <= MAX_AI_INPUT) return clean(text, MAX_AI_INPUT);

  const head = text.slice(0, 18000);
  const middleStart = Math.max(0, Math.floor(text.length * .52) - 3000);
  const middle = text.slice(middleStart, middleStart + 6000);
  const tail = text.slice(-6000);
  return clean(`${head}\n\n[中盤]\n${middle}\n\n[終盤]\n${tail}`, MAX_AI_INPUT);
}

const responseSchema = {
  type: 'object',
  properties: {
    short: { type: 'string', description: '記事の核心を日本語で自然な1〜2文にまとめる。文の途中で省略記号を付けて切らない。' },
    points: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', description: '重要点を自然な完結した文で書く。文字数都合で文中を切らない。' }
    }
  },
  required: ['short', 'points'],
  additionalProperties: false
};

function isQuotaError(err) {
  return Number(err?.statusCode) === 429 || /quota|rate limit|resource_exhausted|too many requests/i.test(String(err?.message || ''));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = bodyOf(req);
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const description = clean(body.description, MAX_RSS_INPUT);
  const url = String(body.url || body.link || '').trim().slice(0, 3000);
  const mode = String(body.mode || '').trim();
  const likelyPdfUrl = /\.pdf(?:$|[?#])/i.test(url);
  const preferFullText = body.preferFullText === true || mode === 'papers' || likelyPdfUrl;
  const forceJapanese = body.forceJapanese === true || looksMostlyEnglish(`${title}\n${description}`);
  // 英語おすすめは端末側AI予算を超えていても、生の英語を出さないため翻訳を1回優先する。
  const allowAi = forceJapanese ? true : body.allowAi !== false;

  if (!title && !description && !url) return res.status(400).json({ error: '要約する情報がありません' });

  let inputTitle = title;
  let inputText = description || title;
  let contentSource = 'rss';
  let extractedLength = inputText.length;
  let pdfPageCount = 0;
  let pdfUrl = '';
  let extractError = '';

  if (preferFullText && url) {
    try {
      const extracted = await extractArticleFromUrl(url, { maxTextLength: MAX_EXTRACT, preferPdf: true });
      if (extracted?.text) {
        inputTitle = clean(extracted.title || title, 500);
        inputText = sampledArticleText(extracted);
        contentSource = extracted.sourceType === 'pdf' || Array.isArray(extracted.pages) ? 'pdf' : 'article';
        extractedLength = String(extracted.text || '').length;
        if (contentSource === 'pdf') {
          pdfPageCount = Array.isArray(extracted.pages) ? extracted.pages.length : Number(extracted.pageCount || 0);
          pdfUrl = String(extracted.pdfUrl || extracted.articleUrl || extracted.url || url || '');
        }
      }
    } catch (error) {
      extractError = String(error?.message || error);
      console.warn('[summary-v2142] full-text fallback:', extractError, url);
    }
  }

  if (!allowAi) {
    return res.status(200).json(localSummary({
      title: inputTitle,
      description: inputText,
      reason: 'client-budget',
      forceJapanese,
      contentSource
    }));
  }

  const prompt = [
    `タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    url ? `URL: ${url}` : '',
    `入力種別: ${contentSource === 'pdf' ? 'PDF本文の重要ページ抜粋' : contentSource === 'article' ? 'リンク先本文' : 'RSS本文・抄録'}`,
    '',
    '本文・抄録:',
    clean(inputText, MAX_AI_INPUT) || inputTitle,
    '',
    '上の情報だけを根拠に、日本語で読みやすく要約してください。',
    '原文が英語でも、shortとpointsは必ず自然な日本語へ翻訳してください。',
    'shortは核心を自然な1〜2文で完結させてください。pointsは追加の重要点を最大4件。',
    '文字数を合わせるために文の途中を「…」「...」で切ることは禁止です。必ず文末まで書いてください。',
    '前置き、一般論、同じ内容の言い換え、推測は不要です。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: '忙しい人が短時間で理解できる日本語要約。事実を増やさず、各文を必ず最後まで完結させる。文字数都合の省略記号による途中切断は禁止。',
      maxOutputTokens: 520,
      responseSchema,
      timeoutMs: contentSource === 'pdf' ? 22000 : 14000
    });

    let parsed;
    try { parsed = JSON.parse(stripFence(result.text)); }
    catch {
      return res.status(200).json(localSummary({
        title: inputTitle,
        description: inputText,
        reason: 'invalid-ai-json',
        forceJapanese,
        contentSource
      }));
    }

    return res.status(200).json({
      short: clean(parsed.short, 2400),
      points: Array.isArray(parsed.points) ? parsed.points.slice(0, 4).map(v => clean(v, 2400)).filter(Boolean) : [],
      why: '',
      provider: 'gemini',
      model: result.model,
      contentSource,
      extractedLength,
      aiInputLength: Math.min(String(inputText || '').length, MAX_AI_INPUT),
      fastPath: contentSource === 'pdf' ? 'pdf-sampled-ai' : contentSource === 'article' ? 'article-sampled-ai' : 'rss-ai',
      fallbackReason: '',
      pdfPageCount,
      pdfUrl,
      extractError,
      resolvedTitle: inputTitle || title
    });
  } catch (err) {
    console.warn('[summary-v2142] Gemini unavailable, using local summary:', err?.statusCode, err?.message);
    return res.status(200).json(localSummary({
      title: inputTitle,
      description: inputText,
      reason: isQuotaError(err) ? 'quota' : 'gemini-unavailable',
      forceJapanese,
      contentSource
    }));
  }
}
