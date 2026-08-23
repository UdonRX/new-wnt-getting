export function asciiHeaderValue(value = '', maxLength = 900) {
  const text = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!text) return '';

  let encoded = '';
  try {
    encoded = encodeURIComponent(text);
  } catch {
    encoded = Buffer.from(text, 'utf8').toString('base64url');
  }
  return encoded.slice(0, Math.max(32, Number(maxLength) || 900));
}

export function setAsciiHeader(res, name, value, maxLength = 900) {
  const encoded = asciiHeaderValue(value, maxLength);
  if (!encoded) return false;
  res.setHeader(String(name), encoded);
  return true;
}

export function summaryServerErrorCode(error) {
  const code = String(error?.code || '').trim();
  if (/^[A-Z0-9_.-]{2,80}$/.test(code)) return code;

  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('gemini_api_key')) return 'GEMINI_API_KEY_MISSING';
  if (message.includes('quota') || message.includes('resource_exhausted')) return 'GEMINI_QUOTA';
  if (message.includes('timeout') || message.includes('timed out')) return 'SUMMARY_TIMEOUT';
  if (message.includes('invalid character in header')) return 'INVALID_HEADER_VALUE';
  return 'SUMMARY_SERVER_ERROR';
}
