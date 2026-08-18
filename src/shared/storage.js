const PREFIX = 'pdv2:';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

export function save(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent('pdv2:storage', { detail: { key, value } }));
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
