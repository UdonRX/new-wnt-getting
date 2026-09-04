const DB_NAME = 'personal-dashboard-x-cache';
const DB_VERSION = 1;
const POST_STORE = 'posts';
const META_STORE = 'meta';
const META_KEY = 'timeline';

export const X_CACHE_LIMIT = 100;
export const X_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise = null;
let warned = false;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[x-indexeddb-cache]', error?.message || error);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(POST_STORE)) db.createObjectStore(POST_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  }).catch(error => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function stringValue(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function safeHttpUrl(value) {
  const raw = stringValue(value).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://x.com/');
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function canonicalIdentityUrl(value) {
  const href = safeHttpUrl(value);
  if (!href) return '';
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'twitter.com' || host.endsWith('.twitter.com')) url.hostname = 'x.com';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href.toLowerCase();
  } catch {
    return href.toLowerCase();
  }
}

function sanitizeAuthor(author = {}) {
  return {
    name: stringValue(author?.name).trim(),
    handle: stringValue(author?.handle).trim(),
    avatar: safeHttpUrl(author?.avatar),
    profileUrl: safeHttpUrl(author?.profileUrl)
  };
}

function sanitizeMedia(media) {
  if (!Array.isArray(media)) return [];
  return media.slice(0, 12).map(entry => {
    const type = entry?.type === 'video' ? 'video' : entry?.type === 'image' ? 'image' : '';
    if (!type) return null;
    const url = safeHttpUrl(entry?.url);
    const poster = safeHttpUrl(entry?.poster);
    if (!url && !poster) return null;
    return { type, url, poster };
  }).filter(Boolean);
}

function sanitizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return [...new Set(links.map(safeHttpUrl).filter(Boolean))].slice(0, 24);
}

function sanitizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const id = stringValue(quote.id).trim();
  const url = safeHttpUrl(quote.url);
  const text = stringValue(quote.text);
  const media = sanitizeMedia(quote.media);
  const links = sanitizeLinks(quote.links);
  const author = sanitizeAuthor(quote.author);
  if (!id && !url && !text && !media.length) return null;
  return {
    id,
    url,
    createdAt: stringValue(quote.createdAt).trim(),
    author,
    text,
    media,
    links
  };
}

function postTime(createdAt, cachedAt) {
  const parsed = Date.parse(stringValue(createdAt));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : cachedAt;
}

function recordAliases(record) {
  const aliases = [];
  if (record.id) aliases.push(`id:${record.id}`);
  const url = canonicalIdentityUrl(record.url);
  if (url) aliases.push(`url:${url}`);
  return aliases;
}

function sanitizePost(post, cachedAt) {
  if (!post || typeof post !== 'object') return null;
  const id = stringValue(post.id).trim();
  const url = safeHttpUrl(post.url);
  const aliases = [];
  if (id) aliases.push(`id:${id}`);
  const canonical = canonicalIdentityUrl(url);
  if (canonical) aliases.push(`url:${canonical}`);
  if (!aliases.length) return null;

  const savedAt = Number.isFinite(Number(cachedAt)) && Number(cachedAt) > 0 ? Number(cachedAt) : Date.now();
  const createdAt = stringValue(post.createdAt).trim();
  return {
    key: aliases[0],
    id,
    url,
    createdAt,
    author: sanitizeAuthor(post.author),
    text: stringValue(post.text),
    media: sanitizeMedia(post.media),
    quote: sanitizeQuote(post.quote),
    links: sanitizeLinks(post.links),
    cachedAt: savedAt,
    sortAt: postTime(createdAt, savedAt)
  };
}

function mergeRecords(incoming, existing, now = Date.now()) {
  const cutoff = now - X_CACHE_RETENTION_MS;
  const seen = new Set();
  const output = [];

  for (const record of [...incoming, ...existing]) {
    if (!record || record.sortAt < cutoff) continue;
    const aliases = recordAliases(record);
    if (!aliases.length || aliases.some(alias => seen.has(alias))) continue;
    aliases.forEach(alias => seen.add(alias));
    record.key = aliases[0];
    output.push(record);
  }

  output.sort((a, b) => (b.sortAt - a.sortAt) || (b.cachedAt - a.cachedAt) || String(b.id).localeCompare(String(a.id)));
  return output.slice(0, X_CACHE_LIMIT);
}

function publicPost(record) {
  return {
    id: record.id,
    url: record.url,
    createdAt: record.createdAt,
    author: record.author,
    text: record.text,
    media: record.media,
    quote: record.quote,
    links: record.links
  };
}

async function readRaw(db) {
  const transaction = db.transaction([POST_STORE, META_STORE], 'readonly');
  const done = transactionDone(transaction);
  const postsRequest = transaction.objectStore(POST_STORE).getAll();
  const metaRequest = transaction.objectStore(META_STORE).get(META_KEY);
  const [posts, meta] = await Promise.all([requestResult(postsRequest), requestResult(metaRequest)]);
  await done;
  return {
    posts: Array.isArray(posts) ? posts : [],
    fetchedAt: Number(meta?.fetchedAt || 0)
  };
}

async function replaceAll(db, records, fetchedAt) {
  const transaction = db.transaction([POST_STORE, META_STORE], 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(POST_STORE);
  store.clear();
  records.forEach(record => store.put(record));
  transaction.objectStore(META_STORE).put({ key: META_KEY, fetchedAt: Number(fetchedAt || 0) });
  await done;
}

function prepareStored(records, now) {
  return (Array.isArray(records) ? records : [])
    .map(record => sanitizePost(record, record?.cachedAt))
    .filter(Boolean)
    .map(record => ({ ...record, sortAt: Number(record.sortAt || postTime(record.createdAt, record.cachedAt)) }))
    .filter(record => Number.isFinite(record.sortAt) && record.sortAt >= now - X_CACHE_RETENTION_MS);
}

export async function readXPostCache() {
  const now = Date.now();
  try {
    const db = await openDb();
    const raw = await readRaw(db);
    const prepared = prepareStored(raw.posts, now);
    const records = mergeRecords([], prepared, now);
    const rawKeys = new Set(raw.posts.map(record => String(record?.key || '')).filter(Boolean));
    const needsCleanup = records.length !== raw.posts.length || records.some(record => !rawKeys.has(record.key));
    if (needsCleanup) {
      try {
        await replaceAll(db, records, raw.fetchedAt);
      } catch (error) {
        warnOnce(error);
      }
    }
    return { available: true, posts: records.map(publicPost), fetchedAt: raw.fetchedAt };
  } catch (error) {
    warnOnce(error);
    return { available: false, posts: [], fetchedAt: 0 };
  }
}

export async function writeXPostCache(posts, { fetchedAt = Date.now() } = {}) {
  const now = Date.now();
  const savedAt = Number.isFinite(Number(fetchedAt)) && Number(fetchedAt) > 0 ? Number(fetchedAt) : now;
  const incoming = mergeRecords(
    (Array.isArray(posts) ? posts : []).map(post => sanitizePost(post, savedAt)).filter(Boolean),
    [],
    now
  );
  const immediatePosts = incoming.map(publicPost);

  try {
    const db = await openDb();
    const raw = await readRaw(db);
    const existing = prepareStored(raw.posts, now);
    const records = mergeRecords(incoming, existing, now);
    await replaceAll(db, records, savedAt);
    return { available: true, saved: true, posts: records.map(publicPost), fetchedAt: savedAt };
  } catch (error) {
    warnOnce(error);
    return { available: false, saved: false, posts: immediatePosts, fetchedAt: savedAt };
  }
}
