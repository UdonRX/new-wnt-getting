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

function stripMarkdown(value = '') {
  return String(value || '').replace(/\*\*/g, '').trim();
}

function visibleLength(value = '') {
  return Array.from(stripMarkdown(value)).length;
}

function clampMarkdown(value = '', maxVisible = 40) {
  const source = clean(value, 2400).replace(/\*{3,}/g, '**');
  let out = '';
  let visible = 0;
  let boldOpen = false;
  for (let i = 0; i < source.length && visible < maxVisible;) {
    if (source.startsWith('**', i)) {
      out += '**';
      boldOpen = !boldOpen;
      i += 2;
      continue;
    }
    const code = source.codePointAt(i);
    const ch = String.fromCodePoint(code);
    out += ch;
    visible += 1;
    i += ch.length;
  }
  if (boldOpen) out += '**';
  return out.replace(/\*\*\s*\*\*/g, '').trim();
}

function clampPlain(value = '', maxVisible = 40) {
  return Array.from(stripMarkdown(clean(value, 2400))).slice(0, maxVisible).join('').trim();
}

function emphasizeNumbers(value = '') {
  return String(value || '').replace(/(?<!\*)([0-9０-９]+(?:[.,．，][0-9０-９]+)?(?:%|％|倍|件|人|年|円|ドル|万|億|兆|℃|度|nm|mm|cm|km|GB|TB|W|kW|MW|GW)?)(?!\*)/g, '**$1**');
}

function normalizeTag(value = '') {
  const raw = stripMarkdown(clean(value, 80)).replace(/^#+/, '').replace(/[\s　]+/g, '');
  return raw ? `#${raw}` : '';
}

function categoryTag(mode = '', category = '') {
  const value = String(category || '').trim();
  if (value) return normalizeTag(value);
  if (mode === 'news') return '#最新ニュース';
  if (mode === 'knowledge') return '#専門知識';
  if (mode === 'papers') return '#研究';
  return '#おすすめ';
}

function splitSentences(text = '') {
  const normalized = clean(text, MAX_AI_INPUT);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?])\s+|(?:\n+)|(?<=。)(?=[^」』])/) 
    .map(v => v.trim())
    .filter(v => v.length >= 8)
    .slice(0, 30);
}

function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.4;
}

function localSummary({ title, description, reason = 'local', forceJapanese = false, contentSource = 'rss', mode = '', category = '', source = '' }) {
  if (forceJapanese && looksMostlyEnglish(`${title}\n${description}`)) {
    const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);
    return {
      headline: '日本語要約を再取得してください',
      lines: [
        { label: '結論/事実', text: '日本語要約の生成に一時的に失敗しました。' },
        { label: '背景/特徴', text: '原文は英語のため、生文のまま表示しません。' },
        { label: '影響/展望', text: '再取得するとAI翻訳をもう一度試します。' }
      ],
      tags,
      short: '日本語要約の生成に一時的に失敗しました。',
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
  const originalTitle = clean(title, 500) || '記事のポイント';
  const headline = clampPlain(originalTitle, 35) || '記事のポイント';
  const conclusion = clampMarkdown(emphasizeNumbers(sentences[0] || originalTitle), 40) || '記事の中心となる内容を確認できます。';
  const background = clampMarkdown(emphasizeNumbers(sentences[1] || '背景や特徴は原文で詳しく確認できます。'), 40);
  const impact = clampMarkdown(emphasizeNumbers(sentences[2] || '今後の動きや影響に注目が必要です。'), 40);
  const tags = [categoryTag(mode, category), source ? normalizeTag(source) : ''].filter(Boolean).slice(0, 3);

  return {
    headline,
    lines: [
      { label: '結論/事実', text: conclusion },
      { label: '背景/特徴', text: background },
      { label: '影響/展望', text: impact }
    ],
    tags,
    short: stripMarkdown(conclusion),
    points: [background, impact].map(stripMarkdown).filter(Boolean),
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

  for (let i = 0; i < Math.min(5, pages.length); i += 1) add(i);

  pages.forEach((page, index) => {
    const text = pageText(page);
    if (/abstract|要旨|概要|results?|結果|discussion|考察|conclusions?|結論|summary|まとめ/i.test(text)) add(index);
  });

  if (pages.length > 10) {
    for (const ratio of [.28, .5, .72]) add(Math.floor((pages.length - 1) * ratio));
  }

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
    headline: {
      type: 'string',
      description: '35文字以内の日本語タイトル。結論や最もインパクトのある事実を先頭に置く。重要な数値や固有名詞は**太字**にしてよい。'
    },
    conclusion: {
      type: 'string',
      description: '40文字以内の1文。何が起きた・発表されたかを明確に。重要な数値や固有名詞は**太字**。'
    },
    background: {
      type: 'string',
      description: '40文字以内の1文。なぜ重要か、仕組みや理由を平易に説明。重要な数値や固有名詞は**太字**。'
    },
    impact: {
      type: 'string',
      description: '40文字以内の1文。今後の影響や展望を具体的に。重要な数値や固有名詞は**太字**。'
    },
    tags: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', description: '#から始まる短い日本語タグ。最大3つ。' }
    }
  },
  required: ['headline', 'conclusion', 'background', 'impact', 'tags'],
  additionalProperties: false
};

function isQuotaError(err) {
  return Number(err?.statusCode) === 429 || /quota|rate limit|resource_exhausted|too many requests/i.test(String(err?.message || ''));
}

function normalizeAiSummary(parsed, { title, mode, category, source }) {
  const headline = clampMarkdown(parsed?.headline || title || '記事のポイント', 35) || '記事のポイント';
  const conclusion = clampMarkdown(parsed?.conclusion || '', 40) || '記事の中心となる事実を確認できます。';
  const background = clampMarkdown(parsed?.background || '', 40) || '背景や仕組みを短く整理しています。';
  const impact = clampMarkdown(parsed?.impact || '', 40) || '今後の影響や展開に注目が必要です。';
  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const tags = [...new Set([
    categoryTag(mode, category),
    ...rawTags.map(normalizeTag).filter(Boolean)
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
    points: [background, impact].map(stripMarkdown)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = bodyOf(req);
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const category = clean(body.category, 80);
  const description = clean(body.description, MAX_RSS_INPUT);
  const url = String(body.url || body.link || '').trim().slice(0, 3000);
  const mode = String(body.mode || '').trim();
  const likelyPdfUrl = /\.pdf(?:$|[?#])/i.test(url);
  const preferFullText = body.preferFullText === true || mode === 'papers' || likelyPdfUrl;
  const forceJapanese = body.forceJapanese === true || looksMostlyEnglish(`${title}\n${description}`);
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
      console.warn('[summary-v2144] full-text fallback:', extractError, url);
    }
  }

  if (!allowAi) {
    return res.status(200).json(localSummary({
      title: inputTitle,
      description: inputText,
      reason: 'client-budget',
      forceJapanese,
      contentSource,
      mode,
      category,
      source
    }));
  }

  const prompt = [
    `元タイトル: ${inputTitle || '不明'}`,
    source ? `媒体: ${source}` : '',
    category ? `カテゴリ: ${category}` : '',
    url ? `URL: ${url}` : '',
    `入力種別: ${contentSource === 'pdf' ? 'PDF本文の重要ページ抜粋' : contentSource === 'article' ? 'リンク先本文' : 'RSS本文・抄録'}`,
    '',
    '本文・抄録:',
    clean(inputText, MAX_AI_INPUT) || inputTitle,
    '',
    '上の情報だけを根拠に、おすすめフィード用の日本語要約をJSONで作成してください。',
    '',
    '【必須フォーマット】',
    '1. headline: 最大35文字。結論や最もインパクトのある事実を先頭に置き、思わず手を止めたくなるタイトルへ打ち直す。',
    '2. conclusion: 最大40文字・1文。何が起きたのか、何が発表されたのかを明確にする。',
    '3. background: 最大40文字・1文。なぜ重要か、仕組みや理由を説明する。',
    '4. impact: 最大40文字・1文。今後どうなるか、社会や技術への変化を書く。',
    '5. tags: 内容を表すタグを最大3個。必ず # から始める。',
    '',
    '【文章ルール】',
    '・原文が英語でも、すべて自然な日本語へ翻訳する。',
    '・難解な専門用語は、日常的な例えや平易な言葉に噛み砕く。特に論文、製品・熱研究、独創研究では専門家向けの言い回しを避ける。',
    '・重要な数値と重要な固有名詞は Markdown の **太字** で強調する。',
    '・事実を足したり推測したりしない。本文にない将来予測を断定しない。',
    '・文字数を合わせるために「…」「...」で途中省略しない。各文を短く言い換えて制限内に収める。',
    '・同じ内容を3行で言い換えない。結論→背景→影響の役割を明確に分ける。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: 'モバイル向けニュース編集者。35文字タイトルと40文字以内の3行要約を、平易で正確な日本語にする。重要な数値・固有名詞は**太字**。省略記号で文を切らない。',
      maxOutputTokens: 620,
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
        contentSource,
        mode,
        category,
        source
      }));
    }

    const normalized = normalizeAiSummary(parsed, { title: inputTitle, mode, category, source });

    return res.status(200).json({
      ...normalized,
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
      resolvedTitle: inputTitle || title,
      limits: { headline: 35, line: 40, tags: 3 }
    });
  } catch (err) {
    console.warn('[summary-v2144] Gemini unavailable, using local summary:', err?.statusCode, err?.message);
    return res.status(200).json(localSummary({
      title: inputTitle,
      description: inputText,
      reason: isQuotaError(err) ? 'quota' : 'gemini-unavailable',
      forceJapanese,
      contentSource,
      mode,
      category,
      source
    }));
  }
}
