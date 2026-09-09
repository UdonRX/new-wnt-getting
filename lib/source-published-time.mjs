import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 4;
const MAX_HTML_PREFIX_BYTES = 512 * 1024;
const GOOGLE_NEWS_BATCH_MAX_BYTES = 1024 * 1024;
const GOOGLE_NEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GOOGLE_NEWS_CACHE_MAX = 200;
const DEFAULT_STAGE_TIMEOUT_MS = 1300;

const googleNewsUrlCache = new Map();

function decodeHtml(value = '') {
  return String(value)
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16) || 0))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0))
    .trim();
}

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

function isPrivateIPv6(address) {
  const value = String(address).toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('2001:db8:') || value.startsWith('ff')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); }
  catch { throw new Error('invalid-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe-url');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('unsafe-port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private-host');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('private-address');
    return url;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => isPrivateAddress(row.address))) throw new Error('private-address');
  return url;
}

async function readPrefix(response, maxBytes = MAX_HTML_PREFIX_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes * 8) {
    // Large publisher pages are fine: only the prefix is needed for metadata.
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.subarray(0, maxBytes).toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = Buffer.from(value);
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      total += Math.min(chunk.length, remaining);
      if (chunk.length >= remaining) break;
    }
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch {}
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtmlPrefix(rawUrl, { timeoutMs = DEFAULT_STAGE_TIMEOUT_MS, maxBytes = MAX_HTML_PREFIX_BYTES } = {}) {
  let current = await assertPublicUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects >= MAX_REDIRECTS) throw new Error('redirect-failed');
        try { await response.body?.cancel?.(); } catch {}
        current = await assertPublicUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (type && !type.includes('html') && !type.includes('xml') && !type.includes('text/plain')) throw new Error('not-html');
      return { text: await readPrefix(response, maxBytes), finalUrl: current.href };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('redirect-failed');
}

function isGoogleNewsArticleUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname.toLowerCase() === 'news.google.com' && (
      url.pathname.startsWith('/rss/articles/') || url.pathname.startsWith('/articles/') || url.pathname.startsWith('/read/')
    );
  } catch { return false; }
}

function isGoogleOwnedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'google.com' || host.endsWith('.google.com') || host === 'gstatic.com' || host.endsWith('.gstatic.com') || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
}

function normalizeGoogleResolvedCandidate(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    let url = new URL(text);
    if (isGoogleOwnedHost(url.hostname)) {
      const wrapped = url.searchParams.get('url') || url.searchParams.get('q');
      if (wrapped && /^https?:\/\//i.test(wrapped)) url = new URL(wrapped);
    }
    return isGoogleOwnedHost(url.hostname) ? '' : url.href;
  } catch { return ''; }
}

function getGoogleNewsUrlCache(rawUrl) {
  const entry = googleNewsUrlCache.get(rawUrl);
  if (!entry) return '';
  if (Date.now() - entry.at > GOOGLE_NEWS_CACHE_TTL_MS) {
    googleNewsUrlCache.delete(rawUrl);
    return '';
  }
  return entry.url;
}

function setGoogleNewsUrlCache(rawUrl, resolvedUrl) {
  if (!rawUrl || !resolvedUrl) return;
  googleNewsUrlCache.set(rawUrl, { at: Date.now(), url: resolvedUrl });
  while (googleNewsUrlCache.size > GOOGLE_NEWS_CACHE_MAX) googleNewsUrlCache.delete(googleNewsUrlCache.keys().next().value);
}

function parseGoogleBatchexecuteResponse(rawText) {
  const text = String(rawText || '').replace(/^\)\]\}'\s*/, '').trim();
  if (!text) return '';
  const roots = [];
  try { roots.push(JSON.parse(text)); }
  catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[')) continue;
      try { roots.push(JSON.parse(trimmed)); } catch {}
    }
  }
  let resolved = '';
  function walk(value) {
    if (resolved || value == null) return;
    if (Array.isArray(value)) {
      if (value[1] === 'Fbv4je' && typeof value[2] === 'string') {
        try {
          const payload = JSON.parse(value[2]);
          const candidate = normalizeGoogleResolvedCandidate(payload?.[1]);
          if (candidate) { resolved = candidate; return; }
        } catch {}
      }
      value.forEach(walk);
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length < GOOGLE_NEWS_BATCH_MAX_BYTES) {
        try { walk(JSON.parse(trimmed)); } catch {}
      }
    }
  }
  roots.forEach(walk);
  return resolved;
}

function extractDataP(html = '') {
  const match = String(html).match(/<c-wiz\b[^>]*\bdata-p\s*=\s*(["'])([\s\S]*?)\1/i);
  return match?.[2] ? decodeHtml(match[2]) : '';
}

async function postGoogleNewsBatchexecute(dataP, refererUrl, timeoutMs) {
  const source = String(dataP || '').trim();
  if (!source) throw new Error('missing-data-p');
  let requestObject;
  try {
    const jsonText = source.includes('%.@.') ? source.replace('%.@.', '["garturlreq",') : source;
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed) || parsed.length < 8) throw new Error('invalid-data-p');
    requestObject = [...parsed.slice(0, -6), ...parsed.slice(-2)];
  } catch { throw new Error('invalid-data-p'); }
  const fReq = JSON.stringify([[['Fbv4je', JSON.stringify(requestObject), 'null', 'generic']]]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: '*/*',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6', Origin: 'https://news.google.com',
        Referer: refererUrl || 'https://news.google.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
      },
      body: new URLSearchParams({ 'f.req': fReq }).toString()
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > GOOGLE_NEWS_BATCH_MAX_BYTES) throw new Error('response-too-large');
    const resolved = parseGoogleBatchexecuteResponse(text);
    if (!resolved) throw new Error('publisher-url-not-found');
    return resolved;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('timeout');
    throw error;
  } finally { clearTimeout(timer); }
}

async function resolveGoogleNewsPublisherUrlLight(rawUrl, timeoutMs) {
  const original = String(rawUrl || '').trim();
  if (!isGoogleNewsArticleUrl(original)) return original;
  const cached = getGoogleNewsUrlCache(original);
  if (cached) return cached;

  const page = await fetchHtmlPrefix(original, { timeoutMs, maxBytes: MAX_HTML_PREFIX_BYTES });
  const direct = normalizeGoogleResolvedCandidate(page.finalUrl);
  if (direct) {
    const safe = await assertPublicUrl(direct);
    setGoogleNewsUrlCache(original, safe.href);
    return safe.href;
  }
  const dataP = extractDataP(page.text);
  const resolved = await postGoogleNewsBatchexecute(dataP, page.finalUrl, timeoutMs);
  const safe = await assertPublicUrl(resolved);
  setGoogleNewsUrlCache(original, safe.href);
  return safe.href;
}

function parseTimestamp(rawValue, now = Date.now()) {
  let value = decodeHtml(rawValue).replace(/\s+/g, ' ').trim();
  if (!value) return 0;
  const ja = value.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2})[:時]\s*(\d{1,2})分?)?/);
  if (ja) {
    const [, y, m, d, hh = '00', mm = '00'] = ja;
    value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;
  } else if (/^20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    value = `${value.replace(' ', 'T')}+09:00`;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const min = Date.UTC(2000, 0, 1);
  const max = Number(now) + 24 * 60 * 60 * 1000;
  return timestamp >= min && timestamp <= max ? timestamp : 0;
}

function attrsToMap(raw = '') {
  const out = {};
  String(raw).replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, key, a, b, c) => {
    out[String(key).toLowerCase()] = decodeHtml(a ?? b ?? c ?? '');
    return '';
  });
  return out;
}

function normalizePageImageUrl(rawValue = '', baseUrl = '') {
  const value = decodeHtml(rawValue).trim();
  if (!value || /^(?:data|blob|javascript):/i.test(value)) return '';
  try {
    const url = new URL(value, baseUrl || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch { return ''; }
}

function jsonLdImageCandidates(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonLdImageCandidates);
  if (typeof value === 'object') {
    return [value.url, value.contentUrl, value.thumbnailUrl].filter(Boolean).flatMap(jsonLdImageCandidates);
  }
  return [];
}

export function extractArticleImageFromHtml(html = '', { baseUrl = '' } = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (raw, method, weight) => {
    const url = normalizePageImageUrl(raw, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, method, weight });
  };

  const metaRe = /<meta\b([^>]*?)>/gi;
  let metaMatch;
  while ((metaMatch = metaRe.exec(String(html)))) {
    const attrs = attrsToMap(metaMatch[1]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content || '';
    if (!content) continue;
    if (key === 'og:image:secure_url') add(content, 'meta:og:image:secure_url', 110);
    else if (key === 'og:image') add(content, 'meta:og:image', 108);
    else if (key === 'twitter:image' || key === 'twitter:image:src') add(content, `meta:${key}`, 102);
    else if (key === 'image') add(content, 'meta:image', 74);
  }

  const linkRe = /<link\b([^>]*?)>/gi;
  let linkMatch;
  while ((linkMatch = linkRe.exec(String(html)))) {
    const attrs = attrsToMap(linkMatch[1]);
    if (String(attrs.rel || '').toLowerCase().split(/\s+/).includes('image_src')) add(attrs.href || '', 'link:image_src', 96);
  }

  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRe.exec(String(html)))) {
    const raw = scriptMatch[1].trim();
    if (!raw || raw.length > 1024 * 1024) continue;
    try {
      const root = JSON.parse(raw);
      const walk = value => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (typeof value !== 'object') return;
        const articleWeight = articleTypeWeight(value['@type']);
        if (value.image) jsonLdImageCandidates(value.image).forEach(image => add(image, 'json-ld:image', articleWeight ? 106 : 88));
        if (value.thumbnailUrl) add(value.thumbnailUrl, 'json-ld:thumbnailUrl', articleWeight ? 98 : 80);
        Object.values(value).forEach(child => { if (child && typeof child === 'object') walk(child); });
      };
      walk(root);
    } catch {}
  }

  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0] || null;
}

function articleTypeWeight(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => /(?:newsarticle|article|reportagenewsarticle|analysisnewsarticle)/i.test(String(type || ''))) ? 100 : 0;
}

export function extractPublishedDateFromHtml(html = '', { now = Date.now() } = {}) {
  const candidates = [];
  function add(raw, method, weight) {
    const timestamp = parseTimestamp(raw, now);
    if (timestamp) candidates.push({ timestamp, raw: decodeHtml(raw), method, weight });
  }

  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRe.exec(String(html)))) {
    const raw = scriptMatch[1].trim();
    if (!raw || raw.length > 1024 * 1024) continue;
    try {
      const root = JSON.parse(raw);
      const walk = value => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (typeof value !== 'object') return;
        if (value.datePublished) {
          const weight = articleTypeWeight(value['@type']) || (value.headline ? 90 : 70);
          add(value.datePublished, 'json-ld:datePublished', weight);
        }
        Object.values(value).forEach(child => { if (child && typeof child === 'object') walk(child); });
      };
      walk(root);
    } catch {}
  }

  const metaRe = /<meta\b([^>]*?)>/gi;
  let metaMatch;
  while ((metaMatch = metaRe.exec(String(html)))) {
    const attrs = attrsToMap(metaMatch[1]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content || attrs.datetime || '';
    if (!content) continue;
    if (key === 'article:published_time') add(content, 'meta:article:published_time', 98);
    else if (key === 'og:published_time') add(content, 'meta:og:published_time', 96);
    else if (/(?:datepublished|date-published|publishdate|publish_date|pubdate|parsely-pub-date|sailthru\.date)/i.test(key)) add(content, `meta:${key}`, 92);
    else if (key === 'date') add(content, 'meta:date', 65);
  }

  const timeRe = /<time\b([^>]*?)>/gi;
  let timeMatch;
  while ((timeMatch = timeRe.exec(String(html)))) {
    const attrs = attrsToMap(timeMatch[1]);
    const raw = attrs.datetime || '';
    if (!raw) continue;
    const hint = `${attrs.itemprop || ''} ${attrs.class || ''} ${attrs.id || ''}`.toLowerCase();
    if (/(?:modified|updated|update-date|lastmod)/i.test(hint)) continue;
    if (/datepublished/i.test(hint)) add(raw, 'time:datePublished', 94);
    else if (/(?:publish|published|entry-date|post-date|posted|article-date)/i.test(hint)) add(raw, 'time:published', 82);
    else add(raw, 'time:datetime', 50);
  }

  candidates.sort((a, b) => b.weight - a.weight || a.timestamp - b.timestamp);
  const best = candidates[0];
  return best ? { timestamp: best.timestamp, raw: best.raw, method: best.method } : null;
}

export async function resolveSourcePublishedTime(rawUrl, { stageTimeoutMs = DEFAULT_STAGE_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const publisherUrl = await resolveGoogleNewsPublisherUrlLight(rawUrl, stageTimeoutMs);
    const page = await fetchHtmlPrefix(publisherUrl, { timeoutMs: stageTimeoutMs, maxBytes: MAX_HTML_PREFIX_BYTES });
    const published = extractPublishedDateFromHtml(page.text);
    const image = extractArticleImageFromHtml(page.text, { baseUrl: page.finalUrl || publisherUrl });
    return {
      ok: Boolean(published?.timestamp),
      publisherUrl: page.finalUrl || publisherUrl,
      sourcePublishedTimestamp: Number(published?.timestamp || 0),
      sourcePublishedRaw: published?.raw || '',
      sourceDateMethod: published?.method || '',
      sourceImage: image?.url || '',
      sourceImageMethod: image?.method || '',
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false, publisherUrl: '', sourcePublishedTimestamp: 0, sourcePublishedRaw: '', sourceDateMethod: '',
      sourceImage: '', sourceImageMethod: '',
      elapsedMs: Date.now() - started, error: error?.message || String(error)
    };
  }
}
