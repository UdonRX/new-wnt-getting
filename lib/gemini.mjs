export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const LEGACY_GEMINI_MIN_START_GAP_MS = 4300;
const DEFAULT_GEMINI_RPM_LIMIT = 15;
const DEFAULT_GEMINI_GAP_GUARD_MS = 300;
const geminiStartQueue = [];
let geminiStartDraining = false;
let geminiQueueSequence = 0;
let lastGeminiStartAt = 0;

export function getGeminiModel() {
  return String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

function positiveNumber(value, fallback, { min = 0, max = 60_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function getGeminiMinStartGapMs() {
  const explicit = Number(process.env.GEMINI_MIN_START_GAP_MS);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.min(60_000, explicit);

  const hasRpmConfig = String(process.env.GEMINI_RPM_LIMIT || '').trim() !== '';
  const hasGuardConfig = String(process.env.GEMINI_START_GAP_GUARD_MS || '').trim() !== '';
  if (!hasRpmConfig && !hasGuardConfig) return LEGACY_GEMINI_MIN_START_GAP_MS;

  const rpmLimit = positiveNumber(process.env.GEMINI_RPM_LIMIT, DEFAULT_GEMINI_RPM_LIMIT, { min: 1, max: 600 });
  const guardMs = positiveNumber(process.env.GEMINI_START_GAP_GUARD_MS, DEFAULT_GEMINI_GAP_GUARD_MS, { min: 0, max: 5000 });
  return Math.max(0, Math.ceil(60_000 / rpmLimit) + guardMs);
}

function geminiRequestPriority(requestType = '') {
  const type = String(requestType || '').toLowerCase();
  if (type === 'display') return 0;
  if (type === 'prefetch') return 2;
  return 1;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function drainGeminiStartQueue() {
  if (geminiStartDraining) return;
  geminiStartDraining = true;
  try {
    while (geminiStartQueue.length) {
      const minStartGapMs = getGeminiMinStartGapMs();
      const waitMs = Math.max(0, minStartGapMs - (Date.now() - lastGeminiStartAt));
      if (waitMs) await sleep(waitMs);

      // Pick only when the slot is actually ready. A display request that arrives
      // while a queued prefetch is waiting therefore jumps ahead of that prefetch.
      geminiStartQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      const next = geminiStartQueue.shift();
      if (!next) continue;

      const startedAt = Date.now();
      lastGeminiStartAt = startedAt;
      next.resolve({
        queueWaitMs: Math.max(0, startedAt - next.enqueuedAt),
        startGapMs: minStartGapMs,
        queueDepth: geminiStartQueue.length,
        requestType: next.requestType,
        requestId: next.requestId
      });
    }
  } finally {
    geminiStartDraining = false;
    if (geminiStartQueue.length) queueMicrotask(() => { drainGeminiStartQueue().catch(() => {}); });
  }
}

export function waitForGeminiStartSlot({ requestType = 'background', requestId = '' } = {}) {
  const enqueuedAt = Date.now();
  return new Promise(resolve => {
    geminiStartQueue.push({
      requestType: String(requestType || 'background'),
      requestId: String(requestId || ''),
      priority: geminiRequestPriority(requestType),
      sequence: geminiQueueSequence++,
      enqueuedAt,
      resolve
    });
    drainGeminiStartQueue().catch(() => {});
  });
}

function textFromResponse(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map(part => part?.text || '').join('').trim();
}

function publicGeminiError(status, data = {}) {
  const apiMessage = String(data?.error?.message || '');
  const statusText = String(data?.error?.status || '');
  const haystack = `${apiMessage} ${statusText}`.toLowerCase();

  if (status === 400 && /(api key|api_key|key invalid|invalid.*key)/i.test(haystack)) {
    return { error: 'Gemini APIキーが無効です', detail: apiMessage || 'VercelのGEMINI_API_KEYを確認してください。' };
  }
  if (status === 401 || status === 403) {
    return { error: 'Gemini APIへのアクセスが拒否されました', detail: apiMessage || 'APIキーの権限・制限を確認してください。' };
  }
  if (status === 404) {
    return { error: 'Geminiモデルを利用できません', detail: `${getGeminiModel()} が利用可能か確認してください。 ${apiMessage}`.trim() };
  }
  if (status === 429) {
    return { error: 'Gemini APIのレート上限に達しました', detail: apiMessage || '少し時間を空けてもう一度試してください。' };
  }
  return { error: `Gemini APIエラー (HTTP ${status})`, detail: apiMessage ? apiMessage.slice(0, 700) : 'VercelのFunctionsログを確認してください。' };
}

async function postGenerate({ apiKey, model, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Gemini APIがタイムアウトしました。');
      timeoutErr.statusCode = 504;
      timeoutErr.publicError = { error: 'Gemini APIがタイムアウトしました。', detail: '少し時間を空けてもう一度試してください。' };
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload({ prompt, systemInstruction, maxOutputTokens, responseSchema, schemaMode = true }) {
  const generationConfig = { maxOutputTokens };
  if (responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    if (schemaMode) generationConfig.responseJsonSchema = responseSchema;
  }
  const payload = { contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }], generationConfig };
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: String(systemInstruction) }] };
  return payload;
}

export async function generateGemini({ prompt, systemInstruction = '', maxOutputTokens = 900, responseSchema = null, timeoutMs = 30000 }) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY が設定されていません。');
    err.statusCode = 500;
    err.publicError = { error: 'GEMINI_API_KEY が設定されていません。', detail: 'Vercel → Project → Settings → Environment Variables に GEMINI_API_KEY を追加し、再デプロイしてください。' };
    throw err;
  }

  await waitForGeminiStartSlot();
  const model = getGeminiModel();
  let payload = buildPayload({ prompt, systemInstruction, maxOutputTokens, responseSchema, schemaMode: true });
  let { response, data } = await postGenerate({ apiKey, model, payload, timeoutMs });

  // JSON Schemaだけが原因の400に限り、JSON MIMEを維持してschema指定なしで1回だけ再試行。
  if (!response.ok && response.status === 400 && responseSchema) {
    const message = String(data?.error?.message || '');
    if (!/(api key|api_key|key invalid|invalid.*key)/i.test(message)) {
      payload = buildPayload({ prompt, systemInstruction, maxOutputTokens, responseSchema, schemaMode: false });
      ({ response, data } = await postGenerate({ apiKey, model, payload, timeoutMs }));
    }
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || `Gemini API ${response.status}`);
    err.statusCode = response.status;
    err.publicError = publicGeminiError(response.status, data);
    throw err;
  }

  const text = textFromResponse(data);
  if (!text) {
    const err = new Error('Geminiから本文が返りませんでした。');
    err.statusCode = 502;
    err.publicError = { error: 'Geminiの応答が空でした', detail: 'もう一度試してください。' };
    throw err;
  }
  return { text, model, raw: data };
}

export function parseGeminiJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw);
}
