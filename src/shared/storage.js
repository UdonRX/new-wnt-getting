const PREFIX = 'pdv2:';
const CACHE_DB_NAME = 'pdv2-cache-v1';
const CACHE_DB_VERSION = 1;
const CACHE_STORE = 'cache';
let cacheDbPromise = null;

function quotaExceeded(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota.*exceeded/i.test(message);
}

function openCacheDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cacheDbPromise) return cacheDbPromise;

  cacheDbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDBを開けませんでした'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  }).catch(error => {
    cacheDbPromise = null;
    throw error;
  });

  return cacheDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function readIndexedCache(key) {
  const db = await openCacheDb();
  if (!db) return { found: false, value: null };
  const tx = db.transaction(CACHE_STORE, 'readonly');
  const record = await idbRequest(tx.objectStore(CACHE_STORE).get(String(key)));
  return record ? { found: true, value: record.value } : { found: false, value: null };
}

async function writeIndexedCache(key, value) {
  const db = await openCacheDb();
  if (!db) return false;
  const tx = db.transaction(CACHE_STORE, 'readwrite');
  tx.objectStore(CACHE_STORE).put({ key: String(key), value, updatedAt: Date.now() });
  await idbTransactionDone(tx);
  return true;
}

async function deleteIndexedCache(key) {
  const db = await openCacheDb();
  if (!db) return false;
  const tx = db.transaction(CACHE_STORE, 'readwrite');
  tx.objectStore(CACHE_STORE).delete(String(key));
  await idbTransactionDone(tx);
  return true;
}

function parseLegacyCache(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

export function reclaimLocalCacheSpace(preserveKey = '') {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch { return; }

  // IndexedDBへ移した旧キャッシュを最優先で削除する。
  // AI要約キャッシュは小さいため、Quota対策で巻き添え削除しない。
  const removable = keys.filter(key => key !== preserveKey && (
    key.startsWith('pdv2:readerCache:') ||
    key === 'pdv2:readerCache:papers'
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

/**
 * 容量の大きい記事・翻訳キャッシュ用。
 * IndexedDBを主保存先にし、初回アクセス時は旧localStorageから自動移行する。
 */
export async function cacheGet(key, { migrateLegacy = true } = {}) {
  try {
    const indexed = await readIndexedCache(key);
    if (indexed.found) return indexed.value;
  } catch (error) {
    console.warn('[storage] IndexedDB read failed', key, error?.message || error);
  }

  if (!migrateLegacy) return null;

  let raw = null;
  try { raw = localStorage.getItem(String(key)); } catch {}
  if (raw == null) return null;
  const legacy = parseLegacyCache(raw);

  try {
    if (await writeIndexedCache(key, legacy)) {
      try { localStorage.removeItem(String(key)); } catch {}
    }
  } catch (error) {
    console.warn('[storage] legacy cache migration failed', key, error?.message || error);
  }
  return legacy;
}

export async function cacheSet(key, value, { removeLegacy = true } = {}) {
  try {
    if (await writeIndexedCache(key, value)) {
      if (removeLegacy) {
        try { localStorage.removeItem(String(key)); } catch {}
      }
      return true;
    }
  } catch (error) {
    console.warn('[storage] IndexedDB write failed; using localStorage fallback', key, error?.message || error);
  }

  // IndexedDBが使えないブラウザだけ従来方式へフォールバック。
  return safeSetItem(String(key), JSON.stringify(value));
}

export async function cacheDelete(key) {
  try { await deleteIndexedCache(key); } catch {}
  try { localStorage.removeItem(String(key)); } catch {}
}

/**
 * 旧版で肥大化した記事・論文タイトルキャッシュをバックグラウンド移行し、
 * SafariのlocalStorage容量を起動直後に開放する。
 */
export async function migrateLargeLocalCaches() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('pdv2:readerCache:') || key === 'pdv2:readerCache:papers' || key === 'pdv2:paperTitleJa')) keys.push(key);
    }
  } catch { return { migrated: 0, failed: 0 }; }

  let migrated = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      const value = parseLegacyCache(raw);
      if (await writeIndexedCache(key, value)) {
        localStorage.removeItem(key);
        migrated += 1;
      } else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed };
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
