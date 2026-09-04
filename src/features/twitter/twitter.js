import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { parseFeed } from '../../shared/rss.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { iconSvg } from '../../shared/icons.js';

const X_FEED = Object.freeze({
  name: 'X',
  id: '2087706843519111304',
  url: 'https://diygod-x.onrender.com/twitter/list/2087706843519111304'
});

let renderGeneration = 0;
let warmJob = null;

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const WARM_PREFIX = 'pdv2:twitterWarm:';
const MAX_WARM_XML = 420_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function feedUrl(feed) {
  return feed.url;
}

function proxied(url, timeout = 4500) {
  if (url.startsWith('/')) return url;
  const q = new URLSearchParams({ url, timeout: String(timeout) });
  return `/api/rss?${q}`;
}

function warmKey(feed) {
  return `${WARM_PREFIX}${feed.id}`;
}

function readWarmRecord(feed) {
  try {
    const cached = JSON.parse(localStorage.getItem(warmKey(feed)) || 'null');
    if (!cached?.xml) return null;
    return { at: Number(cached.at || 0), xml: cached.xml };
  } catch {
    return null;
  }
}

function autoRefreshDue(feed) {
  const cached = readWarmRecord(feed);
  return !cached?.xml || Date.now() - cached.at >= AUTO_REFRESH_MS;
}

function saveWarm(feed, xml) {
  if (!xml || xml.length > MAX_WARM_XML) return;
  try {
    localStorage.setItem(warmKey(feed), JSON.stringify({ at: Date.now(), xml }));
  } catch {}
}

async function fetchXml(feed, { timeout = 4500 } = {}) {
  const response = await fetch(proxied(feedUrl(feed), timeout), { cache: 'no-store' });
  if (!response.ok) throw new Error(`X RSS取得エラー (${response.status})`);
  const xml = await response.text();
  if (!xml.trim()) throw new Error('X RSSが空です');
  return xml;
}

async function warmFeedUntilSuccess(feed, { force = false } = {}) {
  if (!force && !autoRefreshDue(feed)) {
    return { feed: feed.name, cached: true, skipped: true };
  }

  while (true) {
    try {
      // Renderのcold start中は1回を長く待たず、5秒probe→5秒待機で起床を確認する。
      const xml = await fetchXml(feed, { timeout: 5000 });
      saveWarm(feed, xml);
      return { feed: feed.name, ok: true };
    } catch (error) {
      console.warn('[x-warm-retry]', error?.message || error);
      await sleep(5000);
    }
  }
}

function warmJobFor(feed, options = {}) {
  if (warmJob) return warmJob;

  const job = warmFeedUntilSuccess(feed, options).finally(() => {
    if (warmJob === job) warmJob = null;
  });
  warmJob = job;
  return job;
}

export async function warmTwitterFeeds({ force = false } = {}) {
  if (!force && !autoRefreshDue(X_FEED)) return [];
  return Promise.all([warmJobFor(X_FEED, { force })]);
}

function attachPullToRefresh(screen, indicator, onRefresh) {
  let startY = null;
  let startX = null;
  let distance = 0;
  let tracking = false;
  let refreshing = false;
  const trigger = 82;

  const scrollTop = () => Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));

  const reset = () => {
    startY = null;
    startX = null;
    distance = 0;
    tracking = false;
    indicator.classList.remove('pulling', 'ready');
    indicator.style.setProperty('--pull', '0px');
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = '下に引いて更新';
  };

  const onTouchStart = event => {
    if (refreshing || event.touches.length !== 1 || scrollTop() > 1) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    distance = 0;
    tracking = true;
  };

  const onTouchMove = event => {
    if (!tracking || refreshing || startY == null || event.touches.length !== 1) return;
    const raw = event.touches[0].clientY - startY;
    const dx = startX == null ? 0 : event.touches[0].clientX - startX;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(raw) * 1.15) {
      reset();
      return;
    }
    if (raw <= 0 || scrollTop() > 1) {
      reset();
      return;
    }

    distance = raw;
    const visual = Math.min(64, raw * 0.48);
    indicator.classList.add('pulling');
    indicator.classList.toggle('ready', raw >= trigger);
    indicator.style.setProperty('--pull', `${visual}px`);
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = raw >= trigger ? '指を離して更新' : '下に引いて更新';
    if (raw > 8 && event.cancelable) event.preventDefault();
  };

  const onTouchEnd = () => {
    if (!tracking || refreshing) return;
    const shouldRefresh = distance >= trigger && scrollTop() <= 1;
    if (!shouldRefresh) {
      reset();
      return;
    }

    refreshing = true;
    tracking = false;
    indicator.classList.remove('ready');
    indicator.classList.add('pulling', 'refreshing');
    indicator.style.setProperty('--pull', '48px');
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = '更新中…';

    Promise.resolve(onRefresh()).finally(() => {
      refreshing = false;
      indicator.classList.remove('refreshing');
      reset();
    });
  };

  screen.addEventListener('touchstart', onTouchStart, { passive: true });
  screen.addEventListener('touchmove', onTouchMove, { passive: false });
  screen.addEventListener('touchend', onTouchEnd, { passive: true });
  screen.addEventListener('touchcancel', reset, { passive: true });

  return () => {
    screen.removeEventListener('touchstart', onTouchStart);
    screen.removeEventListener('touchmove', onTouchMove);
    screen.removeEventListener('touchend', onTouchEnd);
    screen.removeEventListener('touchcancel', reset);
  };
}

function isTwitterUrl(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function normalizeTweetImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^https?:$/.test(url.protocol)) return '';

    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    const isTweetPhoto =
      (host === 'pbs.twimg.com' || host.endsWith('.twimg.com')) &&
      /^\/media\//i.test(path);
    if (!isTweetPhoto) return '';

    if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    return url.href;
  } catch {
    return '';
  }
}

function normalizeProfileImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^https?:$/.test(url.protocol)) return '';
    const host = url.hostname.toLowerCase();
    if (!(host === 'pbs.twimg.com' || host.endsWith('.twimg.com'))) return '';
    if (!/^\/profile_images\//i.test(url.pathname)) return '';
    url.searchParams.delete('name');
    return url.href.replace(/_(?:normal|bigger|mini)(?=\.[a-z0-9]+(?:$|\?))/i, '_200x200');
  } catch {
    return '';
  }
}

function youtubeVideoIdFromUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return '';
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v') || '';
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
    }
    const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function nestedMarkupSources(html = '') {
  const sources = [];
  let current = String(html || '').trim();
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (!sources.includes(current)) sources.push(current);
    const doc = new DOMParser().parseFromString(`<div>${current}</div>`, 'text/html');
    const decoded = String(doc.body?.textContent || '').trim();
    if (!decoded || decoded === current || !/<(?:img|video|source|a|blockquote)\b/i.test(decoded)) break;
    current = decoded;
  }
  return sources;
}

function tweetImageIdentity(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    if (!(host === 'pbs.twimg.com' || host.endsWith('.twimg.com'))) return '';
    if (!/^\/media\//i.test(url.pathname)) return '';

    const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.(?:jpe?g|png|webp|gif|avif)$/i, '')
      .trim()
      .toLowerCase();
    if (!leaf) return '';
    return `twitter-photo:${leaf}`;
  } catch {
    return '';
  }
}

function normalizeTweetVideoUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^https?:$/.test(url.protocol)) return '';

    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isTwitterVideoHost =
      host === 'video.twimg.com' ||
      (host.endsWith('.twimg.com') && host !== 'pbs.twimg.com');

    if (!isTwitterVideoHost) return '';
    if (!/\.(?:mp4|m3u8|webm|mov)$/i.test(path) && !/\/(?:vid|pl|tweet_video)\//i.test(path)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function tweetVideoIdentity(value = '') {
  const normalized = normalizeTweetVideoUrl(value);
  if (!normalized) return '';

  try {
    const url = new URL(normalized);
    const path = decodeURIComponent(url.pathname);

    const idMatch = path.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//i);
    if (idMatch?.[1]) return `twitter-video:${idMatch[1]}`;

    const tweetVideo = path.match(/\/tweet_video\/([^/?#.]+)/i);
    if (tweetVideo?.[1]) {
      return `twitter-video:${tweetVideo[1].replace(/\.(?:mp4|m3u8|webm|mov)$/i, '').toLowerCase()}`;
    }

    return `twitter-video:${path
      .replace(/\/vid\/(?:[^/]+\/)?\d+x\d+\//i, '/vid/')
      .replace(/\.(?:mp4|m3u8|webm|mov)$/i, '')
      .toLowerCase()}`;
  } catch {
    return normalized.toLowerCase();
  }
}

function videoVariantScore(value = '') {
  const normalized = normalizeTweetVideoUrl(value);
  if (!normalized) return -1;

  try {
    const url = new URL(normalized);
    const path = url.pathname;
    const resolution = path.match(/\/vid\/(?:[^/]+\/)?(\d+)x(\d+)\//i);
    const area = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;

    if (/\.mp4$/i.test(path)) return 1_000_000_000 + area;
    if (/\.m3u8$/i.test(path)) return 500_000_000 + area;
    if (/\.webm$/i.test(path)) return 300_000_000 + area;
    return 100_000_000 + area;
  } catch {
    return 0;
  }
}

function normalizeTweetVideoPosterUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^https?:$/.test(url.protocol)) return '';

    const host = url.hostname.toLowerCase();
    if (!(host === 'pbs.twimg.com' || host.endsWith('.twimg.com'))) return '';

    const path = url.pathname;
    if (!/^\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//i.test(path)) return '';

    if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    return url.href;
  } catch {
    return '';
  }
}

function cleanDescription(html) {
  const sources = nestedMarkupSources(html);
  const images = [];
  const videos = [];
  const videoPosters = [];
  const links = [];
  const avatars = [];
  const youtubeIds = [];
  let visibleText = '';

  sources.forEach((source, sourceIndex) => {
    const doc = new DOMParser().parseFromString(`<div>${source || ''}</div>`, 'text/html');

    for (const video of doc.querySelectorAll('video')) {
      videos.push(video.getAttribute('src'));
      videoPosters.push(video.getAttribute('poster'));
      video.querySelectorAll('source[src]').forEach(node => videos.push(node.getAttribute('src')));
    }
    doc.querySelectorAll('source[src]').forEach(node => videos.push(node.getAttribute('src')));

    for (const image of doc.querySelectorAll('img')) {
      const candidates = [
        image.getAttribute('src'),
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-lazy-src')
      ].filter(Boolean);

      for (const candidate of candidates) {
        const avatar = normalizeProfileImageUrl(candidate);
        if (avatar) avatars.push(avatar);

        const poster = normalizeTweetVideoPosterUrl(candidate);
        if (poster) videoPosters.push(poster);

        const photo = normalizeTweetImageUrl(candidate);
        if (photo) images.push(photo);
      }
    }

    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = anchor.href || anchor.getAttribute('href') || '';
      const yt = youtubeVideoIdFromUrl(href);
      if (yt) youtubeIds.push(yt);
      if (normalizeTweetVideoUrl(href)) videos.push(href);
      if (/^https?:/i.test(href) && !isTwitterUrl(href) && !normalizeTweetVideoUrl(href)) links.push(href);
    }

    const sourceText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    if (sourceIndex === 0) visibleText = sourceText;

    for (const match of sourceText.matchAll(/https?:\/\/[^\s<]+/gi)) {
      const raw = match[0].replace(/[),.!?。、「」]+$/, '');
      const yt = youtubeVideoIdFromUrl(raw);
      if (yt) youtubeIds.push(yt);
    }
  });

  return {
    text: visibleText,
    images: [...new Set(images)].slice(0, 8),
    videos: [...new Set(videos.map(normalizeTweetVideoUrl).filter(Boolean))].slice(0, 12),
    videoPosters: [...new Set(videoPosters.map(normalizeTweetVideoPosterUrl).filter(Boolean))].slice(0, 12),
    links: [...new Set(links)],
    avatar: [...new Set(avatars)][0] || '',
    youtubeIds: [...new Set(youtubeIds)].slice(0, 3)
  };
}

function tweetImages(item, clean) {
  const candidates = [
    ...(Array.isArray(clean?.images) ? clean.images : []),
    ...(Array.isArray(item?.images) ? item.images : []),
    item?.image
  ];

  const seen = new Set();
  const images = [];
  for (const candidate of candidates) {
    const url = normalizeTweetImageUrl(candidate);
    const identity = tweetImageIdentity(url);
    if (!url || !identity || seen.has(identity)) continue;
    seen.add(identity);
    images.push(url);
    if (images.length >= 4) break;
  }
  return images;
}

function tweetVideos(item, clean) {
  const candidates = [
    ...(Array.isArray(clean?.videos) ? clean.videos : []),
    ...(Array.isArray(item?.videos) ? item.videos : []),
    item?.video
  ];

  const bestByVideo = new Map();

  for (const candidate of candidates) {
    const url = normalizeTweetVideoUrl(candidate);
    const identity = tweetVideoIdentity(url);
    if (!url || !identity) continue;

    const current = bestByVideo.get(identity);
    if (!current || videoVariantScore(url) > videoVariantScore(current)) {
      bestByVideo.set(identity, url);
    }
  }

  return [...bestByVideo.values()].slice(0, 4);
}

function tweetVideoPosters(item, clean) {
  const candidates = [
    ...(Array.isArray(clean?.videoPosters) ? clean.videoPosters : []),
    ...(Array.isArray(item?.videoPosters) ? item.videoPosters : []),
    ...(Array.isArray(item?.images) ? item.images : []),
    item?.image
  ];

  return [...new Set(
    candidates.map(normalizeTweetVideoPosterUrl).filter(Boolean)
  )].slice(0, 4);
}

function syncTweetImageGrid(grid) {
  if (!grid) return;
  const count = grid.querySelectorAll('.tweet-image-button').length;
  grid.classList.remove('count-1', 'count-2', 'count-3', 'count-4');
  if (count > 0) grid.classList.add(`count-${Math.min(4, count)}`);
  if (count === 0) grid.remove();
}

function isRetweet(item, clean) {
  const text = `${clean?.text || ''} ${item?.title || ''}`.trim();
  return /^RT(?:\s|:|@)/i.test(text);
}

function appendLinkified(container, text) {
  const regex = /(https?:\/\/[^\s<]+)/gi;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
    const url = match[0].replace(/[),.!?。、「」]+$/, '');
    const suffix = match[0].slice(url.length);
    const anchor = el('a', { class: 'tweet-inline-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url });
    anchor.addEventListener('click', event => event.stopPropagation());
    container.append(anchor);
    if (suffix) container.append(document.createTextNode(suffix));
    last = match.index + match[0].length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function tweetAuthor(item, clean) {
  const direct = String(item?.author || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  if (direct) return direct;
  const candidates = [String(item?.title || ''), String(clean?.text || '')];
  for (const value of candidates) {
    const match = value.match(/^\s*([^:：]{1,50}?(?:\s*\(@[A-Za-z0-9_]+\)|\s+@[A-Za-z0-9_]+))\s*[:：]/);
    if (match?.[1]) return match[1].trim();
    const handle = value.match(/^\s*(@[A-Za-z0-9_]{1,20})\b/);
    if (handle?.[1]) return handle[1];
  }
  return item?.feedName || item?.source || 'Twitter / X';
}

function makeTweetAuthorAvatar(author, avatarUrl = '') {
  const fallback = String(author).replace(/^@/, '').slice(0, 1).toUpperCase() || 'X';
  const avatar = el('div', { class: 'tweet-author-avatar', text: avatarUrl ? '' : fallback });

  if (avatarUrl) {
    const image = el('img', {
      class: 'tweet-author-avatar-image',
      src: avatarUrl,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer'
    });
    image.addEventListener('error', () => {
      image.remove();
      avatar.textContent = fallback;
    }, { once: true });
    avatar.append(image);
  }

  return avatar;
}

function makeTweetYouTubeCard(videoId) {
  const card = el('div', { class: 'tweet-youtube-card' });
  const launcher = el('button', {
    class: 'tweet-youtube-launcher',
    type: 'button',
    'aria-label': 'YouTube動画を再生'
  });
  launcher.append(el('img', {
    src: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    alt: '',
    loading: 'lazy',
    decoding: 'async'
  }));

  launcher.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const iframe = el('iframe', {
      class: 'tweet-youtube-frame',
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0`,
      title: 'YouTube video player',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowfullscreen: 'true',
      referrerpolicy: 'strict-origin-when-cross-origin'
    });
    card.replaceChildren(iframe);
  });

  card.append(launcher);
  return card;
}

let xWidgetsPromise = null;

function canPlayNativeHls(video) {
  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl') ||
    video.canPlayType('application/x-mpegURL')
  );
}

function tweetIdOf(item) {
  const values = [
    item?.link,
    item?.guid,
    item?.id,
    item?.rawDescription,
    item?.description,
    item?.title
  ];
  for (const value of values) {
    const match = String(value || '').match(/(?:x\.com|twitter\.com)\/[^\s/?#]+\/status(?:es)?\/(\d{5,})/i)
      || String(value || '').match(/\/status(?:es)?\/(\d{5,})/i);
    if (match?.[1]) return match[1];
  }
  return '';
}

function canonicalPostUrl(item) {
  const id = tweetIdOf(item);
  if (id) return `https://x.com/i/status/${id}`;
  try {
    const url = new URL(String(item?.link || ''));
    if (url.hostname === 'twitter.com' || url.hostname.endsWith('.twitter.com')) {
      url.hostname = 'x.com';
    }
    return url.href;
  } catch {
    return String(item?.link || 'https://x.com/');
  }
}

function proxyVideoUrl(mediaUrl, { probe = false } = {}) {
  const params = new URLSearchParams({ url: mediaUrl });
  if (probe) params.set('probe', '1');
  params.set('mode', 'twitter-video');
  return `/api/rss?${params}`;
}

function xEmbedTheme() {
  const explicit = document.documentElement.dataset.theme || document.body?.dataset?.theme || '';
  if (/light/i.test(explicit) || document.body?.classList?.contains('light')) return 'light';
  return 'dark';
}

function loadXWidgets() {
  if (window.twttr?.widgets?.createTweet) return Promise.resolve(window.twttr);
  if (xWidgetsPromise) return xWidgetsPromise;

  xWidgetsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-pdv2-x-widgets="1"]');
    const finish = () => {
      const started = Date.now();
      const poll = () => {
        if (window.twttr?.widgets?.createTweet) return resolve(window.twttr);
        if (Date.now() - started > 6000) return reject(new Error('X widgets.js timeout'));
        setTimeout(poll, 80);
      };
      poll();
    };

    if (existing) {
      if (window.twttr?.widgets?.createTweet) resolve(window.twttr);
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', () => reject(new Error('X widgets.js failed')), { once: true });
        finish();
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://platform.x.com/widgets.js';
    script.async = true;
    script.charset = 'utf-8';
    script.dataset.pdv2XWidgets = '1';
    script.referrerPolicy = 'no-referrer';
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error('X widgets.js failed')), { once: true });
    document.head.append(script);
  }).catch(error => {
    xWidgetsPromise = null;
    throw error;
  });

  return xWidgetsPromise;
}

function waitForVideo(video, src, { timeout = 3200 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ['loadedmetadata', 'loadeddata', 'canplay', 'error', 'stalled', 'abort'].forEach(type => {
        video.removeEventListener(type, handlers[type]);
      });
      if (ok) resolve();
      else reject(error || new Error('video load failed'));
    };
    const handlers = {
      loadedmetadata: () => finish(true),
      loadeddata: () => finish(true),
      canplay: () => finish(true),
      error: () => finish(false, new Error('media error')),
      stalled: () => {
        if (video.readyState === 0) finish(false, new Error('media stalled'));
      },
      abort: () => finish(false, new Error('media aborted'))
    };
    const timer = setTimeout(() => finish(false, new Error('media timeout')), timeout);
    Object.entries(handlers).forEach(([type, handler]) => video.addEventListener(type, handler));
    try {
      video.src = src;
      video.load();
    } catch (error) {
      finish(false, error);
    }
  });
}

async function probeProxy(mediaUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(proxyVideoUrl(mediaUrl, { probe: true }), {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`proxy probe ${response.status}`);
    const data = await response.json().catch(() => ({}));
    if (data?.ok === false) throw new Error('proxy probe rejected');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function tryOfficialEmbed(item, container) {
  const tweetId = tweetIdOf(item);
  if (!tweetId) throw new Error('Tweet ID not found');
  const twttr = await loadXWidgets();

  const renderPromise = twttr.widgets.createTweet(tweetId, container, {
    theme: xEmbedTheme(),
    conversation: 'none',
    cards: 'visible',
    align: 'center',
    dnt: true,
    lang: 'ja'
  });

  const result = await Promise.race([
    Promise.resolve(renderPromise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('X embed timeout')), 7000))
  ]);
  if (!result) throw new Error('X embed unavailable');
  return result;
}

function makeVideoLauncher(poster = '') {
  const button = el('button', {
    class: 'tweet-video-launcher',
    type: 'button',
    'aria-label': '動画を再生'
  });

  if (poster) {
    const image = el('img', {
      class: 'tweet-video-launcher-poster',
      src: poster,
      alt: '',
      loading: 'lazy',
      decoding: 'async'
    });
    image.addEventListener('error', () => image.remove(), { once: true });
    button.append(image);
  }

  button.append(
    el('span', { class: 'tweet-video-launcher-shade', 'aria-hidden': 'true' }),
    el('span', { class: 'tweet-video-play-circle', 'aria-hidden': 'true' }, [
      el('span', { class: 'tweet-video-play-triangle' })
    ])
  );
  return button;
}

function setLauncherResolving(launcher, resolving) {
  if (!launcher) return;
  launcher.disabled = Boolean(resolving);
  launcher.classList.toggle('is-resolving', Boolean(resolving));
  launcher.setAttribute('aria-label', resolving ? '再生方法を確認中' : '動画を再生');
}

function makePlayableVideo(poster = '') {
  const video = document.createElement('video');
  video.className = 'tweet-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('referrerpolicy', 'no-referrer');
  if (poster) video.poster = poster;
  return video;
}

function cleanupVideo(video) {
  try { video.pause(); } catch {}
  try { video.removeAttribute('src'); video.load(); } catch {}
}

function startVideoPlayback(video) {
  const playResult = video.play?.();
  if (playResult?.catch) playResult.catch(() => {});
}

function openTweetExternally(item) {
  window.location.assign(canonicalPostUrl(item));
}

async function resolveTweetVideoFromClick(shell, item, mediaUrl, poster) {
  const launcher = shell.querySelector('.tweet-video-launcher');
  const stage = shell.querySelector('.tweet-video-stage');
  const embed = shell.querySelector('.tweet-official-embed');
  if (!launcher || !stage || !embed) return;

  setLauncherResolving(launcher, true);

  const revealVideo = (video, methodLabel) => {
    if (!shell.isConnected) return false;
    launcher.hidden = true;
    embed.hidden = true;
    embed.classList.remove('tweet-official-embed-probing');
    stage.hidden = false;
    stage.replaceChildren(video, el('span', { class: 'tweet-video-method-badge', text: methodLabel }));
    startVideoPlayback(video);
    return true;
  };

  const path = (() => {
    try { return new URL(mediaUrl).pathname.toLowerCase(); }
    catch { return ''; }
  })();

  const directVideo = makePlayableVideo(poster);
  if (!/\.m3u8$/i.test(path) || canPlayNativeHls(directVideo)) {
    try {
      await waitForVideo(directVideo, mediaUrl, { timeout: 2600 });
      if (revealVideo(directVideo, 'CDN直接再生')) return;
    } catch {}
  }
  cleanupVideo(directVideo);

  const proxyVideo = makePlayableVideo(poster);
  try {
    await probeProxy(mediaUrl);
    await waitForVideo(proxyVideo, proxyVideoUrl(mediaUrl), { timeout: 4600 });
    if (revealVideo(proxyVideo, 'プロキシ再生')) return;
  } catch {}
  cleanupVideo(proxyVideo);

  try {
    embed.hidden = false;
    embed.classList.add('tweet-official-embed-probing');
    await tryOfficialEmbed(item, embed);
    if (!shell.isConnected) return;
    stage.hidden = true;
    launcher.hidden = true;
    embed.classList.remove('tweet-official-embed-probing');
    embed.hidden = false;
    return;
  } catch {
    embed.replaceChildren();
    embed.hidden = true;
    embed.classList.remove('tweet-official-embed-probing');
  }

  if (shell.isConnected) openTweetExternally(item);
}

function makeTweetVideo(item, mediaUrl, poster = '') {
  const shell = el('div', { class: 'tweet-video-shell tweet-video-resolver' });
  const launcher = makeVideoLauncher(poster);
  const stage = el('div', { class: 'tweet-video-stage' });
  const embed = el('div', { class: 'tweet-official-embed' });
  stage.hidden = true;
  embed.hidden = true;
  shell.append(launcher, stage, embed);

  launcher.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (launcher.disabled) return;
    resolveTweetVideoFromClick(shell, item, mediaUrl, poster).catch(() => {
      if (shell.isConnected) openTweetExternally(item);
    });
  });

  return shell;
}

function makeExternalOnlyVideo(item, poster = '') {
  const shell = el('div', { class: 'tweet-video-shell external-only tweet-video-resolver' });
  const launcher = makeVideoLauncher(poster);
  const embed = el('div', { class: 'tweet-official-embed' });
  embed.hidden = true;
  shell.append(launcher, embed);

  launcher.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (launcher.disabled) return;
    setLauncherResolving(launcher, true);

    try {
      embed.hidden = false;
      embed.classList.add('tweet-official-embed-probing');
      await tryOfficialEmbed(item, embed);
      if (!shell.isConnected) return;
      launcher.hidden = true;
      embed.classList.remove('tweet-official-embed-probing');
      embed.hidden = false;
    } catch {
      embed.replaceChildren();
      embed.hidden = true;
      embed.classList.remove('tweet-official-embed-probing');
      if (shell.isConnected) openTweetExternally(item);
    }
  });

  return shell;
}

function tweetCard(item) {
  const clean = cleanDescription(item.rawDescription || item.description);
  const images = tweetImages(item, clean);
  const videos = tweetVideos(item, clean);
  const videoPosters = tweetVideoPosters(item, clean);
  const hasVideoMedia = videos.length > 0 || videoPosters.length > 0;

  if (isRetweet(item, clean)) return null;

  const card = el('article', { class: 'tweet-card' });
  const author = tweetAuthor(item, clean);
  card.append(el('div', { class: 'tweet-author-row' }, [
    makeTweetAuthorAvatar(author, clean.avatar),
    el('strong', { class: 'tweet-author-name', text: author })
  ]));

  const rawTitle = String(item?.title || '').trim();
  const titleIsPlaceholder = /^(?:無題|untitled|no\s*title|\(no\s*title\))$/i.test(rawTitle);
  const displayText = clean.text || (!images.length && !hasVideoMedia && !titleIsPlaceholder ? rawTitle : '');

  if (displayText) {
    const text = el('div', { class: 'tweet-text' });
    appendLinkified(text, displayText);
    card.append(text);
  } else if (images.length && !hasVideoMedia) {
    card.classList.add('tweet-card-photo-only');
  } else if (hasVideoMedia) {
    card.classList.add('tweet-card-media-only');
  }

  if (videos.length) {
    const stack = el('div', { class: 'tweet-video-stack' });
    videos.forEach((src, index) => {
      stack.append(makeTweetVideo(item, src, videoPosters[index] || videoPosters[0] || ''));
    });
    card.append(stack);
  } else if (videoPosters.length) {
    card.append(makeExternalOnlyVideo(item, videoPosters[0]));
  }

  if (images.length) {
    const grid = el('div', { class: `tweet-images count-${Math.min(4, images.length)}` });
    images.forEach(src => {
      const button = el('button', { class: 'tweet-image-button', type: 'button', 'aria-label': '画像を拡大' });
      const image = el('img', { src, alt: '投稿画像', loading: 'lazy', decoding: 'async' });

      image.addEventListener('error', () => {
        button.remove();
        syncTweetImageGrid(grid);
      }, { once: true });

      button.append(image);
      button.onclick = () => {
        const visibleImages = [...grid.querySelectorAll('.tweet-image-button img')]
          .filter(img => img.complete && img.naturalWidth > 0)
          .map(img => img.currentSrc || img.src)
          .filter(Boolean);
        const current = image.currentSrc || image.src;
        const index = Math.max(0, visibleImages.indexOf(current));
        if (visibleImages.length) openImageViewer(visibleImages, index);
      };
      grid.append(button);
    });
    card.append(grid);
  }

  if (clean.youtubeIds?.length) {
    const youtubeStack = el('div', { class: 'tweet-youtube-stack' });
    clean.youtubeIds.forEach(videoId => youtubeStack.append(makeTweetYouTubeCard(videoId)));
    card.append(youtubeStack);
  }

  const extra = [...new Set(clean.links)]
    .filter(url => !clean.text.includes(url))
    .filter(url => !normalizeTweetVideoUrl(url))
    .filter(url => !youtubeVideoIdFromUrl(url));
  if (extra.length) {
    const links = el('div', { class: 'tweet-external-links' });
    extra.forEach(url => links.append(el('a', {
      class: 'tweet-external-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url
    })));
    card.append(links);
  }

  card.append(el('div', { class: 'tweet-footer' }, [
    el('span', { class: 'media-meta', text: shortDate(item.pubDate) }),
    el('a', { class: 'tweet-open-x', href: item.link, target: '_blank', rel: 'noopener noreferrer', text: 'Xで開く ↗' })
  ]));
  return card;
}

export async function renderTwitter(root, { navigate, refresh = false }) {
  const generation = ++renderGeneration;
  const feed = X_FEED;
  const screen = el('section', { class: 'screen' });

  screen.append(topbar('X', {
    subtitle: 'タイムライン',
    actions: [
      { label: '↻', title: '更新', onClick: () => renderTwitter(root, { navigate, refresh: true }) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const pullIndicator = el('div', { class: 'twitter-pull-refresh', 'aria-hidden': 'true' }, [
    el('span', { class: 'twitter-pull-spinner', text: '↻' }),
    el('span', { class: 'twitter-pull-label', text: '下に引いて更新' })
  ]);
  const host = el('div', { class: 'twitter-feed-host' });
  screen.append(pullIndicator, host);
  root.replaceChildren(screen);

  attachPullToRefresh(screen, pullIndicator, () => renderTwitter(root, { navigate, refresh: true }));

  const draw = items => {
    if (generation !== renderGeneration) return;
    const cards = (items || []).map(tweetCard).filter(Boolean);
    host.replaceChildren(...(cards.length
      ? cards
      : [el('div', { class: 'empty', text: '表示できる投稿がありません' })]));
  };

  try {
    const cached = !refresh ? readWarmRecord(feed) : null;

    if (cached?.xml) {
      draw(parseFeed(cached.xml, feed.name));

      const redrawAfterWarm = job => job.then(() => {
        if (generation !== renderGeneration) return;
        const fresh = readWarmRecord(feed);
        if (fresh?.xml) draw(parseFeed(fresh.xml, feed.name));
      }).catch(() => {});

      // 起動時の強制warmが既に走っている場合は、15分キャッシュ判定より優先して完了を画面へ反映する。
      if (warmJob) {
        redrawAfterWarm(warmJob);
        return;
      }

      if (!autoRefreshDue(feed)) return;
      redrawAfterWarm(warmJobFor(feed, { force: false }));
      return;
    }

    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: refresh ? 'Xを更新しています…' : 'Xを読み込み中…' }),
      el('span', { text: '取得できない場合は5秒空けて再確認します' })
    ]));

    await warmJobFor(feed, { force: refresh });
    if (generation !== renderGeneration) return;

    const fresh = readWarmRecord(feed);
    if (!fresh?.xml) throw new Error('RSSが空です');
    draw(parseFeed(fresh.xml, feed.name));
  } catch (err) {
    if (generation !== renderGeneration) return;
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
