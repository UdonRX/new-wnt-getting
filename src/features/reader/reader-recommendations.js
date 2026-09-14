import { RECOMMENDATION_CACHE_SCHEMA } from '../../../shared/recommendation-config.js';

const RECOMMENDATION_TIMEOUT_MS = 10000;
const RECOMMENDATION_API_VERSION = '8';
export const RECOMMENDATION_SNAPSHOT_KEY = `pdv2:recommendationSnapshot:v${RECOMMENDATION_CACHE_SCHEMA}`;
const HOME_RECOMMENDATION_SNAPSHOT_KEY = 'pdv2:recommendationSnapshot:v1';
const REFRESH_META_KEY = 'pdv2:recommendationRefreshMeta:v1';
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
let recommendationInflight = null;

function safeParse(value) {
  try { return JSON.parse(value || 'null'); } catch { return null; }
}
function itemTimestamp(item = {}) {
  for (const value of [item.googlePublishedTimestamp, item.publishedTimestamp, item.effectivePublishedTimestamp, item.sourcePublishedTimestamp]) {
    const num = Number(value || 0); if (Number.isFinite(num) && num > 0) return num;
  }
  const parsed = new Date(item.pubDate || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function ageMinutes(timestamp, now = Date.now()) {
  const value = Number(timestamp || 0);
  return Number.isFinite(value) && value > 0 ? Math.max(0, Math.round((now - value) / 60000)) : null;
}
function sortLatest(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
}
function newestAgeMinutes(items = [], now = Date.now()) {
  const latest = sortLatest(items)[0];
  return ageMinutes(itemTimestamp(latest), now);
}
function writeRefreshMeta(patch = {}) {
  try {
    const previous = safeParse(localStorage.getItem(REFRESH_META_KEY)) || {};
    const next = { ...previous, ...patch };
    localStorage.setItem(REFRESH_META_KEY, JSON.stringify(next));
    globalThis.__PDV2_LAST_RECOMMENDATION_REFRESH = next;
    return next;
  } catch {
    const next = { ...patch };
    globalThis.__PDV2_LAST_RECOMMENDATION_REFRESH = next;
    return next;
  }
}
function compactItem(item = {}) {
  return {
    id: item.id || '', title: item.title || '', link: item.link || '', publisherUrl: item.publisherUrl || '', sourceUrl: item.sourceUrl || '', description: String(item.description || '').slice(0, 900),
    source: item.source || '', feedName: item.feedName || '', image: item.image || '', pubDate: item.pubDate || '', recommendationDateSource: item.recommendationDateSource || '',
    googlePublishedTimestamp: Number(item.googlePublishedTimestamp || item.publishedTimestamp || 0),
    publishedTimestamp: Number(item.publishedTimestamp || 0), sourcePublishedTimestamp: Number(item.sourcePublishedTimestamp || 0),
    effectivePublishedTimestamp: Number(item.effectivePublishedTimestamp || item.publishedTimestamp || 0), sourceDateMismatchMinutes: Number.isFinite(Number(item.sourceDateMismatchMinutes)) ? Number(item.sourceDateMismatchMinutes) : null,
    trendMatch: item.trendMatch || '', trendScore: Number(item.trendScore || 0),
    importance: item.importance || '', importanceScore: Number(item.importanceScore || 0), gdeltIndependentSources: Number(item.gdeltIndependentSources || 0),
    totalScore: Number(item.totalScore || 0), _readerMode: 'news', _recommendationLabel: item._recommendationLabel || '重要・話題ニュース'
  };
}
function normalizeTitle(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ').replace(/[\[\]【】「」『』（）()〈〉《》“”"'’‘]/g, ' ')
    .replace(/(?:速報|詳報|更新|写真|動画|解説|ライブ|live|breaking)/gi, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '').trim();
}
function grams(value = '') {
  const text = normalizeTitle(value); const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const aa = grams(a), bb = grams(b); if (!aa.size || !bb.size) return 0;
  let same = 0; for (const token of aa) if (bb.has(token)) same += 1;
  return (2 * same) / (aa.size + bb.size);
}

function majorTerms(value = '') {
  const source = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ').replace(/[\[\]【】「」『』（）()〈〉《》“”"'’‘,:：;；!?！？。・／/|｜―—-]/g, ' ')
    .replace(/(?:速報|詳報|更新|写真|動画|解説|ライブ|live|breaking|ニュース|news|発表|明らか)/gi, ' ');
  const tokens = source.match(/[一-龠々]{2,}|[ァ-ヶー]{3,}|[a-z0-9][a-z0-9.+_-]{2,}/g) || [];
  const chunks = source.split(/\s+|(?:について|による|として|から|まで|より|ため|など|その|この|こと|もの|の|が|を|に|で|と|へ)/)
    .map(v => v.replace(/[\s\p{P}\p{S}]+/gu, '').trim()).filter(v => v.length >= 4);
  return new Set([...tokens, ...chunks].filter(v => !/^(?:政府|企業|日本|海外|新た|正式|決定|開始|発表|対応|今後)$/i.test(v)).slice(0, 16));
}
function sharedMajorCount(a, b) {
  const aa = majorTerms(a), bb = majorTerms(b); let count = 0, longest = 0;
  for (const token of aa) if (bb.has(token)) { count += 1; longest = Math.max(longest, token.length); }
  return { count, longest };
}

function sameTrend(a = {}, b = {}) {
  const aa = normalizeTitle(a.trendMatch || ''), bb = normalizeTitle(b.trendMatch || '');
  return aa.length >= 2 && aa === bb;
}
function sameStory(a, b) {
  const similarity = dice(a.title, b.title), shared = sharedMajorCount(a.title, b.title);
  if (similarity >= .50) return true;
  if (sameTrend(a, b) && similarity >= .22) return true;
  if (shared.count >= 2 && similarity >= .16) return true;
  if (shared.longest >= 5 && similarity >= .25) return true;
  const na = normalizeTitle(a.title), nb = normalizeTitle(b.title), trend = normalizeTitle(a.trendMatch || b.trendMatch || '');
  return trend.length >= 3 && na.includes(trend) && nb.includes(trend) && similarity >= .16;
}
function topicScore(topic) {
  return Math.max(...topic.items.map(item => Number(item.totalScore || 0))) + Math.min(18, Math.max(0, topic.sources.size - 1) * 5);
}

export function clusterRecommendationItems(items = []) {
  const ordered = [...(Array.isArray(items) ? items : [])].sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0) || itemTimestamp(b) - itemTimestamp(a));
  const topics = [];
  for (const item of ordered) {
    let best = null, bestSimilarity = 0;
    for (const topic of topics) {
      const lead = topic.items[0]; const similarity = dice(item.title, lead.title);
      if (sameStory(item, lead) && similarity >= bestSimilarity) { best = topic; bestSimilarity = similarity; }
    }
    if (!best) { best = { items: [], sources: new Set() }; topics.push(best); }
    best.items.push(item); if (item.source) best.sources.add(String(item.source));
  }
  return topics.map((topic, index) => {
    topic.items.sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0) || itemTimestamp(b) - itemTimestamp(a));
    const lead = topic.items[0];
    return {
      id: `topic-${index}-${String(lead?.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24)}`,
      title: lead?.title || 'ニュース', image: topic.items.find(item => item.image)?.image || '',
      mediaCount: Math.max(topic.sources.size, ...topic.items.map(item => Number(item.gdeltIndependentSources || 0)), 1), leadId: lead?.id || '', category: lead?.importance || 'ニュース',
      latestAt: Math.max(...topic.items.map(itemTimestamp)), articleIds: topic.items.map(item => item.id), score: topicScore(topic)
    };
  }).sort((a, b) => b.score - a.score || b.latestAt - a.latestAt);
}

function homeTopicsFromItems(items = []) {
  return sortLatest(items).map((item, index) => ({
    id: `latest-${index}-${String(item?.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24)}`,
    title: item?.title || 'ニュース',
    image: item?.image || '',
    mediaCount: Math.max(1, Number(item?.gdeltIndependentSources || 0)),
    leadId: item?.id || '',
    category: item?.importance || item?._recommendationLabel || 'ニュース',
    latestAt: itemTimestamp(item),
    articleIds: item?.id ? [item.id] : [],
    score: Number(item?.totalScore || 0)
  }));
}
function syncHomeRecommendationSnapshot(snapshot) {
  try { localStorage.setItem(HOME_RECOMMENDATION_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch {}
}

export function readRecommendationSnapshot() {
  const primary = safeParse(localStorage.getItem(RECOMMENDATION_SNAPSHOT_KEY));
  const legacy = primary ? null : safeParse(localStorage.getItem(HOME_RECOMMENDATION_SNAPSHOT_KEY));
  const snapshot = primary || legacy;
  if (!snapshot?.items?.length) return null;
  const items = sortLatest(snapshot.items);
  if (!items.length) return null;
  const normalized = { ...snapshot, schema: RECOMMENDATION_CACHE_SCHEMA, items, topics: homeTopicsFromItems(items) };
  syncHomeRecommendationSnapshot(normalized);
  return {
    ...normalized,
    stale: Boolean(legacy) || Number(snapshot.schema || 0) !== RECOMMENDATION_CACHE_SCHEMA || Date.now() - Number(snapshot.at || 0) > SNAPSHOT_TTL_MS
  };
}
function writeRecommendationSnapshot(items, meta = {}) {
  const compact = sortLatest((Array.isArray(items) ? items : []).map(compactItem));
  const snapshot = { schema: RECOMMENDATION_CACHE_SCHEMA, at: Date.now(), items: compact, topics: homeTopicsFromItems(compact) };
  try { localStorage.setItem(RECOMMENDATION_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch {}
  syncHomeRecommendationSnapshot(snapshot);
  writeRefreshMeta({
    lastAttemptAt: Date.now(),
    lastSuccessAt: Date.now(),
    lastError: '',
    requestId: meta.requestId || '',
    serverElapsedMs: Number(meta.serverElapsedMs || 0),
    serverGeneratedAt: Number(meta.generatedAt || 0),
    forced: Boolean(meta.forced),
    itemCount: compact.length,
    newestPublishedTimestamp: itemTimestamp(compact[0]),
    newestAgeMinutes: newestAgeMinutes(compact),
    strategy: meta.strategy || ''
  });
  window.dispatchEvent(new CustomEvent('pdv2:recommendations-updated', { detail: snapshot }));
  return snapshot;
}
async function mergeKnownImages(items) {
  if (!items.some(item => !item.image)) return items;
  try {
    const { readReaderCache } = await import('./reader-data.js');
    const cache = await readReaderCache('news', 'core');
    const candidates = (cache?.items || []).filter(item => item?.image);
    if (!candidates.length) return items;
    return items.map(item => {
      if (item.image) return item;
      let best = null, score = 0;
      for (const candidate of candidates) {
        const sim = dice(item.title, candidate.title);
        if (sim > score) { score = sim; best = candidate; }
      }
      return score >= .54 && best?.image ? { ...item, image: best.image } : item;
    });
  } catch { return items; }
}
async function fetchNetwork(onProgress, { force = false } = {}) {
  if (recommendationInflight) {
    if (!force || recommendationInflight.force) return recommendationInflight.promise;
    try { await recommendationInflight.promise; } catch {}
  }

  const promise = (async () => {
    const startedAt = Date.now();
    onProgress?.(18, force ? 'Google Newsを強制更新中' : 'Google Newsから候補を確認中');
    writeRefreshMeta({ lastAttemptAt: startedAt, forced: Boolean(force), lastError: '' });
    console.info('[recommendations:client-network-start]', { forced: Boolean(force), timeoutMs: RECOMMENDATION_TIMEOUT_MS, at: startedAt });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECOMMENDATION_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ v: RECOMMENDATION_API_VERSION });
      const headers = { Accept: 'application/json' };
      if (force) {
        params.set('refresh', '1');
        params.set('_', String(Date.now()));
        headers['Cache-Control'] = 'no-cache';
        headers.Pragma = 'no-cache';
      }
      const response = await fetch(`/api/recommendations?${params.toString()}`, {
        method: 'GET', headers, signal: controller.signal, cache: force ? 'no-store' : 'default'
      });
      const data = await response.json().catch(() => ({}));
      const elapsedMs = Date.now() - startedAt;
      const requestId = response.headers.get('x-recommendation-request-id') || data?.requestId || '';
      if (!response.ok || data?.fallbackRequired) {
        const error = new Error(data?.error || `おすすめ取得エラー (${response.status})`);
        error.stage = data?.stage || 'cross-source';
        error.requestId = requestId;
        error.hardFallback = Boolean(data?.fallbackRequired);
        error.elapsedMs = elapsedMs;
        throw error;
      }
      let items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        const error = new Error('新方式のおすすめ候補が空です');
        error.stage = 'empty-response';
        error.requestId = requestId;
        error.hardFallback = true;
        error.elapsedMs = elapsedMs;
        throw error;
      }
      items = items.map(item => ({ ...item, _readerMode: 'news', _recommendationLabel: item?._recommendationLabel || '重要・話題ニュース' }));
      items = await mergeKnownImages(items);
      const diagnostics = {
        strategy: data?.strategy || 'google-news-fast-freshness-v13',
        cached: Boolean(data?.cached),
        forced: Boolean(force),
        requestId,
        status: response.status,
        elapsedMs,
        serverElapsedMs: Number(data?.serverElapsedMs || 0),
        generatedAt: Number(data?.generatedAt || 0),
        itemCount: items.length,
        newestAgeMinutes: newestAgeMinutes(items),
        degradedSignals: Array.isArray(data?.degradedSignals) ? data.degradedSignals : [],
        at: Date.now()
      };
      globalThis.__PDV2_LAST_RECOMMENDATION_META = diagnostics;
      console.info('[recommendations:client-network-success]', diagnostics);
      onProgress?.(88, diagnostics.degradedSignals.length ? 'Google Newsを重要度中心で評価済み' : '最新ニュースを取得済み');
      writeRecommendationSnapshot(items, diagnostics);
      return items;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`ニュース更新が${Math.round(RECOMMENDATION_TIMEOUT_MS / 1000)}秒でタイムアウトしました`);
        timeoutError.stage = 'client-timeout';
        timeoutError.hardFallback = true;
        timeoutError.elapsedMs = elapsedMs;
        writeRefreshMeta({ lastAttemptAt: Date.now(), lastError: timeoutError.message, errorStage: timeoutError.stage, elapsedMs });
        console.warn('[recommendations:client-network-failure]', { stage: timeoutError.stage, elapsedMs, forced: Boolean(force), message: timeoutError.message });
        throw timeoutError;
      }
      writeRefreshMeta({
        lastAttemptAt: Date.now(),
        lastError: error?.message || String(error),
        errorStage: error?.stage || 'network',
        requestId: error?.requestId || '',
        elapsedMs
      });
      console.warn('[recommendations:client-network-failure]', {
        stage: error?.stage || 'network', requestId: error?.requestId || '', elapsedMs,
        forced: Boolean(force), message: error?.message || String(error)
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  recommendationInflight = { promise, force: Boolean(force) };
  try { return await promise; }
  finally { if (recommendationInflight?.promise === promise) recommendationInflight = null; }
}

export async function loadCrossSourceRecommendations(onProgress) { return fetchNetwork(onProgress); }
export async function refreshRecommendationSnapshot({ force = false } = {}) {
  const cached = readRecommendationSnapshot();
  const cacheDiagnostics = {
    forced: Boolean(force),
    hasCache: Boolean(cached?.items?.length),
    cacheStale: Boolean(cached?.stale),
    cacheAgeMs: cached ? Math.max(0, Date.now() - Number(cached.at || 0)) : null,
    cachedNewestAgeMinutes: cached ? newestAgeMinutes(cached.items) : null
  };
  console.info('[recommendations:client-refresh-start]', cacheDiagnostics);
  if (!force && cached && !cached.stale) {
    globalThis.__PDV2_LAST_RECOMMENDATION_REFRESH = { ...cacheDiagnostics, source: 'fresh-cache', at: Date.now() };
    return cached;
  }
  const networkForce = Boolean(force || cached?.stale);
  try {
    const items = await fetchNetwork(undefined, { force: networkForce });
    const next = readRecommendationSnapshot() || writeRecommendationSnapshot(items, { forced: networkForce });
    console.info('[recommendations:client-refresh-applied]', {
      forced: networkForce,
      itemCount: next?.items?.length || 0,
      newestAgeMinutes: newestAgeMinutes(next?.items || []),
      snapshotAt: Number(next?.at || 0)
    });
    return next;
  } catch (error) {
    if (cached) {
      const fallback = { ...cached, stale: true, refreshError: error?.message || String(error) };
      console.warn('[recommendations:client-stale-fallback]', {
        stage: error?.stage || 'network',
        requestId: error?.requestId || '',
        cachedNewestAgeMinutes: newestAgeMinutes(cached.items),
        cachedSnapshotAgeMs: Math.max(0, Date.now() - Number(cached.at || 0)),
        message: error?.message || String(error)
      });
      return fallback;
    }
    throw error;
  }
}
