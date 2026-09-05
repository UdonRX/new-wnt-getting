const DB_NAME = 'pdv2-instagram-cache';
const DB_VERSION = 1;
const STORE = 'accounts';
const MAX_ITEMS_PER_ACCOUNT = 96;

let dbPromise = null;
const memoryFallback = new Map();

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'username' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function sanitizeMedia(media) {
  if (!media || typeof media !== 'object') return null;
  return {
    kind: media.kind === 'video' ? 'video' : 'image',
    url: String(media.url || ''),
    posterUrl: String(media.posterUrl || ''),
    highResUrl: String(media.highResUrl || ''),
    shortcode: String(media.shortcode || ''),
    width: Number.isFinite(Number(media.width)) ? Number(media.width) : null,
    height: Number.isFinite(Number(media.height)) ? Number(media.height) : null,
    qualityResolvedAt: Number.isFinite(Number(media.qualityResolvedAt)) ? Number(media.qualityResolvedAt) : null
  };
}

function sanitizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const account = item.account || {};
  const media = Array.isArray(item.media) ? item.media.map(sanitizeMedia).filter(Boolean) : [];
  return {
    source: 'instagram',
    account: {
      username: String(account.username || ''),
      profileUrl: String(account.profileUrl || ''),
      avatarUrl: String(account.avatarUrl || '')
    },
    id: String(item.id || ''),
    externalId: item.externalId == null ? null : String(item.externalId),
    shortcode: item.shortcode == null ? null : String(item.shortcode),
    text: String(item.text || ''),
    timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : null,
    timestampIso: item.timestampIso ? String(item.timestampIso) : null,
    media,
    mediaType: String(item.mediaType || 'image'),
    permalink: String(item.permalink || ''),
    reelPermalink: item.reelPermalink ? String(item.reelPermalink) : null
  };
}

function sanitizeRecord(record) {
  const username = String(record?.username || '').trim().toLowerCase();
  if (!username) return null;
  const seen = new Set();
  const items = (Array.isArray(record?.items) ? record.items : [])
    .map(sanitizeItem)
    .filter(item => {
      if (!item) return false;
      const key = item.id || `${item.account?.username}:${item.shortcode}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_ITEMS_PER_ACCOUNT);
  return {
    username,
    items,
    nextCursor: String(record?.nextCursor || ''),
    checkedAt: Number.isFinite(Number(record?.checkedAt)) ? Number(record.checkedAt) : 0,
    updatedAt: Number.isFinite(Number(record?.updatedAt)) ? Number(record.updatedAt) : Date.now(),
    version: 1
  };
}

function idbGet(db, username) {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(username);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(db, record) {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function idbDelete(db, username) {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(username);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function idbKeys(db) {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result.map(String) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function readInstagramCaches(usernames) {
  const names = [...new Set((usernames || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  if (!names.length) return new Map();

  const result = new Map();
  const missing = [];

  // Re-renders and SNS mode switches should never wait for IndexedDB when the same
  // sanitized record is already in memory.
  for (const username of names) {
    const memory = sanitizeRecord(memoryFallback.get(username));
    if (memory) result.set(username, memory);
    else missing.push(username);
  }
  if (!missing.length) return result;

  const db = await openDb();
  if (!db) return result;

  // The previous implementation awaited one IndexedDB transaction per account in series.
  // Read independent account records together so 10+ registrations do not add startup
  // latency linearly.
  const records = await Promise.all(missing.map(async username => {
    const raw = await idbGet(db, username);
    return [username, sanitizeRecord(raw)];
  }));

  for (const [username, record] of records) {
    if (!record) continue;
    result.set(username, record);
    memoryFallback.set(username, record);
  }
  return result;
}

export async function writeInstagramCache(record) {
  const clean = sanitizeRecord(record);
  if (!clean) return false;
  memoryFallback.set(clean.username, clean);
  const db = await openDb();
  if (!db) return true;
  return idbPut(db, clean);
}

export async function deleteInstagramCachesExcept(usernames) {
  const allowed = new Set((usernames || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
  for (const key of [...memoryFallback.keys()]) if (!allowed.has(key)) memoryFallback.delete(key);
  const db = await openDb();
  if (!db) return;
  const keys = await idbKeys(db);
  await Promise.all(keys.filter(key => !allowed.has(key)).map(key => idbDelete(db, key)));
}

export function isInstagramCacheFresh(record, ttlMs) {
  const checkedAt = Number(record?.checkedAt || 0);
  return Boolean(checkedAt && Date.now() - checkedAt < Math.max(0, Number(ttlMs) || 0));
}
