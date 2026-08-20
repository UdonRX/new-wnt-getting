import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, collectionManager, centerScrollItem } from '../../shared/components.js';
import { parseFeed } from '../../shared/rss.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { iconSvg } from '../../shared/icons.js';

let selected = Number(localStorage.getItem('pdv2:twitterIndex') || 0);
let renderGeneration = 0;

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const WARM_PREFIX = 'pdv2:twitterWarm:';
const MAX_WARM_XML = 420_000;
const warmJobs = new Map();
let warmActive = 0;
const warmWaiters = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function feedUrl(feed) {
  if (feed.url) return feed.url;
  return `${state.settings.twitterRssBase}${feed.id}`;
}

function proxied(url, timeout = 4500) {
  if (url.startsWith('/')) return url;
  const q = new URLSearchParams({ url, timeout: String(timeout) });
  return `/api/rss?${q}`;
}

function warmKey(feed) {
  return `${WARM_PREFIX}${feed.id || feed.url || feed.name}`;
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

function readWarm(feed) {
  const cached = readWarmRecord(feed);
  if (!cached?.xml) return '';
  if (Date.now() - cached.at >= AUTO_REFRESH_MS) return '';
  return cached.xml;
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
  if (!response.ok) throw new Error(`Twitter RSS取得エラー (${response.status})`);
  const xml = await response.text();
  if (!xml.trim()) throw new Error('Twitter RSSが空です');
  return xml;
}

async function withWarmSlot(worker) {
  if (warmActive >= 2) await new Promise(resolve => warmWaiters.push(resolve));
  warmActive += 1;
  try {
    return await worker();
  } finally {
    warmActive = Math.max(0, warmActive - 1);
    warmWaiters.shift()?.();
  }
}

async function warmFeedUntilSuccess(feed, { force = false } = {}) {
  if (!force && !autoRefreshDue(feed)) {
    return { feed: feed.name, cached: true, skipped: true };
  }

  while (true) {
    try {
      const xml = await withWarmSlot(() => fetchXml(feed, { timeout: 12000 }));
      saveWarm(feed, xml);
      return { feed: feed.name, ok: true };
    } catch (error) {
      console.warn('[twitter-warm-retry]', feed.name, error?.message || error);
      await sleep(5000);
    }
  }
}

function warmJobFor(feed, options = {}) {
  const key = warmKey(feed);
  const existing = warmJobs.get(key);
  if (existing) return existing;

  const job = warmFeedUntilSuccess(feed, options).finally(() => {
    if (warmJobs.get(key) === job) warmJobs.delete(key);
  });
  warmJobs.set(key, job);
  return job;
}

export async function warmTwitterFeeds({ force = false } = {}) {
  const feeds = Array.isArray(state.twitterFeeds)
    ? state.twitterFeeds.filter(feed => feed?.id || feed?.url)
    : [];
  if (!feeds.length) return [];

  const targets = force
    ? feeds.slice(0, 8)
    : feeds.slice(0, 8).filter(autoRefreshDue);

  if (!targets.length) return [];
  return Promise.all(targets.map(feed => warmJobFor(feed, { force })));
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

function manage(onDone) {
  let sheet;
  sheet = openSheet(collectionManager({
    items: state.twitterFeeds,
    fields: [
      { key: 'name', label: 'タブ名', placeholder: 'リスト名' },
      { key: 'id', label: 'Twitter/X リストID', placeholder: '2087...' },
      { key: 'url', label: 'RSS URL（任意）', placeholder: '空ならRSSHubを使用' }
    ],
    onSave: draft => {
      update('twitterFeeds', draft);
      sheet.close();
      selected = 0;
      onDone();
      warmTwitterFeeds({ force: true }).catch(() => {});
    }
  }), { title: 'Twitterリスト編集' });
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

    // v2.14.9: Twitter/X投稿の「写真」だけを対象にする。
    // profile画像・OG画像・動画サムネイル等が混ざると、実際の投稿枚数より多く見えるため除外。
    const isTweetPhoto =
      (host === 'pbs.twimg.com' || host.endsWith('.twimg.com')) &&
      /^\/media\//i.test(path);
    if (!isTweetPhoto) return '';

    // small/thumb違いは同じ写真なので表示URLはlargeへ寄せる。
    if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    return url.href;
  } catch {
    return '';
  }
}

function tweetImageIdentity(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    if (!(host === 'pbs.twimg.com' || host.endsWith('.twimg.com'))) return '';
    if (!/^\/media\//i.test(url.pathname)) return '';

    // 同一写真が
    // /media/ABC.jpg
    // /media/ABC?format=jpg&name=small
    // /media/ABC?format=jpg&name=large
    // のように複数表現されても、画像ID「ABC」で1枚にまとめる。
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

    // MP4を第一候補。iPhone/SafariはHLSも直接再生できるが、
    // MP4の方が他ブラウザでもそのまま扱いやすい。
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
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');

  const videos = [
    ...[...doc.querySelectorAll('video[src]')].map(node => node.getAttribute('src')),
    ...[...doc.querySelectorAll('video source[src], source[src]')].map(node => node.getAttribute('src')),
    ...[...doc.querySelectorAll('a[href]')].map(node => node.getAttribute('href'))
  ]
    .map(normalizeTweetVideoUrl)
    .filter(Boolean);

  const videoPosters = [
    ...[...doc.querySelectorAll('video[poster]')].map(node => node.getAttribute('poster')),
    ...[...doc.querySelectorAll('img')].flatMap(image => [
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
      image.getAttribute('data-lazy-src')
    ])
  ]
    .map(normalizeTweetVideoPosterUrl)
    .filter(Boolean);

  doc.querySelectorAll('script,style,iframe,video,source').forEach(node => node.remove());

  const images = [...doc.querySelectorAll('img')]
    .flatMap(image => [
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
      image.getAttribute('data-lazy-src')
    ])
    .map(normalizeTweetImageUrl)
    .filter(Boolean)
    .filter(src => /twimg\.com|pbs\.twimg|twitter\.com/i.test(src));

  const links = [...doc.querySelectorAll('a[href]')]
    .map(anchor => anchor.href)
    .filter(href =>
      /^https?:/i.test(href) &&
      !isTwitterUrl(href) &&
      !normalizeTweetVideoUrl(href)
    );

  doc.querySelectorAll('img').forEach(node => node.remove());
  return {
    text: (doc.body.textContent || '').replace(/\s+/g, ' ').trim(),
    images: [...new Set(images)].slice(0, 4),
    videos: [...new Set(videos)].slice(0, 12),
    videoPosters: [...new Set(videoPosters)].slice(0, 12),
    links: [...new Set(links)]
  };
}

function tweetImages(item, clean) {
  // 本文HTML内の画像を最優先。RSSHubのmedia:thumbnail等には
  // 同じ写真の別サイズや投稿画像ではないサムネイルが混ざる場合がある。
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

  // Xは同じ動画を複数解像度のMP4 + HLSで返すことがある。
  // 動画IDごとに、インライン再生しやすい最大解像度MP4を優先して1本へ集約。
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

const TWITTER_VIDEO_DIRECT_FAILURE_LIMIT = 2;
let twitterVideoDirectFailures = 0;
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
  return `/api/twitter-video-proxy?${params}`;
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

function makeVideoStatus(poster = '') {
  const status = el('div', { class: 'tweet-video-status' });
  if (poster) {
    const image = el('img', {
      class: 'tweet-video-status-poster',
      src: poster,
      alt: '',
      loading: 'lazy',
      decoding: 'async'
    });
    image.addEventListener('error', () => image.remove(), { once: true });
    status.append(image);
  }
  status.append(el('div', { class: 'tweet-video-status-content' }, [
    el('strong', { class: 'tweet-video-status-title', text: '動画を準備しています' }),
    el('span', { class: 'tweet-video-status-detail', text: '再生できる方法を自動判定中…' }),
    el('span', { class: 'tweet-video-status-progress', 'aria-hidden': 'true' })
  ]));
  return status;
}

function updateVideoStatus(status, title, detail) {
  const titleEl = status.querySelector('.tweet-video-status-title');
  const detailEl = status.querySelector('.tweet-video-status-detail');
  if (titleEl && title) titleEl.textContent = title;
  if (detailEl && detail) detailEl.textContent = detail;
}

function makeVideoFallback(item, mediaUrl, poster, reason = '', { final = false } = {}) {
  const fallback = el('div', { class: `tweet-video-fallback${final ? ' tweet-video-external-final' : ''}` });

  if (poster) {
    const image = el('img', {
      class: 'tweet-video-fallback-poster',
      src: poster,
      alt: '投稿動画のプレビュー',
      loading: 'lazy',
      decoding: 'async'
    });
    image.addEventListener('error', () => image.remove(), { once: true });
    fallback.append(image);
  }

  const body = el('div', { class: 'tweet-video-fallback-body' }, [
    el('strong', {
      text: final ? 'Xアプリで動画を再生' : (mediaUrl ? 'Webアプリ内で再生できませんでした' : '動画はX側で再生できます')
    }),
    el('span', {
      text: reason || (final
        ? '直接再生・プロキシ・公式埋め込みを利用できなかったため、投稿をXで開きます'
        : (mediaUrl ? '動画URLを外部で開きます' : 'RSSに直接再生できる動画URLが含まれていません'))
    })
  ]);
  fallback.append(body);

  const actions = el('div', { class: 'tweet-video-fallback-actions' });
  const postUrl = canonicalPostUrl(item);

  if (final || !mediaUrl) {
    actions.append(el('a', {
      class: 'tweet-video-external-button primary',
      href: postUrl,
      rel: 'external',
      text: 'Xアプリで動画を再生 ↗'
    }));
    actions.append(el('a', {
      class: 'tweet-video-external-button',
      href: postUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'ブラウザで投稿を開く ↗'
    }));
  } else {
    actions.append(el('a', {
      class: 'tweet-video-external-button primary',
      href: mediaUrl,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
      referrerpolicy: 'no-referrer',
      text: '動画URLを外部で開く ↗'
    }));
    if (postUrl) {
      actions.append(el('a', {
        class: 'tweet-video-external-button',
        href: postUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Xで動画を見る ↗'
      }));
    }
  }

  fallback.append(actions);
  return fallback;
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

async function resolveTweetVideo(shell, item, mediaUrl, poster) {
  const status = shell.querySelector('.tweet-video-status');
  const stage = shell.querySelector('.tweet-video-stage');
  const embed = shell.querySelector('.tweet-official-embed');
  if (!status || !stage || !embed) return;

  const makeVideo = () => {
    const video = document.createElement('video');
    video.className = 'tweet-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    // 方法1。video要素単体で未対応のブラウザーもあるため、index.html側にも
    // <meta name="referrer" content="no-referrer"> を設定している。
    video.setAttribute('referrerpolicy', 'no-referrer');
    if (poster) video.poster = poster;
    return video;
  };

  const revealVideo = (video, methodLabel) => {
    if (!shell.isConnected) return;
    status.hidden = true;
    embed.hidden = true;
    stage.hidden = false;
    stage.replaceChildren(video, el('span', { class: 'tweet-video-method-badge', text: methodLabel }));
  };

  const cleanupVideo = video => {
    try { video.pause(); } catch {}
    try { video.removeAttribute('src'); video.load(); } catch {}
  };

  const path = (() => {
    try { return new URL(mediaUrl).pathname.toLowerCase(); }
    catch { return ''; }
  })();

  // 方法1: no-referrerで直接CDN。2回連続失敗後は同一セッション中はスキップ。
  if (twitterVideoDirectFailures < TWITTER_VIDEO_DIRECT_FAILURE_LIMIT) {
    updateVideoStatus(status, '動画を準備しています', '方法1：CDNへリファラーなしで接続中…');
    const directVideo = makeVideo();
    if (!/\.m3u8$/i.test(path) || canPlayNativeHls(directVideo)) {
      try {
        await waitForVideo(directVideo, mediaUrl, { timeout: 2400 });
        twitterVideoDirectFailures = 0;
        revealVideo(directVideo, 'CDN直接再生');
        return;
      } catch {
        twitterVideoDirectFailures += 1;
        cleanupVideo(directVideo);
      }
    } else {
      cleanupVideo(directVideo);
    }
  }

  // 方法2: Vercelバックエンドを同一オリジンの動画プロキシにする。
  updateVideoStatus(status, '動画を準備しています', '方法2：バックエンドプロキシ経由で接続中…');
  const proxyVideo = makeVideo();
  try {
    await probeProxy(mediaUrl);
    await waitForVideo(proxyVideo, proxyVideoUrl(mediaUrl), { timeout: 4200 });
    revealVideo(proxyVideo, 'プロキシ再生');
    return;
  } catch {
    cleanupVideo(proxyVideo);
  }

  // 方法3: X公式widgets.js。X自身のiframe内で動画を再生する。
  updateVideoStatus(status, '動画を準備しています', '方法3：X公式埋め込みへ切り替え中…');
  try {
    embed.hidden = false;
    await tryOfficialEmbed(item, embed);
    if (!shell.isConnected) return;
    status.hidden = true;
    stage.hidden = true;
    embed.hidden = false;
    return;
  } catch {
    embed.replaceChildren();
    embed.hidden = true;
  }

  // 3方式とも失敗した時だけ、壊れた<video>は一切表示せず外部再生カードにする。
  if (!shell.isConnected) return;
  status.hidden = true;
  stage.hidden = true;
  embed.hidden = true;
  shell.replaceChildren(makeVideoFallback(
    item,
    '',
    poster,
    'この環境では3つのWeb再生方法を利用できなかったため、Xアプリ側で再生します',
    { final: true }
  ));
}

function makeTweetVideo(item, mediaUrl, poster = '') {
  const shell = el('div', { class: 'tweet-video-shell tweet-video-resolver' });
  const status = makeVideoStatus(poster);
  const stage = el('div', { class: 'tweet-video-stage' });
  const embed = el('div', { class: 'tweet-official-embed' });
  stage.hidden = true;
  embed.hidden = true;
  shell.append(status, stage, embed);

  // DOMへ載った直後から解決する。例外でも必ず外部再生へ落とす。
  queueMicrotask(() => {
    resolveTweetVideo(shell, item, mediaUrl, poster).catch(() => {
      if (!shell.isConnected) return;
      shell.replaceChildren(makeVideoFallback(
        item,
        '',
        poster,
        'Webアプリ内の動画再生を初期化できなかったため、Xアプリ側で再生します',
        { final: true }
      ));
    });
  });
  return shell;
}

function makeExternalOnlyVideo(item, poster = '') {
  const shell = el('div', { class: 'tweet-video-shell external-only' });
  const embed = el('div', { class: 'tweet-official-embed' });
  const status = makeVideoStatus(poster);
  updateVideoStatus(status, '動画を準備しています', '直接URLがないため、X公式埋め込みを確認中…');
  shell.append(status, embed);
  embed.hidden = true;

  // 直接URLがなくても方法3は使える。公式Embedまで失敗した時だけ外部へ。
  queueMicrotask(async () => {
    try {
      embed.hidden = false;
      await tryOfficialEmbed(item, embed);
      if (!shell.isConnected) return;
      status.hidden = true;
      embed.hidden = false;
    } catch {
      if (!shell.isConnected) return;
      shell.replaceChildren(makeVideoFallback(
        item,
        '',
        poster,
        'RSSから直接動画URLを取得できず、X公式埋め込みも利用できなかったため、Xアプリ側で再生します',
        { final: true }
      ));
    }
  });
  return shell;
}

function tweetCard(item) {
  // v2.14.11:
  // - 方法1: no-referrer付きCDN直接再生
  // - 方法2: /api/twitter-video-proxy 経由
  // - 方法3: X公式widgets.js Embed
  // - すべて失敗時だけXアプリ/ブラウザへ外部再生
  // - v2.14.9〜10の写真枚数/重複修正は維持
  const clean = cleanDescription(item.rawDescription || item.description);
  const images = tweetImages(item, clean);
  const videos = tweetVideos(item, clean);
  const videoPosters = tweetVideoPosters(item, clean);
  const hasVideoMedia = videos.length > 0 || videoPosters.length > 0;

  if (isRetweet(item, clean)) return null;

  const card = el('article', { class: 'tweet-card' });
  const author = tweetAuthor(item, clean);
  card.append(el('div', { class: 'tweet-author-row' }, [
    el('div', { class: 'tweet-author-avatar', text: String(author).replace(/^@/, '').slice(0, 1).toUpperCase() || 'X' }),
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
    // RSSHubが動画サムネイルだけ返し、video.twimg.comの直接URLを返さないケース。
    card.append(makeExternalOnlyVideo(item, videoPosters[0]));
  }

  if (images.length) {
    const grid = el('div', { class: `tweet-images count-${Math.min(4, images.length)}` });
    images.forEach(src => {
      const button = el('button', { class: 'tweet-image-button', type: 'button', 'aria-label': '画像を拡大' });
      const image = el('img', { src, alt: '投稿画像', loading: 'lazy', decoding: 'async' });

      // RSSに壊れた画像候補が混ざっていても「?」の壊れ画像を残さない。
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

  const extra = [...new Set(clean.links)]
    .filter(url => !clean.text.includes(url))
    .filter(url => !normalizeTweetVideoUrl(url));
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
  if (selected >= state.twitterFeeds.length) selected = 0;
  const feed = state.twitterFeeds[selected];
  const screen = el('section', { class: 'screen' });

  screen.append(topbar('SNS', {
    subtitle: 'Twitter / X リスト',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manage(() => renderTwitter(root, { navigate, refresh: true })) },
      { label: '↻', title: '更新', onClick: () => renderTwitter(root, { navigate, refresh: true }) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  if (!feed) {
    screen.append(el('div', { class: 'empty', text: 'Twitter/Xリストを追加してください' }));
    root.replaceChildren(screen);
    return;
  }

  const chips = el('div', { class: 'chips twitter-list-chips' });
  state.twitterFeeds.forEach((item, index) => chips.append(el('button', {
    class: `chip ${index === selected ? 'active' : ''}`,
    type: 'button',
    text: item.name,
    onclick: () => {
      localStorage.setItem(`pdv2:twitterScroll:${selected}`, String(window.scrollY));
      selected = index;
      localStorage.setItem('pdv2:twitterIndex', String(index));
      renderTwitter(root, { navigate });
    }
  })));
  screen.append(chips);

  const pullIndicator = el('div', { class: 'twitter-pull-refresh', 'aria-hidden': 'true' }, [
    el('span', { class: 'twitter-pull-spinner', text: '↻' }),
    el('span', { class: 'twitter-pull-label', text: '下に引いて更新' })
  ]);
  const host = el('div', { class: 'twitter-feed-host' });
  screen.append(pullIndicator, host);
  root.replaceChildren(screen);

  const active = chips.querySelector('.chip.active');
  if (active) centerScrollItem(chips, active, { behavior: 'auto' });

  attachPullToRefresh(screen, pullIndicator, () => {
    localStorage.setItem(`pdv2:twitterScroll:${selected}`, '0');
    return renderTwitter(root, { navigate, refresh: true });
  });

  const draw = items => {
    if (generation !== renderGeneration) return;
    const cards = (items || []).map(tweetCard).filter(Boolean);
    host.replaceChildren(...(cards.length
      ? cards
      : [el('div', { class: 'empty', text: '表示できる投稿がありません' })]));
    requestAnimationFrame(() => window.scrollTo({
      top: Number(localStorage.getItem(`pdv2:twitterScroll:${selected}`) || 0),
      behavior: 'auto'
    }));
  };

  try {
    const cached = !refresh ? readWarmRecord(feed) : null;

    if (cached?.xml) {
      draw(parseFeed(cached.xml, feed.name));

      if (!autoRefreshDue(feed)) return;

      warmJobFor(feed, { force: false }).then(() => {
        if (generation !== renderGeneration) return;
        const fresh = readWarmRecord(feed);
        if (fresh?.xml) draw(parseFeed(fresh.xml, feed.name));
      }).catch(() => {});
      return;
    }

    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: refresh ? 'SNSを更新しています…' : 'SNSを読み込み中…' }),
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
