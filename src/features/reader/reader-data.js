import { state } from '../../app/store.js';
import { fetchFeed, dedupeSort } from '../../shared/rss.js';

const CACHE_TTL = 6 * 60 * 60 * 1000;

export function feedsFor(mode) {
  if (mode === 'papers') return state.paperFeeds;
  if (mode === 'knowledge') return state.knowledgeFeeds;
  return state.newsFeeds;
}

export function readerCacheKey(mode, paperTrack = 'core') {
  return mode === 'papers'
    ? `pdv2:readerCache:papers:${paperTrack === 'creative' ? 'creative' : 'core'}`
    : `pdv2:readerCache:${mode}`;
}

export function readReaderCache(mode, paperTrack = 'core') {
  try {
    let data = JSON.parse(localStorage.getItem(readerCacheKey(mode, paperTrack)) || 'null');
    // beta初期版の論文キャッシュがあれば「製品・熱」側だけ互換読込する。
    if (!data && mode === 'papers' && paperTrack !== 'creative') {
      data = JSON.parse(localStorage.getItem('pdv2:readerCache:papers') || 'null');
    }
    if (!data?.items?.length) return null;
    return {
      ...data,
      items: data.items.map(i => ({ ...i, pubDate: new Date(i.pubDate) })),
      fresh: Date.now() - data.at < CACHE_TTL
    };
  } catch {
    return null;
  }
}

function writeCache(mode, items, paperTrack = 'core') {
  localStorage.setItem(readerCacheKey(mode, paperTrack), JSON.stringify({ at: Date.now(), items }));
}

async function translatePaperTitles(items) {
  const english = items
    .filter(i => /[A-Za-z]{8}/.test(i.title) && !/[ぁ-んァ-ヶ一-龠]{3}/.test(i.title))
    .slice(0, 80);
  if (!english.length) return items;

  const local = JSON.parse(localStorage.getItem('pdv2:paperTitleJa') || '{}');
  english.forEach(item => { if (local[item.title]) item.titleJa = local[item.title]; });
  const missing = english.filter(item => !item.titleJa).slice(0, 40);
  if (!missing.length) return items;

  fetch('/api/paper-titles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titles: missing.map(x => x.title) })
  })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const rows = Array.isArray(data?.translations) ? data.translations : [];
      rows.forEach(row => {
        const original = String(row?.original || '').trim();
        const ja = String(row?.ja || '').trim();
        if (original && ja) local[original] = ja;
      });
      const keys = Object.keys(local);
      if (keys.length > 1200) keys.slice(0, keys.length - 1200).forEach(k => delete local[k]);
      localStorage.setItem('pdv2:paperTitleJa', JSON.stringify(local));
      window.dispatchEvent(new CustomEvent('pdv2:paper-titles'));
    })
    .catch(() => {});

  return items;
}

export async function loadReader(mode, {
  force = false,
  onProgress,
  selectedFeed = '',
  paperTrack = 'core'
} = {}) {
  const normalizedTrack = paperTrack === 'creative' ? 'creative' : 'core';
  const cached = !force ? readReaderCache(mode, normalizedTrack) : null;

  if (cached?.items?.length) {
    const visibleCached = selectedFeed && mode !== 'papers'
      ? cached.items.filter(item => item.feedName === selectedFeed)
      : cached.items;
    if (visibleCached.length) onProgress?.(visibleCached, { cached: true, paperTrack: normalizedTrack });
  }

  const allFeeds = feedsFor(mode);
  const feeds = selectedFeed && mode !== 'papers'
    ? allFeeds.filter(feed => feed.name === selectedFeed)
    : allFeeds;
  const collected = [];
  const failures = [];

  if (mode === 'papers') {
    const base = normalizedTrack === 'creative' ? '/api/creative-papers-feed' : '/api/papers-feed';
    const label = normalizedTrack === 'creative' ? '独創研究' : '製品・熱研究';

    try {
      const fast = await fetchFeed({ name: label, url: `${base}?mode=fast` });
      collected.push(...fast);
      onProgress?.(dedupeSort(collected), { stage: 'fast', paperTrack: normalizedTrack });
    } catch (err) {
      failures.push(err);
    }

    // 先行表示後に詳細ソースを追加する。fastが失敗してもdeepは試す。
    try {
      const deep = await fetchFeed({ name: label, url: `${base}?mode=deep` });
      collected.push(...deep);
    } catch (err) {
      failures.push(err);
    }
  } else {
    const queue = feeds.map((feed, index) => ({ feed, index }));
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const { feed } = queue.shift();
        try {
          collected.push(...await fetchFeed(feed));
          onProgress?.(dedupeSort(collected), { feed: feed.name });
        } catch (err) {
          failures.push({ feed: feed.name, error: err });
        }
      }
    });
    await Promise.all(workers);
  }

  let items = dedupeSort(collected, mode === 'papers' ? 300 : 350);
  if (mode === 'papers') items = await translatePaperTitles(items);

  if (items.length) {
    if (!selectedFeed || mode === 'papers') writeCache(mode, items, normalizedTrack);
    return { items, failures, paperTrack: normalizedTrack };
  }

  if (cached?.items?.length) {
    const fallback = selectedFeed && mode !== 'papers'
      ? cached.items.filter(item => item.feedName === selectedFeed)
      : cached.items;
    if (fallback.length) return { items: fallback, failures, stale: true, paperTrack: normalizedTrack };
  }

  throw failures[0]?.error || failures[0] || new Error('記事を取得できませんでした');
}

export function filterByFeed(items, feed, mode) {
  if (!feed) return items;
  if (String(feed.url).startsWith('/api/news-feed')) return items;
  return items.filter(i => i.feedName === feed.name || i.source === feed.name);
}
