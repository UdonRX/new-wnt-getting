const RECOMMENDATION_TIMEOUT_MS = 7000;
const RECOMMENDATION_API_VERSION = '4';
export const RECOMMENDATION_SNAPSHOT_KEY = 'pdv2:recommendationSnapshot:v2';
const HOME_RECOMMENDATION_SNAPSHOT_KEY = 'pdv2:recommendationSnapshot:v1';
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const NEWS_WINDOW_MS = 12 * 60 * 60 * 1000;
let recommendationInflight = null;

function safeParse(value) {
  try { return JSON.parse(value || 'null'); } catch { return null; }
}
function itemTimestamp(item = {}) {
  for (const value of [item.effectivePublishedTimestamp, item.sourcePublishedTimestamp, item.publishedTimestamp]) {
    const num = Number(value || 0); if (Number.isFinite(num) && num > 0) return num;
  }
  const parsed = new Date(item.pubDate || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function sortLatest(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
}
function compactItem(item = {}) {
  return {
    id: item.id || '', title: item.title || '', link: item.link || '', publisherUrl: item.publisherUrl || '', sourceUrl: item.sourceUrl || '', description: String(item.description || '').slice(0, 900),
    source: item.source || '', feedName: item.feedName || '', image: item.image || '', pubDate: item.pubDate || '', recommendationDateSource: item.recommendationDateSource || '',
    publishedTimestamp: Number(item.publishedTimestamp || 0), sourcePublishedTimestamp: Number(item.sourcePublishedTimestamp || 0),
    effectivePublishedTimestamp: Number(item.effectivePublishedTimestamp || 0), trendMatch: item.trendMatch || '', trendScore: Number(item.trendScore || 0),
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
  const snapshot = safeParse(localStorage.getItem(RECOMMENDATION_SNAPSHOT_KEY))
    || safeParse(localStorage.getItem(HOME_RECOMMENDATION_SNAPSHOT_KEY));
  if (!snapshot?.items?.length) return null;
  const cutoff = Date.now() - NEWS_WINDOW_MS;
  const items = sortLatest(snapshot.items.filter(item => itemTimestamp(item) >= cutoff));
  if (!items.length) return null;
  const normalized = { ...snapshot, items, topics: homeTopicsFromItems(items) };
  syncHomeRecommendationSnapshot(normalized);
  return { ...normalized, stale: Date.now() - Number(snapshot.at || 0) > SNAPSHOT_TTL_MS };
}
function writeRecommendationSnapshot(items) {
  const cutoff = Date.now() - NEWS_WINDOW_MS;
  const compact = sortLatest((Array.isArray(items) ? items : []).filter(item => itemTimestamp(item) >= cutoff).map(compactItem));
  const snapshot = { at: Date.now(), items: compact, topics: homeTopicsFromItems(compact) };
  try { localStorage.setItem(RECOMMENDATION_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch {}
  syncHomeRecommendationSnapshot(snapshot);
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
async function fetchNetwork(onProgress) {
  if (recommendationInflight) return recommendationInflight;
  recommendationInflight = (async () => {
    onProgress?.(18, 'Google Newsから候補を確認中');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), RECOMMENDATION_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/recommendations?v=${RECOMMENDATION_API_VERSION}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'default' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.fallbackRequired) {
        const error = new Error(data?.error || `おすすめ取得エラー (${response.status})`);
        error.stage = data?.stage || 'cross-source'; error.requestId = data?.requestId || ''; error.hardFallback = Boolean(data?.fallbackRequired); throw error;
      }
      let items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) { const error = new Error('新方式のおすすめ候補が空です'); error.stage = 'empty-response'; error.hardFallback = true; throw error; }
      items = items.map(item => ({ ...item, _readerMode: 'news', _recommendationLabel: item?._recommendationLabel || '重要・話題ニュース' }));
      items = await mergeKnownImages(items);
      globalThis.__PDV2_LAST_RECOMMENDATION_META = { strategy: data?.strategy || 'google-news-trends-gdelt-source-date-article-image-v9', cached: Boolean(data?.cached), degradedSignals: Array.isArray(data?.degradedSignals) ? data.degradedSignals : [], at: Date.now() };
      onProgress?.(88, data?.degradedSignals?.length ? 'Google Newsを重要度中心で評価済み' : '重要度・話題性・複数媒体を評価済み');
      writeRecommendationSnapshot(items);
      return items;
    } catch (error) {
      if (error?.name === 'AbortError') { const timeoutError = new Error('新方式のおすすめ取得がタイムアウトしました'); timeoutError.stage = 'client-timeout'; timeoutError.hardFallback = true; throw timeoutError; }
      throw error;
    } finally { clearTimeout(timer); recommendationInflight = null; }
  })();
  return recommendationInflight;
}

export async function loadCrossSourceRecommendations(onProgress) { return fetchNetwork(onProgress); }
export async function refreshRecommendationSnapshot({ force = false } = {}) {
  const cached = readRecommendationSnapshot();
  if (!force && cached && !cached.stale) return cached;
  try { const items = await fetchNetwork(); return readRecommendationSnapshot() || writeRecommendationSnapshot(items); }
  catch (error) { if (cached) return { ...cached, stale: true, error: error?.message || String(error) }; throw error; }
}
