import { state } from '../../app/store.js';
import { readReaderCache } from './reader-data.js';
import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SNAPSHOT_TTL_MS = 1800;
const KNOWN_RSS_SOURCE = [
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/monoist\.xml(?:\?|$)/i, 'monoist'],
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/eetimes\.xml(?:\?|$)/i, 'eetimes'],
  [/^https?:\/\/(?:www\.)?gigazine\.net\/news\/rss_2\.0\/(?:\?|$)/i, 'gigazine']
];

let snapshotPromise = null;
let snapshotAt = 0;

function parseUrl(input) {
  try { return new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }
}

function normalizeComparable(value = '') {
  try {
    const url = new URL(String(value || ''), location.origin);
    url.searchParams.delete('_fresh');
    return `${url.pathname}${url.search}`;
  } catch { return String(value || ''); }
}

function targetForFeed(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return normalizeComparable(raw);
  const known = KNOWN_RSS_SOURCE.find(([pattern]) => pattern.test(raw));
  if (known) return `/api/rss?source=${encodeURIComponent(known[1])}`;
  return `/api/rss?url=${encodeURIComponent(raw)}`;
}

function configuredContext(url) {
  if (!url) return null;
  if (url.pathname === '/api/summary' && url.searchParams.get('technologyResearch') === '1') {
    return { mode: 'papers', track: 'technology' };
  }
  if (url.pathname === '/api/creative-papers-feed') {
    return { mode: 'papers', track: 'creative' };
  }

  const request = normalizeComparable(url.href);
  for (const feed of Array.isArray(state?.newsFeeds) ? state.newsFeeds : []) {
    if (targetForFeed(feed?.url) === request) return { mode: 'news', track: 'core' };
  }
  for (const feed of Array.isArray(state?.knowledgeFeeds) ? state.knowledgeFeeds : []) {
    if (targetForFeed(feed?.url) === request) return { mode: 'knowledge', track: 'core' };
  }
  return null;
}

function recommendationKind() {
  if (typeof document === 'undefined') return '';
  const loading = document.querySelector('.reader-recommendations-open .reader-recommend-loading');
  if (!loading) return '';
  const text = String(loading.textContent || '');
  if (/ニュース・知識・改善事例/.test(text)) return 'mixed';
  if (/技術リサーチ全タブ/.test(text)) return 'papers';
  return 'scoped';
}

async function cacheSnapshot() {
  const now = Date.now();
  if (snapshotPromise && now - snapshotAt < SNAPSHOT_TTL_MS) return snapshotPromise;
  snapshotAt = now;
  snapshotPromise = Promise.all([
    readReaderCache('news', 'core').catch(() => null),
    readReaderCache('knowledge', 'core').catch(() => null),
    readReaderCache('papers', 'technology').catch(() => null),
    readReaderCache('papers', 'creative').catch(() => null)
  ]).then(([news, knowledge, technology, creative]) => ({
    news: news?.items?.length || 0,
    knowledge: knowledge?.items?.length || 0,
    technology: technology?.items?.length || 0,
    creative: creative?.items?.length || 0
  }));
  return snapshotPromise;
}

function contextCount(snapshot, context) {
  if (context?.mode === 'news') return snapshot.news;
  if (context?.mode === 'knowledge') return snapshot.knowledge;
  if (context?.track === 'creative') return snapshot.creative;
  if (context?.mode === 'papers') return snapshot.technology;
  return 0;
}

function canUseCacheFastPath(kind, context, snapshot) {
  if (!context) return false;
  if (kind === 'mixed') {
    const anyMixed = snapshot.news + snapshot.knowledge + snapshot.technology > 0;
    return anyMixed && (context.mode === 'news' || context.mode === 'knowledge' || context.track === 'technology');
  }
  if (kind === 'papers') {
    const anyPapers = snapshot.technology + snapshot.creative > 0;
    return anyPapers && context.mode === 'papers';
  }
  return contextCount(snapshot, context) > 0;
}

function cacheFallbackResponse(kind, context, snapshot) {
  readerTrace('reader-recommend-cache-fast-path', {
    kind,
    mode: context?.mode || '',
    track: context?.track || '',
    cacheCounts: snapshot
  });
  return new Response(JSON.stringify({
    error: 'reader-recommendation-cache-first',
    cacheFirst: true
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Reader-Recommendation-Cache': 'hit'
    }
  });
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_RECOMMEND_CACHE_FAST_INSTALLED) {
  window.__PDV2_READER_RECOMMEND_CACHE_FAST_INSTALLED = true;
  globalThis.fetch = async function readerRecommendationCacheFirstFetch(input, init = {}) {
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    if (method !== 'GET') return upstreamFetch(input, init);

    const kind = recommendationKind();
    if (!kind) return upstreamFetch(input, init);
    const url = parseUrl(input);
    const context = configuredContext(url);
    if (!context) return upstreamFetch(input, init);

    const snapshot = await cacheSnapshot();
    if (!recommendationKind()) return upstreamFetch(input, init);
    if (!canUseCacheFastPath(kind, context, snapshot)) return upstreamFetch(input, init);
    return cacheFallbackResponse(kind, context, snapshot);
  };
}
