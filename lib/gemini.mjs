export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export function getGeminiModel() {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function describeGeminiApiError(status, data) {
  const apiMessage = String(data?.error?.message || '').trim();
  const apiStatus = String(data?.error?.status || '').trim();

  if (status === 400 && /api key|API_KEY_INVALID|key not valid/i.test(apiMessage)) {
    return {
      error: 'Gemini APIキーが無効です。',
      detail: 'Vercelの GEMINI_API_KEY を確認し、保存後に再デプロイしてください。'
    };
  }

  if (status === 403) {
    return {
      error: 'Gemini APIへのアクセスが拒否されました。',
      detail: apiMessage || 'Google AI Studio側のAPIキー・プロジェクト設定を確認してください。'
    };
  }

  if (status === 404) {
    return {
      error: `Geminiモデル「${getGeminiModel()}」を利用できません。`,
      detail: 'Vercelの GEMINI_MODEL を削除するか、gemini-3.1-flash-lite を指定してください。'
    };
  }

  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    return {
      error: 'Gemini無料枠のレート上限に達しました。',
      detail: '課金を有効にしていない場合、料金は発生せずAPIが止まります。時間を空けて再試行してください。'
    };
  }

  return {
    error: `Gemini APIエラー (HTTP ${status})`,
    detail: apiMessage ? apiMessage.slice(0, 500) : 'VercelのFunctionsログを確認してください。'
  };
}

export async function generateGemini({
  prompt,
  systemInstruction = '',
  maxOutputTokens = 900,
  responseSchema = null,
  timeoutMs = 30000
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY が設定されていません。');
    err.statusCode = 500;
    err.publicError = {
      error: 'GEMINI_API_KEY が設定されていません。',
      detail: 'Vercel → Project → Settings → Environment Variables に GEMINI_API_KEY を追加し、再デプロイしてください。'
    };
    throw err;
  }

  const model = getGeminiModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const generationConfig = {
    maxOutputTokens
  };

  if (responseSchema) {
    // generateContent の安定した構造化JSON指定。Vercel上でも通常のREST形式を使う。
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = responseSchema;
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(prompt || '') }]
      }
    ],
    generationConfig
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: String(systemInstruction) }]
    };
  }

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Gemini APIがタイムアウトしました。');
      timeoutErr.statusCode = 504;
      timeoutErr.publicError = {
        error: 'Gemini APIがタイムアウトしました。',
        detail: '少し時間を空けてもう一度試してください。'
      };
      throw timeoutErr;
    }
    throw err;
  }

  clearTimeout(timer);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const publicError = describeGeminiApiError(response.status, data);
    const err = new Error(publicError.error);
    err.statusCode = 502;
    err.publicError = publicError;
    err.apiStatus = response.status;
    throw err;
  }

  const text = extractGeminiText(data);
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    const finishReason = data?.candidates?.[0]?.finishReason;
    const detail = blockReason
      ? `Geminiの安全フィルタ: ${blockReason}`
      : finishReason
        ? `Geminiの終了理由: ${finishReason}`
        : 'Geminiからテキストが返りませんでした。';

    const err = new Error('Geminiの回答が空でした。');
    err.statusCode = 502;
    err.publicError = { error: 'Geminiの回答が空でした。', detail };
    throw err;
  }

  return { text, data, model };
}
