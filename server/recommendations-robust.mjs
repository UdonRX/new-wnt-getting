import {
  parseGoogleNews,
  parseGoogleTrends,
  filterBlockedSources,
  filterRecentGoogleNews,
  preliminaryScore
} from './recommendations.mjs';
import { resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

const GOOGLE_NEWS_URL = 'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja';
const GOOGLE_TRENDS_URL = 'https://trends.google.com/trending/rss?geo=JP';
const RECOMMENDATION_STRATEGY = 'google-news-trends-gdelt-source-date-article-v6';
const RECOMMENDATION_TTL_MS = 10 * 60 * 1000;
const TRENDS_TTL_MS = 15 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2600;
const GDELT_TIMEOUT_MS = 2200;
const GDELT_CHECK_COUNT = 4;
const GOOGLE_NEWS_CANDIDATE_COUNT = 20;
const INITIAL_SOURCE_DATE_CHECK_COUNT = 12;
const RECOMMENDATION_TARGET_COUNT = 10;
const SOURCE_DATE_STAGE_TIMEOUT_MS = 1300;
const RECENT_NEWS_WINDOW_MS = 12 * 60 * 60 * 1000;

const NON_ARTICLE_TITLE_RE = /(?:新着記事一覧|記事一覧|ニュース一覧|検索結果|タグ一覧|関連タグ|カテゴリ(?:ー)?一覧|アーカイブ一覧|新着一覧)/i;
const NON_ARTICLE_PATH_RE = /\/(?:relatedtags?|tags?|search|archive|archives|authors?)(?:\/|$)|\/(?:category|categories)\/[^/?#]+\/?$/i;

let recommendationCache = { at: 0, payload: null };
let trendsCache = { at: 0, rows: null };

function requestId() { return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function nowMs() { return Date.now(); }
function fresh(cache, ttl) { return Boolean(cache?.payload || cache?.rows) && nowMs() - Number(cache.at || 0) < ttl; }
function stripHtml(value = '') { return String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function isRecentTimestamp(timestamp, { now = nowMs(), windowMs = RECENT_NEWS_WINDOW_MS } = {}) {
  const value = Number(timestamp || 0);
  return Number.isFinite(value) && value > 0 && value >= now - windowMs && value <= now;
}

export function classifyRecommendationCandidate(item = {}, publisherUrl = '') {
  const title = stripHtml(item?.title || '');
  if (NON_ARTICLE_TITLE_RE.test(title)) return { nonArticle: true, pageType: 'list', reason: 'non-article-title' };
  const rawUrl = publisherUrl || item?.publisherUrl || '';
  if (rawUrl) {
    try {
      const path = new URL(String(rawUrl)).pathname || '';
      if (NON_ARTICLE_PATH_RE.test(path)) return { nonArticle: true, pageType: 'list', reason: 'non-article-publisher-path' };
    } catch {}
  }
  return { nonArticle: false, pageType: 'article-candidate', reason: '' };
}

export function filterArticleCandidates(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => !classifyRecommendationCandidate(item).nonArticle);
}

async function fetchWithTimeout(url, { timeoutMs = GOOGLE_TIMEOUT_MS, accept = '*/*' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: accept, 'User-Agent': 'new-wnt-getting/1.0 (+recommendation-selector)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await response.text(), elapsedMs: Date.now() - started };
  } finally { clearTimeout(timer); }
}

async function getTrends({ refresh = false } = {}) {
  if (!refresh && fresh(trendsCache, TRENDS_TTL_MS)) return { rows: trendsCache.rows, cache: 'hit', elapsedMs: 0, degraded: false };
  try {
    const result = await fetchWithTimeout(GOOGLE_TRENDS_URL, { accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' });
    const rows = parseGoogleTrends(result.text);
    if (!rows.length) throw new Error('Google Trends returned no rows');
    trendsCache = { at: nowMs(), rows };
    return { rows, cache: 'miss', elapsedMs: result.elapsedMs, degraded: false };
  } catch (error) {
    if (Array.isArray(trendsCache.rows) && trendsCache.rows.length) return { rows: trendsCache.rows, cache: 'stale', elapsedMs: 0, degraded: true, error: error?.message || String(error) };
    return { rows: [], cache: 'unavailable', elapsedMs: 0, degraded: true, error: error?.message || String(error) };
  }
}

function gdeltQuery(title = '') {
  return stripHtml(title)
    .replace(/[\[\]{}()"'“”‘’]/g, ' ')
    .split(/[\s　、。・:：｜|／/\-—]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2 && !/^(?:速報|最新|発表|明らか|について|ニュース)$/i.test(word))
    .slice(0, 5).join(' ').slice(0, 100);
}
function domainOf(article) {
  const direct = String(article?.domain || '').replace(/^www\./i, '').toLowerCase();
  if (direct) return direct;
  try { return new URL(String(article?.url || '')).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
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

async function resolveSourceBatch(items = []) {
  const rows = await Promise.all(items.map(item => resolveSourcePublishedTime(item.link, { stageTimeoutMs: SOURCE_DATE_STAGE_TIMEOUT_MS })));
  return items.map((item, index) => ({ item, result: rows[index] || {} }));
}
function sourceEligible(item, result, evaluatedAt) {
  if (!result?.sourcePublishedTimestamp || !isRecentTimestamp(result.sourcePublishedTimestamp, { now: evaluatedAt })) return false;
  return !classifyRecommendationCandidate(item, result.publisherUrl).nonArticle;
}
function mergeSourceResult(row, result = {}) {
  const classification = classifyRecommendationCandidate(row, result.publisherUrl);
  return {
    ...row,
    sourcePublishedTimestamp: Number(result.sourcePublishedTimestamp || 0),
    sourceDateMethod: result.sourceDateMethod || '',
    publisherUrl: result.publisherUrl || '',
    sourceDateError: result.error || '',
    sourceDateElapsedMs: Number(result.elapsedMs || 0),
    nonArticle: classification.nonArticle,
    pageType: classification.pageType,
    nonArticleReason: classification.reason
  };
}
function finalizeSelection(rows = []) {
  return [...rows]
    .filter(row => row.sourcePublishedTimestamp > 0 && !row.nonArticle)
    .sort((a, b) => {
      const byDate = Number(b.sourcePublishedTimestamp || 0) - Number(a.sourcePublishedTimestamp || 0);
      if (byDate) return byDate;
      return Number(b.score || 0) - Number(a.score || 0) || Number(a.googleRank || 0) - Number(b.googleRank || 0);
    })
    .map(row => ({
      id: row.id,
      title: row.title,
      // 配信元URLを直接使うことで、表示時にGoogle News中間URLをもう一度解決する無駄をなくす。
      link: row.publisherUrl || row.link,
      googleNewsLink: row.link,
      description: row.description,
      source: row.source,
      feedName: row.feedName,
      pubDate: new Date(row.sourcePublishedTimestamp).toISOString(),
      publishedTimestamp: row.sourcePublishedTimestamp,
      sourcePublishedTimestamp: row.sourcePublishedTimestamp,
      sourceDateMethod: row.sourceDateMethod || '',
      _readerMode: 'news',
      _recommendationLabel: '重要・話題ニュース'
    }));
}

async function buildRecommendations({ refresh = false, debug = false, id = requestId() } = {}) {
  const started = Date.now();
  const stage = {};
  const [newsResult, trendResult] = await Promise.all([
    fetchWithTimeout(GOOGLE_NEWS_URL, { accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }),
    getTrends({ refresh })
  ]);
  stage.googleNewsMs = newsResult.elapsedMs;
  stage.googleTrendsMs = trendResult.elapsedMs;
  stage.googleTrendsCache = trendResult.cache;
  stage.googleTrendsDegraded = Boolean(trendResult.degraded);

  const allNews = parseGoogleNews(newsResult.text);
  if (!allNews.length) throw Object.assign(new Error('Google News returned no candidates'), { stage: 'google-news' });

  const sourceAllowed = filterBlockedSources(allNews);
  const articleTitleAllowed = filterArticleCandidates(sourceAllowed);
  const allowedNews = articleTitleAllowed.slice(0, GOOGLE_NEWS_CANDIDATE_COUNT);
  stage.googleNewsCandidates = allNews.length;
  stage.blockedSourceCandidates = allNews.length - sourceAllowed.length;
  stage.nonArticleTitleCandidates = sourceAllowed.length - articleTitleAllowed.length;
  stage.candidatePoolLimit = GOOGLE_NEWS_CANDIDATE_COUNT;
  stage.candidatePool = allowedNews.length;
  if (!allowedNews.length) throw Object.assign(new Error('No article candidates after source/title filtering'), { stage: 'article-filter' });

  const evaluatedAt = nowMs();
  const recent = filterRecentGoogleNews(allowedNews, { now: evaluatedAt, windowMs: RECENT_NEWS_WINDOW_MS });
  stage.recentWindowHours = RECENT_NEWS_WINDOW_MS / 3600000;
  stage.googleRecentCandidates = recent.length;
  if (!recent.length) throw Object.assign(new Error('No recent Google News article candidates'), { stage: 'freshness' });

  let ranked = preliminaryScore(recent, trendResult.rows);
  const gdeltTargets = ranked.slice(0, Math.min(GDELT_CHECK_COUNT, ranked.length));
  const initialSourceTargets = ranked.slice(0, Math.min(INITIAL_SOURCE_DATE_CHECK_COUNT, ranked.length));

  const parallelStarted = Date.now();
  const [gdeltResults, initialSourceRows] = await Promise.all([
    Promise.all(gdeltTargets.map(checkGdelt)),
    resolveSourceBatch(initialSourceTargets)
  ]);
  stage.parallelVerificationMs = Date.now() - parallelStarted;
  stage.gdeltChecked = gdeltTargets.length;
  stage.gdeltSucceeded = gdeltResults.filter(row => row.ok).length;
  stage.gdeltDegraded = stage.gdeltChecked > 0 && stage.gdeltSucceeded === 0;

  const gdeltById = new Map(gdeltTargets.map((item, index) => [item.id, gdeltResults[index]]));
  ranked = ranked.map(row => {
    const gdelt = gdeltById.get(row.id);
    const independent = gdelt?.ok ? gdelt.count : 0;
    const gdeltScore = Math.min(24, independent * 4);
    return { ...row, gdeltIndependentSources: independent, gdeltScore, score: Number(row.preliminaryScore || 0) + gdeltScore };
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.googleRank || 0) - Number(b.googleRank || 0));

  const sourceById = new Map(initialSourceRows.map(({ item, result }) => [item.id, result]));
  let eligibleCount = initialSourceRows.filter(({ item, result }) => sourceEligible(item, result, evaluatedAt)).length;
  let replenishChecked = 0;

  // 通常は最初の12件だけ。足りない時だけ、まだ日時確認していない次候補を並列確認して自動補充する。
  while (eligibleCount < Math.min(RECOMMENDATION_TARGET_COUNT, ranked.length)) {
    const remaining = ranked.filter(row => !sourceById.has(row.id));
    if (!remaining.length) break;
    const need = Math.max(1, RECOMMENDATION_TARGET_COUNT - eligibleCount);
    const batchSize = Math.min(remaining.length, Math.max(need, 2), 4);
    const targets = remaining.slice(0, batchSize);
    const extraRows = await resolveSourceBatch(targets);
    replenishChecked += extraRows.length;
    extraRows.forEach(({ item, result }) => sourceById.set(item.id, result));
    eligibleCount += extraRows.filter(({ item, result }) => sourceEligible(item, result, evaluatedAt)).length;
  }

  stage.sourceDateChecked = sourceById.size;
  stage.sourceDateReplenishChecked = replenishChecked;
  stage.sourceDateSucceeded = [...sourceById.values()].filter(row => row?.sourcePublishedTimestamp).length;
  stage.sourceDateUnknown = stage.sourceDateChecked - stage.sourceDateSucceeded;

  const verifiedRows = ranked
    .filter(row => sourceById.has(row.id))
    .map(row => mergeSourceResult(row, sourceById.get(row.id)));
  stage.nonArticlePublisherCandidates = verifiedRows.filter(row => row.nonArticle).length;
  stage.sourceDateOld = verifiedRows.filter(row => row.sourcePublishedTimestamp > 0 && !isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt })).length;
  const recentVerified = verifiedRows.filter(row => isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt }) && !row.nonArticle);
  stage.sourceDateRecent = recentVerified.length;

  const items = finalizeSelection(recentVerified);
  if (!items.length) throw Object.assign(new Error('No recommendations with verified article publisher dates in the last 12 hours'), { stage: 'publisher-freshness' });

  const degradedSignals = [];
  if (stage.googleTrendsDegraded) degradedSignals.push('google-trends');
  if (stage.gdeltDegraded) degradedSignals.push('gdelt');
  if (stage.sourceDateUnknown > 0) degradedSignals.push('source-published-time-partial');

  const diagnostics = {
    requestId: id, strategy: RECOMMENDATION_STRATEGY, totalMs: Date.now() - started,
    candidates: allNews.length, trends: trendResult.rows.length, degradedSignals, ...stage,
    ranking: verifiedRows.map(row => ({
      id: row.id, title: row.title, source: row.source, googleRank: row.googleRank,
      sourcePublishedTimestamp: row.sourcePublishedTimestamp,
      sourceDateMethod: row.sourceDateMethod,
      publisherUrl: row.publisherUrl,
      pageType: row.pageType,
      nonArticle: row.nonArticle,
      nonArticleReason: row.nonArticleReason,
      trendMatch: row.trendMatch,
      trendScore: row.trendScore,
      importance: row.importanceCategory,
      importanceScore: row.importanceScore,
      gdeltIndependentSources: row.gdeltIndependentSources,
      gdeltScore: row.gdeltScore,
      totalScore: Number(Number(row.score || 0).toFixed(1)),
      eligibleBySourceDate: isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt }) && !row.nonArticle
    }))
  };
  if (debug) console.log('[recommendations:debug]', diagnostics);
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
    res.setHeader('X-Recommendation-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ strategy: RECOMMENDATION_STRATEGY, cached: true, items: recommendationCache.payload.items });
  }

  res.setHeader('X-Recommendation-Cache', 'MISS');
  res.setHeader('Cache-Control', debug || refresh ? 'no-store' : 'public, max-age=0, s-maxage=600, stale-while-revalidate=1200');
  console.log('[recommendations:start]', { requestId: id, debug, refresh, strategy: RECOMMENDATION_STRATEGY });
  try {
    const payload = await buildRecommendations({ refresh, debug, id });
    recommendationCache = { at: nowMs(), payload };
    console.log('[recommendations:success]', {
      requestId: id, items: payload.items.length,
      candidates: payload.diagnostics.candidates,
      nonArticleTitleCandidates: payload.diagnostics.nonArticleTitleCandidates,
      nonArticlePublisherCandidates: payload.diagnostics.nonArticlePublisherCandidates,
      sourceDateChecked: payload.diagnostics.sourceDateChecked,
      sourceDateReplenishChecked: payload.diagnostics.sourceDateReplenishChecked,
      sourceDateRecent: payload.diagnostics.sourceDateRecent,
      elapsedMs: payload.diagnostics.totalMs
    });
    return res.status(200).json({
      strategy: RECOMMENDATION_STRATEGY,
      cached: false,
      items: payload.items,
      degradedSignals: payload.diagnostics.degradedSignals,
      ...(debug ? { diagnostics: payload.diagnostics } : {})
    });
  } catch (error) {
    const stage = error?.stage || 'google-news';
    res.setHeader('Cache-Control', 'no-store');
    console.error('[recommendations:fallback-required]', { requestId: id, stage, name: error?.name, message: error?.message || String(error) });
    return res.status(503).json({
      error: 'Google News recommendation unavailable', fallbackRequired: true,
      strategy: RECOMMENDATION_STRATEGY, requestId: id, stage,
      ...(debug ? { detail: error?.message || String(error) } : {})
    });
  }
}
