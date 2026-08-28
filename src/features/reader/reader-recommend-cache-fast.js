import { state } from '../../app/store.js';
import { loadReader, readReaderCache } from './reader-data.js';
import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const FAST_AGE_MS = 2 * 60 * 1000;
const SNAPSHOT_TTL_MS = 1200;
const STARTUP_WAIT_MS = 500;
const KNOWN_RSS_SOURCE = [
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/monoist\.xml(?:\?|$)/i, 'monoist'],
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/eetimes\.xml(?:\?|$)/i, 'eetimes'],
  [/^https?:\/\/(?:www\.)?gigazine\.net\/news\/rss_2\.0\/(?:\?|$)/i, 'gigazine']
];
let snapshotPromise = null;
let snapshotAt = 0;
let startupRefresh = null;

function normalize(value = '') {
  try {
    const url = new URL(String(value || ''), location.origin);
    url.searchParams.delete('_fresh');
    return `${url.pathname}${url.search}`;
  } catch { return String(value || ''); }
}
function targetForFeed(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return normalize(raw);
  const known = KNOWN_RSS_SOURCE.find(([pattern]) => pattern.test(raw));
  if (known) return `/api/rss?source=${encodeURIComponent(known[1])}`;
  return `/api/rss?url=${encodeURIComponent(raw)}`;
}
function contextFor(input) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }
  if (url.pathname === '/api/summary' && url.searchParams.get('technologyResearch') === '1') return { mode: 'papers', track: 'technology' };
  if (url.pathname === '/api/creative-papers-feed') return { mode: 'papers', track: 'creative' };
  const request = normalize(url.href);
  if ((state?.newsFeeds || []).some(feed => targetForFeed(feed?.url) === request)) return { mode: 'news', track: 'core' };
  if ((state?.knowledgeFeeds || []).some(feed => targetForFeed(feed?.url) === request)) return { mode: 'knowledge', track: 'core' };
  return null;
}
function recommendationKind() {
  const box = typeof document === 'undefined' ? null : document.querySelector('.reader-recommendations-open .reader-recommend-loading');
  if (!box) return '';
  const text = String(box.textContent || '');
  if (/ニュース・知識・改善事例/.test(text)) return 'mixed';
  if (/技術リサーチ全タブ/.test(text)) return 'papers';
  return 'scoped';
}
function entry(cache) {
  const count = cache?.items?.length || 0;
  const at = Number(cache?.at || 0);
  const ageMs = at > 0 ? Math.max(0, Date.now() - at) : Infinity;
  return { count, ageMs, fresh: count > 0 && ageMs <= FAST_AGE_MS };
}
async function snapshot(force = false) {
  const now = Date.now();
  if (!force && snapshotPromise && now - snapshotAt < SNAPSHOT_TTL_MS) return snapshotPromise;
  snapshotAt = now;
  snapshotPromise = Promise.all([
    readReaderCache('news', 'core').catch(() => null),
    readReaderCache('knowledge', 'core').catch(() => null),
    readReaderCache('papers', 'technology').catch(() => null),
    readReaderCache('papers', 'creative').catch(() => null)
  ]).then(([news, knowledge, technology, creative]) => ({
    news: entry(news), knowledge: entry(knowledge), technology: entry(technology), creative: entry(creative)
  }));
  return snapshotPromise;
}
function contextEntry(data, context) {
  if (context?.mode === 'news') return data.news;
  if (context?.mode === 'knowledge') return data.knowledge;
  if (context?.track === 'creative') return data.creative;
  if (context?.mode === 'papers') return data.technology;
  return null;
}
function usable(kind, context, data) {
  if (!context) return false;
  if (kind === 'mixed' && !(context.mode === 'news' || context.mode === 'knowledge' || context.track === 'technology')) return false;
  if (kind === 'papers' && context.mode !== 'papers') return false;
  return Boolean(contextEntry(data, context)?.fresh);
}
function cacheResponse(kind, context, data) {
  const hit = contextEntry(data, context);
  readerTrace('reader-recommend-latest-cache-hit', {
    kind, mode: context?.mode || '', track: context?.track || '', cacheAgeMs: Math.round(hit?.ageMs || 0), cacheCount: hit?.count || 0
  });
  return new Response(JSON.stringify({ error: 'reader-recommendation-fresh-cache', cacheFirst: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Reader-Recommendation-Cache': 'fresh' }
  });
}
function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })
  ]).finally(() => clearTimeout(timer));
}
async function refreshStaleCaches() {
  const data = await snapshot(true);
  const jobs = [];
  if (!data.news.fresh) jobs.push(loadReader('news', { selectedFeed: '', backgroundRefresh: true }).catch(() => null));
  if (!data.knowledge.fresh) jobs.push(loadReader('knowledge', { selectedFeed: '', backgroundRefresh: true }).catch(() => null));
  if (!data.technology.fresh) jobs.push(loadReader('papers', { paperTrack: 'core', fastOnly: true, backgroundRefresh: true }).catch(() => null));
  if (!data.creative.fresh) jobs.push(loadReader('papers', { paperTrack: 'creative', fastOnly: true, backgroundRefresh: true }).catch(() => null));
  if (jobs.length) await Promise.allSettled(jobs);
  snapshotAt = 0;
  snapshotPromise = null;
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_RECOMMEND_CACHE_FAST_INSTALLED) {
  window.__PDV2_READER_RECOMMEND_CACHE_FAST_INSTALLED = true;
  globalThis.fetch = async function readerLatestRecommendationFetch(input, init = {}) {
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    if (method !== 'GET') return upstreamFetch(input, init);
    const kind = recommendationKind();
    const context = kind ? contextFor(input) : null;
    if (!kind || !context) return upstreamFetch(input, init);

    let data = await snapshot();
    if (!recommendationKind()) return upstreamFetch(input, init);
    if (usable(kind, context, data)) return cacheResponse(kind, context, data);

    if (startupRefresh) {
      await waitAtMost(startupRefresh, STARTUP_WAIT_MS);
      data = await snapshot(true);
      if (!recommendationKind()) return upstreamFetch(input, init);
      if (usable(kind, context, data)) return cacheResponse(kind, context, data);
    }
    return upstreamFetch(input, init);
  };

  const schedule = typeof requestIdleCallback === 'function'
    ? fn => requestIdleCallback(fn, { timeout: 900 })
    : fn => setTimeout(fn, 0);
  schedule(() => {
    startupRefresh = refreshStaleCaches().catch(() => null).finally(() => { startupRefresh = null; });
  });
}
