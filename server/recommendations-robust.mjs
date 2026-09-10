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
const RECOMMENDATION_STRATEGY = 'google-news-trends-gdelt-source-date-article-image-v9';
const RECOMMENDATION_TTL_MS = 10 * 60 * 1000;
const TRENDS_TTL_MS = 15 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2600;
const GDELT_TIMEOUT_MS = 2200;
const GDELT_CHECK_COUNT = 4;
// ここから下の件数は表示上限ではなく、追加メタデータ取得の速度を守るための enrichment budget。
// 未確認の記事も Google News の日時が12時間以内なら候補から落とさない。
const SOURCE_DATE_ENRICHMENT_COUNT = 12;
const RECOMMENDATION_MIN_COUNT = 5;
const SOURCE_DATE_STAGE_TIMEOUT_MS = 1300;
const RECENT_NEWS_WINDOW_MS = 12 * 60 * 60 * 1000;
const PUBLISHER_VERIFY_TIMEOUT_MS = 1200;
const PUBLISHER_VERIFY_MAX_BYTES = 256 * 1024;
const PUBLISHER_VERIFY_ENRICHMENT_COUNT = 6;

// 明らかな一覧タイトルだけはGoogle News候補の時点で除外する。
const NON_ARTICLE_TITLE_RE = /(?:新着記事一覧|記事一覧|ニュース一覧|検索結果|タグ一覧|関連タグ|カテゴリ(?:ー)?一覧|アーカイブ一覧|新着一覧)/i;
// publisherUrlのpathは「疑い」のヒントにだけ使い、これだけでは候補を落とさない。
const NON_ARTICLE_PATH_HINT_RE = /\/(?:relatedtags?|tags?|search|archive|archives|authors?)(?:\/|$)|\/(?:category|categories)\/[^/?#]+\/?$/i;
const ARTICLE_DATE_METHOD_RE = /^(?:json-ld:datePublished|meta:article:published_time|meta:og:published_time|meta:datepublished|time:datePublished)$/i;

let recommendationCache = { at: 0, payload: null };
let trendsCache = { at: 0, rows: null };

function requestId() { return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function nowMs() { return Date.now(); }
function fresh(cache, ttl) { return Boolean(cache?.payload || cache?.rows) && nowMs() - Number(cache.at || 0) < ttl; }
function stripHtml(value = '') { return String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim(); }
function isRecentTimestamp(timestamp, { now = nowMs(), windowMs = RECENT_NEWS_WINDOW_MS } = {}) {
  const value = Number(timestamp || 0);
  return Number.isFinite(value) && value > 0 && value >= now - windowMs && value <= now;
}
function publisherPathHint(rawUrl = '') {
  try { return NON_ARTICLE_PATH_HINT_RE.test(new URL(String(rawUrl)).pathname || ''); }
  catch { return false; }
}
function hostOfUrl(rawUrl = '') {
  try { return new URL(String(rawUrl || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

export function classifyRecommendationCandidate(item = {}, publisherUrl = '') {
  const title = stripHtml(item?.title || '');
  if (NON_ARTICLE_TITLE_RE.test(title)) {
    return { nonArticle: true, pageType: 'list', reason: 'non-article-title', publisherPathHint: false };
  }
  const rawUrl = publisherUrl || item?.publisherUrl || '';
  const pathHint = publisherPathHint(rawUrl);
  return {
    nonArticle: false,
    pageType: pathHint ? 'article-candidate-path-hint' : 'article-candidate',
    reason: '',
    publisherPathHint: pathHint
  };
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

async function readResponsePrefix(response, maxBytes = PUBLISHER_VERIFY_MAX_BYTES) {
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

async function fetchPublisherHtmlPrefix(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISHER_VERIFY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=.2',
        'Accept-Language': 'ja,en-US;q=.8,en;q=.6',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('xml') && !type.includes('text/plain')) throw new Error('not-html');
    return {
      text: await readResponsePrefix(response),
      finalUrl: response.url || rawUrl,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function htmlTagText(html = '', tag = 'title') {
  const match = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return stripHtml(match?.[1] || '');
}

function analyzePublisherHtml(html = '', rawUrl = '') {
  const source = String(html || '');
  const hasArticleType = /"@type"\s*:\s*(?:"(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle)"|\[[^\]]*"(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle)"[^\]]*\])/i.test(source);
  const hasArticleBody = /"articleBody"\s*:/i.test(source);
  const hasDatePublished = /"datePublished"\s*:|article:published_time|og:published_time|itemprop\s*=\s*["']datePublished["']/i.test(source);
  const articleTagCount = (source.match(/<article\b/gi) || []).length;
  const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripHtml(match[1]))
    .filter(text => text.length >= 24)
    .slice(0, 80);
  const paragraphChars = paragraphs.reduce((sum, text) => sum + text.length, 0);
  const heading = `${htmlTagText(source, 'title')} ${htmlTagText(source, 'h1')}`.trim();
  const listHeading = NON_ARTICLE_TITLE_RE.test(heading);
  const pathHint = publisherPathHint(rawUrl);

  const strongArticle = Boolean(
    hasArticleBody
    || (hasArticleType && (hasDatePublished || paragraphChars >= 180))
    || (hasDatePublished && articleTagCount === 1 && paragraphChars >= 160)
    || (hasDatePublished && paragraphs.length >= 3 && paragraphChars >= 260)
  );

  // pathだけでは落とさない。HTMLを見てもArticle系シグナルがなく、
  // かつページ自身が一覧を明示している場合にだけ「非記事」を確定する。
  const confirmedNonArticle = Boolean(pathHint && !strongArticle && listHeading);

  return {
    confirmedArticle: strongArticle,
    confirmedNonArticle,
    pageType: confirmedNonArticle ? 'list' : strongArticle ? 'article' : 'unknown',
    reason: confirmedNonArticle ? 'publisher-html-list-confirmed' : '',
    hasArticleType,
    hasArticleBody,
    hasDatePublished,
    articleTagCount,
    paragraphCount: paragraphs.length,
    paragraphChars,
    listHeading
  };
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

function mergeSourceResult(row, result = {}) {
  const classification = classifyRecommendationCandidate(row, result.publisherUrl);
  const sourceDateMethod = String(result.sourceDateMethod || '');
  return {
    ...row,
    image: row.image || result.sourceImage || '',
    sourceImageMethod: result.sourceImageMethod || '',
    sourcePublishedTimestamp: Number(result.sourcePublishedTimestamp || 0),
    sourceDateMethod,
    publisherUrl: result.publisherUrl || '',
    sourceDateError: result.error || '',
    sourceDateElapsedMs: Number(result.elapsedMs || 0),
    publisherPathHint: classification.publisherPathHint,
    publisherArticleConfirmed: Boolean(result.publisherUrl && !classification.publisherPathHint && ARTICLE_DATE_METHOD_RE.test(sourceDateMethod)),
    publisherHtmlChecked: false,
    publisherHtmlElapsedMs: 0,
    publisherHtmlSignals: null,
    nonArticle: classification.nonArticle,
    pageType: classification.pageType,
    nonArticleReason: classification.reason
  };
}

async function verifyPublisherPathHints(rows = []) {
  const targets = rows
    .filter(row => row.publisherUrl && row.publisherPathHint && !row.nonArticle)
    .slice(0, PUBLISHER_VERIFY_ENRICHMENT_COUNT);
  const checks = await Promise.all(targets.map(async row => {
    try {
      const page = await fetchPublisherHtmlPrefix(row.publisherUrl);
      return { id: row.id, page, analysis: analyzePublisherHtml(page.text, page.finalUrl || row.publisherUrl) };
    } catch (error) {
      return { id: row.id, error: error?.message || String(error) };
    }
  }));
  const byId = new Map(checks.map(check => [check.id, check]));
  return rows.map(row => {
    const check = byId.get(row.id);
    if (!check) return row;
    if (check.error) {
      return {
        ...row,
        publisherHtmlChecked: true,
        publisherHtmlError: check.error,
        publisherHtmlElapsedMs: 0
      };
    }
    const analysis = check.analysis || {};
    return {
      ...row,
      publisherUrl: check.page?.finalUrl || row.publisherUrl,
      publisherHtmlChecked: true,
      publisherHtmlElapsedMs: Number(check.page?.elapsedMs || 0),
      publisherHtmlSignals: analysis,
      publisherArticleConfirmed: Boolean(analysis.confirmedArticle),
      nonArticle: Boolean(analysis.confirmedNonArticle),
      pageType: analysis.pageType || row.pageType,
      nonArticleReason: analysis.reason || ''
    };
  });
}

function selectionTimestamp(row = {}) {
  return Number(row.effectivePublishedTimestamp || row.sourcePublishedTimestamp || row.googlePublishedTimestamp || row.publishedTimestamp || 0);
}

function finalizeSelection(rows = []) {
  return [...rows]
    .filter(row => !row.nonArticle && selectionTimestamp(row) > 0)
    .sort((a, b) => {
      if (a.selectionSource !== b.selectionSource) {
        if (a.selectionSource === 'publisher-verified') return -1;
        if (b.selectionSource === 'publisher-verified') return 1;
      }
      const byDate = selectionTimestamp(b) - selectionTimestamp(a);
      if (byDate) return byDate;
      return Number(b.score || 0) - Number(a.score || 0) || Number(a.googleRank || 0) - Number(b.googleRank || 0);
    })
    .map(row => {
      const effectiveTimestamp = selectionTimestamp(row);
      const usePublisherLink = Boolean(row.publisherArticleConfirmed && row.publisherUrl);
      return {
        id: row.id,
        title: row.title,
        // 配信元が「記事」と確認できた時だけ直URLを使う。
        // 未確認・日時取得失敗・path疑いは旧版同様Google News URLを保持する。
        link: usePublisherLink ? row.publisherUrl : row.link,
        googleNewsLink: row.link,
        description: row.description,
        source: row.source,
        sourceUrl: row.sourceUrl || '',
        feedName: row.feedName,
        image: row.image || '',
        pubDate: new Date(effectiveTimestamp).toISOString(),
        publishedTimestamp: effectiveTimestamp,
        sourcePublishedTimestamp: Number(row.sourcePublishedTimestamp || 0),
        sourceDateMethod: row.sourceDateMethod || '',
        recommendationDateSource: row.selectionSource === 'publisher-verified' ? 'publisher' : 'google-news',
        _readerMode: 'news',
        _recommendationLabel: '重要・話題ニュース'
      };
    });
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
  // ここではタイトルだけをhard filterにする。publisher pathは後段の参考情報。
  const articleTitleAllowed = filterArticleCandidates(sourceAllowed);
  // 記事件数では切らない。Google News RSSが返した全候補を12時間フィルタへ渡す。
  const allowedNews = articleTitleAllowed;
  stage.googleNewsCandidates = allNews.length;
  stage.blockedSourceCandidates = allNews.length - sourceAllowed.length;
  stage.nonArticleTitleCandidates = sourceAllowed.length - articleTitleAllowed.length;
  stage.candidatePoolUnbounded = true;
  stage.candidatePool = allowedNews.length;
  if (!allowedNews.length) throw Object.assign(new Error('No article candidates after source/title filtering'), { stage: 'article-filter' });

  const evaluatedAt = nowMs();
  const recent = filterRecentGoogleNews(allowedNews, { now: evaluatedAt, windowMs: RECENT_NEWS_WINDOW_MS });
  stage.recentWindowHours = RECENT_NEWS_WINDOW_MS / 3600000;
  stage.googleRecentCandidates = recent.length;
  if (!recent.length) throw Object.assign(new Error('No recent Google News article candidates'), { stage: 'freshness' });

  let ranked = preliminaryScore(recent, trendResult.rows);
  const gdeltTargets = ranked.slice(0, Math.min(GDELT_CHECK_COUNT, ranked.length));
  // 配信元日時は上位だけを enrichment するが、未確認の記事も最終候補には残す。
  const initialSourceTargets = ranked.slice(0, Math.min(SOURCE_DATE_ENRICHMENT_COUNT, ranked.length));

  // GDELTと配信元日時は並列。日時確認に失敗しても後段でGoogle News日時を使って補充する。
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
  stage.sourceDateEnrichmentLimit = SOURCE_DATE_ENRICHMENT_COUNT;
  stage.sourceDateChecked = sourceById.size;
  stage.sourceDateReplenishChecked = 0;
  stage.sourceDateSucceeded = [...sourceById.values()].filter(row => row?.sourcePublishedTimestamp).length;
  stage.sourceDateUnknown = stage.sourceDateChecked - stage.sourceDateSucceeded;
  stage.sourceImageFound = [...sourceById.values()].filter(row => row?.sourceImage).length;

  let checkedRows = ranked
    .filter(row => sourceById.has(row.id))
    .map(row => mergeSourceResult(row, sourceById.get(row.id)));

  // /tag/ /category/ 等はここで初めてHTMLを確認する。
  // pathだけでは除外せず、Article/NewsArticle/articleBody/datePublished/本文段落の証拠を評価する。
  checkedRows = await verifyPublisherPathHints(checkedRows);
  const checkedById = new Map(checkedRows.map(row => [row.id, row]));

  stage.publisherVerifyEnrichmentLimit = PUBLISHER_VERIFY_ENRICHMENT_COUNT;
  stage.publisherPathHints = checkedRows.filter(row => row.publisherPathHint).length;
  stage.publisherHtmlChecked = checkedRows.filter(row => row.publisherHtmlChecked).length;
  stage.publisherHtmlConfirmedArticle = checkedRows.filter(row => row.publisherHtmlSignals?.confirmedArticle).length;
  stage.publisherHtmlConfirmedNonArticle = checkedRows.filter(row => row.nonArticle && row.nonArticleReason === 'publisher-html-list-confirmed').length;
  stage.nonArticlePublisherCandidates = checkedRows.filter(row => row.nonArticle).length;
  stage.sourceDateOld = checkedRows.filter(row => row.sourcePublishedTimestamp > 0 && !isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt })).length;

  const verifiedRecent = checkedRows
    .filter(row => !row.nonArticle && isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt }))
    .map(row => ({
      ...row,
      selectionSource: 'publisher-verified',
      effectivePublishedTimestamp: row.sourcePublishedTimestamp
    }));
  stage.sourceDateRecent = verifiedRecent.length;

  const verifiedIds = new Set(verifiedRecent.map(row => row.id));
  const supplementRows = ranked
    .filter(row => !verifiedIds.has(row.id))
    .map(row => checkedById.get(row.id) || row)
    .filter(row => {
      if (row.nonArticle) return false;
      // 配信元日時が取得できて「12時間より古い」と分かった記事は補充しない。
      if (Number(row.sourcePublishedTimestamp || 0) > 0 && !isRecentTimestamp(row.sourcePublishedTimestamp, { now: evaluatedAt })) return false;
      // 配信元日時が取得できない/未確認なら、Google News上で12時間以内であることを使う。
      return isRecentTimestamp(row.googlePublishedTimestamp || row.publishedTimestamp, { now: evaluatedAt });
    })
    .map(row => ({
      ...row,
      selectionSource: 'google-news-supplement',
      effectivePublishedTimestamp: Number(row.googlePublishedTimestamp || row.publishedTimestamp || 0)
    }));

  // 表示件数の目標値・上限値は設けない。12時間条件を満たす候補をすべて返す。
  const selectedRows = [...verifiedRecent, ...supplementRows];
  const items = finalizeSelection(selectedRows);

  stage.verifiedCount = verifiedRecent.length;
  stage.supplementedCount = items.filter(item => item.recommendationDateSource === 'google-news').length;
  stage.itemsReturned = items.length;
  stage.imageCount = items.filter(item => item.image).length;
  stage.imageMissingCount = items.length - stage.imageCount;
  stage.outputCountUnbounded = true;

  // 1件だけを成功扱いにはしない。最低5件に届かない場合は既存RSS fallbackへ渡す。
  if (items.length < RECOMMENDATION_MIN_COUNT) {
    throw Object.assign(new Error(`Only ${items.length} recommendation articles available after supplementation`), { stage: 'recommendation-minimum' });
  }

  const degradedSignals = [];
  if (stage.googleTrendsDegraded) degradedSignals.push('google-trends');
  if (stage.gdeltDegraded) degradedSignals.push('gdelt');
  if (stage.sourceDateUnknown > 0) degradedSignals.push('source-published-time-partial');
  if (stage.supplementedCount > 0) degradedSignals.push('google-news-date-supplement');
  if (stage.imageMissingCount > 0) degradedSignals.push('article-image-partial');

  if (stage.imageMissingCount > 0) {
    console.warn('[recommendations:image-missing]', {
      requestId: id,
      missing: stage.imageMissingCount,
      total: items.length,
      articles: items.filter(item => !item.image).slice(0, 12).map(item => ({ id: item.id, title: item.title, source: item.source }))
    });
  }

  const diagnostics = {
    requestId: id, strategy: RECOMMENDATION_STRATEGY, totalMs: Date.now() - started,
    candidates: allNews.length, trends: trendResult.rows.length, degradedSignals, ...stage,
    ranking: ranked.map(row => {
      const checked = checkedById.get(row.id) || row;
      return {
        id: row.id, title: row.title, source: row.source, googleRank: row.googleRank,
        googlePublishedTimestamp: Number(row.googlePublishedTimestamp || row.publishedTimestamp || 0),
        sourcePublishedTimestamp: Number(checked.sourcePublishedTimestamp || 0),
        sourceDateMethod: checked.sourceDateMethod || '',
        publisherUrl: checked.publisherUrl || '',
        publisherPathHint: Boolean(checked.publisherPathHint),
        publisherArticleConfirmed: Boolean(checked.publisherArticleConfirmed),
        publisherHtmlChecked: Boolean(checked.publisherHtmlChecked),
        publisherHtmlSignals: checked.publisherHtmlSignals || null,
        pageType: checked.pageType || 'article-candidate',
        nonArticle: Boolean(checked.nonArticle),
        nonArticleReason: checked.nonArticleReason || '',
        hasImage: Boolean(checked.image),
        imageHost: hostOfUrl(checked.image),
        sourceImageMethod: checked.sourceImageMethod || '',
        trendMatch: row.trendMatch,
        trendScore: row.trendScore,
        importance: row.importanceCategory,
        importanceScore: row.importanceScore,
        gdeltIndependentSources: row.gdeltIndependentSources,
        gdeltScore: row.gdeltScore,
        totalScore: Number(Number(row.score || 0).toFixed(1)),
        eligibleBySourceDate: isRecentTimestamp(checked.sourcePublishedTimestamp, { now: evaluatedAt }),
        eligibleByGoogleDate: isRecentTimestamp(row.googlePublishedTimestamp || row.publishedTimestamp, { now: evaluatedAt })
      };
    })
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
      requestId: id,
      items: payload.items.length,
      itemsReturned: payload.diagnostics.itemsReturned,
      verifiedCount: payload.diagnostics.verifiedCount,
      supplementedCount: payload.diagnostics.supplementedCount,
      imageCount: payload.diagnostics.imageCount,
      imageMissingCount: payload.diagnostics.imageMissingCount,
      sourceImageFound: payload.diagnostics.sourceImageFound,
      candidates: payload.diagnostics.candidates,
      nonArticleTitleCandidates: payload.diagnostics.nonArticleTitleCandidates,
      nonArticlePublisherCandidates: payload.diagnostics.nonArticlePublisherCandidates,
      publisherPathHints: payload.diagnostics.publisherPathHints,
      publisherHtmlChecked: payload.diagnostics.publisherHtmlChecked,
      publisherHtmlConfirmedNonArticle: payload.diagnostics.publisherHtmlConfirmedNonArticle,
      sourceDateChecked: payload.diagnostics.sourceDateChecked,
      sourceDateRecent: payload.diagnostics.sourceDateRecent,
      outputCountUnbounded: payload.diagnostics.outputCountUnbounded,
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