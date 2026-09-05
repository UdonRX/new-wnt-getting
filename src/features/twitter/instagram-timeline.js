import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { relativeTime } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { instagramAccounts, instagramProfileUrl, openInstagramAccountManager } from './instagram-accounts.js';
import { makeInstagramVideoLauncher } from './instagram-video.js';
import {
  deleteInstagramCachesExcept,
  isInstagramCacheFresh,
  readInstagramCaches,
  writeInstagramCache
} from './instagram-cache.js';

const INSTAGRAM_PAGE_SIZE = 12;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const QUALITY_BATCH_SIZE = 6;
// iOS WebKit is prone to killing a tab when many Instagram accounts create dozens of
// image-heavy cards in the same task. Keep the DOM budget global, not per account.
const INITIAL_RENDER_LIMIT = 18;
const FIRST_PAINT_RENDER_LIMIT = 8;
const LOAD_MORE_RENDER_LIMIT = 12;
const NETWORK_ACCOUNT_BATCH = 3;
const QUALITY_ROOT_MARGIN = '240px 0px';
const QUALITY_FALLBACK_DELAY_MS = 180;
const qualityQueue = new Map();
let qualityTimer = 0;

function openExternal(url) {
  const target = String(url || '').trim();
  if (!target) return;
  const opened = window.open(target, '_blank');
  if (opened) {
    try { opened.opener = null; } catch {}
  } else {
    window.location.assign(target);
  }
}

function itemKey(item) {
  return String(item?.id || `${item?.account?.username || ''}:${item?.shortcode || ''}`).trim();
}

function itemTimestamp(item) {
  return Number(item?.timestamp || 0);
}

function mergeMediaQuality(freshMedia, cachedMedia) {
  const fresh = Array.isArray(freshMedia) ? freshMedia : [];
  const cached = Array.isArray(cachedMedia) ? cachedMedia : [];
  return fresh.map((entry, index) => {
    const old = cached[index] || {};
    return {
      ...entry,
      highResUrl: entry?.highResUrl || old?.highResUrl || '',
      width: entry?.width || old?.width || null,
      height: entry?.height || old?.height || null,
      qualityResolvedAt: entry?.qualityResolvedAt || old?.qualityResolvedAt || null
    };
  });
}

function mergeItemPreferQuality(fresh, cached) {
  if (!cached) return fresh;
  return {
    ...cached,
    ...fresh,
    account: { ...(cached.account || {}), ...(fresh.account || {}) },
    media: mergeMediaQuality(fresh.media, cached.media)
  };
}

function dedupeSort(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter(item => {
      const key = itemKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
}

function relativeInstagramTime(item) {
  const iso = item?.timestampIso || (
    Number.isFinite(Number(item?.timestamp))
      ? new Date(Number(item.timestamp) * 1000).toISOString()
      : ''
  );
  return iso ? relativeTime(iso) : '';
}

function absoluteInstagramTime(item) {
  const ms = item?.timestampIso
    ? Date.parse(item.timestampIso)
    : Number(item?.timestamp) * 1000;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

function qualityResolved(item) {
  const media = Array.isArray(item?.media) ? item.media : [];
  const images = media.filter(entry => entry?.kind !== 'video' && (entry?.url || entry?.posterUrl));
  return !images.length || images.every(entry => Boolean(entry?.highResUrl));
}

async function flushQualityQueue() {
  qualityTimer = 0;
  const batch = [...qualityQueue.entries()].slice(0, QUALITY_BATCH_SIZE);
  if (!batch.length) return;
  batch.forEach(([shortcode]) => qualityQueue.delete(shortcode));
  const shortcodes = batch.map(([shortcode]) => shortcode);
  const query = new URLSearchParams({ shortcodes: shortcodes.join(',') });

  try {
    const response = await fetch(`/api/instagram-image?${query}`, {
      headers: { Accept: 'application/json' },
      cache: 'force-cache',
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    const resolved = data?.resolved || {};
    batch.forEach(([shortcode, jobs]) => {
      const result = resolved[shortcode];
      if (!result || !Array.isArray(result.images) || !result.images.length) return;
      jobs.forEach(job => job.apply(result.images));
    });
  } catch (error) {
    console.warn('[instagram-image-quality]', error?.message || error);
  } finally {
    if (qualityQueue.size && !qualityTimer) qualityTimer = window.setTimeout(flushQualityQueue, 120);
  }
}

function enqueueQualityResolution(shortcode, apply) {
  if (!shortcode) return;
  const jobs = qualityQueue.get(shortcode) || [];
  jobs.push({ apply });
  qualityQueue.set(shortcode, jobs);
  if (!qualityTimer) qualityTimer = window.setTimeout(flushQualityQueue, 70);
}

function mediaGallery(item, onQualityChanged) {
  const media = Array.isArray(item?.media) ? item.media.filter(entry => entry?.url || entry?.posterUrl || entry?.highResUrl) : [];
  if (!media.length) return null;

  const wrap = el('div', {
    class: 'instagram-media-gallery',
    style: 'position:relative;margin-top:9px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#0d0d0f;'
  });
  const strip = el('div', {
    style: 'display:flex;width:100%;overflow-x:auto;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none;'
  });

  media.forEach((entry, index) => {
    const slide = el('div', {
      style: 'position:relative;flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;display:grid;place-items:center;overflow:hidden;'
    });

    if (entry.kind === 'video') {
      slide.append(makeInstagramVideoLauncher(item, {
        ...entry,
        posterUrl: entry.highResUrl || entry.posterUrl || entry.url || ''
      }));
    } else {
      const originalSrc = entry.url || entry.posterUrl || '';
      const src = entry.highResUrl || originalSrc;
      const image = el('img', {
        src,
        alt: 'Instagram投稿画像',
        loading: 'lazy',
        decoding: 'async',
        'data-instagram-media-index': String(index),
        style: 'display:block;width:100%;height:auto;max-height:68vh;object-fit:contain;background:#0d0d0f;image-rendering:auto;'
      });
      image.addEventListener('error', () => {
        if (entry.highResUrl && originalSrc && image.src !== originalSrc) image.src = originalSrc;
      }, { once: true });
      image.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const currentUrls = media
          .filter(value => value.kind !== 'video' && (value.highResUrl || value.url || value.posterUrl))
          .map(value => value.highResUrl || value.url || value.posterUrl);
        const currentSrc = entry.highResUrl || originalSrc;
        const currentIndex = Math.max(0, currentUrls.indexOf(currentSrc));
        if (currentUrls.length) openImageViewer(currentUrls, currentIndex);
      });
      slide.append(image);
    }

    if (media.length > 1) {
      slide.append(el('span', {
        text: `${index + 1}/${media.length}`,
        style: 'position:absolute;right:9px;top:9px;padding:4px 7px;border-radius:999px;background:rgba(0,0,0,.68);color:#fff;font-size:11px;font-weight:800;pointer-events:none;'
      }));
    }
    strip.append(slide);
  });

  wrap.append(strip);

  if (!qualityResolved(item) && item?.shortcode) {
    const resolve = () => enqueueQualityResolution(item.shortcode, images => {
      let changed = false;
      media.forEach((entry, index) => {
        if (entry.kind === 'video') return;
        const resolved = images[index] || (images.length === 1 ? images[0] : null);
        const highResUrl = String(resolved?.url || '').trim();
        if (!highResUrl || highResUrl === entry.highResUrl) return;
        entry.highResUrl = highResUrl;
        entry.width = resolved?.width || entry.width || null;
        entry.height = resolved?.height || entry.height || null;
        entry.qualityResolvedAt = Date.now();
        const image = wrap.querySelector(`img[data-instagram-media-index="${index}"]`);
        if (image) image.src = highResUrl;
        changed = true;
      });
      if (changed) onQualityChanged?.(item);
    });

    const scheduleResolve = () => {
      const run = () => {
        if (wrap.isConnected) resolve();
      };
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(run, { timeout: 900 });
      } else {
        window.setTimeout(run, QUALITY_FALLBACK_DELAY_MS);
      }
    };

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        scheduleResolve();
      }, { rootMargin: QUALITY_ROOT_MARGIN });
      observer.observe(wrap);
    } else {
      scheduleResolve();
    }
  }

  return wrap;
}

function makeAccountAvatar(account, username, profileUrl) {
  const avatarLink = el('a', {
    href: profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': `@${username}のInstagramプロフィールを開く`,
    style: 'width:42px;height:42px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--surface-2);color:var(--text-strong);text-decoration:none;overflow:hidden;'
  });
  const fallback = () => {
    avatarLink.replaceChildren();
    avatarLink.innerHTML = iconSvg('instagram', { size: 22, strokeWidth: 1.9 });
  };
  const avatarUrl = String(account?.avatarUrl || '').trim();
  if (!avatarUrl) {
    fallback();
    return avatarLink;
  }
  const image = el('img', {
    src: avatarUrl,
    alt: `@${username}`,
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    style: 'display:block;width:100%;height:100%;object-fit:cover;'
  });
  image.addEventListener('error', fallback, { once: true });
  avatarLink.append(image);
  return avatarLink;
}

function instagramCard(item, onQualityChanged) {
  const username = String(item?.account?.username || '').trim();
  const profileUrl = item?.account?.profileUrl || instagramProfileUrl(username);
  const permalink = item?.permalink || profileUrl;
  const elapsed = relativeInstagramTime(item);

  const card = el('article', {
    class: 'tweet-card tweet-timeline-item instagram-timeline-item',
    role: 'link',
    tabindex: '0',
    'aria-label': 'Instagram投稿を開く',
    'data-instagram-item-key': itemKey(item),
    style: 'margin:0;padding:12px 14px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none;display:grid;grid-template-columns:42px minmax(0,1fr);column-gap:10px;align-items:start;cursor:pointer;'
  });

  const avatarLink = makeAccountAvatar(item?.account, username, profileUrl);
  const content = el('div', { style: 'min-width:0;' });
  const meta = el('div', {
    style: 'min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden;white-space:nowrap;line-height:1.25;'
  });
  const author = el('a', {
    href: profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    style: 'min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:5px;overflow:hidden;text-decoration:none;color:inherit;'
  }, [
    el('strong', {
      text: `@${username}`,
      style: 'min-width:0;max-width:72%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:780;color:var(--text-strong);'
    }),
    el('span', {
      html: iconSvg('instagram', { size: 13, strokeWidth: 1.9 }),
      'aria-hidden': 'true',
      style: 'flex:0 0 auto;display:inline-flex;color:var(--muted);'
    })
  ]);
  meta.append(author);
  if (elapsed) {
    meta.append(el('a', {
      href: permalink,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: elapsed,
      title: absoluteInstagramTime(item),
      style: 'flex:0 0 auto;margin-left:2px;font-size:14px;color:var(--muted);text-decoration:none;'
    }));
  }
  content.append(meta);

  if (item?.text) {
    content.append(el('div', {
      class: 'tweet-text',
      text: item.text,
      style: 'margin-top:3px;font-size:15.5px;line-height:1.45;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap;'
    }));
  }

  const gallery = mediaGallery(item, onQualityChanged);
  if (gallery) content.append(gallery);

  card.append(avatarLink, content);
  const openPost = () => openExternal(permalink);
  card.addEventListener('click', event => {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('a,button,video,.instagram-media-gallery')) ||
      String(window.getSelection?.()?.toString() || '').trim()
    ) return;
    openPost();
  });
  card.addEventListener('keydown', event => {
    if ((event.key !== 'Enter' && event.key !== ' ') || (event.target instanceof Element && event.target.closest('a,button'))) return;
    event.preventDefault();
    openPost();
  });
  return card;
}

function normalizeResponseItem(item, username, responseAccount) {
  return {
    source: 'instagram',
    account: { ...responseAccount, ...(item.account || {}) },
    id: item.id,
    externalId: item.externalId || null,
    shortcode: item.shortcode || null,
    text: String(item.text || ''),
    timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : null,
    timestampIso: item.timestampIso || null,
    media: Array.isArray(item.media) ? item.media : [],
    mediaType: item.mediaType || 'image',
    permalink: item.permalink || instagramProfileUrl(username),
    reelPermalink: item.reelPermalink || null
  };
}

async function fetchInstagramAccount(username, cursor = '') {
  const started = performance.now();
  const query = new URLSearchParams({
    username,
    limit: String(INSTAGRAM_PAGE_SIZE),
    t: String(Date.now())
  });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/instagram-profile?${query}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(cursor ? 16000 : 13000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || !Array.isArray(data.items)) {
    throw new Error(data.error || `Instagram取得 HTTP ${response.status}`);
  }
  const responseAccount = data.account || { username, profileUrl: instagramProfileUrl(username) };
  return {
    username,
    items: data.items
      .filter(item => item?.source === 'instagram')
      .map(item => normalizeResponseItem(item, username, responseAccount)),
    nextCursor: data.hasMore && data.nextCursor ? String(data.nextCursor) : '',
    hasMore: Boolean(data.hasMore && data.nextCursor),
    ms: Math.round(performance.now() - started),
    diagnostics: data.diagnostics || null
  };
}

export function renderInstagramTimeline(root, options, { generation, isCurrent, modeSegment }) {
  let refreshSerial = 0;
  let loadMoreBusy = false;
  let visibleItems = [];
  let pageCursors = new Map();
  let cacheRecords = new Map();
  let cacheQueues = new Map();
  let sentinelObserver = null;
  let cursorBatchOffset = 0;
  let disposed = false;

  const screen = el('section', { class: 'screen sns-screen instagram-screen' });
  const header = topbar('SNS', {
    subtitle: 'Instagramタイムライン',
    actions: [
      {
        html: iconSvg('plus', { size: 20 }),
        title: 'Instagramアカウントを追加・管理',
        onClick: () => openInstagramAccountManager({
          onChanged: () => {
            // Adding/removing an account must not force every already-fresh account to hit
            // Instagram again. A new account has no cache and is fetched automatically.
            if (isCurrent(generation)) refreshNow(false);
          }
        })
      },
      {
        html: iconSvg('refresh', { size: 20 }),
        title: '更新',
        onClick: () => refreshNow(true)
      },
      {
        html: iconSvg('settings', { size: 20 }),
        title: '設定',
        onClick: () => options.navigate('settings')
      }
    ]
  });
  const status = el('div', {
    class: 'twitter-update-status media-meta',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
    style: 'min-height:16px;margin:0 4px 4px;opacity:.82;'
  });
  const host = el('div', {
    class: 'twitter-feed-host instagram-feed-host',
    style: 'display:block;margin:0 -14px;padding:0;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;overflow:visible;'
  });
  const listHost = el('div', { class: 'instagram-feed-list' });
  const sentinel = el('div', {
    class: 'instagram-load-more-sentinel',
    role: 'status',
    'aria-live': 'polite',
    style: 'min-height:1px;padding:10px 14px 18px;text-align:center;color:var(--muted);font-size:12px;'
  });
  host.append(listHost, sentinel);
  screen.append(header, status, host, modeSegment);
  root.replaceChildren(screen);

  const activeCursorEntries = () => [...pageCursors.entries()].filter(([, cursor]) => Boolean(cursor));
  const cachedQueueCount = () => [...cacheQueues.values()].reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const hasMore = () => cachedQueueCount() > 0 || activeCursorEntries().length > 0;

  const persistQualityItem = async updatedItem => {
    if (disposed) return;
    const username = String(updatedItem?.account?.username || '').toLowerCase();
    const record = cacheRecords.get(username);
    if (!record) return;
    const key = itemKey(updatedItem);
    const items = record.items.map(item => itemKey(item) === key ? mergeItemPreferQuality(updatedItem, item) : item);
    const next = { ...record, items, updatedAt: Date.now() };
    cacheRecords.set(username, next);
    await writeInstagramCache(next);
  };

  const makeCard = item => instagramCard(item, persistQualityItem);

  const updateSentinel = (text = '') => {
    sentinel.textContent = text || '';
    sentinel.style.display = hasMore() || text ? 'block' : 'none';
    if (!hasMore() && sentinelObserver) sentinelObserver.disconnect();
  };

  const replaceItems = (items, limit = INITIAL_RENDER_LIMIT) => {
    visibleItems = dedupeSort(items).slice(0, Math.max(0, limit));
    listHost.replaceChildren(...visibleItems.map(makeCard));
  };

  const mergeItems = (items, limit = LOAD_MORE_RENDER_LIMIT) => {
    const known = new Set(visibleItems.map(itemKey).filter(Boolean));
    const incoming = dedupeSort(items).filter(item => {
      const key = itemKey(item);
      if (!key || known.has(key)) return false;
      known.add(key);
      return true;
    }).slice(0, Math.max(0, limit));
    for (const item of incoming) {
      const timestamp = itemTimestamp(item);
      let index = visibleItems.findIndex(existing => itemTimestamp(existing) < timestamp);
      if (index < 0) index = visibleItems.length;
      listHost.insertBefore(makeCard(item), listHost.children[index] || null);
      visibleItems.splice(index, 0, item);
    }
    return incoming.length;
  };

  const trimVisibleTail = limit => {
    const max = Math.max(0, Number(limit) || 0);
    while (visibleItems.length > max) {
      visibleItems.pop();
      listHost.lastElementChild?.remove();
    }
  };

  const syncQueue = username => {
    const record = cacheRecords.get(username);
    if (!record) {
      cacheQueues.set(username, []);
      return;
    }
    const visible = new Set(visibleItems.map(itemKey));
    cacheQueues.set(username, record.items.filter(item => !visible.has(itemKey(item))));
  };

  const syncAllQueues = accounts => accounts.forEach(syncQueue);

  const observeSentinel = loadMore => {
    sentinelObserver?.disconnect();
    if (!('IntersectionObserver' in window) || !hasMore()) return;
    sentinelObserver = new IntersectionObserver(entries => {
      if (!screen.isConnected || disposed) {
        sentinelObserver?.disconnect();
        return;
      }
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { rootMargin: '900px 0px 900px 0px' });
    sentinelObserver.observe(sentinel);
  };

  const persistNetworkPage = async (username, result, { initial = false } = {}) => {
    const old = cacheRecords.get(username) || { username, items: [], nextCursor: '', checkedAt: 0, updatedAt: 0 };
    const oldByKey = new Map(old.items.map(item => [itemKey(item), item]));
    const fresh = result.items.map(item => mergeItemPreferQuality(item, oldByKey.get(itemKey(item))));
    const combined = dedupeSort([...fresh, ...old.items]);
    const oldHadDeepHistory = old.items.length > result.items.length && Boolean(old.nextCursor);
    const nextCursor = initial && oldHadDeepHistory ? old.nextCursor : (result.nextCursor || '');
    const next = {
      username,
      items: combined,
      nextCursor,
      checkedAt: initial ? Date.now() : old.checkedAt,
      updatedAt: Date.now()
    };
    cacheRecords.set(username, next);
    pageCursors.set(username, nextCursor);
    await writeInstagramCache(next);
    return { old, next, fresh };
  };

  // Reveal one global page ordered by time. The old implementation revealed 12 items
  // PER ACCOUNT in one task (12 x account count), which could create hundreds of cards.
  const revealCachedPage = () => {
    const incoming = [];
    while (incoming.length < LOAD_MORE_RENDER_LIMIT) {
      let bestUsername = '';
      let bestItem = null;
      for (const [username, queue] of cacheQueues.entries()) {
        if (!Array.isArray(queue) || !queue.length) continue;
        const candidate = queue[0];
        if (!bestItem || itemTimestamp(candidate) > itemTimestamp(bestItem)) {
          bestItem = candidate;
          bestUsername = username;
        }
      }
      if (!bestItem || !bestUsername) break;
      const queue = cacheQueues.get(bestUsername) || [];
      incoming.push(queue.shift());
      cacheQueues.set(bestUsername, queue);
    }
    if (!incoming.length) return 0;
    return mergeItems(incoming, LOAD_MORE_RENDER_LIMIT);
  };

  const loadMore = async () => {
    if (loadMoreBusy || !isCurrent(generation) || !screen.isConnected || disposed) return;

    const cachedAdded = revealCachedPage();
    if (cachedAdded) {
      updateSentinel();
      observeSentinel(loadMore);
      return;
    }

    const allEntries = activeCursorEntries();
    if (!allEntries.length) return updateSentinel();

    // Only advance a few accounts per network turn. Rotate the starting account so a
    // large registration list remains fair without creating N simultaneous responses.
    const count = Math.min(NETWORK_ACCOUNT_BATCH, allEntries.length);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      entries.push(allEntries[(cursorBatchOffset + index) % allEntries.length]);
    }
    cursorBatchOffset = (cursorBatchOffset + count) % Math.max(1, allEntries.length);

    loadMoreBusy = true;
    updateSentinel('過去の投稿を読み込み中…');

    const results = await Promise.allSettled(entries.map(([username, cursor]) => fetchInstagramAccount(username, cursor)));
    if (!isCurrent(generation) || !screen.isConnected || disposed) return;

    const incoming = [];
    for (let index = 0; index < entries.length; index += 1) {
      const [username] = entries[index];
      const result = results[index];
      if (result.status === 'fulfilled') {
        incoming.push(...result.value.items);
        await persistNetworkPage(username, result.value, { initial: false });
      } else {
        console.warn('[instagram-load-more]', username, result.reason?.message || result.reason);
        pageCursors.set(username, '');
        const old = cacheRecords.get(username);
        if (old) {
          const next = { ...old, nextCursor: '', updatedAt: Date.now() };
          cacheRecords.set(username, next);
          writeInstagramCache(next).catch(() => {});
        }
      }
    }

    const added = mergeItems(incoming, LOAD_MORE_RENDER_LIMIT);
    syncAllQueues(entries.map(([username]) => username));
    loadMoreBusy = false;
    updateSentinel();
    if (added) {
      status.textContent = `${visibleItems.length}投稿を表示中`;
      setTimeout(() => {
        if (status.isConnected && isCurrent(generation) && !loadMoreBusy) status.textContent = '';
      }, 1200);
    }
    observeSentinel(loadMore);
  };

  const fetchInitialTargets = async (accounts, targets, serial, hadCache) => {
    if (!targets.length) return;
    if (!hadCache) {
      listHost.replaceChildren(el('div', {
        class: 'twitter-wake-status',
        style: 'margin:12px 14px;'
      }, [
        el('strong', { text: `${targets.length}アカウントを取得中…` }),
        el('span', { text: '取得できた投稿から順番に表示します' })
      ]));
      status.textContent = '更新中…';
    }

    let ok = 0;
    let newCount = 0;
    let processed = 0;
    let nextTargetIndex = 0;
    let progressiveStarted = hadCache;

    const stillCurrent = () => (
      isCurrent(generation) &&
      serial === refreshSerial &&
      screen.isConnected &&
      !disposed
    );

    const processAccount = async username => {
      let result;
      try {
        result = await fetchInstagramAccount(username);
      } catch (error) {
        if (stillCurrent()) console.warn('[instagram-account-fetch]', username, error?.message || error);
        return;
      } finally {
        processed += 1;
        if (stillCurrent()) status.textContent = `${Math.min(processed, targets.length)}/${targets.length}アカウントを取得中…`;
      }

      if (!stillCurrent()) return;
      ok += 1;
      const old = cacheRecords.get(username);
      const oldKeys = new Set((old?.items || []).map(itemKey));
      const persisted = await persistNetworkPage(username, result, { initial: true });
      if (!stillCurrent()) return;

      const newItems = persisted.fresh.filter(item => !oldKeys.has(itemKey(item)));
      newCount += newItems.length;
      const candidates = !old?.items?.length
        ? persisted.next.items.slice(0, INSTAGRAM_PAGE_SIZE)
        : newItems;

      if (candidates.length) {
        if (!progressiveStarted) {
          visibleItems = [];
          listHost.replaceChildren();
          progressiveStarted = true;
        }

        const firstPaint = !hadCache && visibleItems.length === 0;
        mergeItems(candidates, firstPaint ? FIRST_PAINT_RENDER_LIMIT : LOAD_MORE_RENDER_LIMIT);
        trimVisibleTail(hadCache ? INITIAL_RENDER_LIMIT + LOAD_MORE_RENDER_LIMIT : INITIAL_RENDER_LIMIT);
        syncAllQueues(accounts);
        updateSentinel();
      }

      // Let WebKit paint the account that just finished before this worker grabs another.
      await new Promise(resolve => window.setTimeout(resolve, 0));
    };

    const worker = async () => {
      while (stillCurrent()) {
        const index = nextTargetIndex;
        nextTargetIndex += 1;
        if (index >= targets.length) return;
        await processAccount(targets[index]);
      }
    };

    const workerCount = Math.min(NETWORK_ACCOUNT_BATCH, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (!stillCurrent()) return;
    // Anything fetched but not placed in the bounded DOM stays in per-account queues and
    // appears as the user scrolls, so limiting render work does not discard posts.
    syncAllQueues(accounts);

    if (!visibleItems.length) {
      listHost.replaceChildren(el('div', {
        style: 'margin:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--muted);line-height:1.55;'
      }, [
        el('strong', { text: 'Instagram投稿を取得できませんでした', style: 'display:block;color:var(--text-strong);margin-bottom:4px;' }),
        el('span', { text: '公開プロフィールか確認して、更新を試してください。' })
      ]));
      status.textContent = `0/${accounts.length}アカウント取得`;
      updateSentinel();
      return;
    }

    updateSentinel();
    observeSentinel(loadMore);
    if (hadCache) {
      status.textContent = newCount ? `新着${newCount}件を追加` : '';
    } else {
      status.textContent = `${ok}/${accounts.length}アカウント · ${visibleItems.length}投稿`;
    }
    if (status.textContent) setTimeout(() => {
      if (status.isConnected && isCurrent(generation) && !loadMoreBusy) status.textContent = '';
    }, 1400);
  };

  const refreshNow = async (force = false) => {
    const serial = ++refreshSerial;
    sentinelObserver?.disconnect();
    loadMoreBusy = false;
    cursorBatchOffset = 0;
    const accounts = instagramAccounts();
    await deleteInstagramCachesExcept(accounts).catch(() => {});
    if (!accounts.length) {
      visibleItems = [];
      cacheRecords = new Map();
      cacheQueues = new Map();
      pageCursors = new Map();
      listHost.replaceChildren(el('div', {
        style: 'margin:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--muted);line-height:1.55;'
      }, [
        el('strong', { text: 'Instagramアカウントを登録してください', style: 'display:block;color:var(--text-strong);margin-bottom:4px;' }),
        el('span', { text: '上部の＋から @username / username / profile URL を追加できます。' })
      ]));
      status.textContent = '';
      updateSentinel();
      return;
    }

    const loaded = await readInstagramCaches(accounts);
    if (!isCurrent(generation) || serial !== refreshSerial || disposed) return;
    cacheRecords = loaded;
    pageCursors = new Map();
    cacheQueues = new Map();

    const cachedInitial = [];
    accounts.forEach(username => {
      const record = cacheRecords.get(username);
      if (!record) return;
      cachedInitial.push(...record.items.slice(0, INSTAGRAM_PAGE_SIZE));
      pageCursors.set(username, record.nextCursor || '');
    });
    // Sort all accounts together, then render only a small global first page. The rest
    // remains in cacheQueues and is revealed in bounded chunks on scroll.
    replaceItems(cachedInitial, INITIAL_RENDER_LIMIT);
    syncAllQueues(accounts);

    const hadCache = visibleItems.length > 0;
    if (hadCache) {
      status.textContent = '';
      updateSentinel();
      observeSentinel(loadMore);
    }

    const targets = force
      ? accounts
      : accounts.filter(username => {
          const record = cacheRecords.get(username);
          return !record?.items?.length || !isInstagramCacheFresh(record, CACHE_FRESH_MS);
        });

    if (!targets.length) return;
    if (hadCache && !force) {
      setTimeout(() => {
        if (serial === refreshSerial && isCurrent(generation) && screen.isConnected && !disposed) {
          fetchInitialTargets(accounts, targets, serial, true).catch(error => console.warn('[instagram-background-refresh]', error));
        }
      }, 60);
      return;
    }
    await fetchInitialTargets(accounts, targets, serial, hadCache);
  };

  const dispose = () => {
    disposed = true;
    sentinelObserver?.disconnect();
    qualityQueue.clear();
    if (qualityTimer) {
      clearTimeout(qualityTimer);
      qualityTimer = 0;
    }
  };
  window.addEventListener('pdv2:before-navigate', dispose, { once: true });
  refreshNow(false).catch(error => {
    if (!isCurrent(generation) || disposed) return;
    console.error('[instagram-refresh]', error);
    status.textContent = 'Instagramを更新できませんでした';
  });
}
