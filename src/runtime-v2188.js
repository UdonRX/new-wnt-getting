/* Personal Dashboard v2.18.8
 * TikTok-style Reader summary chunks:
 * - keep the active card on the existing streaming path for fastest first paint
 * - generate/fetch the rest of the current 10-card chunk in one server request
 * - when the user reaches the 5th card, prefetch the next 10-card chunk
 * - intercept later per-card summary requests with already-loaded chunk data
 */

const rawFetch2188 = window.fetch.bind(window);
await import('./runtime-v2187.js');
const inheritedFetch2188 = window.fetch.bind(window);

const CHUNK_SIZE_2188 = 10;
const NEXT_TRIGGER_OFFSET_2188 = 4;
const SUMMARY_STORAGE_KEY_2188 = 'reader-summary-cache-v2180';
const chunkSummaryCache2188 = new Map();
const chunkInflight2188 = new Map();
const boundFeeds2188 = new WeakSet();
let itemIndex2188 = null;
let itemIndexAt2188 = 0;

function clean2188(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function href2188(value = '') {
  try { return new URL(value, location.href).href; }
  catch { return String(value || ''); }
}

function parseBody2188(init) {
  try { return typeof init?.body === 'string' ? JSON.parse(init.body) : {}; }
  catch { return {}; }
}

function modeOfCard2188(card) {
  const category = clean2188(card?.querySelector('.reader-story-category-badge')?.textContent || '');
  if (category.startsWith('論文')) return 'papers';
  if (category.startsWith('知識')) return 'knowledge';
  return 'news';
}

function summaryLookupKey2188(url, mode) {
  return `${href2188(url)}::${clean2188(mode) || 'auto'}`;
}

function usableSummary2188(summary) {
  if (!summary || !Array.isArray(summary.lines) || summary.lines.length !== 3) return false;
  if (/^(?:pending|unavailable|insufficient)$/i.test(String(summary.provider || ''))) return false;
  const generic = /(?:本文を十分に取得できず|タイトルだけから内容を推測|についての記事です|背景や特徴.*(?:整理|確認)|影響や今後.*(?:整理|確認)|元記事(?:本文)?(?:を|で))/i;
  return summary.lines.every(row => {
    const text = clean2188(row?.text);
    return text.length >= 12 && !generic.test(text);
  });
}

function jsonResponse2188(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Reader-Chunk': 'v2188' }
  });
}

function readReaderItems2188() {
  if (itemIndex2188 && Date.now() - itemIndexAt2188 < 12_000) return itemIndex2188;
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
        const link = href2188(item?.link || item?.url || '');
        if (link && !map.has(link)) map.set(link, item);
      }
    } catch {}
  }
  itemIndex2188 = map;
  itemIndexAt2188 = Date.now();
  return map;
}

function storedSummary2188(item, mode) {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY_2188) || '{}');
    const key = `${item?.link || item?.id || item?.title || ''}::${mode || 'auto'}::v2180`;
    const entry = raw?.[key];
    if (!entry?.value || !usableSummary2188(entry.value)) return null;
    const ttl = mode === 'papers' ? 14 * 24 * 60 * 60 * 1000 : 36 * 60 * 60 * 1000;
    if (Date.now() - Number(entry.ts || 0) > ttl) return null;
    return entry.value;
  } catch { return null; }
}

function persistSummary2188(item, mode, summary) {
  if (!usableSummary2188(summary)) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY_2188) || '{}');
    const key = `${item?.link || item?.id || item?.title || ''}::${mode || 'auto'}::v2180`;
    raw[key] = { value: summary, ts: Date.now(), mode };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, 84);
    localStorage.setItem(SUMMARY_STORAGE_KEY_2188, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function cardForUrl2188(feed, url) {
  const wanted = href2188(url);
  return [...feed.querySelectorAll(':scope > .reader-swipe-card')]
    .find(card => href2188(card.querySelector('.reader-story-open')?.href || '') === wanted) || null;
}

function paintSummary2188(card, summary) {
  if (!card?.isConnected || !usableSummary2188(summary)) return;
  const title = card.querySelector('[data-reader-title]');
  if (title && clean2188(summary.headline)) title.textContent = clean2188(summary.headline);
  const texts = [...card.querySelectorAll('.reader-story-summary-text')];
  summary.lines.slice(0, 3).forEach((row, index) => {
    if (texts[index]) texts[index].textContent = clean2188(row?.text);
  });
  card.querySelector('[data-reader-summary]')?.classList.remove('is-pending', 'is-unavailable');
  card.querySelector('[data-reader-progress]')?.remove();
  card.dataset.summaryProvider = String(summary.provider || 'gemini-batch-v2188');
}

function payloadForCard2188(card) {
  const link = href2188(card?.querySelector('.reader-story-open')?.href || '');
  if (!link) return null;
  const item = readReaderItems2188().get(link);
  if (!item) return null;
  const mode = modeOfCard2188(card);
  const title = clean2188(item.title || '');
  const description = clean2188(item.description || '');
  if (!title) return null;
  return {
    item,
    payload: {
      url: link,
      title,
      description,
      source: clean2188(item.source || item.feedName || ''),
      category: clean2188(card.querySelector('.reader-story-category-badge')?.textContent || ''),
      mode,
      allowAi: true,
      fast: mode !== 'papers'
    }
  };
}

function hydrateStoredChunk2188(feed, cards) {
  for (const card of cards) {
    const resolved = payloadForCard2188(card);
    if (!resolved) continue;
    const { item, payload } = resolved;
    const key = summaryLookupKey2188(payload.url, payload.mode);
    const stored = storedSummary2188(item, payload.mode);
    if (!stored) continue;
    chunkSummaryCache2188.set(key, stored);
    paintSummary2188(card, stored);
  }
}

async function requestChunk2188(feed, start, activeIndex = -1) {
  if (!feed?.isConnected) return;
  const cards = [...feed.querySelectorAll(':scope > .reader-swipe-card')];
  const chunkCards = cards.slice(start, start + CHUNK_SIZE_2188);
  if (!chunkCards.length) return;

  hydrateStoredChunk2188(feed, chunkCards);

  const missing = [];
  for (const card of chunkCards) {
    const index = Number(card.dataset.index || 0);
    if (index === activeIndex) continue;
    const resolved = payloadForCard2188(card);
    if (!resolved) continue;
    const { item, payload } = resolved;
    const key = summaryLookupKey2188(payload.url, payload.mode);
    const hit = chunkSummaryCache2188.get(key);
    if (hit) { paintSummary2188(card, hit); continue; }
    const stored = storedSummary2188(item, payload.mode);
    if (stored) {
      chunkSummaryCache2188.set(key, stored);
      paintSummary2188(card, stored);
      continue;
    }
    missing.push({ card, item, payload });
  }
  if (!missing.length) return;

  const requestKey = `${start}:${missing.map(row => summaryLookupKey2188(row.payload.url, row.payload.mode)).join('|')}`;
  if (chunkInflight2188.has(requestKey)) return chunkInflight2188.get(requestKey);

  const task = rawFetch2188('/api/summary?batch=1&client=2188', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ items: missing.map(row => row.payload) }),
    signal: AbortSignal.timeout(24_000)
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data?.results)) throw new Error(data?.error || `summary batch ${response.status}`);
    const byUrl = new Map(missing.map(row => [href2188(row.payload.url), row]));
    for (const result of data.results) {
      if (!usableSummary2188(result?.summary)) continue;
      const row = byUrl.get(href2188(result.url));
      if (!row) continue;
      const key = summaryLookupKey2188(row.payload.url, row.payload.mode);
      chunkSummaryCache2188.set(key, result.summary);
      persistSummary2188(row.item, row.payload.mode, result.summary);
      paintSummary2188(row.card, result.summary);
    }
  }).catch(error => {
    console.warn('[reader-chunk-v2188]', error?.message || error);
  }).finally(() => chunkInflight2188.delete(requestKey));

  chunkInflight2188.set(requestKey, task);
  return task;
}

function nearestIndex2188(feed) {
  const cards = [...feed.querySelectorAll(':scope > .reader-swipe-card')];
  if (!cards.length) return 0;
  const active = cards.find(card => card.classList.contains('is-active'));
  if (active) return Number(active.dataset.index || 0);
  const root = feed.getBoundingClientRect();
  const center = root.top + root.height * 0.5;
  let bestIndex = 0;
  let bestDistance = Infinity;
  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    const distance = Math.abs((rect.top + rect.bottom) * 0.5 - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = Number(card.dataset.index || 0);
    }
  });
  return bestIndex;
}

function ensureChunks2188(feed) {
  if (!feed?.isConnected) return;
  const index = nearestIndex2188(feed);
  const currentStart = Math.floor(index / CHUNK_SIZE_2188) * CHUNK_SIZE_2188;
  requestChunk2188(feed, currentStart, index);
  if (index - currentStart >= NEXT_TRIGGER_OFFSET_2188) {
    requestChunk2188(feed, currentStart + CHUNK_SIZE_2188, index);
  }
}

function bindFeed2188(feed) {
  if (!feed || boundFeeds2188.has(feed)) return;
  boundFeeds2188.add(feed);
  let raf = 0;
  let settle = 0;
  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = 0; ensureChunks2188(feed); });
    clearTimeout(settle);
    settle = setTimeout(() => ensureChunks2188(feed), 120);
  };
  feed.addEventListener('scroll', schedule, { passive: true });
  feed.addEventListener('touchend', () => setTimeout(schedule, 30), { passive: true });
  if ('onscrollend' in feed) feed.addEventListener('scrollend', schedule, { passive: true });
  setTimeout(schedule, 60);
}

function bindFeeds2188(root = document) {
  root.querySelectorAll?.('.reader-swipe-feed').forEach(bindFeed2188);
}

new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes || []) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.('.reader-swipe-feed')) bindFeed2188(node);
      bindFeeds2188(node);
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true });

setTimeout(() => bindFeeds2188(), 250);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(() => bindFeeds2188(), 100);
});

window.fetch = async function pdv2188Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2188(input, init); }

  if (url.origin === location.origin && url.pathname === '/api/summary' && String(init?.method || 'GET').toUpperCase() === 'POST' && url.searchParams.get('batch') !== '1') {
    const body = parseBody2188(init);
    const mode = clean2188(body.mode || 'auto');
    const key = summaryLookupKey2188(body.url || body.link || '', mode);
    const hit = chunkSummaryCache2188.get(key);
    if (hit && usableSummary2188(hit)) return jsonResponse2188(hit);
  }
  return inheritedFetch2188(input, init);
};

try { localStorage.setItem('pdv2:runtime:v2188', '1'); } catch {}
