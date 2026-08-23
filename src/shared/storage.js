const PREFIX = 'pdv2:';

function quotaExceeded(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota.*exceeded/i.test(message);
}

export function reclaimLocalCacheSpace(preserveKey = '') {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch { return; }

  const removable = keys.filter(key => key !== preserveKey && (
    key.startsWith('pdv2:readerCache:') ||
    key.startsWith('pdv2:weatherCache:') ||
    key === 'reader-summary-cache-v2180' ||
    key === 'pdv2:paperTitleJa'
  ));

  for (const key of removable) {
    try { localStorage.removeItem(key); } catch {}
  }
}

export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!quotaExceeded(error)) return false;
    reclaimLocalCacheSpace(key);
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

export function save(key, value) {
  const stored = safeSetItem(PREFIX + key, JSON.stringify(value));
  if (stored) window.dispatchEvent(new CustomEvent('pdv2:storage', { detail: { key, value } }));
  return stored;
}

export function remove(key) { localStorage.removeItem(PREFIX + key); }

export function exportAll() {
  const data = { version: 2, exportedAt: new Date().toISOString(), values: {} };
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try { data.values[key.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(key)); }
    catch { data.values[key.slice(PREFIX.length)] = localStorage.getItem(key); }
  }
  return data;
}

export function importAll(payload) {
  if (!payload || Number(payload.version) !== 2 || typeof payload.values !== 'object') {
    throw new Error('Dashboard V2の設定ファイルではありません');
  }
  Object.entries(payload.values).forEach(([key, value]) => save(key, value));
}
