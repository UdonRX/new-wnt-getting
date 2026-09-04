import rss from './rss.mjs';

const LIST_ID = '2087706843519111304';
const LIST_PATH = `/twitter/list/${LIST_ID}`;
const RSS_URL = `https://diygod-x.onrender.com${LIST_PATH}`;
// DIYgod_X persistent-history.ts uses xxhash-wasm h64ToString(path) (XXH64, seed 0).
const HISTORY_KEY = 'rsshub:history:v1:7930682cb6c0217b';
const HISTORY_MAX = 100;
const REDIS_TIMEOUT_MS = 3500;
// twitter.js currently persists warmed XML only below 420 kB. Keep Redis RSS safely inside that budget.
const MAX_RSS_BYTES = 400_000;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function isXHistoryRequest(req) {
  const raw = String(first(req?.query?.url) || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username && !url.password && (!url.port || url.port === '443') &&
      url.hostname.toLowerCase() === 'diygod-x.onrender.com' &&
      url.pathname.replace(/\/+$/, '') === LIST_PATH &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

function xmlEscape(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cdata(value = '') {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function firstAuthor(author) {
  const value = Array.isArray(author) ? author[0] : author;
  if (typeof value === 'string') return { name: value, url: '', avatar: '' };
  if (!value || typeof value !== 'object') return { name: '', url: '', avatar: '' };
  return {
    name: String(value.name || value.title || ''),
    url: String(value.url || value.link || value.uri || ''),
    avatar: String(value.avatar || value.image || value.icon || '')
  };
}

function extraLinks(item) {
  const links = Array.isArray(item?._extra?.links) ? item._extra.links : [];
  return links
    .filter(link => link && typeof link === 'object')
    .map(link => ({
      type: String(link.type || '').trim(),
      url: String(link.url || link.link || '').trim()
    }))
    .filter(link => link.type || link.url)
    .slice(0, 8);
}

function itemIdentity(item, index) {
  const stable = item?.guid || item?.id || item?.link;
  if (stable) return String(stable);
  return `${String(item?.title || '')}\u0000${String(item?.pubDate || item?.updated || '')}\u0000${String(item?.description || '')}\u0000${index}`;
}

function historyItemsFromStored(value) {
  if (value == null) return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.item) ? parsed.item : [];
  const seen = new Set();
  const output = [];
  source.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const identity = itemIdentity(item, index);
    if (seen.has(identity)) return;
    seen.add(identity);
    output.push(item);
  });
  return output.slice(0, HISTORY_MAX);
}

function serializeItem(item, index) {
  const author = firstAuthor(item?.author);
  const link = String(item?.link || item?.guid || '');
  const guid = String(item?.guid || item?.id || link || `x-history-${index}`);
  const pubDate = String(item?.pubDate || item?.updated || '');
  const categories = Array.isArray(item?.category) ? item.category : item?.category ? [item.category] : [];
  const extras = extraLinks(item);

  return [
    '<item>',
    `<title>${cdata(item?.title || '')}</title>`,
    link ? `<link>${xmlEscape(link)}</link>` : '',
    `<guid isPermaLink="false">${cdata(guid)}</guid>`,
    pubDate ? `<pubDate>${xmlEscape(pubDate)}</pubDate>` : '',
    '<author>',
    `<name>${cdata(author.name)}</name>`,
    author.url ? `<url>${xmlEscape(author.url)}</url>` : '',
    author.avatar ? `<avatar>${xmlEscape(author.avatar)}</avatar>` : '',
    '</author>',
    `<description>${cdata(item?.description || '')}</description>`,
    ...categories.slice(0, 12).map(category => `<category>${cdata(category)}</category>`),
    ...extras.map(row => `<x-extra-link${row.type ? ` type="${xmlEscape(row.type)}"` : ''}${row.url ? ` href="${xmlEscape(row.url)}"` : ''}/>`),
    '</item>'
  ].filter(Boolean).join('');
}

function historyRss(items) {
  const prefix = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>X history - ${LIST_ID}</title><link>https://x.com/i/lists/${LIST_ID}</link><description>Saved X timeline history</description><lastBuildDate>${xmlEscape(new Date().toUTCString())}</lastBuildDate>`;
  const suffix = '</channel></rss>';
  const parts = [];
  let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);

  for (let index = 0; index < items.length && parts.length < HISTORY_MAX; index += 1) {
    const serialized = serializeItem(items[index], index);
    const nextBytes = Buffer.byteLength(serialized);
    if (parts.length > 0 && bytes + nextBytes > MAX_RSS_BYTES) break;
    parts.push(serialized);
    bytes += nextBytes;
  }

  return { xml: prefix + parts.join('') + suffix, count: parts.length };
}

async function readRedisHistory() {
  const restUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!restUrl || !token) throw new Error('Upstash Redis credentials are not configured');

  const response = await fetch(restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(['GET', HISTORY_KEY]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new Error(`Upstash Redis read failed (${response.status})`);

  const items = historyItemsFromStored(payload?.result);
  if (!items.length) throw new Error('Upstash Redis history is empty');
  return items;
}

function fallbackRequest(req) {
  if (isXHistoryRequest(req)) return req;
  const proxy = Object.create(req || null);
  proxy.query = { ...(req?.query || {}), url: RSS_URL };
  return proxy;
}

function setHistoryHeaders(res, source, count = null) {
  res.setHeader('X-X-History-Source', source);
  if (Number.isFinite(count)) res.setHeader('X-X-History-Items', String(count));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const items = await readRedisHistory();
    const { xml, count } = historyRss(items);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    setHistoryHeaders(res, 'redis', count);
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).send(xml);
  } catch (error) {
    console.warn('[x-history] Redis unavailable; using normal RSS fallback', error?.message || String(error));
    setHistoryHeaders(res, 'rss-fallback');
    return rss(fallbackRequest(req), res);
  }
}
