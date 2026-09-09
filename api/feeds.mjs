import newsFeed from '../server/news-feed.mjs';
import instagramImage from '../server/instagram-image.mjs';
import instagramStories from '../server/instagram-stories.mjs';
import { instagramProfile, instagramVideo } from '../server/instagram.mjs';
import recommendations from '../server/recommendations-robust.mjs';
import rss from '../server/rss.mjs';
import twitchEventsub from '../server/twitch-eventsub.mjs';
import twitchFeed from '../server/twitch-feed.mjs';
import twitchOauth from '../server/twitch-oauth.mjs';
import weatherRain from '../server/weather-rain.mjs';
import xHistory, { isXHistoryRequest } from '../server/x-history.mjs';
import { resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

const READER_IMAGE_RESOLVE_TTL_MS = 30 * 60 * 1000;
const READER_IMAGE_NEGATIVE_TTL_MS = 90 * 1000;
const READER_IMAGE_RESOLVE_MAX = 180;
const READER_IMAGE_GDELT_TIMEOUT_MS = 1700;
const readerImageResolveCache = new Map();

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function compactLogValue(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function requestBody(req) {
  if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req?.body !== 'string') return {};
  try { return JSON.parse(req.body); } catch { return {}; }
}

function readerImageDiagnostic(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const body = requestBody(req);
  const log = {
    phase: compactLogValue(body.phase, 80) || 'unknown',
    articleId: compactLogValue(body.articleId, 700),
    title: compactLogValue(body.title, 260),
    source: compactLogValue(body.source, 120),
    imageUrl: compactLogValue(body.imageUrl, 1100),
    imageHost: compactLogValue(body.imageHost, 180),
    summaryProvider: compactLogValue(body.summaryProvider, 80),
    viewport: compactLogValue(body.viewport, 80),
    online: body.online !== false
  };
  console.warn('[reader-image]', log);
  return res.status(204).end();
}

function imageResolveCacheGet(link) {
  const entry = readerImageResolveCache.get(link);
  if (!entry) return null;
  const ttl = entry.value?.image ? READER_IMAGE_RESOLVE_TTL_MS : READER_IMAGE_NEGATIVE_TTL_MS;
  if (Date.now() - Number(entry.at || 0) > ttl) {
    readerImageResolveCache.delete(link);
    return null;
  }
  return entry.value || null;
}

function imageResolveCacheSet(link, value) {
  if (!link || !value) return;
  readerImageResolveCache.set(link, { at: Date.now(), value });
  while (readerImageResolveCache.size > READER_IMAGE_RESOLVE_MAX) {
    readerImageResolveCache.delete(readerImageResolveCache.keys().next().value);
  }
}

function hostOf(rawUrl = '') {
  try { return new URL(String(rawUrl || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function bareHost(rawHost = '') {
  return String(rawHost || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function sameSiteHost(a = '', b = '') {
  const aa = bareHost(a);
  const bb = bareHost(b);
  if (!aa || !bb) return false;
  return aa === bb || aa.endsWith(`.${bb}`) || bb.endsWith(`.${aa}`);
}

function normalizeHeadline(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function titleSimilarity(a = '', b = '') {
  const aa = normalizeHeadline(a);
  const bb = normalizeHeadline(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.length >= 12 && (aa.includes(bb) || bb.includes(aa))) {
    return Math.min(0.96, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + 0.22);
  }
  const grams = value => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const ga = grams(aa);
  const gb = grams(bb);
  if (!ga.size || !gb.size) return 0;
  let same = 0;
  for (const token of ga) if (gb.has(token)) same += 1;
  return (2 * same) / (ga.size + gb.size);
}

function gdeltQueryFromTitle(title = '') {
  return String(title || '').normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[【】「」『』（）()〈〉《》“”"'’‘,:：;；!?！？。・／/|｜―—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function safeHttpUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function resolveImageFromGdelt(title, publisherUrl = '') {
  const query = gdeltQueryFromTitle(title);
  if (query.length < 8) return { image: '', error: 'gdelt-query-too-short' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READER_IMAGE_GDELT_TIMEOUT_MS);
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&format=json&sort=HybridRel&timespan=72h`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'new-wnt-getting/1.0 (+reader-image-fallback)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const rows = Array.isArray(json?.articles) ? json.articles : [];
    const publisherHost = hostOf(publisherUrl);
    let best = null;

    for (const row of rows) {
      const image = safeHttpUrl(row?.socialimage || row?.image || row?.thumbnail || '');
      if (!image) continue;
      const candidateHost = bareHost(row?.domain || hostOf(row?.url));
      const domainMatch = sameSiteHost(publisherHost, candidateHost);
      const similarity = titleSimilarity(title, row?.title || '');
      if (!domainMatch && similarity < 0.5) continue;
      if (domainMatch && similarity < 0.18) continue;
      const score = similarity + (domainMatch ? 0.45 : 0);
      if (!best || score > best.score) {
        best = {
          image,
          method: 'gdelt:socialimage',
          score,
          similarity,
          candidateHost,
          articleUrl: safeHttpUrl(row?.url || '')
        };
      }
    }

    return best || { image: '', error: rows.length ? 'gdelt-no-matching-image' : 'gdelt-no-results' };
  } catch (error) {
    return {
      image: '',
      error: error?.name === 'AbortError' ? 'gdelt-timeout' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readerImageResolve(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const body = requestBody(req);
  const articleId = compactLogValue(body.articleId, 700);
  const title = compactLogValue(body.title, 260);
  const source = compactLogValue(body.source, 120);
  const link = compactLogValue(body.link, 2200);
  if (!/^https?:\/\//i.test(link)) {
    console.warn('[reader-image-resolve]', { ok: false, articleId, source, reason: 'invalid-link' });
    return res.status(400).json({ error: 'Invalid article link' });
  }

  const cached = imageResolveCacheGet(link);
  if (cached) {
    console.info('[reader-image-resolve]', {
      ok: Boolean(cached.image), cached: true, articleId, source,
      imageHost: hostOf(cached.image), publisherHost: hostOf(cached.publisherUrl),
      method: cached.method || '', fallback: cached.fallback || '',
      fallbackError: cached.fallbackError || ''
    });
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ ...cached, cached: true });
  }

  const started = Date.now();
  const result = await resolveSourcePublishedTime(link, { stageTimeoutMs: 2200 });
  const payload = {
    image: compactLogValue(result?.sourceImage, 2200),
    method: compactLogValue(result?.sourceImageMethod, 120),
    publisherUrl: compactLogValue(result?.publisherUrl, 2200),
    error: compactLogValue(result?.error, 240),
    fallback: '',
    fallbackError: ''
  };

  if (!payload.image) {
    const fallback = await resolveImageFromGdelt(title, payload.publisherUrl || link);
    if (fallback.image) {
      payload.image = compactLogValue(fallback.image, 2200);
      payload.method = compactLogValue(fallback.method, 120);
      payload.fallback = 'gdelt';
      console.info('[reader-image-resolve:fallback]', {
        ok: true,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        imageHost: hostOf(payload.image),
        method: payload.method,
        candidateHost: fallback.candidateHost || '',
        similarity: Number(Number(fallback.similarity || 0).toFixed(3)),
        elapsedMs: Date.now() - started
      });
    } else {
      payload.fallbackError = compactLogValue(fallback.error, 240);
      console.warn('[reader-image-resolve:fallback]', {
        ok: false,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        reason: payload.fallbackError,
        elapsedMs: Date.now() - started
      });
    }
  }

  imageResolveCacheSet(link, payload);
  const log = {
    ok: Boolean(payload.image), cached: false, articleId, title, source,
    imageHost: hostOf(payload.image), publisherHost: hostOf(payload.publisherUrl),
    method: payload.method,
    fallback: payload.fallback,
    elapsedMs: Date.now() - started,
    error: payload.error,
    fallbackError: payload.fallbackError
  };
  if (payload.image) console.info('[reader-image-resolve]', log);
  else console.warn('[reader-image-resolve]', log);
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json(payload);
}

const handlers = new Map([
  ['news-feed', newsFeed],
  ['instagram-profile', instagramProfile],
  ['instagram-image', instagramImage],
  ['instagram-video', instagramVideo],
  ['instagram-stories', instagramStories],
  ['recommendations', recommendations],
  ['reader-image-diagnostic', readerImageDiagnostic],
  ['reader-image-resolve', readerImageResolve],
  ['rss', rss],
  ['twitch-eventsub', twitchEventsub],
  ['twitch-feed', twitchFeed],
  ['twitch-oauth', twitchOauth],
  ['weather-rain', weatherRain],
  ['x-history', xHistory]
]);

function rssItemCount(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  if (!text) return 0;
  const rssItems = text.match(/<item\b/gi)?.length || 0;
  return rssItems || (text.match(/<entry\b/gi)?.length || 0);
}

function installXUpstreamSuccessLog(req, res) {
  if (typeof res.send !== 'function') return;
  const originalSend = res.send;
  res.send = function diagnosticSend(body) {
    res.send = originalSend;
    try {
      const raw = String(first(req.query?.url) || '');
      const host = new URL(raw).hostname.toLowerCase();
      const status = Number(res.statusCode || 200);
      const items = rssItemCount(body);
      if (status >= 200 && status < 300) {
        console.info(`[x-upstream] OK host=${host} items=${items} status=${status}`);
      }
    } catch (error) {
      console.warn('[x-upstream-diagnostic]', error?.message || String(error));
    }
    return originalSend.call(this, body);
  };
}

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const xUpstream = String(first(req.query?.xUpstream) || '').trim() === '1';
  const xRequest = route === 'rss' && isXHistoryRequest(req);
  const target = xRequest && !xUpstream ? xHistory : handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  if (xRequest && xUpstream) installXUpstreamSuccessLog(req, res);

  try {
    const result = await target(req, res);
    if (xRequest && !xUpstream) {
      const source = String(res.getHeader?.('X-X-History-Source') || '');
      const backend = String(res.getHeader?.('X-X-History-Backend') || '');
      const items = Number(res.getHeader?.('X-X-History-Items'));
      if (source === 'redis' && Number.isFinite(items)) {
        console.info(`[x-history] OK backend=${backend || 'unknown'} items=${items} source=${source}`);
      }
    }
    return result;
  } catch (error) {
    console.error('[api-feeds-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
