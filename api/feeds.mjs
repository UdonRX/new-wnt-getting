import newsFeed from '../server/news-feed.mjs';
import instagramImage from '../server/instagram-image.mjs';
import instagramStories from '../server/instagram-stories.mjs';
import { instagramProfile, instagramVideo } from '../server/instagram.mjs';
import recommendations from '../server/recommendations-robust.mjs';
import { readerImageCacheLookup, readerImageCacheRemember, readerImageResolve } from '../server/reader-image.mjs';
import rss from '../server/rss.mjs';
import twitchEventsub from '../server/twitch-eventsub.mjs';
import twitchFeed from '../server/twitch-feed.mjs';
import twitchOauth from '../server/twitch-oauth.mjs';
import weatherRain from '../server/weather-rain.mjs';
import xHistory, { isXHistoryRequest } from '../server/x-history.mjs';
import { resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

const READER_IMAGE_POLICY = 'reader-image-fast-v2';
const GOOGLE_NEWS_HTML_DECODE_TIMEOUT_MS = 550;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestBody(req) {
  if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(req?.body || '{}'); }
  catch { return {}; }
}

function compactLog(value = '', max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hostOf(value = '') {
  try { return new URL(String(value || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function bareHost(value = '') {
  return String(value || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function sameSite(a = '', b = '') {
  const aa = bareHost(a);
  const bb = bareHost(b);
  return Boolean(aa && bb && (aa === bb || aa.endsWith(`.${bb}`) || bb.endsWith(`.${aa}`)));
}

function safeHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function readerImageBlockedReason(image = '', imageKind = '') {
  const href = safeHttpUrl(image);
  if (!href) return 'invalid-image-url';
  if (String(imageKind || '').toLowerCase() === 'site-brand') return 'site-brand';
  try {
    const url = new URL(href);
    const path = decodeURIComponent(`${url.pathname}${url.search}`).toLowerCase();
    if (url.hostname === 'www.google.com' && url.pathname.startsWith('/s2/favicons')) return 'site-brand';
    if (/(?:^|[\/_.-])(?:ogp[_-]?default|default[_-]?ogp|default[_-]?image|no[_-]?image|noimage|placeholder|site[_-]?brand)(?:[\/_.?&=-]|$)/i.test(path)) return 'default-ogp';
  } catch {}
  return '';
}

function hash32(value = '') {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readerImageRequestId(body = {}) {
  const articleId = compactLog(body?.articleId, 700);
  const key = articleId || compactLog(body?.link, 2200) || compactLog(body?.title, 320);
  return `img-${hash32(key)}`;
}

function finiteNumber(value, fallback = -1) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readerImageDiagnosticV2(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = requestBody(req);
  if (Number(body?.diagnosticVersion) !== 2) return res.status(204).end();

  const phase = compactLog(body?.phase, 80) || 'unknown';
  const log = {
    diagnosticVersion: 2,
    phase,
    readerRequestId: compactLog(body?.readerRequestId, 100),
    imageRequestId: compactLog(body?.imageRequestId, 100) || readerImageRequestId(body),
    readerMode: compactLog(body?.readerMode, 40),
    articleId: compactLog(body?.articleId, 260),
    title: compactLog(body?.title, 260),
    source: compactLog(body?.source, 120),
    articleHost: compactLog(body?.articleHost, 180),
    imageHost: compactLog(body?.imageHost, 180),
    imageUrlSource: compactLog(body?.imageUrlSource, 80),
    imageUrl: compactLog(body?.imageUrl, 700),
    summaryProvider: compactLog(body?.summaryProvider, 80),
    readerToPhaseMs: finiteNumber(body?.readerToPhaseMs),
    totalReaderToImageLoadedMs: finiteNumber(body?.totalReaderToImageLoadedMs),
    imageObservedToLoadMs: finiteNumber(body?.imageObservedToLoadMs),
    imageObservedToErrorMs: finiteNumber(body?.imageObservedToErrorMs),
    resourceStartAfterReaderMs: finiteNumber(body?.resourceStartAfterReaderMs),
    resourceStartAfterNavigationMs: finiteNumber(body?.resourceStartAfterNavigationMs),
    fetchStartMs: finiteNumber(body?.fetchStartMs),
    requestStartMs: finiteNumber(body?.requestStartMs),
    responseStartMs: finiteNumber(body?.responseStartMs),
    responseEndMs: finiteNumber(body?.responseEndMs),
    redirectStartMs: finiteNumber(body?.redirectStartMs),
    redirectEndMs: finiteNumber(body?.redirectEndMs),
    redirectMs: finiteNumber(body?.redirectMs),
    redirectCount: finiteNumber(body?.redirectCount),
    redirectVisibility: compactLog(body?.redirectVisibility, 80),
    queueMs: finiteNumber(body?.queueMs),
    ttfbMs: finiteNumber(body?.ttfbMs),
    downloadMs: finiteNumber(body?.downloadMs),
    resourceDurationMs: finiteNumber(body?.resourceDurationMs),
    transferSize: finiteNumber(body?.transferSize),
    encodedBodySize: finiteNumber(body?.encodedBodySize),
    decodedBodySize: finiteNumber(body?.decodedBodySize),
    responseStatus: finiteNumber(body?.responseStatus),
    contentType: compactLog(body?.contentType, 80),
    contentLength: finiteNumber(body?.contentLength),
    headerVisibility: compactLog(body?.headerVisibility, 80),
    resourceTiming: compactLog(body?.resourceTiming, 80),
    browserCache: compactLog(body?.browserCache, 24),
    nextHopProtocol: compactLog(body?.nextHopProtocol, 40),
    deliveryType: compactLog(body?.deliveryType, 40),
    imageNaturalWidth: finiteNumber(body?.imageNaturalWidth, 0),
    imageNaturalHeight: finiteNumber(body?.imageNaturalHeight, 0),
    imageLoading: compactLog(body?.imageLoading, 24),
    imageDecoding: compactLog(body?.imageDecoding, 24),
    imageCompleteAtObservation: Boolean(body?.imageCompleteAtObservation),
    articleDataReadyDefinition: compactLog(body?.articleDataReadyDefinition, 80),
    cardObservedToVisibleMs: finiteNumber(body?.cardObservedToVisibleMs),
    viewport: compactLog(body?.viewport, 80),
    online: body?.online !== false,
    effectiveType: compactLog(body?.effectiveType, 24),
    downlinkMbps: finiteNumber(body?.downlinkMbps),
    rttMs: finiteNumber(body?.rttMs),
    saveData: Boolean(body?.saveData),
    clientEpochMs: finiteNumber(body?.clientEpochMs),
    readerStartedAtEpochMs: finiteNumber(body?.readerStartedAtEpochMs)
  };

  const method = /error|missing|fail/i.test(phase) ? 'warn' : 'info';
  console[method]('[NEWS-IMAGE]', log);
  return res.status(204).end();
}

function installReaderImageResolveDiagnostic(req, res) {
  if (req.method !== 'POST' || typeof res.json !== 'function') return;
  const started = Date.now();
  const initialBody = requestBody(req);
  const imageRequestId = compactLog(initialBody?.imageRequestId, 100) || readerImageRequestId(initialBody);
  req.__readerImageResolveStartedAt = started;
  req.__readerImageRequestId = imageRequestId;
  req.__readerImageGoogleRecoveryMs = 0;
  req.__readerImageGoogleDecodeMethod = '';
  req.__readerImageGoogleSourceHost = '';

  console.info('[NEWS-IMAGE]', {
    diagnosticVersion: 2,
    phase: 'resolve-start',
    policy: READER_IMAGE_POLICY,
    imageRequestId,
    readerRequestId: compactLog(initialBody?.readerRequestId, 100),
    articleId: compactLog(initialBody?.articleId, 260),
    title: compactLog(initialBody?.title, 260),
    source: compactLog(initialBody?.source, 120),
    articleHost: hostOf(initialBody?.link),
    cache: 'UNKNOWN'
  });

  const originalJson = res.json;
  res.json = function readerImageDiagnosticJson(payload) {
    res.json = originalJson;
    try {
      const body = requestBody(req);
      const status = Number(res.statusCode || 200);
      const ok = status >= 200 && status < 300 && Boolean(payload?.image);
      const log = {
        diagnosticVersion: 2,
        phase: 'resolve-finish',
        policy: READER_IMAGE_POLICY,
        ok,
        status,
        imageRequestId,
        readerRequestId: compactLog(initialBody?.readerRequestId, 100),
        articleId: compactLog(initialBody?.articleId, 260),
        title: compactLog(initialBody?.title, 260),
        source: compactLog(initialBody?.source, 120),
        requestedArticleHost: hostOf(initialBody?.link),
        resolvedArticleHost: hostOf(body?.link),
        imageHost: hostOf(payload?.image),
        publisherHost: hostOf(payload?.publisherUrl),
        imageUrlSource: compactLog(payload?.method || payload?.fallback || '', 140),
        method: compactLog(payload?.method, 140),
        fallback: compactLog(payload?.fallback, 100),
        imageKind: compactLog(payload?.imageKind, 60),
        cache: payload?.cached === true ? 'HIT' : 'MISS',
        resolveTotalMs: Date.now() - started,
        googleNewsRecoveryMs: finiteNumber(req.__readerImageGoogleRecoveryMs, 0),
        googleNewsDecodeMethod: compactLog(req.__readerImageGoogleDecodeMethod, 80),
        googleNewsSourceHost: compactLog(req.__readerImageGoogleSourceHost, 180),
        googleNewsRowReused: Boolean(req.__readerImageGoogleNewsRow),
        error: compactLog(payload?.error, 180),
        fallbackError: compactLog(payload?.fallbackError, 320)
      };
      console[ok ? 'info' : 'warn']('[NEWS-IMAGE]', log);
    } catch (error) {
      console.warn('[NEWS-IMAGE]', {
        diagnosticVersion: 2,
        phase: 'resolve-log-error',
        imageRequestId,
        error: compactLog(error?.message || error, 180)
      });
    }
    return originalJson.call(this, payload);
  };
}

const handlers = new Map([
  ['news-feed', newsFeed],
  ['instagram-profile', instagramProfile],
  ['instagram-image', instagramImage],
  ['instagram-video', instagramVideo],
  ['instagram-stories', instagramStories],
  ['recommendations', recommendations],
  ['reader-image-diagnostic', readerImageDiagnosticV2],
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

function googleNewsArticleId(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname.toLowerCase() !== 'news.google.com') return '';
    const id = url.pathname.split('/').filter(Boolean).at(-1) || '';
    return /^[A-Za-z0-9_-]{16,}$/.test(id) ? id : '';
  } catch { return ''; }
}

function sourceUrlFromAttrs(raw = '') {
  const match = String(raw || '').match(/(?:^|\s)url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return safeHttpUrl(cleanXml(match?.[1] ?? match?.[2] ?? match?.[3] ?? ''));
}

function publisherUrlFromText(raw = '', sourceUrl = '') {
  const sourceHost = hostOf(sourceUrl);
  if (!sourceHost) return '';
  const normalized = String(raw || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\u002f|\\x2f/gi, '/')
    .replace(/\\u003a|\\x3a/gi, ':')
    .replace(/\\u0026|\\x26/gi, '&')
    .replace(/\\u003d|\\x3d/gi, '=')
    .replace(/\\\//g, '/');
  const matches = normalized.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (let candidate of matches) {
    candidate = candidate.replace(/[),.;\]}]+$/g, '');
    const href = safeHttpUrl(candidate);
    if (!href) continue;
    try {
      const url = new URL(href);
      if (!sameSite(url.hostname, sourceHost)) continue;
      if (url.pathname === '/' || /\.(?:css|js|jpe?g|png|gif|webp|svg|ico|woff2?)(?:$|\?)/i.test(url.href)) continue;
      return url.href;
    } catch {}
  }
  return '';
}

function publisherUrlFromArticleId(link = '', sourceUrl = '') {
  const id = googleNewsArticleId(link);
  if (!id) return '';
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    return publisherUrlFromText(decoded, sourceUrl);
  } catch { return ''; }
}

async function publisherUrlFromGoogleHtml(link = '', sourceUrl = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_NEWS_HTML_DECODE_TIMEOUT_MS);
  try {
    const response = await fetch(link, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=.9,*/*;q=.2',
        'Accept-Language': 'ja,en-US;q=.8,en;q=.6',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.url && !googleNewsArticleLink(response.url) && sameSite(hostOf(response.url), hostOf(sourceUrl))) {
      return { publisherUrl: response.url, method: 'google-news-http-redirect' };
    }
    const html = (await response.text()).slice(0, 700 * 1024);
    const publisherUrl = publisherUrlFromText(html, sourceUrl);
    return publisherUrl ? { publisherUrl, method: 'google-news-html-publisher-link' } : null;
  } finally {
    clearTimeout(timer);
  }
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
      const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
      const rowSource = cleanXml(sourceMatch?.[2] || '');
      const sourceUrl = sourceUrlFromAttrs(sourceMatch?.[1] || '');
      if (!rowTitle || !googleNewsArticleLink(link)) continue;
      const titleScore = titleSimilarity(query, rowTitle);
      const sourceScore = hint ? titleSimilarity(hint, rowSource) : 0;
      if (titleScore < 0.62) continue;
      if (hint && sourceScore < 0.25 && titleScore < 0.88) continue;
      rows.push({ title: rowTitle, source: rowSource, sourceUrl, link, titleScore, sourceScore, score: titleScore + sourceScore * 0.25 });
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

  const imageRequestId = compactLog(req.__readerImageRequestId, 100) || readerImageRequestId(body);
  const started = Date.now();
  try {
    const searchStarted = Date.now();
    const row = await fetchFreshGoogleNewsRow(title);
    const googleNewsSearchMs = Date.now() - searchStarted;
    if (!row) {
      console.info('[NEWS-IMAGE]', {
        diagnosticVersion: 2,
        phase: 'google-news-recovery',
        policy: READER_IMAGE_POLICY,
        ok: false,
        imageRequestId,
        articleId: compactLog(body?.articleId, 260),
        googleNewsSearchMs,
        totalMs: Date.now() - started,
        reason: 'no-matching-row'
      });
      return null;
    }

    req.__readerImageGoogleNewsRow = {
      title: row.title,
      source: row.source,
      home: row.sourceUrl,
      sim: row.titleScore,
      link: row.link
    };
    req.__readerImageGoogleSourceHost = hostOf(row.sourceUrl);

    let resolved = null;
    let decodeMethod = '';
    let legacyDecodeMs = 0;
    let modernDecodeMs = 0;
    let publisherPageMs = 0;

    const articleIdPublisherUrl = publisherUrlFromArticleId(row.link, row.sourceUrl);
    if (articleIdPublisherUrl) {
      decodeMethod = 'article-id-embedded-url';
      const pageStarted = Date.now();
      resolved = await resolveSourcePublishedTime(articleIdPublisherUrl, { stageTimeoutMs: 850 });
      publisherPageMs = Date.now() - pageStarted;
    } else {
      const legacyStarted = Date.now();
      const legacy = await resolveSourcePublishedTime(row.link, { stageTimeoutMs: 700 });
      legacyDecodeMs = Date.now() - legacyStarted;
      if (legacy?.sourceImage || legacy?.publisherUrl) {
        resolved = legacy;
        decodeMethod = legacy?.publisherUrl ? 'legacy-google-news-decode' : 'legacy-source-image';
      } else if (String(legacy?.error || '').includes('missing-google-news-decode-params')) {
        const modernStarted = Date.now();
        let modern = null;
        try { modern = await publisherUrlFromGoogleHtml(row.link, row.sourceUrl); }
        catch (error) {
          modern = { error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error) };
        }
        modernDecodeMs = Date.now() - modernStarted;
        if (modern?.publisherUrl) {
          decodeMethod = modern.method || 'google-news-html-publisher-link';
          const pageStarted = Date.now();
          resolved = await resolveSourcePublishedTime(modern.publisherUrl, { stageTimeoutMs: 850 });
          publisherPageMs = Date.now() - pageStarted;
          if (!resolved?.publisherUrl) resolved = { ...resolved, publisherUrl: modern.publisherUrl };
        } else {
          resolved = legacy;
          decodeMethod = modern?.error ? `modern-decode-${modern.error}` : 'decode-unresolved';
        }
      } else {
        resolved = legacy;
        decodeMethod = 'legacy-decode-failed';
      }
    }

    req.__readerImageGoogleDecodeMethod = decodeMethod;
    const publisherUrl = String(resolved?.publisherUrl || '').trim();
    const sourceImage = String(resolved?.sourceImage || '').trim();
    const imageRejectedReason = sourceImage ? readerImageBlockedReason(sourceImage, 'article') : '';
    if (imageRejectedReason) {
      console.info('[NEWS-IMAGE]', {
        diagnosticVersion: 2,
        phase: 'candidate-rejected',
        policy: READER_IMAGE_POLICY,
        articleId: compactLog(body?.articleId, 260),
        stage: 'google-news-recovery',
        reason: imageRejectedReason,
        imageHost: hostOf(sourceImage),
        method: compactLog(resolved?.sourceImageMethod, 140)
      });
    }

    console.info('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'google-news-recovery',
      policy: READER_IMAGE_POLICY,
      ok: Boolean((sourceImage && !imageRejectedReason) || publisherUrl),
      imageRequestId,
      articleId: compactLog(body?.articleId, 260),
      rowSource: compactLog(row.source, 120),
      sourceHomeHost: hostOf(row.sourceUrl),
      titleSimilarity: Number(row.titleScore.toFixed(3)),
      decodeMethod,
      publisherHost: hostOf(publisherUrl),
      imageHost: imageRejectedReason ? '' : hostOf(sourceImage),
      imageRejectedReason,
      googleNewsSearchMs,
      legacyDecodeMs,
      modernDecodeMs,
      publisherPageMs,
      totalMs: Date.now() - started,
      rowSavedForFallback: Boolean(row.sourceUrl),
      resolveError: compactLog(resolved?.error, 180)
    });

    if (/^https?:\/\//i.test(sourceImage) && !imageRejectedReason) {
      return {
        payload: {
          image: sourceImage,
          backupImage: '',
          imageKind: 'article',
          method: `google-news-refresh:${String(resolved?.sourceImageMethod || 'source-image').slice(0, 100)}`,
          publisherUrl: /^https?:\/\//i.test(publisherUrl) ? publisherUrl : '',
          error: '',
          fallback: 'google-news-refresh',
          fallbackError: '',
          cached: false
        }
      };
    }

    if (/^https?:\/\//i.test(publisherUrl)) {
      req.__readerImageRecoveredPublisherUrl = publisherUrl;
      return { publisherUrl };
    }
  } catch (error) {
    console.warn('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'google-news-recovery',
      policy: READER_IMAGE_POLICY,
      ok: false,
      imageRequestId,
      articleId: compactLog(body?.articleId, 260),
      sourceHomeHost: compactLog(req.__readerImageGoogleSourceHost, 180),
      totalMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : compactLog(error?.message || error, 180)
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
      installReaderImageResolveDiagnostic(req, res);
      const initialBody = requestBody(req);
      const cached = readerImageCacheLookup(initialBody);
      if (cached?.payload?.image) {
        console.info('[NEWS-IMAGE]', {
          diagnosticVersion: 2,
          phase: 'resolved-url-reuse',
          policy: READER_IMAGE_POLICY,
          articleId: compactLog(initialBody?.articleId, 260),
          cacheLayer: 'server-memory-pre-recovery',
          cacheKey: cached.cacheKey,
          imageHost: hostOf(cached.payload.image),
          method: compactLog(cached.payload.method, 140),
          googleNewsRecoverySkipped: true
        });
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.status(200).json(cached.payload);
      }

      const sourceUrl = safeHttpUrl(initialBody?.sourceUrl);
      if (googleNewsArticleLink(initialBody?.link) && sourceUrl) {
        req.__readerImageGoogleNewsRow = {
          title: compactLog(initialBody?.title, 320),
          source: compactLog(initialBody?.source, 120),
          home: sourceUrl,
          sim: 1,
          link: compactLog(initialBody?.link, 2200)
        };
        req.__readerImageGoogleSourceHost = hostOf(sourceUrl);
        req.__readerImageGoogleDecodeMethod = 'rss-source-url-seed';
        console.info('[NEWS-IMAGE]', {
          diagnosticVersion: 2,
          phase: 'google-news-source-seed',
          policy: READER_IMAGE_POLICY,
          imageRequestId: compactLog(req.__readerImageRequestId, 100),
          articleId: compactLog(initialBody?.articleId, 260),
          source: compactLog(initialBody?.source, 120),
          sourceHomeHost: hostOf(sourceUrl),
          preflightSkipped: true
        });
      } else {
        const recoveryStarted = Date.now();
        const recovery = await prepareReaderImageRecovery(req);
        req.__readerImageGoogleRecoveryMs = Date.now() - recoveryStarted;
        if (recovery?.payload) {
          readerImageCacheRemember(initialBody, recovery.payload);
          console.info('[NEWS-IMAGE]', {
            diagnosticVersion: 2,
            phase: 'resolved-url-cache-store',
            policy: READER_IMAGE_POLICY,
            articleId: compactLog(initialBody?.articleId, 260),
            cacheLayer: 'server-memory-pre-recovery',
            stored: true,
            imageHost: hostOf(recovery.payload.image),
            source: 'google-news-recovery'
          });
          res.setHeader('Cache-Control', 'private, max-age=300');
          return res.status(200).json(recovery.payload);
        }
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
