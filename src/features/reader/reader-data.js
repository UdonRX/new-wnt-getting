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
    if (!data && mode === 'papers' && paperTrack !== 'creative') {
      data = JSON.parse(localStorage.getItem('pdv2:readerCache:papers') || 'null');
    }
    if (!data?.items?.length) return null;
    return {
      ...data,
      items: data.items.map(item => ({ ...item, pubDate: new Date(item.pubDate) })),
      fresh: Date.now() - Number(data.at || 0) < CACHE_TTL
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
    .filter(item => /[A-Za-z]{8}/.test(item.title) && !/[ぁ-んァ-ヶ一-龠]{3}/.test(item.title))
    .slice(0, 80);
  if (!english.length) return items;

  const local = JSON.parse(localStorage.getItem('pdv2:paperTitleJa') || '{}');
  english.forEach(item => { if (local[item.title]) item.titleJa = local[item.title]; });
  const missing = english.filter(item => !item.titleJa).slice(0, 40);
  if (!missing.length) return items;

  fetch('/api/paper-titles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titles: missing.map(item => item.title) })
  })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      const rows = Array.isArray(data?.translations) ? data.translations : [];
      rows.forEach(row => {
        const original = String(row?.original || '').trim();
        const ja = String(row?.ja || '').trim();
        if (original && ja) local[original] = ja;
      });
      const keys = Object.keys(local);
      if (keys.length > 1200) keys.slice(0, keys.length - 1200).forEach(key => delete local[key]);
      localStorage.setItem('pdv2:paperTitleJa', JSON.stringify(local));
      window.dispatchEvent(new CustomEvent('pdv2:paper-titles'));
    })
    .catch(() => {});

  return items;
}

// ニュースは報道記事だけを残す。コラム/寄稿/レビュー/PR/明示的有料記事/個人ブログを除外。
const NEWS_EDITORIAL_RE = /コラム|オピニオン|論説|社説|寄稿|エッセイ|評論|レビュー|ランキング|まとめ|PR|広告|Sponsored/i;
const NEWS_PAYWALL_RE = /会員限定|有料記事|有料会員|会員登録|購読者限定|続きを読むには|subscriber(?:s)? only|members? only|premium article/i;
const NEWS_PERSONAL_RE = /個人ブログ|note\.com|アメブロ|はてなブログ|medium\.com|substack\.com/i;
const NEWS_BLOCKED_HOST_RE = /(?:^|\.)(?:nikkei\.com|toyokeizai\.net)$/i;

function newsHost(link = '') {
  try { return new URL(String(link || '')).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isStraightNewsItem(item) {
  const hay = [item?.title, item?.description, item?.source, item?.feedName, item?.link]
    .filter(Boolean)
    .join('\n');
  if (NEWS_EDITORIAL_RE.test(hay)) return false;
  if (NEWS_PAYWALL_RE.test(hay)) return false;
  if (NEWS_PERSONAL_RE.test(hay)) return false;
  if (NEWS_BLOCKED_HOST_RE.test(newsHost(item?.link))) return false;
  return Boolean(String(item?.title || '').trim());
}

function filterModeItems(items, mode) {
  return mode === 'news' ? items.filter(isStraightNewsItem) : items;
}

export async function loadReader(mode, {
  force = false,
  onProgress,
  selectedFeed = '',
  paperTrack = 'core',
  fastOnly = false,
  preferCache = false
} = {}) {
  const normalizedTrack = paperTrack === 'creative' ? 'creative' : 'core';
  const cached = !force ? readReaderCache(mode, normalizedTrack) : null;

  let visibleCached = [];
  if (cached?.items?.length) {
    const visibleCachedRaw = selectedFeed && mode !== 'papers'
      ? cached.items.filter(item => item.feedName === selectedFeed)
      : cached.items;
    visibleCached = filterModeItems(visibleCachedRaw, mode);

    if (visibleCached.length) {
      onProgress?.(visibleCached, { cached: true, paperTrack: normalizedTrack });
    }

    // おすすめの事前ロードでは、キャッシュがあれば外部API待ちを避ける。
    if (preferCache && visibleCached.length) {
      return { items: visibleCached, failures: [], cached: true, paperTrack: normalizedTrack };
    }
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

    if (!fastOnly) {
      try {
        const deep = await fetchFeed({ name: label, url: `${base}?mode=deep` });
        collected.push(...deep);
      } catch (err) {
        failures.push(err);
      }
    }
  } else {
    const queue = feeds.map(feed => ({ feed }));
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const { feed } = queue.shift();
        try {
          collected.push(...await fetchFeed(feed));
          onProgress?.(filterModeItems(dedupeSort(collected), mode), { feed: feed.name });
        } catch (err) {
          failures.push({ feed: feed.name, error: err });
        }
      }
    });
    await Promise.all(workers);
  }

  let items = filterModeItems(
    dedupeSort(collected, mode === 'papers' ? 300 : 350),
    mode
  );

  if (mode === 'papers') items = await translatePaperTitles(items);

  if (items.length) {
    if (!selectedFeed || mode === 'papers') writeCache(mode, items, normalizedTrack);
    return { items, failures, paperTrack: normalizedTrack };
  }

  if (cached?.items?.length) {
    const fallbackRaw = selectedFeed && mode !== 'papers'
      ? cached.items.filter(item => item.feedName === selectedFeed)
      : cached.items;
    const fallback = filterModeItems(fallbackRaw, mode);
    if (fallback.length) {
      return { items: fallback, failures, stale: true, paperTrack: normalizedTrack };
    }
  }

  throw failures[0]?.error || failures[0] || new Error('記事を取得できませんでした');
}

export function filterByFeed(items, feed, mode) {
  if (!feed) return items;
  if (String(feed.url).startsWith('/api/news-feed')) return items;
  return items.filter(item => item.feedName === feed.name || item.source === feed.name);
}
