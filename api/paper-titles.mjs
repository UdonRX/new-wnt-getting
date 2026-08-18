import { generateGemini } from '../lib/gemini.mjs';

const MAX_TITLES = 50;
const CACHE_MAX = 1200;
const cache = new Map();

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function needsTranslation(title) {
  const text = normalizeSpace(title);
  if (!text) return false;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 8 && latin > japanese;
}

function setCached(original, ja) {
  if (!original || !ja) return;
  if (cache.has(original)) cache.delete(original);
  cache.set(original, ja);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function parseJson(text) {
  return JSON.parse(
    String(text || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const input = Array.isArray(req.body?.titles) ? req.body.titles : [];
  const titles = Array.from(new Set(input.map(normalizeSpace).filter(Boolean))).slice(0, MAX_TITLES);
  if (!titles.length) return res.status(200).json({ translations: [] });

  const results = [];
  const pending = [];

  for (const title of titles) {
    if (!needsTranslation(title)) {
      results.push({ original: title, ja: title });
      continue;
    }
    const cached = cache.get(title);
    if (cached) results.push({ original: title, ja: cached });
    else pending.push(title);
  }

  if (pending.length) {
    const indexed = pending.map((title, index) => `${index}\t${title}`).join('\n');
    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              index: { type: 'integer' },
              ja: { type: 'string' }
            },
            required: ['index', 'ja']
          }
        }
      },
      required: ['translations']
    };

    try {
      const result = await generateGemini({
        systemInstruction: [
          'あなたは学術論文タイトルの翻訳者です。',
          '英語を自然で簡潔な日本語の論文タイトルへ翻訳してください。',
          '要約・説明・注釈は追加しないでください。',
          '【Panasonic】のような先頭の企業ラベルはそのまま維持してください。',
          '固有名詞・型番・材料名・略語は必要に応じて原語を残してください。',
          '入力のindexは絶対に変更しないでください。'
        ].join('\n'),
        prompt: `次の論文タイトルを日本語へ翻訳してください。\n\n${indexed}`,
        maxOutputTokens: 7000,
        responseSchema,
        timeoutMs: 20_000
      });

      const parsed = parseJson(result.text);
      for (const entry of Array.isArray(parsed?.translations) ? parsed.translations : []) {
        const index = Number(entry?.index);
        const ja = normalizeSpace(entry?.ja);
        const original = pending[index];
        if (!Number.isInteger(index) || !original || !ja) continue;
        setCached(original, ja);
        results.push({ original, ja });
      }
    } catch (err) {
      // 翻訳が失敗しても一覧自体は英語原題で使えるよう200で返す。
      console.warn('[paper-titles] translation skipped:', err?.message || err);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ translations: results });
}
