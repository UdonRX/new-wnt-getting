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
const READER_IMAGE_GDELT_TIMEOUT_MS = 1400;
const READER_IMAGE_DISCOVERY_RSS_TIMEOUT_MS = 1200;
const READER_IMAGE_DISCOVERY_HOME_TIMEOUT_MS = 1400;
const READER_IMAGE_DISCOVERY_INDEX_TIMEOUT_MS = 1100;
const READER_IMAGE_DISCOVERY_ARTICLE_TIMEOUT_MS = 1600;
const READER_IMAGE_DISCOVERY_INDEX_MAX = 8;
const READER_IMAGE_DISCOVERY_PAGINATION_MAX = 4;
const READER_IMAGE_DISCOVERY_MAX_BYTES = 512 * 1024;
const READER_PUBLISHER_HOME_TTL_MS = 6 * 60 * 60 * 1000;
const readerImageResolveCache = new Map();
const readerPublisherHomepageCache = new Map();

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

function sourceAllowsAggregator(source = '') {
  const key = normalizeHeadline(source);
  return /(?:yahooニュース|yahoonews|googlenews|googleニュース|smartnews|スマートニュース|gunosy|グノシー)/i.test(key);
}

function isAggregatorHomepage(rawUrl = '') {
  const host = bareHost(hostOf(rawUrl));
  return host === 'news.yahoo.co.jp'
    || host === 'news.google.com'
    || host === 'smartnews.com'
    || host === 'gunosy.com';
}

function publisherHomepageCacheKey(source = '') {
  return normalizeHeadline(source).slice(0, 120);
}

function getCachedPublisherHomepage(source = '') {
  const key = publisherHomepageCacheKey(source);
  if (!key) return '';
  const entry = readerPublisherHomepageCache.get(key);
  if (!entry) return '';
  if (Date.now() - Number(entry.at || 0) > READER_PUBLISHER_HOME_TTL_MS) {
    readerPublisherHomepageCache.delete(key);
    return '';
  }
  return safeHttpUrl(entry.homepage || '');
}

function setCachedPublisherHomepage(source = '', homepage = '') {
  const key = publisherHomepageCacheKey(source);
  const url = safeHttpUrl(homepage);
  if (!key || !url) return;
  readerPublisherHomepageCache.set(key, { at: Date.now(), homepage: url });
  while (readerPublisherHomepageCache.size > 120) {
    readerPublisherHomepageCache.delete(readerPublisherHomepageCache.keys().next().value);
  }
}

function parseGoogleNewsSourceHomepage(xml = '', title = '', source = '') {
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const sourceKey = normalizeHeadline(source);
  const requireSourceMatch = Boolean(sourceKey) && !sourceAllowsAggregator(source);
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
    if (requireSourceMatch && sourceScore < 0.34) continue;
    if (requireSourceMatch && isAggregatorHomepage(homepage)) continue;
    const score = titleScore + sourceScore * 0.8 + (sourceScore >= 0.8 ? 0.25 : 0) - (isAggregatorHomepage(homepage) ? 0.2 : 0);
    if (!best || score > best.score) best = { homepage, rowTitle, rowSource, score, titleScore, sourceScore };
  }
  return best;
}

async function discoverSourceHomepage(title, source) {
  const cachedHomepage = getCachedPublisherHomepage(source);
  if (cachedHomepage) {
    return { homepage: cachedHomepage, cached: true, titleScore: 1, sourceScore: 1 };
  }

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
    if (match?.homepage) setCachedPublisherHomepage(source, match.homepage);
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

function isLikelyArticleDetailPath(rawPath = '') {
  const path = String(rawPath || '').replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1) || '';
  if (/^\/(?:article|post)\/[^/]+/i.test(path)) return true;
  if (/^\/news\/(?:info|detail|article|entry)\/[^/]+/i.test(path)) return true;
  if (segments.length >= 3 && /^(?:\d{3,}|[a-f0-9]{8,}|[a-f0-9-]{16,})$/i.test(last)) return true;
  return false;
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
    if (isLikelyArticleDetailPath(path)) continue;
    const segments = path.split('/').filter(Boolean).length;
    const shallowIndexPath = segments <= 2 && /\/(?:news|topics?|articles?|posts?|press|latest|info|information|blog|column|category)(?:\/|$)/i.test(path);
    const labelHint = /^(?:ニュース|トピックス|新着|最新記事|記事一覧|お知らせ|プレス|news|topics?|latest|articles?|press)(?:\s|$)/i.test(label);
    if (!shallowIndexPath && !labelHint) continue;
    if (segments > 4) continue;
    const score = (labelHint ? 7 : 0) + (shallowIndexPath ? 5 : 0) + (/tournament|sports?|category|topics?/i.test(path) ? 0.5 : 0) - segments * 0.08;
    seen.add(normalized);
    rows.push({ url: normalized, label: compactLogValue(label, 120), score, conventional: false });
  }

  try {
    const origin = new URL(homepageUrl).origin;
    const conventional = [
      ['/news/', 9.8, true],
      ['/news/tournament/', 9.6, true],
      ['/articles/', 9.3, true],
      ['/news/news_and_topics/', 8.9, false],
      ['/topics/', 8.7, false],
      ['/latest/', 8.5, false],
      ['/category/news/', 8.3, false]
    ];
    for (const [path, score, guaranteed] of conventional) {
      const url = new URL(path, origin).href;
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({ url, label: 'conventional-index', score, conventional: guaranteed });
    }
  } catch {}

  const guaranteed = rows.filter(row => row.conventional).sort((a, b) => b.score - a.score).slice(0, 3);
  const guaranteedUrls = new Set(guaranteed.map(row => row.url));
  const others = rows
    .filter(row => !guaranteedUrls.has(row.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, READER_IMAGE_DISCOVERY_INDEX_MAX - guaranteed.length));
  return [...guaranteed, ...others];
}

function discoverPaginationLinks(html = '', baseUrl = '') {
  const baseHost = hostOf(baseUrl);
  if (!baseHost) return [];
  const rows = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || '')))) {
    const href = htmlAttr(match[1], 'href');
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let url;
    try { url = new URL(decodeMarkup(href), baseUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !sameSiteHost(baseHost, url.hostname)) continue;
    url.hash = '';
    if (url.href === baseUrl || seen.has(url.href)) continue;
    const label = stripMarkup(match[2]) || htmlAttr(match[1], 'aria-label') || htmlAttr(match[1], 'title');
    const rel = htmlAttr(match[1], 'rel').toLowerCase();
    const isNext = rel.split(/\s+/).includes('next') || /^(?:next|次へ|次のページ|›|»|→)$/i.test(label);
    const isEarlyPage = /^[2-4]$/.test(label);
    const urlLooksPaged = /(?:[?&](?:page|p)=\d+|\/page\/\d+\/?$|\/\d+\/?$)/i.test(`${url.pathname}${url.search}`);
    if (!isNext && !isEarlyPage && !urlLooksPaged) continue;
    const score = (isNext ? 6 : 0) + (isEarlyPage ? 4 : 0) + (urlLooksPaged ? 2 : 0);
    seen.add(url.href);
    rows.push({ url: url.href, label: compactLogValue(label, 80), score });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, READER_IMAGE_DISCOVERY_PAGINATION_MAX);
}

async function discoverArticleViaPublisherIndexes(homePage, homepage, title) {
  const indexes = discoverPublisherIndexLinks(homePage?.text || '', homePage?.finalUrl || homepage);
  if (!indexes.length) return { article: null, checked: 0, paginationChecked: 0, error: 'publisher-index-not-found' };

  const indexPages = await Promise.all(indexes.map(async index => {
    try {
      const page = await fetchTextPrefix(index.url, {
        timeoutMs: READER_IMAGE_DISCOVERY_INDEX_TIMEOUT_MS,
        maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
      });
      if (!sameSiteHost(hostOf(homepage), hostOf(page.finalUrl))) return { index, page: null, article: null };
      const article = discoverArticleLinkFromHomepage(page.text, page.finalUrl || index.url, title);
      return { index, page, article };
    } catch { return { index, page: null, article: null }; }
  }));

  const matches = indexPages
    .filter(row => row.article)
    .map(row => ({ ...row.article, indexUrl: row.page?.finalUrl || row.index.url, indexLabel: row.index.label || '' }))
    .sort((a, b) => b.score - a.score);
  if (matches[0]) return { article: matches[0], checked: indexes.length, paginationChecked: 0, error: '' };

  const paginationCandidates = [];
  const paginationSeen = new Set();
  const addPagination = (html, baseUrl) => {
    for (const row of discoverPaginationLinks(html, baseUrl)) {
      if (paginationSeen.has(row.url)) continue;
      paginationSeen.add(row.url);
      paginationCandidates.push(row);
    }
  };
  addPagination(homePage?.text || '', homePage?.finalUrl || homepage);
  for (const row of indexPages) {
    if (row.page?.text) addPagination(row.page.text, row.page.finalUrl || row.index.url);
  }
  paginationCandidates.sort((a, b) => b.score - a.score);
  const pagination = paginationCandidates.slice(0, READER_IMAGE_DISCOVERY_PAGINATION_MAX);
  if (!pagination.length) {
    return { article: null, checked: indexes.length, paginationChecked: 0, error: 'publisher-index-article-not-found' };
  }

  const paginationResults = await Promise.all(pagination.map(async candidate => {
    try {
      const page = await fetchTextPrefix(candidate.url, {
        timeoutMs: READER_IMAGE_DISCOVERY_INDEX_TIMEOUT_MS,
        maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
      });
      if (!sameSiteHost(hostOf(homepage), hostOf(page.finalUrl))) return null;
      const article = discoverArticleLinkFromHomepage(page.text, page.finalUrl || candidate.url, title);
      return article ? { ...article, indexUrl: page.finalUrl || candidate.url, indexLabel: candidate.label || '' } : null;
    } catch { return null; }
  }));
  const pagedMatches = paginationResults.filter(Boolean).sort((a, b) => b.score - a.score);
  return pagedMatches[0]
    ? { article: pagedMatches[0], checked: indexes.length, paginationChecked: pagination.length, error: '' }
    : { article: null, checked: indexes.length, paginationChecked: pagination.length, error: 'publisher-index-pagination-article-not-found' };
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

    setCachedPublisherHomepage(source, homePage.finalUrl || homepage);
    let article = discoverArticleLinkFromHomepage(homePage.text, homePage.finalUrl || homepage, title);
    let discoveryMethod = 'publisher-homepage';
    let indexUrl = '';
    let indexChecked = 0;
    let paginationChecked = 0;
    if (!article?.articleUrl) {
      const indexResult = await discoverArticleViaPublisherIndexes(homePage, homepage, title);
      article = indexResult.article;
      indexChecked = Number(indexResult.checked || 0);
      paginationChecked = Number(indexResult.paginationChecked || 0);
      if (article?.articleUrl) {
        discoveryMethod = paginationChecked ? 'publisher-pagination' : 'publisher-index';
        indexUrl = article.indexUrl || '';
      } else {
        return {
          image: '', homepage, indexChecked, paginationChecked,
          error: indexResult.error || 'publisher-article-link-not-found'
        };
      }
    }

    const articlePage = await fetchTextPrefix(article.articleUrl, {
      timeoutMs: READER_IMAGE_DISCOVERY_ARTICLE_TIMEOUT_MS,
      maxBytes: READER_IMAGE_DISCOVERY_MAX_BYTES
    });
    if (!sameSiteHost(hostOf(homepage), hostOf(articlePage.finalUrl))) {
      return { image: '', homepage, articleUrl: article.articleUrl, indexUrl, indexChecked, paginationChecked, error: 'publisher-article-cross-site-redirect' };
    }
    const image = extractArticleImageFromHtml(articlePage.text, { baseUrl: articlePage.finalUrl || article.articleUrl });
    if (!image?.url) {
      return {
        image: '', homepage, articleUrl: articlePage.finalUrl || article.articleUrl,
        indexUrl, indexChecked, paginationChecked, similarity: article.similarity, error: 'publisher-article-no-image'
      };
    }
    return {
      image: image.url,
      method: `${discoveryMethod}:${image.method || 'image'}`,
      homepage,
      articleUrl: articlePage.finalUrl || article.articleUrl,
      indexUrl,
      indexChecked,
      paginationChecked,
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
    const publisherFallback = await resolveImageFromPublisherDiscovery(title, source);
    if (publisherFallback.image) {
      payload.image = compactLogValue(publisherFallback.image, 2200);
      payload.method = compactLogValue(publisherFallback.method, 120);
      payload.publisherUrl = compactLogValue(publisherFallback.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = publisherFallback.paginationChecked
        ? 'publisher-pagination'
        : publisherFallback.indexUrl ? 'publisher-index' : 'publisher-homepage';
      console.info('[reader-image-resolve:publisher-discovery]', {
        ok: true,
        articleId,
        source,
        publisherHost: hostOf(payload.publisherUrl),
        imageHost: hostOf(payload.image),
        method: payload.method,
        indexHost: hostOf(publisherFallback.indexUrl),
        indexChecked: Number(publisherFallback.indexChecked || 0),
        paginationChecked: Number(publisherFallback.paginationChecked || 0),
        similarity: Number(Number(publisherFallback.similarity || 0).toFixed(3)),
        sourceTitleScore: Number(Number(publisherFallback.sourceTitleScore || 0).toFixed(3)),
        elapsedMs: Date.now() - started
      });
    } else {
      const publisherError = compactLogValue(publisherFallback.error, 180);
      console.warn('[reader-image-resolve:publisher-discovery]', {
        ok: false,
        articleId,
        source,
        homepageHost: hostOf(publisherFallback.homepage),
        indexHost: hostOf(publisherFallback.indexUrl),
        indexChecked: Number(publisherFallback.indexChecked || 0),
        paginationChecked: Number(publisherFallback.paginationChecked || 0),
        reason: publisherError || 'unknown',
        elapsedMs: Date.now() - started
      });

      const gdeltFallback = await resolveImageFromGdelt(title, payload.publisherUrl || link);
      if (gdeltFallback.image) {
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
        const gdeltError = compactLogValue(gdeltFallback.error, 180);
        payload.fallbackError = compactLogValue(`publisher:${publisherError || 'unknown'};gdelt:${gdeltError || 'unknown'}`, 240);
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
