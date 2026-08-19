import { generateGemini } from '../lib/gemini.mjs';

const MAX_INPUT = 6200;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value, max = MAX_INPUT) {
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
  const normalized = clean(text, MAX_INPUT);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?])\s+|(?:\n+)|(?<=。)(?=[^」』])/)
    .map(v => v.trim())
    .filter(v => v.length >= 12)
    .slice(0, 18);
}

function trimSentence(value, max = 92) {
  const text = clean(value, max + 24);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).replace(/[、,;；:\s]+$/g, '')}…`;
}

/*
 * Geminiを使えない時でもReader自体は止めないための軽量要約。
 * RSS本文/論文abstractに含まれる文だけを抜き出し、推測は加えない。
 */
function localSummary({ title, description, reason = 'local' }) {
  const sentences = splitSentences(description);
  const fallbackTitle = clean(title, 110);
  const short = trimSentence(sentences[0] || fallbackTitle || '要約できる本文がありません。', 96);

  const points = [];
  for (const sentence of sentences.slice(1)) {
    const point = trimSentence(sentence, 74);
    if (!point || points.includes(point) || point === short) continue;
    points.push(point);
    if (points.length >= 2) break;
  }

  if (!points.length && fallbackTitle && fallbackTitle !== short) {
    points.push(trimSentence(fallbackTitle, 74));
  }

  return {
    short,
    points,
    why: '',
    provider: 'local',
    model: '',
    contentSource: 'rss',
    extractedLength: clean(description).length,
    aiInputLength: 0,
    fastPath: 'rss-local-fast',
    fallbackReason: reason
  };
}

const responseSchema = {
  type: 'object',
  properties: {
    short: { type: 'string', description: '記事の核心を日本語で45〜85文字。1文中心。' },
    points: {
      type: 'array',
      maxItems: 2,
      items: { type: 'string', description: '重要点を1項目30〜65文字程度。' }
    }
  },
  required: ['short', 'points'],
  additionalProperties: false
};

function isQuotaError(err) {
  return Number(err?.statusCode) === 429 || /quota|rate limit|resource_exhausted|too many requests/i.test(String(err?.message || ''));
}

export default async function handler(req, res) {
  // POSTでもVercel/ブラウザ側で古い応答を使わないよう明示。
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = bodyOf(req);
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const description = clean(body.description, MAX_INPUT);
  const allowAi = body.allowAi !== false;

  if (!title && !description) return res.status(400).json({ error: '要約する情報がありません' });

  // 端末側の日次予算を超えた場合は、Geminiへ1リクエストも送らず即返す。
  if (!allowAi) {
    return res.status(200).json(localSummary({ title, description, reason: 'client-budget' }));
  }

  const prompt = [
    `タイトル: ${title || '不明'}`,
    source ? `媒体: ${source}` : '',
    '',
    '本文・抄録:',
    description || title,
    '',
    '上の情報だけを根拠に、日本語でかなり短く要約してください。',
    'shortは核心だけを45〜85文字。pointsは追加で重要な点を最大2件。',
    '前置き、一般論、同じ内容の言い換え、推測は不要です。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: '忙しい人が数十秒で読める超短縮要約。事実を増やさず、端的にする。',
      maxOutputTokens: 190,
      responseSchema,
      timeoutMs: 12000
    });

    let parsed;
    try { parsed = JSON.parse(stripFence(result.text)); }
    catch {
      return res.status(200).json(localSummary({ title, description, reason: 'invalid-ai-json' }));
    }

    return res.status(200).json({
      short: clean(parsed.short, 140),
      points: Array.isArray(parsed.points) ? parsed.points.slice(0, 2).map(v => clean(v, 100)).filter(Boolean) : [],
      why: '',
      provider: 'gemini',
      model: result.model,
      contentSource: 'rss',
      extractedLength: description.length,
      aiInputLength: Math.min(description.length, MAX_INPUT),
      fastPath: 'rss-abstract-fast',
      fallbackReason: ''
    });
  } catch (err) {
    console.warn('[summary-v210] Gemini unavailable, using local summary:', err?.statusCode, err?.message);

    // 429や一時障害をReaderへエラーとして返さない。
    // APIキー再設定中でも記事は読めるよう、常に200 + ローカル要約へフォールバック。
    return res.status(200).json(localSummary({
      title,
      description,
      reason: isQuotaError(err) ? 'quota' : 'gemini-unavailable'
    }));
  }
}
