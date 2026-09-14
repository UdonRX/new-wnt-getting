import {
  parseGoogleNews,
  parseGoogleTrends,
  filterBlockedSources,
  filterRecentGoogleNews,
  preliminaryScore
} from './recommendations.mjs';
import { NEWS_RECOMMENDATION_WINDOW_HOURS, NEWS_RECOMMENDATION_WINDOW_MS } from '../shared/recommendation-config.js';

const GOOGLE_NEWS_URL = 'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja';
const GOOGLE_TRENDS_URL = 'https://trends.google.com/trending/rss?geo=JP';
const RECOMMENDATION_STRATEGY = 'google-news-fast-freshness-v13';
const RECOMMENDATION_TTL_MS = 5 * 60 * 1000;
const TRENDS_TTL_MS = 15 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2600;
const GDELT_TIMEOUT_MS = 900;
const GDELT_CHECK_COUNT = 4;
const RECOMMENDATION_MIN_COUNT = 1;
const NON_ARTICLE_TITLE_RE = /(?:新着記事一覧|記事一覧|ニュース一覧|検索結果|タグ一覧|関連タグ|カテゴリ(?:ー)?一覧|アーカイブ一覧|新着一覧)/i;

let recommendationCache = { at: 0, payload: null };
let trendsCache = { at: 0, rows: null };

function requestId() { return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function nowMs() { return Date.now(); }
function fresh(cache, ttl) { return Boolean(cache?.payload || cache?.rows) && nowMs() - Number(cache.at || 0) < ttl; }
function stripHtml(value = '') {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function ageMinutes(timestamp, now = nowMs()) {
  const value = Number(timestamp || 0);
  return Number.isFinite(value) && value > 0 ? Math.max(0, Math.round((now - value) / 60000)) : null;
}
function hostOfUrl(rawUrl = '') {
  try { return new URL(String(rawUrl || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

export function classifyRecommendationCandidate(item = {}) {
  const title = stripHtml(item?.title || '');
  return NON_ARTICLE_TITLE_RE.test(title)
    ? { nonArticle: true, pageType: 'list', reason: 'non-article-title' }
    : { nonArticle: false, pageType: 'article-candidate', reason: '' };
}

export function filterArticleCandidates(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => !classifyRecommendationCandidate(item).nonArticle);
}

async function fetchWithTimeout(url, { timeoutMs = GOOGLE_TIMEOUT_MS, accept = '*/*', noCache = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = nowMs();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: noCache ? 'no-store' : 'default',
      headers: {
        Accept: accept,
        'User-Agent': 'new-wnt-getting/1.0 (+recommendation-selector)',
        ...(noCache ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await response.text(), elapsedMs: nowMs() - started };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getTrends({ refresh = false } = {}) {
  if (!refresh && fresh(trendsCache, TRENDS_TTL_MS)) {
    return { rows: trendsCache.rows, cache: 'hit', elapsedMs: 0, degraded: false };
  }
  try {
    const url = refresh ? `${GOOGLE_TRENDS_URL}&_=${nowMs()}` : GOOGLE_TRENDS_URL;
    const result = await fetchWithTimeout(url, {
      accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2',
      noCache: refresh
    });
    const rows = parseGoogleTrends(result.text);
    if (!rows.length) throw new Error('Google Trends returned no rows');
    trendsCache = { at: nowMs(), rows };
    return { rows, cache: 'miss', elapsedMs: result.elapsedMs, degraded: false };
  } catch (error) {
    if (Array.isArray(trendsCache.rows) && trendsCache.rows.length) {
      return { rows: trendsCache.rows, cache: 'stale', elapsedMs: 0, degraded: true, error: error?.message || String(error) };
    }
    return { rows: [], cache: 'unavailable', elapsedMs: 0, degraded: true, error: error?.message || String(error) };
  }
}

function gdeltQuery(title = '') {
  return stripHtml(title)
    .replace(/[\[\]{}()"'“”‘’]/g, ' ')
    .split(/[\s　、。・:：｜|／/\-—]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2 && !/^(?:速報|最新|発表|明らか|について|ニュース)$/i.test(word))
    .slice(0, 5)
    .join(' ')
    .slice(0, 100);
}
function domainOf(article) {
  const direct = String(article?.domain || '').replace(/^www\./i, '').toLowerCase();
  if (direct) return direct;
  try { return new URL(String(article?.url || '')).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}
async function checkGdelt(item) {
  const query = gdeltQuery(item?.title || '');
  if (!query) return { ok: false, count: 0, elapsedMs: 0, error: 'empty-query' };
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&format=json&sort=HybridRel&timespan=24h`;
  try {
    const result = await fetchWithTimeout(url, { timeoutMs: GDELT_TIMEOUT_MS, accept: 'application/json,text/plain,*/*' });
    const json = JSON.parse(result.text);
    const domains = new Set((Array.isArray(json?.articles) ? json.articles : []).map(domainOf).filter(Boolean));
    domains.delete('news.google.com');
    return { ok: true, count: domains.size, elapsedMs: result.elapsedMs };
  } catch (error) {
    return { ok: false, count: 0, elapsedMs: 0, error: error?.message || String(error) };
  }
}

function selectionTimestamp(row = {}) {
  for (const value of [row.googlePublishedTimestamp, row.publishedTimestamp, row.effectivePublishedTimestamp, row.sourcePublishedTimestamp]) {
    const timestamp = Number(value || 0);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  const parsed = new Date(row.pubDate || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function finalizeSelection(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter(row => !row.nonArticle && selectionTimestamp(row) > 0)
    .sort((a, b) => {
      const byDate = selectionTimestamp(b) - selectionTimestamp(a);
      if (byDate) return byDate;
      return Number(b.score || b.totalScore || 0) - Number(a.score || a.totalScore || 0)
        || Number(a.googleRank || 0) - Number(b.googleRank || 0);
    })
    .map(row => {
      const effectiveTimestamp = selectionTimestamp(row);
      const sourceTimestamp = Number(row.sourcePublishedTimestamp || 0);
      return {
        id: row.id || '',
        title: row.title || '',
        link: row.link || '',
        googleNewsLink: row.googleNewsLink || row.link || '',
        publisherUrl: row.publisherUrl || '',
        description: row.description || '',
        source: row.source || '',
        sourceUrl: row.sourceUrl || '',
        feedName: row.feedName || 'Google News',
        image: row.image || '',
        pubDate: new Date(effectiveTimestamp).toISOString(),
        googlePublishedTimestamp: effectiveTimestamp,
        publishedTimestamp: effectiveTimestamp,
        effectivePublishedTimestamp: effectiveTimestamp,
        sourcePublishedTimestamp: sourceTimestamp,
        sourceDateMethod: row.sourceDateMethod || '',
        sourceDateMismatchMinutes: sourceTimestamp > 0 ? Math.round((sourceTimestamp - effectiveTimestamp) / 60000) : null,
        recommendationDateSource: 'google-news',
        trendMatch: row.trendMatch || '',
        trendScore: Number(row.trendScore || 0),
        importance: row.importanceCategory || row.importance || '一般',
        importanceScore: Number(row.importanceScore || 0),
        gdeltIndependentSources: Number(row.gdeltIndependentSources || 0),
        totalScore: Number(row.score || row.totalScore || row.preliminaryScore || 0),
        _readerMode: 'news',
        _recommendationLabel: '重要・話題ニュース'
      };
    });
}

async function buildRecommendations({ refresh = false, debug = false, id = requestId() } = {}) {
  const started = nowMs();
  const stage = {};
  const newsUrl = `${GOOGLE_NEWS_URL}&_=${started}`;

  const [newsResult, trendResult] = await Promise.all([
    fetchWithTimeout(newsUrl, {
      accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2',
      noCache: true
    }),
    getTrends({ refresh })
  ]);

  stage.googleNewsMs = newsResult.elapsedMs;
  stage.googleTrendsMs = trendResult.elapsedMs;
  stage.googleTrendsCache = trendResult.cache;
  stage.googleTrendsDegraded = Boolean(trendResult.degraded);
  stage.forcedRefresh = Boolean(refresh);

  const allNews = parseGoogleNews(newsResult.text);
  if (!allNews.length) throw Object.assign(new Error('Google News returned no candidates'), { stage: 'google-news' });

  const sourceAllowed = filterBlockedSources(allNews);
  const articleTitleAllowed = filterArticleCandidates(sourceAllowed);
  const evaluatedAt = nowMs();
  const recent = filterRecentGoogleNews(articleTitleAllowed, { now: evaluatedAt, windowMs: NEWS_RECOMMENDATION_WINDOW_MS });

  stage.googleNewsCandidates = allNews.length;
  stage.blockedSourceCandidates = allNews.length - sourceAllowed.length;
  stage.nonArticleTitleCandidates = sourceAllowed.length - articleTitleAllowed.length;
  stage.recentWindowHours = NEWS_RECOMMENDATION_WINDOW_HOURS;
  stage.googleRecentCandidates = recent.length;
  stage.newestRawAgeMinutes = recent.length
    ? Math.min(...recent.map(row => ageMinutes(row.googlePublishedTimestamp || row.publishedTimestamp, evaluatedAt)).filter(Number.isFinite))
    : null;

  console.info('[recommendations:flow]', {
    requestId: id,
    phase: 'google-news-ready',
    elapsedMs: nowMs() - started,
    candidates: stage.googleNewsCandidates,
    recent: stage.googleRecentCandidates,
    newestAgeMinutes: stage.newestRawAgeMinutes,
    trendsCache: stage.googleTrendsCache,
    forcedRefresh: stage.forcedRefresh
  });

  if (!recent.length) throw Object.assign(new Error('No recent Google News article candidates'), { stage: 'freshness' });

  let ranked = preliminaryScore(recent, trendResult.rows);
  const gdeltTargets = ranked.slice(0, Math.min(GDELT_CHECK_COUNT, ranked.length));
  const gdeltStarted = nowMs();
  const gdeltResults = await Promise.all(gdeltTargets.map(checkGdelt));
  stage.gdeltMs = nowMs() - gdeltStarted;
  stage.gdeltChecked = gdeltTargets.length;
  stage.gdeltSucceeded = gdeltResults.filter(row => row.ok).length;
  stage.gdeltDegraded = stage.gdeltChecked > 0 && stage.gdeltSucceeded === 0;

  const gdeltById = new Map(gdeltTargets.map((item, index) => [item.id, gdeltResults[index]]));
  ranked = ranked.map(row => {
    const gdelt = gdeltById.get(row.id);
    const independent = gdelt?.ok ? gdelt.count : 0;
    const gdeltScore = Math.min(24, independent * 4);
    return {
      ...row,
      gdeltIndependentSources: independent,
      gdeltScore,
      score: Number(row.preliminaryScore || 0) + gdeltScore,
      effectivePublishedTimestamp: Number(row.googlePublishedTimestamp || row.publishedTimestamp || 0),
      sourcePublishedTimestamp: 0,
      sourceDateMethod: '',
      publisherUrl: '',
      image: row.image || '',
      nonArticle: false,
      pageType: 'article-candidate'
    };
  });

  const items = finalizeSelection(ranked);
  if (items.length < RECOMMENDATION_MIN_COUNT) {
    throw Object.assign(new Error('No recommendation articles available after freshness filtering'), { stage: 'recommendation-empty' });
  }

  stage.itemsReturned = items.length;
  stage.imageCount = items.filter(item => item.image).length;
  stage.imageMissingCount = items.length - stage.imageCount;
  stage.newestGoogleAgeMinutes = ageMinutes(items[0]?.publishedTimestamp, evaluatedAt);
  stage.oldestGoogleAgeMinutes = ageMinutes(items.at(-1)?.publishedTimestamp, evaluatedAt);
  stage.enrichmentMode = 'freshness-first-deferred-publisher';
  stage.publisherResolutionDeferred = true;
  stage.sourceDateDeferred = true;
  stage.totalMs = nowMs() - started;

  const degradedSignals = [];
  if (stage.googleTrendsDegraded) degradedSignals.push('google-trends');
  if (stage.gdeltDegraded) degradedSignals.push('gdelt');
  if (stage.imageMissingCount > 0) degradedSignals.push('article-image-deferred');

  const diagnostics = {
    requestId: id,
    strategy: RECOMMENDATION_STRATEGY,
    degradedSignals,
    candidates: allNews.length,
    trends: trendResult.rows.length,
    ...stage,
    ranking: debug ? ranked.map(row => ({
      id: row.id,
      title: row.title,
      source: row.source,
      googleRank: row.googleRank,
      googlePublishedTimestamp: Number(row.googlePublishedTimestamp || row.publishedTimestamp || 0),
      ageMinutes: ageMinutes(row.googlePublishedTimestamp || row.publishedTimestamp, evaluatedAt),
      trendMatch: row.trendMatch,
      trendScore: row.trendScore,
      importance: row.importanceCategory,
      importanceScore: row.importanceScore,
      gdeltIndependentSources: row.gdeltIndependentSources,
      gdeltScore: row.gdeltScore,
      totalScore: Number(Number(row.score || 0).toFixed(1)),
      hasImage: Boolean(row.image),
      sourceHost: hostOfUrl(row.sourceUrl)
    })) : undefined
  };

  console.info('[recommendations:flow]', {
    requestId: id,
    phase: 'freshness-first-complete',
    elapsedMs: diagnostics.totalMs,
    items: diagnostics.itemsReturned,
    newestAgeMinutes: diagnostics.newestGoogleAgeMinutes,
    oldestAgeMinutes: diagnostics.oldestGoogleAgeMinutes,
    googleNewsMs: diagnostics.googleNewsMs,
    gdeltMs: diagnostics.gdeltMs,
    gdeltSucceeded: diagnostics.gdeltSucceeded,
    trendsDegraded: diagnostics.googleTrendsDegraded,
    publisherResolutionDeferred: true
  });

  return { items, diagnostics };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const debug = String(req.query?.debug || '') === '1';
  const refresh = String(req.query?.refresh || '') === '1';
  const id = requestId();
  res.setHeader('X-Recommendation-Strategy', RECOMMENDATION_STRATEGY);
  res.setHeader('X-Recommendation-Request-Id', id);

  if (!debug && !refresh && fresh(recommendationCache, RECOMMENDATION_TTL_MS)) {
    const payload = recommendationCache.payload;
    const newestPublishedTimestamp = Number(payload?.items?.[0]?.publishedTimestamp || 0);
    res.setHeader('X-Recommendation-Cache', 'HIT');
    res.setHeader('X-Recommendation-Newest-Age-Minutes', String(ageMinutes(newestPublishedTimestamp) ?? ''));
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=300');
    return res.status(200).json({
      strategy: RECOMMENDATION_STRATEGY,
      requestId: id,
      cached: true,
      generatedAt: recommendationCache.at,
      serverElapsedMs: 0,
      newestPublishedTimestamp,
      items: payload.items,
      degradedSignals: payload.diagnostics?.degradedSignals || []
    });
  }

  res.setHeader('X-Recommendation-Cache', 'MISS');
  res.setHeader('Cache-Control', debug || refresh ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=300');
  console.info('[recommendations:start]', { requestId: id, debug, refresh, strategy: RECOMMENDATION_STRATEGY });

  try {
    const payload = await buildRecommendations({ refresh, debug, id });
    const generatedAt = nowMs();
    recommendationCache = { at: generatedAt, payload };
    const newestPublishedTimestamp = Number(payload.items[0]?.publishedTimestamp || 0);
    res.setHeader('Server-Timing', `recommendations;dur=${payload.diagnostics.totalMs}`);
    res.setHeader('X-Recommendation-Newest-Age-Minutes', String(payload.diagnostics.newestGoogleAgeMinutes ?? ''));
    res.setHeader('X-Recommendation-Generated-At', String(generatedAt));
    console.info('[recommendations:success]', {
      requestId: id,
      items: payload.items.length,
      newestGoogleAgeMinutes: payload.diagnostics.newestGoogleAgeMinutes,
      oldestGoogleAgeMinutes: payload.diagnostics.oldestGoogleAgeMinutes,
      googleNewsCandidates: payload.diagnostics.googleNewsCandidates,
      googleRecentCandidates: payload.diagnostics.googleRecentCandidates,
      googleNewsMs: payload.diagnostics.googleNewsMs,
      gdeltMs: payload.diagnostics.gdeltMs,
      totalMs: payload.diagnostics.totalMs,
      forcedRefresh: payload.diagnostics.forcedRefresh,
      enrichmentMode: payload.diagnostics.enrichmentMode
    });
    return res.status(200).json({
      strategy: RECOMMENDATION_STRATEGY,
      requestId: id,
      cached: false,
      generatedAt,
      serverElapsedMs: payload.diagnostics.totalMs,
      newestPublishedTimestamp,
      items: payload.items,
      degradedSignals: payload.diagnostics.degradedSignals,
      ...(debug ? { diagnostics: payload.diagnostics } : {})
    });
  } catch (error) {
    const stage = error?.stage || 'google-news';
    res.setHeader('Cache-Control', 'no-store');
    console.error('[recommendations:fallback-required]', {
      requestId: id,
      stage,
      name: error?.name,
      message: error?.message || String(error)
    });
    return res.status(503).json({
      error: 'Google News recommendation unavailable',
      fallbackRequired: true,
      strategy: RECOMMENDATION_STRATEGY,
      requestId: id,
      stage,
      ...(debug ? { detail: error?.message || String(error) } : {})
    });
  }
}
