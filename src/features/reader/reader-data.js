import { state } from '../../app/store.js';
import { fetchFeed, parseFeed, dedupeSort } from '../../shared/rss.js';
import { cacheGet, cacheSet, migrateLargeLocalCaches } from '../../shared/storage.js';

const CACHE_TTL = 6 * 60 * 60 * 1000;
let technologyResearchInFlight = null;
const readerBackgroundRefreshes = new Map();

// 旧版でlocalStorageに残った巨大な記事キャッシュを、起動後すぐIndexedDBへ逃がす。
migrateLargeLocalCaches().catch(() => {});

async function fetchTechnologyResearch(force = false) {
  if (technologyResearchInFlight) return technologyResearchInFlight;

  const request = (async () => {
    const refresh = Boolean(force);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const target = `/api/summary?technologyResearch=1${refresh ? '&refresh=1' : ''}`;
      const response = await fetch(target, {
        cache: refresh ? 'no-store' : 'default',
        signal: controller.signal,
        headers: { Accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }
      });
      if (!response.ok) {
        let detail = '';
        try { detail = String((await response.json())?.error || ''); } catch {}
        throw new Error(`技術リサーチ取得エラー (${response.status})${detail ? `: ${detail}` : ''}`);
      }
      const xml = await response.text();
      return parseFeed(xml, '技術リサーチ');
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('技術リサーチの取得がタイムアウトしました');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  technologyResearchInFlight = request;
  try {
    return await request;
  } finally {
    if (technologyResearchInFlight === request) technologyResearchInFlight = null;
  }
}

export function feedsFor(mode) {
  if (mode === 'papers') return state.paperFeeds;
  if (mode === 'knowledge') return state.knowledgeFeeds;
  return state.newsFeeds;
}

export function readerCacheKey(mode, paperTrack = 'core') {
  if (mode !== 'papers') return `pdv2:readerCache:${mode}`;
  const track = paperTrack === 'creative' ? 'creative' : 'technology';
  return `pdv2:readerCache:papers:${track}`;
}

function restoreReaderCache(data) {
  if (!data?.items?.length) return null;
  return {
    ...data,
    items: data.items.map(item => ({ ...item, pubDate: new Date(item.pubDate) })),
    fresh: Date.now() - Number(data.at || 0) < CACHE_TTL
  };
}

export async function readReaderCache(mode, paperTrack = 'core') {
  try {
    const data = await cacheGet(readerCacheKey(mode, paperTrack));
    return restoreReaderCache(data);
  } catch {
    return null;
  }
}

function compactCacheItem(item) {
  return {
    id: item?.id || '',
    title: item?.title || '',
    titleJa: item?.titleJa || '',
    link: item?.link || '',
    description: String(item?.description || '').slice(0, 8000),
    source: item?.source || '',
    author: item?.author || '',
    feedName: item?.feedName || '',
    image: item?.image || '',
    pubDate: item?.pubDate instanceof Date ? item.pubDate.toISOString() : item?.pubDate || '',
    relative: item?.relative || ''
  };
}

async function writeCache(mode, items, paperTrack = 'core') {
  const source = Array.isArray(items) ? items : [];
  const rows = mode === 'papers' && paperTrack === 'technology'
    ? source
    : source.slice(0, mode === 'papers' ? 300 : 350);
  await cacheSet(readerCacheKey(mode, paperTrack), { at: Date.now(), items: rows.map(compactCacheItem) });
}

async function translatePaperTitles(items) {
  const english = items
    .filter(item => /[A-Za-z]{8}/.test(item.title) && !/[ぁ-んァ-ヶ一-龠]{3}/.test(item.title))
    .slice(0, 80);
  if (!english.length) return items;

  let local = {};
  try { local = (await cacheGet('pdv2:paperTitleJa')) || {}; } catch {}
  english.forEach(item => { if (local[item.title]) item.titleJa = local[item.title]; });
  const missing = english.filter(item => !item.titleJa).slice(0, 36);
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
      if (keys.length > 900) keys.slice(0, keys.length - 900).forEach(key => delete local[key]);
      cacheSet('pdv2:paperTitleJa', local).catch(() => {});
      window.dispatchEvent(new CustomEvent('pdv2:paper-titles'));
    })
    .catch(() => {});

  return items;
}

const NEWS_EDITORIAL_RE = /コラム|オピニオン|論説|社説|寄稿|エッセイ|評論|レビュー|ランキング|まとめ|PR|広告|Sponsored/i;
const NEWS_PAYWALL_RE = /会員限定|有料記事|有料会員|会員登録|購読者限定|続きを読むには|subscriber(?:s)? only|members? only|premium article/i;
const NEWS_PERSONAL_RE = /個人ブログ|note\.com|アメブロ|はてなブログ|medium\.com|substack\.com/i;
const NEWS_BLOCKED_HOST_RE = /(?:^|\.)(?:nikkei\.com|toyokeizai\.net)$/i;

function newsHost(link = '') {
  try { return new URL(String(link || '')).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isStraightNewsItem(item) {
  const hay = [item?.title, item?.description, item?.source, item?.feedName, item?.link].filter(Boolean).join('\n');
  if (NEWS_EDITORIAL_RE.test(hay) || NEWS_PAYWALL_RE.test(hay) || NEWS_PERSONAL_RE.test(hay)) return false;
  if (NEWS_BLOCKED_HOST_RE.test(newsHost(item?.link))) return false;
  return Boolean(String(item?.title || '').trim());
}

function filterModeItems(items, mode) {
  return mode === 'news' ? items.filter(isStraightNewsItem) : items;
}

function itemTime(item) {
  const ms = new Date(item?.pubDate || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function itemKey(item) {
  return String(item?.link || item?.id || item?.title || '').trim().toLowerCase();
}

function fairNewsOrder(items, feeds, limit = 350) {
  const feedOrder = new Map((Array.isArray(feeds) ? feeds : []).map((feed, index) => [String(feed?.name || ''), index]));
  const grouped = new Map();
  for (const item of filterModeItems(items, 'news')) {
    const name = String(item?.feedName || item?.source || 'その他');
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(item);
  }
  const buckets = [...grouped.entries()].map(([name, rows]) => {
    const sorted = dedupeSort(rows, limit);
    return {
      name, rows: sorted, cursor: 0,
      latest: sorted.length ? itemTime(sorted[0]) : 0,
      order: feedOrder.has(name) ? feedOrder.get(name) : Number.MAX_SAFE_INTEGER
    };
  }).filter(bucket => bucket.rows.length)
    .sort((a, b) => b.latest - a.latest || a.order - b.order || a.name.localeCompare(b.name, 'ja'));

  const out = [];
  const seen = new Set();
  let added = true;
  while (out.length < limit && added) {
    added = false;
    for (const bucket of buckets) {
      while (bucket.cursor < bucket.rows.length) {
        const item = bucket.rows[bucket.cursor++];
        const key = itemKey(item);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(item);
        added = true;
        break;
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function arrangeModeItems(items, mode, feeds, limit) {
  if (mode === 'news' && (feeds?.length || 0) > 1) return fairNewsOrder(items, feeds, limit);
  return filterModeItems(dedupeSort(items, limit), mode);
}

function friendlyFailure(mode, failures) {
  const count = failures.length;
  const first = String(failures[0]?.error?.message || '').trim();
  const detail = first ? ` ${first}` : '';
  if (mode === 'knowledge') return `知識RSSを取得できませんでした。保存済み記事があれば自動で表示します。${count ? `（失敗 ${count}件）` : ''}${detail}`;
  if (mode === 'papers') return `技術リサーチ取得先が一時的に応答していません。保存済み記事があれば自動で表示します。${detail}`;
  return `記事を取得できませんでした。しばらくしてから更新してください。${detail}`;
}

function backgroundRefreshKey(mode, selectedFeed, paperTrack, fastOnly) {
  return [mode, selectedFeed || '', paperTrack || 'core', fastOnly ? 'fast' : 'deep'].join('::');
}

function scheduleReaderBackgroundRefresh(mode, options = {}) {
  const key = backgroundRefreshKey(mode, options.selectedFeed, options.paperTrack, options.fastOnly);
  if (readerBackgroundRefreshes.has(key)) return readerBackgroundRefreshes.get(key);
  const request = Promise.resolve().then(() => loadReader(mode, {
    ...options,
    force: false,
    preferCache: false,
    backgroundRefresh: true,
    onProgress: undefined
  })).catch(error => {
    console.warn('[reader background refresh]', mode, error?.message || error);
    return null;
  }).finally(() => readerBackgroundRefreshes.delete(key));
  readerBackgroundRefreshes.set(key, request);
  return request;
}

export async function loadReader(mode, {
  force = false,
  onProgress,
  selectedFeed = '',
  paperTrack = 'core',
  fastOnly = false,
  preferCache = false,
  backgroundRefresh = false
} = {}) {
  // 現在の papers/core は「技術リサーチ」に全面置換済み。旧 papers-feed は一覧表示経路から外す。
  const normalizedTrack = paperTrack === 'creative' ? 'creative' : 'technology';
  const allFeeds = feedsFor(mode);
  const feeds = selectedFeed && mode !== 'papers'
    ? allFeeds.filter(feed => feed.name === selectedFeed)
    : allFeeds;
  const cached = await readReaderCache(mode, normalizedTrack);
  const itemLimit = mode === 'papers' && normalizedTrack === 'technology' ? 0 : (mode === 'papers' ? 300 : 350);

  let visibleCached = [];
  if (cached?.items?.length) {
    const raw = selectedFeed && mode !== 'papers'
      ? cached.items.filter(item => item.feedName === selectedFeed)
      : cached.items;
    visibleCached = arrangeModeItems(raw, mode, feeds, itemLimit);
    if (visibleCached.length) onProgress?.(visibleCached, { cached: true, refreshing: force, paperTrack: normalizedTrack });
    if (preferCache && !force && visibleCached.length) {
      return { items: visibleCached, failures: [], cached: true, paperTrack: normalizedTrack };
    }
  }

  const warmCacheOnly = !backgroundRefresh && !force && Boolean(globalThis.__PDV2_READER_WARM_CACHE_ONLY);
  if (warmCacheOnly) {
    scheduleReaderBackgroundRefresh(mode, { selectedFeed, paperTrack: normalizedTrack, fastOnly });
    return {
      items: visibleCached,
      failures: [],
      cached: Boolean(visibleCached.length),
      warming: true,
      paperTrack: normalizedTrack
    };
  }

  const collected = [];
  const failures = [];

  if (mode === 'papers' && normalizedTrack === 'technology') {
    try {
      const research = await fetchTechnologyResearch(force);
      collected.push(...research);
      onProgress?.(dedupeSort([...collected, ...visibleCached], 0), { stage: 'technology-research', paperTrack: normalizedTrack });
    } catch (error) {
      failures.push({ feed: '技術リサーチ', error });
    }
  } else if (mode === 'papers') {
    const label = '独創研究';
    try {
      const fast = await fetchFeed({ name: label, url: '/api/creative-papers-feed?mode=fast' }, { force, timeoutMs: 35_000 });
      collected.push(...fast);
      onProgress?.(dedupeSort([...collected, ...(force ? visibleCached : [])]), { stage: 'fast', paperTrack: normalizedTrack });
    } catch (error) { failures.push({ feed: label, error }); }

    if (!fastOnly) {
      try {
        const deep = await fetchFeed({ name: label, url: '/api/creative-papers-feed?mode=deep' }, { force, timeoutMs: 45_000 });
        collected.push(...deep);
      } catch (error) { failures.push({ feed: label, error }); }
    }
  } else {
    const queue = feeds.map(feed => ({ feed }));
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const { feed } = queue.shift();
        try {
          collected.push(...await fetchFeed(feed, { force, timeoutMs: 35_000 }));
          onProgress?.(arrangeModeItems([...collected, ...(force ? visibleCached : [])], mode, feeds, 350), { feed: feed.name });
        } catch (error) {
          failures.push({ feed: feed.name, error });
        }
      }
    });
    await Promise.all(workers);
  }

  const shouldMergeCached = visibleCached.length && (failures.length > 0 || mode === 'papers');
  const combined = shouldMergeCached ? [...collected, ...visibleCached] : collected;
  let items = arrangeModeItems(combined, mode, feeds, itemLimit);
  if (mode === 'papers') items = await translatePaperTitles(items);

  if (items.length) {
    if (!selectedFeed || mode === 'papers') await writeCache(mode, items, normalizedTrack);
    return { items, failures, refreshed: force && collected.length > 0, stale: force && collected.length === 0, paperTrack: normalizedTrack };
  }

  if (visibleCached.length) {
    return { items: visibleCached, failures, stale: true, paperTrack: normalizedTrack };
  }

  const error = new Error(friendlyFailure(mode, failures));
  error.failures = failures;
  throw error;
}

export function filterByFeed(items, feed, mode) {
  if (!feed) return items;
  if (String(feed.url).startsWith('/api/news-feed')) return items;
  return items.filter(item => item.feedName === feed.name || item.source === feed.name);
}
