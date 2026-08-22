/* Personal Dashboard v2.18.9
 * Reliable Reader chunk paging for iPhone Safari.
 *
 * Key changes from v2.18.8:
 * - do NOT import runtime-v2188 (its chunk detector trusted .is-active)
 * - current article = Math.round(scrollTop / clientHeight)
 * - only react when the calculated index changes
 * - one lock per 10-card chunk, independent of the current missing set
 * - retry a partially generated chunk without duplicate concurrent calls
 * - prefetch 11-20 as soon as article 5 (zero-based index 4) becomes current
 */

const rawFetch2189 = window.fetch.bind(window);
await import('./runtime-v2187.js');
const inheritedFetch2189 = window.fetch.bind(window);

const CHUNK_SIZE_2189 = 10;
const NEXT_TRIGGER_OFFSET_2189 = 4;
const SUMMARY_STORAGE_KEY_2189 = 'reader-summary-cache-v2180';
const chunkSummaryCache2189 = new Map();
const feedState2189 = new WeakMap();
const boundFeeds2189 = new WeakSet();
let itemIndex2189 = null;
let itemIndexAt2189 = 0;

function clean2189(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function href2189(value = '') {
  try { return new URL(value, location.href).href; }
  catch { return String(value || ''); }
}

function parseBody2189(init) {
  try { return typeof init?.body === 'string' ? JSON.parse(init.body) : {}; }
  catch { return {}; }
}

function modeOfCard2189(card) {
  const category = clean2189(card?.querySelector('.reader-story-category-badge')?.textContent || '');
  if (category.startsWith('論文')) return 'papers';
  if (category.startsWith('知識')) return 'knowledge';
  return 'news';
}

function summaryLookupKey2189(url, mode) {
  return `${href2189(url)}::${clean2189(mode) || 'auto'}`;
}

function usableSummary2189(summary) {
  if (!summary || !Array.isArray(summary.lines) || summary.lines.length !== 3) return false;
  if (/^(?:pending|unavailable|insufficient)$/i.test(String(summary.provider || ''))) return false;
  const generic = /(?:本文を十分に取得できず|タイトルだけから内容を推測|についての記事です|背景や特徴.*(?:整理|確認)|影響や今後.*(?:整理|確認)|元記事(?:本文)?(?:を|で))/i;
  return summary.lines.every(row => {
    const text = clean2189(row?.text);
    return text.length >= 12 && !generic.test(text);
  });
}

function jsonResponse2189(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Reader-Chunk': 'v2189'
    }
  });
}

function stateForFeed2189(feed) {
  let state = feedState2189.get(feed);
  if (!state) {
    state = {
      lastIndex: -1,
      locks: new Map(),
      completed: new Set(),
      attempts: new Map(),
      retryTimers: new Map(),
      raf: 0,
      settle: 0
    };
    feedState2189.set(feed, state);
  }
  return state;
}

function readReaderItems2189() {
  if (itemIndex2189 && Date.now() - itemIndexAt2189 < 12_000) return itemIndex2189;
  const map = new Map();
  const keys = [
    'pdv2:readerCache:news',
    'pdv2:readerCache:knowledge',
    'pdv2:readerCache:papers:core',
    'pdv2:readerCache:papers:creative',
    'pdv2:readerCache:papers'
  ];
  for (const storageKey of keys) {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey) || 'null');
      for (const item of data?.items || []) {
        const link = href2189(item?.link || item?.url || '');
        if (link && !map.has(link)) map.set(link, item);
      }
    } catch {}
  }
  itemIndex2189 = map;
  itemIndexAt2189 = Date.now();
  return map;
}

function storedSummary2189(item, mode) {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY_2189) || '{}');
    const key = `${item?.link || item?.id || item?.title || ''}::${mode || 'auto'}::v2180`;
    const entry = raw?.[key];
    if (!entry?.value || !usableSummary2189(entry.value)) return null;
    const ttl = mode === 'papers' ? 14 * 24 * 60 * 60 * 1000 : 36 * 60 * 60 * 1000;
    if (Date.now() - Number(entry.ts || 0) > ttl) return null;
    return entry.value;
  } catch { return null; }
}

function persistSummary2189(item, mode, summary) {
  if (!usableSummary2189(summary)) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY_2189) || '{}');
    const key = `${item?.link || item?.id || item?.title || ''}::${mode || 'auto'}::v2180`;
    raw[key] = { value: summary, ts: Date.now(), mode };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, 84);
    localStorage.setItem(SUMMARY_STORAGE_KEY_2189, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function paintSummary2189(card, summary) {
  if (!card?.isConnected || !usableSummary2189(summary)) return;
  const title = card.querySelector('[data-reader-title]');
  if (title && clean2189(summary.headline)) title.textContent = clean2189(summary.headline);
  const texts = [...card.querySelectorAll('.reader-story-summary-text')];
  summary.lines.slice(0, 3).forEach((row, index) => {
    if (texts[index]) texts[index].textContent = clean2189(row?.text);
  });
  card.querySelector('[data-reader-summary]')?.classList.remove('is-pending', 'is-unavailable');
  card.querySelector('[data-reader-progress]')?.remove();
  card.dataset.summaryProvider = String(summary.provider || 'gemini-batch-v2189');
}

function payloadForCard2189(card) {
  const link = href2189(card?.querySelector('.reader-story-open')?.href || '');
  if (!link) return null;
  const item = readReaderItems2189().get(link);
  if (!item) return null;
  const mode = modeOfCard2189(card);
  const title = clean2189(item.title || '');
  const description = clean2189(item.description || '');
  if (!title) return null;
  return {
    item,
    payload: {
      url: link,
      title,
      description,
      source: clean2189(item.source || item.feedName || ''),
      category: clean2189(card.querySelector('.reader-story-category-badge')?.textContent || ''),
      mode,
      allowAi: true,
      fast: mode !== 'papers'
    }
  };
}

function resolvedForCard2189(card) {
  const resolved = payloadForCard2189(card);
  if (!resolved) return null;
  const { item, payload } = resolved;
  const key = summaryLookupKey2189(payload.url, payload.mode);
  let summary = chunkSummaryCache2189.get(key);
  if (!usableSummary2189(summary)) summary = storedSummary2189(item, payload.mode);
  if (usableSummary2189(summary)) {
    chunkSummaryCache2189.set(key, summary);
    paintSummary2189(card, summary);
    return { ...resolved, key, summary };
  }
  return { ...resolved, key, summary: null };
}

function cardAlreadyReady2189(card) {
  const provider = clean2189(card?.dataset?.summaryProvider || '');
  return Boolean(provider && !/^(?:pending|unavailable|insufficient)$/i.test(provider));
}

function chunkCards2189(feed, start) {
  return [...feed.querySelectorAll(':scope > .reader-swipe-card')].slice(start, start + CHUNK_SIZE_2189);
}

function chunkComplete2189(feed, start, { skipInitialActive = false } = {}) {
  const cards = chunkCards2189(feed, start);
  if (!cards.length) return true;
  return cards.every((card, offset) => {
    if (skipInitialActive && start === 0 && offset === 0) return true;
    const resolved = resolvedForCard2189(card);
    return Boolean(resolved?.summary || cardAlreadyReady2189(card));
  });
}

function scheduleChunkRetry2189(feed, start, activeIndex) {
  if (!feed?.isConnected) return;
  const state = stateForFeed2189(feed);
  if (state.retryTimers.has(start)) return;
  const attempts = Number(state.attempts.get(start) || 0);
  if (attempts >= 3) return;
  const timer = setTimeout(() => {
    state.retryTimers.delete(start);
    requestChunk2189(feed, start, activeIndex, { retry: true });
  }, 900 + attempts * 650);
  state.retryTimers.set(start, timer);
}

async function requestChunk2189(feed, start, activeIndex = -1, { retry = false } = {}) {
  if (!feed?.isConnected || start < 0) return;
  const state = stateForFeed2189(feed);
  if (state.completed.has(start)) return;
  if (state.locks.has(start)) return state.locks.get(start);

  const cards = chunkCards2189(feed, start);
  if (!cards.length) {
    state.completed.add(start);
    return;
  }

  // Only article 1 keeps the single-card streaming path.  Future chunk-leading
  // cards (11, 21, ...) are included in the batch if they are still missing.
  const skipInitialActive = start === 0 && activeIndex === 0;
  const missing = [];
  cards.forEach((card, offset) => {
    if (skipInitialActive && offset === 0) return;
    const resolved = resolvedForCard2189(card);
    if (!resolved || resolved.summary || cardAlreadyReady2189(card)) return;
    missing.push({ card, ...resolved });
  });

  if (!missing.length) {
    state.completed.add(start);
    return;
  }

  if (retry) state.attempts.set(start, Number(state.attempts.get(start) || 0) + 1);
  else if (!state.attempts.has(start)) state.attempts.set(start, 0);

  const task = rawFetch2189('/api/summary?batch=1&client=2189', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ items: missing.map(row => row.payload) }),
    signal: AbortSignal.timeout(24_000)
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data?.results)) {
      throw new Error(data?.error || `summary batch ${response.status}`);
    }
    const byUrl = new Map(missing.map(row => [href2189(row.payload.url), row]));
    for (const result of data.results) {
      if (!usableSummary2189(result?.summary)) continue;
      const row = byUrl.get(href2189(result.url));
      if (!row) continue;
      chunkSummaryCache2189.set(row.key, result.summary);
      persistSummary2189(row.item, row.payload.mode, result.summary);
      paintSummary2189(row.card, result.summary);
    }
  }).catch(error => {
    console.warn('[reader-chunk-v2189]', { start, activeIndex, message: error?.message || error });
  }).finally(() => {
    state.locks.delete(start);
    if (chunkComplete2189(feed, start, { skipInitialActive })) {
      state.completed.add(start);
      state.attempts.delete(start);
      const timer = state.retryTimers.get(start);
      if (timer) clearTimeout(timer);
      state.retryTimers.delete(start);
    } else {
      scheduleChunkRetry2189(feed, start, activeIndex);
    }
  });

  // Strong lock: one in-flight request per chunk start (0,10,20...), even if
  // the set of missing articles changes while the user is swiping quickly.
  state.locks.set(start, task);
  return task;
}

function currentIndex2189(feed) {
  const cards = [...feed.querySelectorAll(':scope > .reader-swipe-card')];
  if (!cards.length) return 0;
  const pageHeight = Number(feed.clientHeight || 0);
  if (pageHeight <= 1) return 0;
  const raw = Math.round(Math.max(0, Number(feed.scrollTop || 0)) / pageHeight);
  return Math.max(0, Math.min(cards.length - 1, raw));
}

function processIndex2189(feed, { force = false } = {}) {
  if (!feed?.isConnected) return;
  const state = stateForFeed2189(feed);
  const index = currentIndex2189(feed);
  if (!force && index === state.lastIndex) return;

  state.lastIndex = index;
  feed.dataset.readerCurrentIndex = String(index + 1);

  const currentStart = Math.floor(index / CHUNK_SIZE_2189) * CHUNK_SIZE_2189;
  requestChunk2189(feed, currentStart, index);

  // Article 5, 15, 25... means five cards remain in the current chunk.
  // Start the NEXT ten-card bundle at that exact point.
  if (index - currentStart >= NEXT_TRIGGER_OFFSET_2189) {
    requestChunk2189(feed, currentStart + CHUNK_SIZE_2189, index);
  }
}

function scheduleIndex2189(feed, { force = false, settleDelay = 90 } = {}) {
  const state = stateForFeed2189(feed);
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    processIndex2189(feed, { force });
  });
  clearTimeout(state.settle);
  state.settle = setTimeout(() => processIndex2189(feed, { force }), settleDelay);
}

function bindFeed2189(feed) {
  if (!feed || boundFeeds2189.has(feed)) return;
  boundFeeds2189.add(feed);

  // scrollTop/clientHeight is the source of truth. IntersectionObserver and
  // .is-active are deliberately not read here.
  feed.addEventListener('scroll', () => scheduleIndex2189(feed), { passive: true });
  feed.addEventListener('touchend', () => scheduleIndex2189(feed, { settleDelay: 40 }), { passive: true });
  if ('onscrollend' in feed) {
    feed.addEventListener('scrollend', () => scheduleIndex2189(feed, { force: true, settleDelay: 20 }), { passive: true });
  }
  setTimeout(() => scheduleIndex2189(feed, { force: true, settleDelay: 40 }), 80);
}

function bindFeeds2189(root = document) {
  root.querySelectorAll?.('.reader-swipe-feed').forEach(bindFeed2189);
}

new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes || []) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.('.reader-swipe-feed')) bindFeed2189(node);
      bindFeeds2189(node);
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true });

setTimeout(() => bindFeeds2189(), 250);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(() => {
    bindFeeds2189();
    document.querySelectorAll('.reader-swipe-feed').forEach(feed => scheduleIndex2189(feed, { force: true }));
  }, 100);
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => document.querySelectorAll('.reader-swipe-feed').forEach(feed => scheduleIndex2189(feed, { force: true })), 220);
}, { passive: true });
window.visualViewport?.addEventListener('resize', () => {
  document.querySelectorAll('.reader-swipe-feed').forEach(feed => scheduleIndex2189(feed, { force: true, settleDelay: 120 }));
}, { passive: true });

window.fetch = async function pdv2189Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2189(input, init); }

  if (
    url.origin === location.origin
    && url.pathname === '/api/summary'
    && String(init?.method || 'GET').toUpperCase() === 'POST'
    && url.searchParams.get('batch') !== '1'
  ) {
    const body = parseBody2189(init);
    const mode = clean2189(body.mode || 'auto');
    const key = summaryLookupKey2189(body.url || body.link || '', mode);
    const hit = chunkSummaryCache2189.get(key);
    if (hit && usableSummary2189(hit)) return jsonResponse2189(hit);
  }
  return inheritedFetch2189(input, init);
};

try { localStorage.setItem('pdv2:runtime:v2189', '1'); } catch {}
