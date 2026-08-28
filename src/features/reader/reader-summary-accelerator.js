import { state } from '../../app/store.js';
import { parseFeed } from '../../shared/rss.js';
import { readerTrace } from '../../shared/reader-debug.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const STORAGE_KEY = 'reader-summary-cache-v2180';
const STORAGE_LIMIT = 84;
const MEMORY_LIMIT = 120;
const BATCH_SIZE = 5;
const BACKGROUND_START_GAP_MS = 4300;
const FEED_BATCH_LIMIT = 24;
const QUEUE_LIMIT = 80;
const FAST_SINGLE_RACE_DELAY_MS = 850;
const FAILURE_PROVIDERS = new Set(['', 'pending', 'instant', 'insufficient', 'unavailable']);
const KNOWN_PROXY_SOURCE = {
  monoist: 'https://rss.itmedia.co.jp/rss/2.0/monoist.xml',
  eetimes: 'https://rss.itmedia.co.jp/rss/2.0/eetimes.xml',
  gigazine: 'https://gigazine.net/news/rss_2.0/'
};

const memory = new Map();
const inFlight = new Map();
const queued = new Map();
let backgroundRunning = false;
let lastBackgroundStartAt = 0;
let batchSequence = 0;

function clean(value = '', max = 3000) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function modeOf(value = '') {
  const mode = String(value || 'auto').split('#')[0].trim();
  return ['news', 'knowledge', 'papers'].includes(mode) ? mode : (mode || 'auto');
}

function articleIdOf(item = {}) {
  return String(
    item?.articleId
    || item?.id
    || item?.link
    || item?.url
    || `${item?.feedName || item?.source || 'unknown'}|${item?.title || 'untitled'}`
  ).trim();
}

function memoryKey(articleId, mode) {
  return `${String(articleId || '').trim()}::${modeOf(mode)}`;
}

function readerStorageKey({ link = '', url = '', articleId = '', title = '', mode = '' } = {}) {
  return `${String(link || url || articleId || title || '').trim()}::${modeOf(mode) || 'auto'}::v2180`;
}

function summaryRows(summary = {}) {
  if (Array.isArray(summary?.lines) && summary.lines.length) return summary.lines.slice(0, 3).map(row => clean(row?.text || '', 260));
  const points = Array.isArray(summary?.points) ? summary.points : [];
  return [summary?.short || '', points[0] || '', points[1] || ''].map(row => clean(row, 260));
}

function usableSummary(summary) {
  if (!summary || FAILURE_PROVIDERS.has(String(summary?.provider || ''))) return false;
  const rows = summaryRows(summary);
  if (rows.length !== 3 || rows.some(row => Array.from(row).length < 12)) return false;
  if (rows.some(row => !/[。！？!?][」』）】〉》]?$/.test(row))) return false;
  return new Set(rows.map(row => row.replace(/[\s。、，,.!！?？]/g, '').toLowerCase())).size === 3;
}

function summaryTtl(mode = '') {
  return modeOf(mode) === 'papers' ? 14 * 24 * 60 * 60 * 1000 : 36 * 60 * 60 * 1000;
}

function touchMemory(key, summary) {
  if (!key || !usableSummary(summary)) return;
  memory.delete(key);
  memory.set(key, summary);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

function readStoredSummary(meta = {}) {
  const key = readerStorageKey(meta);
  if (!key || key.startsWith('::')) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const entry = raw?.[key];
    if (!entry?.value || !entry?.ts) return null;
    if (Date.now() - Number(entry.ts) > summaryTtl(entry.mode || meta.mode)) return null;
    return usableSummary(entry.value) ? entry.value : null;
  } catch {
    return null;
  }
}

function persistSummary(meta = {}, summary) {
  if (!usableSummary(summary) || summary?.cacheable === false) return;
  const key = readerStorageKey(meta);
  if (!key || key.startsWith('::')) return;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    raw[key] = { value: summary, ts: Date.now(), mode: modeOf(meta.mode) };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, STORAGE_LIMIT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function remember(meta = {}, summary) {
  if (!usableSummary(summary)) return null;
  const key = memoryKey(articleIdOf(meta), meta.mode);
  touchMemory(key, summary);
  persistSummary(meta, summary);
  return summary;
}

function cached(meta = {}) {
  const key = memoryKey(articleIdOf(meta), meta.mode);
  const hit = memory.get(key);
  if (usableSummary(hit)) return hit;
  const stored = readStoredSummary(meta);
  if (stored) touchMemory(key, stored);
  return stored;
}

function fastMaterial(item = {}) {
  const description = clean(item?.description || '', 1000);
  if (Array.from(description).length >= 45) return Array.from(description).slice(0, 500).join('');
  const title = clean(item?.title || '', 300);
  const combined = [description, title].filter(Boolean).join(description && title ? '。' : '');
  return Array.from(combined).slice(0, 500).join('');
}

function batchPayload(meta = {}) {
  return {
    articleId: articleIdOf(meta),
    title: clean(meta?.title || '', 500),
    description: fastMaterial(meta),
    source: clean(meta?.source || meta?.feedName || '', 160),
    category: clean(meta?.category || '', 160),
    mode: modeOf(meta?.mode),
    fast: true
  };
}

function responseFor(summary, meta = {}, requestType = 'display') {
  const body = JSON.stringify({
    ...summary,
    articleId: articleIdOf(meta),
    requestType,
    requestId: `reader-fast-${Date.now()}-${++batchSequence}`
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Summary-Route': 'reader-prefetched-batch-v1'
    }
  });
}

async function callBatch(rows, { requestType = 'prefetch' } = {}) {
  const targets = rows.filter(Boolean).slice(0, BATCH_SIZE);
  if (!targets.length) return [];
  const startedAt = performance.now();
  readerTrace('summary-fast-batch-start', {
    requestType,
    count: targets.length,
    articles: targets.map(row => articleIdOf(row)).slice(0, BATCH_SIZE)
  });

  const response = await upstreamFetch('/api/summary?batch=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ items: targets.map(batchPayload) })
  });
  const data = await response.json().catch(() => ({}));
  const results = Array.isArray(data?.results) ? data.results : [];
  const output = targets.map((meta, index) => {
    const row = results.find(result => Number(result?.index) === index) || results[index] || {};
    const summary = usableSummary(row?.summary) ? row.summary : null;
    if (summary) remember(meta, summary);
    return { meta, summary };
  });
  readerTrace('summary-fast-batch-finish', {
    requestType,
    count: targets.length,
    generated: output.filter(row => row.summary).length,
    elapsedMs: Math.round(performance.now() - startedAt),
    route: String(data?.batch || '')
  });
  return output;
}

function trackInFlight(meta, promise) {
  const key = memoryKey(articleIdOf(meta), meta.mode);
  inFlight.set(key, promise);
  promise.finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  return promise;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sortNewest(rows = []) {
  return [...rows].sort((a, b) => {
    const at = Number(a?.publishedTimestamp) || new Date(a?.pubDate || 0).getTime() || 0;
    const bt = Number(b?.publishedTimestamp) || new Date(b?.pubDate || 0).getTime() || 0;
    return bt - at;
  });
}

function enqueue(items = [], mode = 'auto', category = '') {
  const rows = sortNewest(Array.isArray(items) ? items : []).slice(0, FEED_BATCH_LIMIT);
  for (const item of rows) {
    const meta = { ...item, mode: modeOf(mode), category };
    const articleId = articleIdOf(meta);
    if (!articleId || Array.from(fastMaterial(meta)).length < 40) continue;
    if (cached(meta) || inFlight.has(memoryKey(articleId, meta.mode))) continue;
    queued.delete(memoryKey(articleId, meta.mode));
    queued.set(memoryKey(articleId, meta.mode), meta);
  }
  while (queued.size > QUEUE_LIMIT) queued.delete(queued.keys().next().value);
  void drainBackground();
}

async function drainBackground() {
  if (backgroundRunning || !upstreamFetch) return;
  backgroundRunning = true;
  try {
    while (queued.size) {
      const gap = Math.max(0, BACKGROUND_START_GAP_MS - (Date.now() - lastBackgroundStartAt));
      if (gap) await wait(gap);
      const metas = sortNewest([...queued.values()]).slice(0, BATCH_SIZE);
      metas.forEach(meta => queued.delete(memoryKey(articleIdOf(meta), meta.mode)));
      const pending = metas.filter(meta => !cached(meta) && !inFlight.has(memoryKey(articleIdOf(meta), meta.mode)));
      if (!pending.length) continue;
      lastBackgroundStartAt = Date.now();
      const promise = callBatch(pending, { requestType: 'prefetch' }).catch(error => {
        readerTrace('summary-fast-batch-error', { requestType: 'prefetch', message: String(error?.message || error).slice(0, 300) });
        return [];
      });
      pending.forEach(meta => trackInFlight(meta, promise.then(rows => rows.find(row => articleIdOf(row.meta) === articleIdOf(meta))?.summary || null)));
      await promise;
    }
  } finally {
    backgroundRunning = false;
  }
}

function normalizeComparableUrl(value = '') {
  try {
    const url = new URL(String(value || ''), location.origin);
    url.searchParams.delete('_fresh');
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value || '');
  }
}

function configuredFeeds() {
  return [
    ...(Array.isArray(state?.newsFeeds) ? state.newsFeeds.map(feed => ({ ...feed, mode: 'news' })) : []),
    ...(Array.isArray(state?.knowledgeFeeds) ? state.knowledgeFeeds.map(feed => ({ ...feed, mode: 'knowledge' })) : [])
  ];
}

function contextForFeedRequest(url) {
  if (url.pathname === SUMMARY_PATH && url.searchParams.get('technologyResearch') === '1') {
    return { mode: 'papers', feedName: '技術リサーチ', category: '技術リサーチ' };
  }
  if (url.pathname === '/api/creative-papers-feed') {
    return { mode: 'papers', feedName: '独創研究', category: '独創研究' };
  }

  let original = '';
  if (url.pathname === '/api/rss') {
    original = url.searchParams.get('url') || KNOWN_PROXY_SOURCE[url.searchParams.get('source') || ''] || '';
  }
  const requestComparable = normalizeComparableUrl(url.href);
  for (const feed of configuredFeeds()) {
    const feedUrl = String(feed?.url || '');
    if (!feedUrl) continue;
    if (original && feedUrl === original) return { mode: feed.mode, feedName: feed.name || feed.mode, category: feed.name || '' };
    if (feedUrl.startsWith('/') && normalizeComparableUrl(feedUrl) === requestComparable) {
      return { mode: feed.mode, feedName: feed.name || feed.mode, category: feed.name || '' };
    }
    const known = Object.entries(KNOWN_PROXY_SOURCE).find(([, knownUrl]) => knownUrl === feedUrl)?.[0];
    if (known && url.pathname === '/api/rss' && url.searchParams.get('source') === known) {
      return { mode: feed.mode, feedName: feed.name || feed.mode, category: feed.name || '' };
    }
  }
  return null;
}

function parseRequestUrl(input) {
  try {
    return new URL(typeof input === 'string' ? input : input?.url || '', location.href);
  } catch {
    return null;
  }
}

function maybeWarmFeed(input, init, response) {
  if (!response?.ok || String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase() !== 'GET') return;
  const url = parseRequestUrl(input);
  if (!url) return;
  const context = contextForFeedRequest(url);
  if (!context) return;
  response.clone().text().then(xml => {
    if (!/^\s*</.test(xml)) return;
    let items;
    try { items = parseFeed(xml, context.feedName); }
    catch { return; }
    readerTrace('summary-fast-feed-captured', { mode: context.mode, feed: context.feedName, count: items.length });
    enqueue(items, context.mode, context.category);
  }).catch(() => {});
}

function parseSummarySingle(input, init = {}) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  const url = parseRequestUrl(input);
  if (!url || url.pathname !== SUMMARY_PATH || url.searchParams.has('batch') || url.searchParams.has('stream')) return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  const articleId = String(body?.articleId || '').trim();
  if (!articleId) return null;
  return {
    articleId,
    title: body?.title || '',
    description: body?.description || '',
    source: body?.source || '',
    category: body?.category || '',
    mode: modeOf(body?.mode),
    url: body?.url || '',
    link: body?.url || ''
  };
}

function renderFastPreview(meta = {}) {
  if (typeof document === 'undefined') return;
  const card = document.querySelector(`.reader-swipe-card.is-active[data-article-id="${CSS.escape(articleIdOf(meta))}"]`);
  if (!card || !FAILURE_PROVIDERS.has(String(card.dataset.summaryProvider || ''))) return;
  const node = card.querySelector('[data-reader-summary]');
  if (!node) return;
  const description = clean(meta.description, 800);
  const pieces = (description.match(/[^。！？!?]+[。！？!?]?/g) || [])
    .map(row => clean(row, 100))
    .filter(row => Array.from(row).length >= 10)
    .slice(0, 3);
  if (!pieces.length) return;
  const labels = ['結論/事実', '背景/特徴', '影響/展望'];
  node.replaceChildren();
  pieces.forEach((piece, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'reader-story-summary-row';
    const copy = document.createElement('div');
    copy.className = 'reader-story-summary-copy';
    const label = document.createElement('span');
    label.className = 'reader-story-summary-label';
    label.textContent = labels[index];
    const text = document.createElement('span');
    text.className = 'reader-story-summary-text';
    text.textContent = piece;
    copy.append(label, text);
    wrapper.append(copy);
    node.append(wrapper);
  });
}

async function accelerateSingle(input, init, meta) {
  const hit = cached(meta);
  if (hit) {
    readerTrace('summary-fast-cache-hit', { articleId: meta.articleId, mode: meta.mode });
    return responseFor(hit, meta, 'display');
  }

  const key = memoryKey(meta.articleId, meta.mode);
  let fastPromise = inFlight.get(key);
  if (!fastPromise && Array.from(fastMaterial(meta)).length >= 40) {
    queued.delete(key);
    fastPromise = trackInFlight(meta, callBatch([meta], { requestType: 'display' })
      .then(rows => rows[0]?.summary || null)
      .catch(error => {
        readerTrace('summary-fast-batch-error', { requestType: 'display', articleId: meta.articleId, message: String(error?.message || error).slice(0, 300) });
        return null;
      }));
  }

  renderFastPreview(meta);
  if (fastPromise) {
    const first = await Promise.race([
      fastPromise.then(summary => ({ kind: 'fast', summary })),
      wait(FAST_SINGLE_RACE_DELAY_MS).then(() => ({ kind: 'delay', summary: null }))
    ]);
    if (first.kind === 'fast' && usableSummary(first.summary)) {
      readerTrace('summary-fast-display-hit', { articleId: meta.articleId, mode: meta.mode, racedLegacy: false });
      return responseFor(first.summary, meta, 'display');
    }
    if (first.kind === 'delay') {
      const legacyPromise = upstreamFetch(input, init);
      const fastResponse = fastPromise.then(summary => {
        if (!usableSummary(summary)) return legacyPromise;
        readerTrace('summary-fast-display-hit', { articleId: meta.articleId, mode: meta.mode, racedLegacy: true });
        return responseFor(summary, meta, 'display');
      });
      readerTrace('summary-fast-race-legacy', { articleId: meta.articleId, mode: meta.mode, delayMs: FAST_SINGLE_RACE_DELAY_MS });
      return Promise.race([fastResponse, legacyPromise]);
    }
  }

  readerTrace('summary-fast-fallback-single', { articleId: meta.articleId, mode: meta.mode });
  return upstreamFetch(input, init);
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_SUMMARY_ACCELERATOR_INSTALLED) {
  window.__PDV2_READER_SUMMARY_ACCELERATOR_INSTALLED = true;
  globalThis.fetch = function readerSummaryAcceleratedFetch(input, init = {}) {
    const single = parseSummarySingle(input, init);
    if (single) return accelerateSingle(input, init, single);

    const response = upstreamFetch(input, init);
    Promise.resolve(response).then(value => maybeWarmFeed(input, init, value)).catch(() => {});
    return response;
  };

  window.__PDV2_READER_SUMMARY_ACCELERATOR = {
    snapshot: () => ({
      memory: memory.size,
      inFlight: inFlight.size,
      queued: queued.size,
      backgroundRunning,
      lastBackgroundStartAt
    })
  };
}
