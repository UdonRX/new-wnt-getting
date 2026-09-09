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
import { extractArticleImageFromHtml, resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

const READER_IMAGE_RESOLVE_TTL_MS = 30 * 60 * 1000;
const READER_IMAGE_NEGATIVE_TTL_MS = 90 * 1000;
const READER_IMAGE_RESOLVE_MAX = 180;
const READER_IMAGE_GDELT_TIMEOUT_MS = 2600;
const READER_IMAGE_DISCOVERY_RSS_TIMEOUT_MS = 1200;
const READER_IMAGE_DISCOVERY_HOME_TIMEOUT_MS = 1400;
const READER_IMAGE_DISCOVERY_INDEX_TIMEOUT_MS = 1100;
const READER_IMAGE_DISCOVERY_ARTICLE_TIMEOUT_MS = 1600;
const READER_IMAGE_DISCOVERY_INDEX_MAX = 5;
const READER_IMAGE_DISCOVERY_MAX_BYTES = 512 * 1024;
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
    .slice(0, 110);
}

function safeHttpUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function decodeMarkup(value = '') {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16) || 0))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0));
}

function stripMarkup(value = '') {
  return decodeMarkup(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function htmlAttr(raw = '', name = '') {
  const safe = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(raw || '').match(new RegExp(`(?:^|\\s)${safe}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeMarkup(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

async function readTextPrefix(response, maxBytes = READER_IMAGE_DISCOVERY_MAX_BYTES) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    return String(await response.text()).slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
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

async function fetchTextPrefix(rawUrl, { timeoutMs, maxBytes = READER_IMAGE_DISCOVERY_MAX_BYTES, accept = 'text/html,application/xhtml+xml;q=.9,*/*;q=.2' } = {}) {
  const url = safeHttpUrl(rawUrl);
  if (!url) throw new Error('invalid-url');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(400, Number(timeoutMs) || 1200));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: accept,
        'Accept-Language': 'ja,en-US;q=.8,en;q=.6',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await readTextPrefix(response, maxBytes), finalUrl: safeHttpUrl(response.url || url) || url };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sourceNameSimilarity(a = '', b = '') {
  const aa = normalizeHeadline(a);
  const bb = normalizeHeadline(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.85;
  return titleSimilarity(aa, bb);
}

function parseGoogleNewsSourceHomepage(xml = '', title = '', source = '') {
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  let best = null;
  for (const block of blocks) {
    const titleMatch = block.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    if (!sourceMatch) continue;
    const rowTitle = stripMarkup(titleMatch?.[1] || '');
    const rowSource = stripMarkup(sourceMatch?.[2] || '');
    const homepage = safeHttpUrl(htmlAttr(sourceMatch[1], 'url'));
    if (!rowTitle || !homepage) continue;
    const titleScore = titleSimilarity(title, rowTitle);
    const sourceScore = sourceNameSimilarity(source, rowSource);
    if (titleScore < 0.46) continue;
    const score = titleScore + sourceScore * 0.2;
    if (!best || score > best.score) best = { homepage, rowTitle, rowSource, score, titleScore, sourceScore };
  }
  return best;
}

async function discoverSourceHomepage(title, source) {
  const query = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (query.length < 6) return { homepage: '', error: 'publisher-discovery-title-too-short' };
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
  try {
    const page = await fetchTextPrefix(url, {
      timeoutMs: READER_IMAGE_DISCOVERY_RSS_TIMEOUT_MS,
      maxBytes: 384 * 1024,
      accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2'
    });
    const match = parseGoogleNewsSourceHomepage(page.text, title, source);
    return match || { homepage: '', error: 'publisher-homepage-not-found' };
  } catch (error) {
    return { homepage: '', error: `publisher-rss-${error?.message || String(error)}` };
  }
}

function discoverArticleLinkFromHomepage(html = '', homepageUrl = '', title = '') {
  const homepageHost = hostOf(homepageUrl);
  if (!homepageHost) return null;
  const source = String(html || '');
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  let best = null;
  while ((match = anchorRe.exec(source))) {
    const href = htmlAttr(match[1], 'href');
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let articleUrl;
    try { articleUrl = new URL(decodeMarkup(href), homepageUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(articleUrl.protocol)) continue;
    if (!sameSiteHost(homepageHost, articleUrl.hostname)) continue;
    const label = stripMarkup(match[2]) || htmlAttr(match[1], 'aria-label') || htmlAttr(match[1], 'title');
    if (!label) continue;
    const similarity = titleSimilarity(title, label);
    if (similarity < 0.5) continue;
    const pathBonus = articleUrl.pathname && articleUrl.pathname !== '/' ? 0.08 : 0;
    const score = similarity + pathBonus;
    if (!best || score > best.score) best = { articleUrl: articleUrl.href, similarity, label: compactLogValue(label, 220), score };
  }
  return best;
}

function discoverPublisherIndexLinks(html = '', homepageUrl = '') {
  const homepageHost = hostOf(homepageUrl);
  if (!homepageHost) return [];
  const rows = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || '')))) {
    const href = htmlAttr(match[1], 'href');
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let url;
    try { url = new URL(decodeMarkup(href), homepageUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !sameSiteHost(homepageHost, url.hostname)) continue;
    url.hash = '';
    const normalized = url.href;
    if (seen.has(normalized)) continue;
    const label = stripMarkup(match[2]) || htmlAttr(match[1], 'aria-label') || htmlAttr(match[1], 'title');
    const path = url.pathname || '/';
    const pathHint = /\/(?:news|topics?|articles?|posts?|press|latest|info|information|blog|column)(?:\/|$)/i.test(path);
    const labelHint = /ニュース|トピックス|新着|最新|記事|お知らせ|プレス|news|topics?|latest|articles?|press/i.test(label);
    if (!pathHint && !labelHint) continue;
    const segments = path.split('/').filter(Boolean).length;
    if (segments > 5) continue;
    const score = (labelHint ? 3 : 0) + (pathHint ? 2 : 0) + (/tournament|sports?|category|topics?/i.test(path) ? 0.5 : 0) - segments * 0.08;
    seen.add(normalized);
    rows.push({ url: normalized, label: compactLogValue(label, 120), score });
  }

  try {
    const origin = new URL(homepageUrl).origin;
    for (const path of ['/news/', '/news/tournament/', '/topics/', '/articles/', '/latest/']) {
      const url = new URL(path, origin).href;
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({ url, label: 'conventional-index', score: path === '/news/' ? 1.7 : path === '/news/tournament/' ? 1.6 : 1.1 });
    }
  } catch {}

  return rows.sort((a, b) => b.score - a.score).slice(0, READER_IMAGE_DISCOVERY_INDEX_MAX);
}

async function discoverArticleViaPublisherIndexes(homePage, homepage, title) {
  const indexes = discoverPublisherIndexLinks(homePage?.text || '', homePage?.finalUrl || homepage);
  if (!indexes.length) return { article: null, checked: 0, error: 'publisher-index-not-found' };
  const results = await Promise.all(indexes.map(async index => {
    try {
      const page = await fetchTextPrefix(index.url, {
        timeoutMs: READER_IMAGE_DISCOVERY_INDEX_TIMEOUT_MS,
        maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
      });
      if (!sameSiteHost(hostOf(homepage), hostOf(page.finalUrl))) return null;
      const article = discoverArticleLinkFromHomepage(page.text, page.finalUrl || index.url, title);
      return article ? { ...article, indexUrl: page.finalUrl || index.url, indexLabel: index.label || '' } : null;
    } catch { return null; }
  }));
  const matches = results.filter(Boolean).sort((a, b) => b.score - a.score);
  return matches[0]
    ? { article: matches[0], checked: indexes.length, error: '' }
    : { article: null, checked: indexes.length, error: 'publisher-index-article-not-found' };
}

async function resolveImageFromPublisherDiscovery(title, source) {
  const sourceResult = await discoverSourceHomepage(title, source);
  if (!sourceResult?.homepage) return { image: '', error: sourceResult?.error || 'publisher-homepage-not-found' };
  const homepage = safeHttpUrl(sourceResult.homepage);
  try {
    const homePage = await fetchTextPrefix(homepage, {
      timeoutMs: READER_IMAGE_DISCOVERY_HOME_TIMEOUT_MS,
      maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
    });
    if (!sameSiteHost(hostOf(homepage), hostOf(homePage.finalUrl))) {
      return { image: '', homepage, error: 'publisher-homepage-cross-site-redirect' };
    }

    let article = discoverArticleLinkFromHomepage(homePage.text, homePage.finalUrl || homepage, title);
    let discoveryMethod = 'publisher-homepage';
    let indexUrl = '';
    let indexChecked = 0;
    if (!article?.articleUrl) {
      const indexResult = await discoverArticleViaPublisherIndexes(homePage, homepage, title);
      article = indexResult.article;
      indexChecked = Number(indexResult.checked || 0);
      if (article?.articleUrl) {
        discoveryMethod = 'publisher-index';
        indexUrl = article.indexUrl || '';
      } else {
        return {
          image: '', homepage, indexChecked,
          error: indexResult.error || 'publisher-article-link-not-found'
        };
      }
    }

    const articlePage = await fetchTextPrefix(article.articleUrl, {
      timeoutMs: READER_IMAGE_DISCOVERY_ARTICLE_TIMEOUT_MS,
      maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
    });
    if (!sameSiteHost(hostOf(homepage), hostOf(articlePage.finalUrl))) {
      return { image: '', homepage, articleUrl: article.articleUrl, indexUrl, indexChecked, error: 'publisher-article-cross-site-redirect' };
    }
    const image = extractArticleImageFromHtml(articlePage.text, { baseUrl: articlePage.finalUrl || article.articleUrl });
    if (!image?.url) {
      return {
        image: '', homepage, articleUrl: articlePage.finalUrl || article.articleUrl,
        indexUrl, indexChecked, similarity: article.similarity, error: 'publisher-article-no-image'
      };
    }
    return {
      image: image.url,
      method: `${discoveryMethod}:${image.method || 'image'}`,
      homepage,
      articleUrl: articlePage.finalUrl || article.articleUrl,
      indexUrl,
      indexChecked,
      similarity: article.similarity,
      sourceTitleScore: Number(sourceResult.titleScore || 0)
    };
  } catch (error) {
    return { image: '', homepage, error: `publisher-discovery-${error?.message || String(error)}` };
  }
}

async function resolveImageFromGdelt(title, publisherUrl = '') {
  const query = gdeltQueryFromTitle(title);
  if (query.length < 8) return { image: '', error: 'gdelt-query-too-short' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READER_IMAGE_GDELT_TIMEOUT_MS);
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=10&format=json&sort=HybridRel&timespan=72h`;
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
    const [publisherFallback, gdeltFallback] = await Promise.all([
      resolveImageFromPublisherDiscovery(title, source),
      resolveImageFromGdelt(title, payload.publisherUrl || link)
    ]);

    if (publisherFallback.image) {
      payload.image = compactLogValue(publisherFallback.image, 2200);
      payload.method = compactLogValue(publisherFallback.method, 120);
      payload.publisherUrl = compactLogValue(publisherFallback.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = publisherFallback.indexUrl ? 'publisher-index' : 'publisher-homepage';
      console.info('[reader-image-resolve:publisher-discovery]', {
        ok: true,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        imageHost: hostOf(payload.image),
        method: payload.method,
        indexHost: hostOf(publisherFallback.indexUrl),
        indexChecked: Number(publisherFallback.indexChecked || 0),
        similarity: Number(Number(publisherFallback.similarity || 0).toFixed(3)),
        sourceTitleScore: Number(Number(publisherFallback.sourceTitleScore || 0).toFixed(3)),
        elapsedMs: Date.now() - started
      });
    } else if (gdeltFallback.image) {
      payload.image = compactLogValue(gdeltFallback.image, 2200);
      payload.method = compactLogValue(gdeltFallback.method, 120);
      payload.publisherUrl = compactLogValue(gdeltFallback.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = 'gdelt';
      console.info('[reader-image-resolve:fallback]', {
        ok: true,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        imageHost: hostOf(payload.image),
        method: payload.method,
        candidateHost: gdeltFallback.candidateHost || '',
        similarity: Number(Number(gdeltFallback.similarity || 0).toFixed(3)),
        elapsedMs: Date.now() - started
      });
    } else {
      const publisherError = compactLogValue(publisherFallback.error, 180);
      const gdeltError = compactLogValue(gdeltFallback.error, 180);
      payload.fallbackError = compactLogValue(`publisher:${publisherError || 'unknown'};gdelt:${gdeltError || 'unknown'}`, 240);
      console.warn('[reader-image-resolve:publisher-discovery]', {
        ok: false,
        articleId,
        source,
        homepageHost: hostOf(publisherFallback.homepage),
        indexHost: hostOf(publisherFallback.indexUrl),
        indexChecked: Number(publisherFallback.indexChecked || 0),
        reason: publisherError || 'unknown',
        elapsedMs: Date.now() - started
      });
      console.warn('[reader-image-resolve:fallback]', {
        ok: false,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        reason: gdeltError || 'unknown',
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