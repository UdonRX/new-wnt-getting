import { generateGemini } from '../lib/gemini.mjs';

const MAX_INPUT = 7000;

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

const responseSchema = {
  type: 'object',
  properties: {
    short: { type: 'string', description: '記事の核心を日本語で60〜100文字。1〜2文。' },
    points: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', description: '重要点を1項目35〜70文字程度。' }
    }
  },
  required: ['short', 'points'],
  additionalProperties: false
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = bodyOf(req);
  const title = clean(body.title, 500);
  const source = clean(body.source, 180);
  const description = clean(body.description, MAX_INPUT);

  if (!title && !description) return res.status(400).json({ error: '要約する情報がありません' });

  /*
   * V2.9: 初回表示の待ち時間を短くするため、RSS本文・抄録を優先して要約する。
   * ニュースはRSS説明、論文はAPIから得たabstractが入っているため、
   * 毎回リンク先HTML/PDFを取得するよりかなり速い。
   */
  const prompt = [
    `タイトル: ${title || '不明'}`,
    source ? `媒体: ${source}` : '',
    '',
    '本文・抄録:',
    description || title,
    '',
    '上の情報だけを根拠に、日本語で短く要約してください。',
    '長い前置き、一般論、重複は不要です。',
    'shortは核心だけを60〜100文字。pointsは本当に重要な点だけ最大3件。',
    '情報が不足する場合は推測で補わないでください。'
  ].filter(Boolean).join('\n');

  try {
    const result = await generateGemini({
      prompt,
      systemInstruction: '忙しい人向けの超短縮ニュース・論文要約。事実を増やさず、短く明快にする。',
      maxOutputTokens: 260,
      responseSchema,
      timeoutMs: 16000
    });

    let parsed;
    try { parsed = JSON.parse(stripFence(result.text)); }
    catch {
      return res.status(502).json({ error: 'AI要約の形式が不正でした', detail: '再取得してください。' });
    }

    return res.status(200).json({
      short: clean(parsed.short, 180),
      points: Array.isArray(parsed.points) ? parsed.points.slice(0, 3).map(v => clean(v, 120)).filter(Boolean) : [],
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
    console.error('[summary-v29]', err);
    const payload = err?.publicError || {
      error: 'Gemini要約APIとの通信に失敗しました',
      detail: err?.message || 'VercelのFunctionsログを確認してください。'
    };
    return res.status(err?.statusCode || 500).json(payload);
  }
}
