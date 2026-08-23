import { extractArticleFromUrl } from '../lib/article-reader.mjs';
import { generateGemini } from '../lib/gemini.mjs';

const MAX_ARTICLE_TEXT = 60000;

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

function formatHistory(history) {
  if (!Array.isArray(history)) return '';
  return history
    .slice(-8)
    .map(message => {
      const role = message?.role === 'assistant' ? 'AI' : 'ユーザー';
      const content = clampText(message?.content, 1500);
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = getBody(req);
  const question = clampText(body.question, 2000);
  const article = body.article || {};
  const summary = body.summary || {};

  if (!question) {
    return res.status(400).json({ error: '質問を入力してください' });
  }

  const rssTitle = clampText(article.title, 500);
  const rssDescription = clampText(article.description, 12000);
  const source = clampText(article.source, 200);
  const url = clampText(article.url || article.link, 3000);
  const catchcopy = clampText(summary.catchcopy, 500);
  const points = Array.isArray(summary.points)
    ? summary.points.slice(0, 4).map(point => clampText(point, 800)).filter(Boolean)
    : [];

  let articleTitle = rssTitle;
  let articleText = rssDescription;
  let contentSource = 'rss';

  if (url) {
    try {
      const extracted = await extractArticleFromUrl(url, { maxTextLength: MAX_ARTICLE_TEXT });
      if (extracted?.text) {
        articleTitle = extracted.title || rssTitle;
        articleText = extracted.text;
        contentSource = 'article';
      }
    } catch (err) {
      console.warn('[chat] article extraction fallback:', err?.message || err, url);
    }
  }

  const historyText = formatHistory(body.history);
  const prompt = [
    '【対象記事】',
    source ? `配信元: ${source}` : '',
    url ? `元記事URL: ${url}` : '',
    articleTitle ? `タイトル: ${articleTitle}` : '',
    articleText
      ? `${contentSource === 'article' ? 'リンク先から抽出した記事本文' : 'RSS本文'}:\n${articleText}`
      : '',
    catchcopy ? `要約キャッチコピー: ${catchcopy}` : '',
    points.length ? `要約ポイント:\n- ${points.join('\n- ')}` : '',
    historyText ? `\n【これまでの会話】\n${historyText}` : '',
    `\n【今回の質問】\n${question}`
  ].filter(Boolean).join('\n\n');

  const systemInstruction = [
    'あなたはニュース記事について質問に答える日本語アシスタントです。',
    '提供された対象記事本文と会話履歴を根拠に答えてください。',
    '記事本文だけでは断定できない場合は、そのことを明示してください。',
    '本文にない事実を、記事に書かれている事実であるかのように追加しないでください。',
    'ユーザーが求めない限り、回答は短く読みやすくしてください。',
    '箇条書きが適切な場合は2〜5項目程度にまとめてください。'
  ].join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction,
      maxOutputTokens: 1100
    });

    return res.status(200).json({
      answer: result.text,
      provider: 'gemini',
      model: result.model,
      contentSource
    });
  } catch (err) {
    console.error('[chat] Gemini request failed:', err);
    const payload = err?.publicError || {
      error: 'GeminiチャットAPIとの通信に失敗しました',
      detail: err?.message || 'VercelのFunctionsログを確認してください。'
    };
    return res.status(err?.statusCode || 500).json(payload);
  }
}
