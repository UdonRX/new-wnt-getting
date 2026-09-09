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
const READER_IMAGE_RESOLVE_MAX = 180;
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
  if (Date.now() - Number(entry.at || 0) > READER_IMAGE_RESOLVE_TTL_MS) {
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
      method: cached.method || ''
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
    error: compactLogValue(result?.error, 240)
  };
  imageResolveCacheSet(link, payload);
  const log = {
    ok: Boolean(payload.image), cached: false, articleId, title, source,
    imageHost: hostOf(payload.image), publisherHost: hostOf(payload.publisherUrl),
    method: payload.method,
    elapsedMs: Date.now() - started,
    error: payload.error
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
