import newsFeed from '../server/news-feed.mjs';
import instagramImage from '../server/instagram-image.mjs';
import instagramStories from '../server/instagram-stories.mjs';
import { instagramProfile, instagramVideo } from '../server/instagram.mjs';
import recommendations from '../server/recommendations-robust.mjs';
import { readerImageDiagnostic, readerImageResolve } from '../server/reader-image.mjs';
import rss from '../server/rss.mjs';
import twitchEventsub from '../server/twitch-eventsub.mjs';
import twitchFeed from '../server/twitch-feed.mjs';
import twitchOauth from '../server/twitch-oauth.mjs';
import weatherRain from '../server/weather-rain.mjs';
import xHistory, { isXHistoryRequest } from '../server/x-history.mjs';
import { resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

function first(value) {
  return Array.isArray(value) ? value[0] : value;
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

function requestBody(req) {
  if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(req?.body || '{}'); }
  catch { return {}; }
}

function cleanXml(value = '') {
  return String(value || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 0))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0))
    .replace(/\s+/g, ' ')
    .trim();
}

function publisherHint(title = '') {
  return String(title || '').match(/[（(]([^（）()]{2,90})[）)]\s*$/)?.[1]?.trim() || '';
}

function baseStoryTitle(title = '') {
  return String(title || '').replace(/[（(][^（）()]{2,90}[）)]\s*$/, '').trim();
}

function storyKey(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function titleSimilarity(a = '', b = '') {
  const aa = storyKey(baseStoryTitle(a));
  const bb = storyKey(baseStoryTitle(b));
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.length >= 10 && (aa.includes(bb) || bb.includes(aa))) {
    return Math.min(0.98, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + 0.22);
  }
  const grams = value => {
    const set = new Set();
    for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2));
    return set;
  };
  const ga = grams(aa);
  const gb = grams(bb);
  if (!ga.size || !gb.size) return 0;
  let same = 0;
  for (const token of ga) if (gb.has(token)) same += 1;
  return (2 * same) / (ga.size + gb.size);
}

function googleNewsArticleLink(value = '') {
  try {
    const url = new URL(String(value || ''));
    return url.hostname.toLowerCase() === 'news.google.com' && /\/(?:rss\/articles|articles|read)\//.test(url.pathname);
  } catch { return false; }
}

async function fetchFreshGoogleNewsRow(title = '') {
  const query = baseStoryTitle(title).slice(0, 180);
  if (query.length < 8) return null;
  const hint = publisherHint(title);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2',
        'Accept-Language': 'ja,en-US;q=.8,en;q=.6',
        'User-Agent': 'new-wnt-getting/1.0'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const rows = [];
    for (const block of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
      const rowTitle = cleanXml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
      const link = cleanXml(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '');
      const rowSource = cleanXml(block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i)?.[1] || '');
      if (!rowTitle || !googleNewsArticleLink(link)) continue;
      const titleScore = titleSimilarity(query, rowTitle);
      const sourceScore = hint ? titleSimilarity(hint, rowSource) : 0;
      if (titleScore < 0.62) continue;
      if (hint && sourceScore < 0.25 && titleScore < 0.88) continue;
      rows.push({ title: rowTitle, source: rowSource, link, titleScore, sourceScore, score: titleScore + sourceScore * 0.25 });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0] || null;
  } finally {
    clearTimeout(timer);
  }
}

async function prepareReaderImageRecovery(req) {
  const body = requestBody(req);
  const link = String(body?.link || '').trim();
  const title = String(body?.title || '').trim();
  if (!title || !googleNewsArticleLink(link)) return null;

  try {
    const row = await fetchFreshGoogleNewsRow(title);
    if (!row) return null;
    const resolved = await resolveSourcePublishedTime(row.link, { stageTimeoutMs: 950 });
    const publisherUrl = String(resolved?.publisherUrl || '').trim();
    const sourceImage = String(resolved?.sourceImage || '').trim();

    console.info('[reader-image-resolve:google-news-refresh]', {
      ok: Boolean(sourceImage || publisherUrl),
      articleId: String(body?.articleId || '').slice(0, 180),
      rowSource: row.source,
      titleSimilarity: Number(row.titleScore.toFixed(3)),
      publisherHost: (() => { try { return new URL(publisherUrl).hostname; } catch { return ''; } })(),
      imageHost: (() => { try { return new URL(sourceImage).hostname; } catch { return ''; } })(),
      resolveError: String(resolved?.error || '')
    });

    if (/^https?:\/\//i.test(sourceImage)) {
      return {
        payload: {
          image: sourceImage,
          backupImage: '',
          imageKind: 'article',
          method: `google-news-refresh:${String(resolved?.sourceImageMethod || 'source-image').slice(0, 100)}`,
          publisherUrl: /^https?:\/\//i.test(publisherUrl) ? publisherUrl : '',
          error: '',
          fallback: 'google-news-refresh',
          fallbackError: ''
        }
      };
    }

    if (/^https?:\/\//i.test(publisherUrl)) {
      req.body = {
        ...body,
        link: publisherUrl,
        source: row.source || body.source
      };
      return { publisherUrl };
    }
  } catch (error) {
    console.warn('[reader-image-resolve:google-news-refresh]', {
      ok: false,
      articleId: String(body?.articleId || '').slice(0, 180),
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error)
    });
  }
  return null;
}

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const xUpstream = String(first(req.query?.xUpstream) || '').trim() === '1';
  const xRequest = route === 'rss' && isXHistoryRequest(req);
  const target = xRequest && !xUpstream ? xHistory : handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  if (xRequest && xUpstream) installXUpstreamSuccessLog(req, res);

  try {
    if (route === 'reader-image-resolve' && req.method === 'POST') {
      const recovery = await prepareReaderImageRecovery(req);
      if (recovery?.payload) {
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.status(200).json(recovery.payload);
      }
    }

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
