import { extractArticleFromUrl } from '../lib/article-reader.mjs';
import { generateGemini } from '../lib/gemini.mjs';

const MAX_ARTICLE_TEXT = 60000;
const MAX_PDF_EXTRACT_TEXT = 180000;
const PDF_DIRECT_INPUT_LIMIT = 32000;
const PDF_PAGE_SLICE_LIMIT = 6500;

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function pageScore(page, totalPages) {
  const text = String(page?.text || '');
  const pageNumber = Number(page?.pageNumber || 0);
  let score = 0;

  if (pageNumber <= 2) score += 12;
  if (pageNumber >= Math.max(1, totalPages - 1)) score += 10;

  const important = [
    /(?:抄録|要旨|概要|abstract)/i,
    /(?:結果|results?)/i,
    /(?:考察|discussion)/i,
    /(?:結論|結語|まとめ|conclusions?)/i,
    /(?:目的|objective|purpose)/i,
    /(?:方法|実験|method|materials?)/i
  ];

  important.forEach((pattern, index) => {
    if (pattern.test(text)) score += index <= 3 ? 9 : 4;
  });

  return score;
}

function buildFastPdfInput(extracted) {
  const fullText = String(extracted?.text || '').trim();
  const pages = Array.isArray(extracted?.pages) ? extracted.pages.filter(page => page?.text) : [];

  if (fullText.length <= PDF_DIRECT_INPUT_LIMIT || pages.length <= 4) {
    return {
      text: fullText.slice(0, PDF_DIRECT_INPUT_LIMIT),
      aiInputLength: Math.min(fullText.length, PDF_DIRECT_INPUT_LIMIT),
      fastPath: fullText.length > PDF_DIRECT_INPUT_LIMIT ? 'pdf-truncated' : 'pdf-direct'
    };
  }

  const totalPages = Number(extracted?.pageCount || pages.length || 0);
  const selected = new Map();
  const addPage = page => {
    if (!page?.pageNumber || !page?.text) return;
    selected.set(page.pageNumber, page);
  };

  // 冒頭・末尾は必ず含める。
  pages.slice(0, 2).forEach(addPage);
  pages.slice(-2).forEach(addPage);

  // 論文の中心となるセクションを優先。
  [...pages]
    .sort((a, b) => pageScore(b, totalPages) - pageScore(a, totalPages))
    .slice(0, 5)
    .forEach(addPage);

  // 長い論文の中盤を完全に落とさないよう、全体から均等サンプル。
  [0.25, 0.5, 0.75].forEach(ratio => {
    const target = Math.max(1, Math.round(totalPages * ratio));
    const closest = pages.reduce((best, page) => {
      if (!best) return page;
      return Math.abs(page.pageNumber - target) < Math.abs(best.pageNumber - target) ? page : best;
    }, null);
    addPage(closest);
  });

  const ordered = [...selected.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  const chunks = [];
  let used = 0;

  for (const page of ordered) {
    if (used >= PDF_DIRECT_INPUT_LIMIT) break;
    const header = `【PDF ${page.pageNumber}ページ】\n`;
    const room = PDF_DIRECT_INPUT_LIMIT - used - header.length;
    if (room <= 0) break;
    const body = String(page.text || '').slice(0, Math.min(PDF_PAGE_SLICE_LIMIT, room));
    if (!body) continue;
    const chunk = `${header}${body}`;
    chunks.push(chunk);
    used += chunk.length + 2;
  }

  const text = chunks.join('\n\n');
  return {
    text: text || fullText.slice(0, PDF_DIRECT_INPUT_LIMIT),
    aiInputLength: (text || fullText.slice(0, PDF_DIRECT_INPUT_LIMIT)).length,
    fastPath: 'pdf-key-pages'
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = getBody(req);
  const article = body.article || body;
  const rssTitle = clampText(article.title, 500);
  const rssDescription = clampText(article.description, 12000);
  const source = clampText(article.source, 200);
  const url = clampText(article.url || article.link, 3000);

  if (!rssTitle && !rssDescription && !url) {
    return res.status(400).json({ error: '要約する記事データがありません' });
  }

  let articleTitle = rssTitle;
  let articleText = rssDescription;
  let contentSource = 'rss';
  let articleMeta = null;
  let extractionError = '';
  let aiInputLength = articleText.length;
  let fastPath = 'rss';

  if (url) {
    try {
      articleMeta = await extractArticleFromUrl(url, {
        maxTextLength: MAX_PDF_EXTRACT_TEXT,
        preferPdf: true
      });

      if (articleMeta?.text) {
        articleTitle = articleMeta.title || rssTitle;

        if (articleMeta.sourceType === 'pdf') {
          const prepared = buildFastPdfInput(articleMeta);
          articleText = prepared.text;
          aiInputLength = prepared.aiInputLength;
          fastPath = prepared.fastPath;
          contentSource = 'pdf';
        } else {
          articleText = articleMeta.text.slice(0, MAX_ARTICLE_TEXT);
          aiInputLength = articleText.length;
          fastPath = 'article-direct';
          contentSource = 'article';
        }
      }
    } catch (err) {
      extractionError = err?.message || '記事全文を取得できませんでした';
      console.warn('[summary] article/PDF extraction fallback:', extractionError, url);
    }
  }

  if (!articleText) {
    return res.status(422).json({
      error: '記事本文を取得できませんでした',
      detail: extractionError || undefined
    });
  }

  const sourceLabel = contentSource === 'pdf'
    ? '【PDF本文から抽出した要約用テキスト】'
    : contentSource === 'article'
      ? '【リンク先から抽出した記事本文】'
      : '【RSS本文（リンク先本文を取得できなかったためフォールバック）】';

  const pdfNote = contentSource === 'pdf'
    ? [
        `PDFページ数: ${Number(articleMeta?.pageCount || 0) || '不明'}`,
        `PDF抽出文字数: ${Number(articleMeta?.originalLength || 0).toLocaleString()}`,
        fastPath === 'pdf-key-pages'
          ? '長いPDFのため、全文を読み取った上で抄録・結果・考察・結論・冒頭/末尾・全体の均等サンプルを優先して要約入力に使用しています。'
          : 'PDF本文を直接要約入力に使用しています。'
      ].join('\n')
    : '';

  const prompt = [
    source ? `配信元: ${source}` : '',
    url ? `元記事URL: ${url}` : '',
    articleTitle ? `タイトル: ${articleTitle}` : '',
    pdfNote,
    `${sourceLabel}\n${articleText}`
  ].filter(Boolean).join('\n\n');

  const systemInstruction = [
    'あなたは日本語のニュース・論文要約アシスタントです。',
    '提供された本文だけを根拠に要約してください。本文にない事実を追加・推測しないでください。',
    '論文の場合は、可能な範囲で「目的・方法・主な結果・結論/示唆」が分かるように重要ポイントを作ってください。',
    '長いPDFでは重要ページを抽出したテキストが与えられる場合があります。入力に含まれない箇所の内容を推測しないでください。',
    '広告、ナビゲーション、定型フッター、参考文献一覧そのものは重要ポイントに含めないでください。',
    'shortは本文の核心を1〜2文で、5秒程度で理解できる日本語にしてください。',
    'whyは「なぜ今読む価値があるか」を本文の範囲内で1〜2文にしてください。過度に煽らないでください。',
    'pointsは重要度の高い順に3〜4項目。各項目は簡潔な1文にしてください。'
  ].join('\n');

  const responseSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      short: {
        type: 'string',
        description: '5秒程度で理解できる1〜2文の要約'
      },
      why: {
        type: 'string',
        description: '本文から分かる、今読む価値・重要性を1〜2文で説明'
      },
      points: {
        type: 'array',
        minItems: 3,
        maxItems: 4,
        items: { type: 'string' },
        description: '重要度の高い順の重要ポイント'
      }
    },
    required: ['short', 'why', 'points']
  };

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction,
      maxOutputTokens: 520,
      responseSchema,
      timeoutMs: contentSource === 'pdf' ? 40000 : 30000
    });

    let summary;
    try {
      summary = JSON.parse(stripCodeFence(result.text));
    } catch (err) {
      console.error('[summary] Gemini JSON parse error:', result.text);
      return res.status(502).json({
        error: 'Gemini要約の形式が不正でした',
        detail: 'もう一度要約ボタンを押してください。'
      });
    }

    return res.status(200).json({
      short: clampText(summary.short, 900),
      why: clampText(summary.why, 900),
      points: Array.isArray(summary.points)
        ? summary.points.slice(0, 4).map(point => clampText(point, 500)).filter(Boolean)
        : [],
      provider: 'gemini',
      model: result.model,
      contentSource,
      extractedLength: contentSource === 'pdf'
        ? Number(articleMeta?.originalLength || articleText.length)
        : articleText.length,
      aiInputLength,
      fastPath,
      pdfPageCount: contentSource === 'pdf' ? Number(articleMeta?.pageCount || 0) : 0,
      pdfUrl: contentSource === 'pdf' ? (articleMeta?.pdfUrl || articleMeta?.url || '') : '',
      articleTitle: articleTitle || rssTitle,
      articleMeta: articleMeta ? {
        siteName: articleMeta.siteName || '',
        byline: articleMeta.byline || '',
        publishedTime: articleMeta.publishedTime || '',
        truncated: Boolean(articleMeta.truncated),
        originalLength: articleMeta.originalLength || articleText.length,
        finalUrl: articleMeta.articleUrl || articleMeta.url || url,
        sourceType: articleMeta.sourceType || 'html',
        pageCount: articleMeta.pageCount || 0,
        pdfUrl: articleMeta.pdfUrl || ''
      } : null,
      fallbackReason: contentSource === 'rss'
        ? extractionError || 'リンク先本文を取得できませんでした'
        : articleMeta?.pdfFallbackReason || ''
    });
  } catch (err) {
    console.error('[summary] Gemini request failed:', err);
    const payload = err?.publicError || {
      error: 'Gemini要約APIとの通信に失敗しました',
      detail: err?.message || 'VercelのFunctionsログを確認してください。'
    };
    return res.status(err?.statusCode || 500).json(payload);
  }
}
