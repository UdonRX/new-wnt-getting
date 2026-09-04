import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { iconSvg } from '../../shared/icons.js';
import { isXUrl, normalizeXFeed } from './x-normalizer.js';
import { readXPostCache, writeXPostCache } from './x-cache.js';

const X_FEED = Object.freeze({
  name: 'X',
  id: '2087706843519111304',
  url: 'https://diygod-x.onrender.com/twitter/list/2087706843519111304'
});

let renderGeneration = 0;
let warmJob = null;

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const LEGACY_WARM_KEY = `pdv2:twitterWarm:${X_FEED.id}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clearLegacyWarmCache() {
  try { localStorage.removeItem(LEGACY_WARM_KEY); } catch {}
}

function cacheRefreshDue(cache) {
  const posts = Array.isArray(cache?.posts) ? cache.posts : [];
  const fetchedAt = Number(cache?.fetchedAt || 0);
  return !posts.length || !fetchedAt || Date.now() - fetchedAt >= AUTO_REFRESH_MS;
}

function proxied(url, timeout = 4500) {
  if (url.startsWith('/')) return url;
  const q = new URLSearchParams({ url, timeout: String(timeout) });
  return `/api/rss?${q}`;
}

async function fetchXml(feed, { timeout = 4500 } = {}) {
  const response = await fetch(proxied(feed.url, timeout), { cache: 'no-store' });
  if (!response.ok) throw new Error(`X RSS取得エラー (${response.status})`);
  const xml = await response.text();
  if (!xml.trim()) throw new Error('X RSSが空です');
  return xml;
}

async function warmFeedUntilSuccess(feed) {
  while (true) {
    try {
      const xml = await fetchXml(feed, { timeout: 5000 });
      const posts = normalizedPosts(xml, feed.name);
      if (!posts.length) throw new Error('表示できるX投稿がありません');
      const stored = await writeXPostCache(posts, { fetchedAt: Date.now() });
      return {
        feed: feed.name,
        ok: true,
        posts: stored?.posts?.length ? stored.posts : posts,
        fetchedAt: Number(stored?.fetchedAt || Date.now())
      };
    } catch (error) {
      console.warn('[x-warm-retry]', error?.message || error);
      await sleep(5000);
    }
  }
}

function warmJobFor(feed) {
  if (warmJob) return warmJob;
  const job = warmFeedUntilSuccess(feed).finally(() => {
    if (warmJob === job) warmJob = null;
  });
  warmJob = job;
  return job;
}

export async function warmTwitterFeeds({ force = false } = {}) {
  clearLegacyWarmCache();
  if (!force) {
    const cached = await readXPostCache();
    if (!cacheRefreshDue(cached)) return [];
  }
  return Promise.all([warmJobFor(X_FEED)]);
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
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(raw) * 1.15) return reset();
    if (raw <= 0 || scrollTop() > 1) return reset();
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
    if (!shouldRefresh) return reset();
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
    return url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/i)?.[1] || '';
  } catch {
    return '';
  }
}

function appendLinkified(container, text) {
  const regex = /(https?:\/\/[^\s<]+)/gi;
  let last = 0;
  for (const match of String(text || '').matchAll(regex)) {
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

function makeTweetAuthorAvatar(author = {}) {
  const label = author.name || author.handle || 'X';
  const fallback = String(label).replace(/^@/, '').slice(0, 1).toUpperCase() || 'X';
  const avatar = el('div', { class: 'tweet-author-avatar', text: author.avatar ? '' : fallback });
  if (author.avatar) {
    const image = el('img', {
      class: 'tweet-author-avatar-image',
      src: author.avatar,
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
  const launcher = el('button', { class: 'tweet-youtube-launcher', type: 'button', 'aria-label': 'YouTube動画を再生' });
  launcher.append(el('img', {
    src: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    alt: '', loading: 'lazy', decoding: 'async'
  }));
  launcher.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    card.replaceChildren(el('iframe', {
      class: 'tweet-youtube-frame',
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0`,
      title: 'YouTube video player',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowfullscreen: 'true',
      referrerpolicy: 'strict-origin-when-cross-origin'
    }));
  });
  card.append(launcher);
  return card;
}

let xWidgetsPromise = null;

function canPlayNativeHls(video) {
  return Boolean(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
}

function tweetIdOf(item) {
  if (/^\d{5,}$/.test(String(item?.id || ''))) return String(item.id);
  return String(item?.url || '').match(/\/status(?:es)?\/(\d{5,})/i)?.[1] || '';
}

function canonicalPostUrl(item) {
  if (item?.url) return item.url;
  const id = tweetIdOf(item);
  return id ? `https://x.com/i/status/${id}` : 'https://x.com/';
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
      ['loadedmetadata', 'loadeddata', 'canplay', 'error', 'stalled', 'abort'].forEach(type => video.removeEventListener(type, handlers[type]));
      if (ok) resolve();
      else reject(error || new Error('video load failed'));
    };
    const handlers = {
      loadedmetadata: () => finish(true), loadeddata: () => finish(true), canplay: () => finish(true),
      error: () => finish(false, new Error('media error')),
      stalled: () => { if (video.readyState === 0) finish(false, new Error('media stalled')); },
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
    const response = await fetch(proxyVideoUrl(mediaUrl, { probe: true }), { cache: 'no-store', signal: controller.signal });
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
    theme: xEmbedTheme(), conversation: 'none', cards: 'visible', align: 'center', dnt: true, lang: 'ja'
  });
  const result = await Promise.race([
    Promise.resolve(renderPromise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('X embed timeout')), 7000))
  ]);
  if (!result) throw new Error('X embed unavailable');
  return result;
}

function makeVideoLauncher(poster = '') {
  const button = el('button', { class: 'tweet-video-launcher', type: 'button', 'aria-label': '動画を再生' });
  if (poster) {
    const image = el('img', { class: 'tweet-video-launcher-poster', src: poster, alt: '', loading: 'lazy', decoding: 'async' });
    image.addEventListener('error', () => image.remove(), { once: true });
    button.append(image);
  }
  button.append(
    el('span', { class: 'tweet-video-launcher-shade', 'aria-hidden': 'true' }),
    el('span', { class: 'tweet-video-play-circle', 'aria-hidden': 'true' }, [el('span', { class: 'tweet-video-play-triangle' })])
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
  const result = video.play?.();
  if (result?.catch) result.catch(() => {});
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

  const path = (() => { try { return new URL(mediaUrl).pathname.toLowerCase(); } catch { return ''; } })();
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

function syncTweetImageGrid(grid) {
  if (!grid) return;
  const count = grid.querySelectorAll('.tweet-image-button').length;
  grid.classList.remove('count-1', 'count-2', 'count-3', 'count-4');
  if (count > 0) grid.classList.add(`count-${Math.min(4, count)}`);
  if (count === 0) grid.remove();
}

function authorLabel(author = {}) {
  const name = String(author.name || '').trim();
  const handle = String(author.handle || '').trim();
  if (!name) return handle || 'X';
  if (!handle || name.includes(handle)) return name;
  return `${name} (${handle})`;
}

function tweetCard(item) {
  const media = Array.isArray(item?.media) ? item.media : [];
  const images = media.filter(entry => entry?.type === 'image' && entry.url).map(entry => entry.url).slice(0, 4);
  const videoMedia = media.filter(entry => entry?.type === 'video' && (entry.url || entry.poster)).slice(0, 4);
  const hasVideoMedia = videoMedia.length > 0;
  const card = el('article', { class: 'tweet-card' });
  const author = item.author || {};
  card.append(el('div', { class: 'tweet-author-row' }, [
    makeTweetAuthorAvatar(author),
    el('strong', { class: 'tweet-author-name', text: authorLabel(author) })
  ]));

  const displayText = String(item.text || '').trim();
  if (displayText) {
    const text = el('div', { class: 'tweet-text' });
    appendLinkified(text, displayText);
    card.append(text);
  } else if (images.length && !hasVideoMedia) card.classList.add('tweet-card-photo-only');
  else if (hasVideoMedia) card.classList.add('tweet-card-media-only');

  if (videoMedia.length) {
    const stack = el('div', { class: 'tweet-video-stack' });
    videoMedia.forEach(entry => {
      stack.append(entry.url ? makeTweetVideo(item, entry.url, entry.poster || '') : makeExternalOnlyVideo(item, entry.poster || ''));
    });
    card.append(stack);
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

  const youtubeIds = [...new Set((item.links || []).map(youtubeVideoIdFromUrl).filter(Boolean))].slice(0, 3);
  if (youtubeIds.length) {
    const youtubeStack = el('div', { class: 'tweet-youtube-stack' });
    youtubeIds.forEach(videoId => youtubeStack.append(makeTweetYouTubeCard(videoId)));
    card.append(youtubeStack);
  }

  const extra = [...new Set(item.links || [])]
    .filter(url => !isXUrl(url))
    .filter(url => !youtubeVideoIdFromUrl(url));
  if (extra.length) {
    const links = el('div', { class: 'tweet-external-links' });
    extra.forEach(url => links.append(el('a', {
      class: 'tweet-external-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url
    })));
    card.append(links);
  }

  card.append(el('div', { class: 'tweet-footer' }, [
    el('span', { class: 'media-meta', text: shortDate(item.createdAt) }),
    el('a', { class: 'tweet-open-x', href: canonicalPostUrl(item), target: '_blank', rel: 'noopener noreferrer', text: 'Xで開く ↗' })
  ]));
  return card;
}

function normalizedPosts(xml, feedName) {
  try {
    return normalizeXFeed(xml, feedName);
  } catch (error) {
    console.error('[x-normalize-error]', error);
    throw new Error(`Xデータの変換に失敗しました: ${error?.message || error}`);
  }
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

  const draw = posts => {
    if (generation !== renderGeneration) return;
    const list = Array.isArray(posts) ? posts : [];
    const cards = list.map(tweetCard);
    host.replaceChildren(...(cards.length ? cards : [el('div', { class: 'empty', text: '表示できる投稿がありません' })]));
  };

  try {
    clearLegacyWarmCache();
    const cached = !refresh ? await readXPostCache() : { posts: [], fetchedAt: 0 };
    if (generation !== renderGeneration) return;

    if (cached?.posts?.length) {
      draw(cached.posts);
      const redrawAfterWarm = job => job.then(async result => {
        if (generation !== renderGeneration) return;
        let posts = Array.isArray(result?.posts) ? result.posts : [];
        if (!posts.length) posts = (await readXPostCache()).posts || [];
        if (generation !== renderGeneration || !posts.length) return;
        draw(posts);
      }).catch(() => {});

      if (warmJob) {
        redrawAfterWarm(warmJob);
        return;
      }
      if (!cacheRefreshDue(cached)) return;
      redrawAfterWarm(warmJobFor(feed));
      return;
    }

    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: refresh ? 'Xを更新しています…' : 'Xを読み込み中…' }),
      el('span', { text: '取得できない場合は5秒空けて再確認します' })
    ]));
    const result = await warmJobFor(feed);
    if (generation !== renderGeneration) return;
    let posts = Array.isArray(result?.posts) ? result.posts : [];
    if (!posts.length) posts = (await readXPostCache()).posts || [];
    if (!posts.length) throw new Error('X投稿が空です');
    draw(posts);
  } catch (err) {
    if (generation !== renderGeneration) return;
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
