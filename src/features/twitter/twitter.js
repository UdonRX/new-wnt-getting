import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { relativeTime } from '../../shared/time.js';
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
let historyJob = null;
let renderWarmJob = null;
let xNavIconObserver = null;

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const HISTORY_TIMEOUT_MS = 5000;
const RENDER_TIMEOUT_MS = 12000;
const X_BIRD_NAV_MARKUP = '<path style="fill:currentColor;stroke:none" d="M21.2 6.1c-.7.3-1.4.5-2.2.6.8-.5 1.4-1.2 1.7-2-.8.5-1.7.8-2.6 1A3.7 3.7 0 0 0 11.7 8c0 .3 0 .6.1.9-3.1-.2-5.9-1.7-7.8-4-.4.6-.6 1.3-.6 2.1 0 1.4.7 2.7 1.8 3.4-.6 0-1.2-.2-1.7-.5v.1c0 2 1.4 3.6 3.3 4-.3.1-.7.2-1.1.2-.3 0-.5 0-.8-.1.5 1.6 2 2.8 3.8 2.8A7.5 7.5 0 0 1 4 18.5c-.3 0-.6 0-.9-.1A10.5 10.5 0 0 0 8.8 20c6.8 0 10.6-5.7 10.6-10.6v-.5c.7-.5 1.3-1.1 1.8-1.8z"/>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function syncXNavBirdIcon() {
  const svg = document.querySelector('#bottom-nav .nav-item[aria-label="X"] svg');
  if (!svg || svg.dataset.xReadOnlyBird === '1') return;
  svg.innerHTML = X_BIRD_NAV_MARKUP;
  svg.dataset.xReadOnlyBird = '1';
  svg.style.fill = 'currentColor';
  svg.style.stroke = 'none';
}

function installXNavBirdIcon() {
  syncXNavBirdIcon();
  if (xNavIconObserver || typeof MutationObserver === 'undefined') return;
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  xNavIconObserver = new MutationObserver(() => syncXNavBirdIcon());
  xNavIconObserver.observe(nav, { childList: true, subtree: true });
}

function cacheRefreshDue(cache) {
  const posts = Array.isArray(cache?.posts) ? cache.posts : [];
  const fetchedAt = Number(cache?.fetchedAt || 0);
  return !posts.length || !fetchedAt || Date.now() - fetchedAt >= AUTO_REFRESH_MS;
}

function proxied(url, timeout = 4500, { historyOnly = false, upstream = false } = {}) {
  if (url.startsWith('/')) return url;
  const q = new URLSearchParams({ url, timeout: String(timeout) });
  if (historyOnly) q.set('historyOnly', '1');
  if (upstream) q.set('xUpstream', '1');
  return `/api/rss?${q}`;
}

async function fetchXml(feed, { timeout = 4500, historyOnly = false, upstream = false } = {}) {
  const response = await fetch(proxied(feed.url, timeout, { historyOnly, upstream }), { cache: 'no-store' });
  if (!response.ok) throw new Error(`X RSS取得エラー (${response.status})`);
  const xml = await response.text();
  if (!xml.trim()) throw new Error('X RSSが空です');
  return xml;
}

async function fetchAndMerge(feed, { source, timeout, historyOnly = false, upstream = false } = {}) {
  const xml = await fetchXml(feed, { timeout, historyOnly, upstream });
  const posts = normalizedPosts(xml, feed.name);
  if (!posts.length) throw new Error('表示できるX投稿がありません');
  const fetchedAt = Date.now();
  const stored = await writeXPostCache(posts, { fetchedAt });
  return {
    feed: feed.name,
    source,
    ok: true,
    posts: stored?.posts?.length ? stored.posts : posts,
    fetchedAt: Number(stored?.fetchedAt || fetchedAt)
  };
}

function historyJobFor(feed) {
  if (historyJob) return historyJob;
  const job = fetchAndMerge(feed, {
    source: 'upstash',
    timeout: HISTORY_TIMEOUT_MS,
    historyOnly: true
  }).catch(error => {
    console.warn('[x-history-sync]', error?.message || error);
    throw error;
  }).finally(() => {
    if (historyJob === job) historyJob = null;
  });
  historyJob = job;
  return job;
}

async function prewarmRenderUntilSuccess(feed) {
  let retryMs = 5000;
  while (true) {
    try {
      return await fetchAndMerge(feed, {
        source: 'render',
        timeout: RENDER_TIMEOUT_MS,
        upstream: true
      });
    } catch (error) {
      console.warn('[x-render-prewarm]', error?.message || error);
      await sleep(retryMs);
      retryMs = Math.min(30000, Math.round(retryMs * 1.5));
    }
  }
}

function renderJobFor(feed) {
  if (renderWarmJob) return renderWarmJob;
  const job = prewarmRenderUntilSuccess(feed).finally(() => {
    if (renderWarmJob === job) renderWarmJob = null;
  });
  renderWarmJob = job;
  return job;
}

export async function warmTwitterFeeds({ force = false } = {}) {
  installXNavBirdIcon();
  const cached = await readXPostCache();
  const shouldSyncHistory = force || cacheRefreshDue(cached);

  // Render wake-up is deliberately detached from the fast history path.
  renderJobFor(X_FEED).catch(() => {});
  if (!shouldSyncHistory) return [];

  try {
    return [await historyJobFor(X_FEED)];
  } catch {
    return [];
  }
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

function urlsFromText(value = '') {
  const urls = [];
  for (const match of String(value || '').matchAll(/https?:\/\/[^\s<]+/gi)) {
    const url = match[0].replace(/[),.!?。、「」]+$/, '');
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (/^https?:$/.test(parsed.protocol)) urls.push(parsed.href);
    } catch {}
  }
  return [...new Set(urls)];
}

function textWithoutUrls(value = '') {
  return String(value || '')
    .replace(/https?:\/\/[^\s<]+/gi, token => token.match(/[),.!?。、「」]+$/)?.[0] || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([、。！？!?])/g, '$1')
    .trim();
}

function profileUrlForAuthor(author = {}) {
  const explicit = String(author?.profileUrl || '').trim();
  if (explicit) return explicit;
  const handle = String(author?.handle || '').trim().replace(/^@/, '');
  return handle ? `https://x.com/${encodeURIComponent(handle)}` : '';
}

function avatarFallbackUrl(author = {}) {
  const handle = String(author?.handle || '').trim().replace(/^@/, '');
  return handle ? `https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false` : '';
}

function makeTweetAuthorAvatar(author = {}) {
  const label = author.name || author.handle || 'X';
  const fallback = String(label).replace(/^@/, '').slice(0, 1).toUpperCase() || 'X';
  const sources = [];
  const primary = String(author.avatar || '').trim();
  if (primary) {
    sources.push(primary);
    if (/_200x200(?=\.[a-z0-9]+(?:$|\?))/i.test(primary)) {
      sources.push(primary.replace(/_200x200(?=\.[a-z0-9]+(?:$|\?))/i, '_normal'));
    }
  }
  const providerFallback = avatarFallbackUrl(author);
  if (providerFallback && !sources.includes(providerFallback)) sources.push(providerFallback);

  const avatar = el('div', { class: 'tweet-author-avatar', text: sources.length ? '' : fallback });
  if (!sources.length) return avatar;

  const image = el('img', {
    class: 'tweet-author-avatar-image',
    src: sources[0],
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer'
  });
  let sourceIndex = 0;
  image.addEventListener('error', () => {
    sourceIndex += 1;
    if (sourceIndex < sources.length) {
      image.src = sources[sourceIndex];
      return;
    }
    image.remove();
    avatar.textContent = fallback;
  });
  avatar.append(image);
  return avatar;
}

function makeTimelineAvatar(author = {}, { main = false } = {}) {
  const avatar = makeTweetAuthorAvatar(author);
  if (main) avatar.classList.add('tweet-main-avatar');
  avatar.style.cssText += ';width:42px;height:42px;min-width:42px;min-height:42px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);font-size:14px;font-weight:800;line-height:1;overflow:hidden;';
  return avatar;
}

function makeProfileAvatarLink(author = {}, { main = false } = {}) {
  const avatar = makeTimelineAvatar(author, { main });
  const profileUrl = profileUrlForAuthor(author);
  if (!profileUrl) return avatar;
  return el('a', {
    class: 'tweet-profile-avatar-link',
    href: profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': `${author.name || author.handle || '投稿者'}のプロフィールを開く`,
    style: 'width:42px;height:42px;display:block;border-radius:50%;text-decoration:none;color:inherit;'
  }, [avatar]);
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

function comparableUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (url.hostname === 'twitter.com' || url.hostname.endsWith('.twitter.com')) url.hostname = 'x.com';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href.toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function linkCandidatesForPost(item, author = {}) {
  const excluded = new Set([
    comparableUrl(canonicalPostUrl(item)),
    comparableUrl(profileUrlForAuthor(author)),
    comparableUrl(item?.quote?.url || '')
  ].filter(Boolean));
  return [...new Set([...(Array.isArray(item?.links) ? item.links : []), ...urlsFromText(item?.text || '')])]
    .filter(Boolean)
    .filter(url => !excluded.has(comparableUrl(url)))
    .filter(url => {
      try { return !new URL(url).hostname.toLowerCase().endsWith('twimg.com'); } catch { return true; }
    });
}

function openExternalUrl(url) {
  const target = String(url || '').trim();
  if (!target) return;
  const opened = window.open(target, '_blank');
  if (opened) {
    try { opened.opener = null; } catch {}
  } else {
    window.location.assign(target);
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

function makeTweetQuoteCard(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const media = Array.isArray(quote.media) ? quote.media : [];
  const images = media.filter(entry => entry?.type === 'image' && entry.url).map(entry => entry.url).slice(0, 4);
  const videoMedia = media.filter(entry => entry?.type === 'video' && (entry.url || entry.poster)).slice(0, 4);
  const text = textWithoutUrls(quote.text || '');
  if (!quote.url && !quote.id && !text && !images.length && !videoMedia.length) return null;

  const author = quote.author || {};
  const name = String(author.name || '').trim() || String(author.handle || '').trim() || 'X';
  const handle = String(author.handle || '').trim();
  const profileUrl = profileUrlForAuthor(author);
  const card = el('article', {
    class: 'tweet-quote-card',
    role: 'link',
    tabindex: '0',
    'aria-label': '引用ポストをXで開く',
    style: 'margin-top:10px;padding:11px;border:1px solid var(--line);border-radius:16px;background:color-mix(in srgb,var(--surface-2) 84%,transparent);cursor:pointer;overflow:hidden;'
  });

  const authorCopyChildren = [
    el('strong', { class: 'tweet-author-name', text: name }),
    handle ? el('span', { class: 'media-meta', text: handle, style: 'margin:0;white-space:nowrap;' }) : null
  ];
  const authorCopy = profileUrl
    ? el('a', {
        href: profileUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: 'min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden;text-decoration:none;color:inherit;'
      }, authorCopyChildren)
    : el('div', { style: 'min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden;' }, authorCopyChildren);
  card.append(el('div', { class: 'tweet-author-row', style: 'margin-bottom:7px;' }, [
    makeProfileAvatarLink(author),
    authorCopy
  ]));

  if (text) card.append(el('div', { class: 'tweet-text', text, style: 'font-size:.94em;' }));

  if (videoMedia.length) {
    const stack = el('div', { class: 'tweet-video-stack' });
    videoMedia.forEach(entry => {
      const shell = entry.url ? makeTweetVideo(quote, entry.url, entry.poster || '') : makeExternalOnlyVideo(quote, entry.poster || '');
      shell.addEventListener('click', event => event.stopPropagation());
      stack.append(shell);
    });
    card.append(stack);
  }

  if (images.length) {
    const grid = el('div', { class: `tweet-images count-${Math.min(4, images.length)}` });
    images.forEach(src => {
      const button = el('button', { class: 'tweet-image-button', type: 'button', 'aria-label': '引用元の画像を拡大' });
      const image = el('img', { src, alt: '引用元の投稿画像', loading: 'lazy', decoding: 'async' });
      image.addEventListener('error', () => {
        button.remove();
        syncTweetImageGrid(grid);
      }, { once: true });
      button.append(image);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const visibleImages = [...grid.querySelectorAll('.tweet-image-button img')]
          .filter(img => img.complete && img.naturalWidth > 0)
          .map(img => img.currentSrc || img.src)
          .filter(Boolean);
        const current = image.currentSrc || image.src;
        const index = Math.max(0, visibleImages.indexOf(current));
        if (visibleImages.length) openImageViewer(visibleImages, index);
      });
      grid.append(button);
    });
    card.append(grid);
  }

  const openQuote = () => openExternalUrl(canonicalPostUrl(quote));
  card.addEventListener('click', event => {
    if (event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('button,a,video,iframe')) return;
    event.stopPropagation();
    openQuote();
  });
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    openQuote();
  });
  return card;
}

function tweetCard(item) {
  const media = Array.isArray(item?.media) ? item.media : [];
  const images = media.filter(entry => entry?.type === 'image' && entry.url).map(entry => entry.url).slice(0, 4);
  const videoMedia = media.filter(entry => entry?.type === 'video' && (entry.url || entry.poster)).slice(0, 4);
  const card = el('article', {
    class: 'tweet-card tweet-timeline-item',
    role: 'link',
    tabindex: '0',
    'aria-label': 'X投稿を開く',
    style: 'margin:0;padding:12px 14px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none;display:grid;grid-template-columns:42px minmax(0,1fr);column-gap:10px;align-items:start;cursor:pointer;'
  });
  const author = item.author || {};
  const profileUrl = profileUrlForAuthor(author);
  card.append(makeProfileAvatarLink(author, { main: true }));

  const content = el('div', { class: 'tweet-timeline-content', style: 'min-width:0;' });
  const name = String(author.name || '').trim() || String(author.handle || '').trim() || 'X';
  const handle = String(author.handle || '').trim();
  const elapsed = relativeTime(item.createdAt);
  const meta = el('div', {
    class: 'tweet-timeline-meta',
    style: 'min-width:0;display:flex;align-items:baseline;gap:4px;overflow:hidden;white-space:nowrap;line-height:1.25;'
  });
  const authorMetaChildren = [
    el('strong', {
      class: 'tweet-timeline-name',
      text: name,
      style: 'min-width:0;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:780;color:var(--text-strong);'
    }),
    handle ? el('span', {
      class: 'tweet-timeline-handle',
      text: handle,
      style: 'min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;color:var(--muted);'
    }) : null
  ];
  const authorMeta = profileUrl
    ? el('a', {
        class: 'tweet-timeline-author-link',
        href: profileUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: 'min-width:0;flex:1 1 auto;display:flex;align-items:baseline;gap:4px;overflow:hidden;text-decoration:none;color:inherit;'
      }, authorMetaChildren)
    : el('div', {
        class: 'tweet-timeline-author-link',
        style: 'min-width:0;flex:1 1 auto;display:flex;align-items:baseline;gap:4px;overflow:hidden;'
      }, authorMetaChildren);
  meta.append(authorMeta);
  if (elapsed) {
    meta.append(
      el('span', { class: 'tweet-timeline-dot', text: '·', style: 'flex:0 0 auto;font-size:14px;color:var(--muted);' }),
      el('a', {
        class: 'tweet-timeline-time',
        href: canonicalPostUrl(item),
        target: '_blank',
        rel: 'noopener noreferrer',
        text: elapsed,
        'aria-label': `${elapsed}、Xで投稿を開く`,
        style: 'flex:0 0 auto;font-size:14px;color:var(--muted);text-decoration:none;'
      })
    );
  }
  content.append(meta);

  const displayText = textWithoutUrls(item.text || '');
  if (displayText) {
    content.append(el('div', {
      class: 'tweet-text',
      text: displayText,
      style: 'margin-top:3px;font-size:15.5px;line-height:1.45;overflow-wrap:anywhere;word-break:normal;'
    }));
  }

  const quoteCard = makeTweetQuoteCard(item.quote);
  if (quoteCard) content.append(quoteCard);

  if (videoMedia.length) {
    const stack = el('div', { class: 'tweet-video-stack' });
    videoMedia.forEach(entry => {
      stack.append(entry.url ? makeTweetVideo(item, entry.url, entry.poster || '') : makeExternalOnlyVideo(item, entry.poster || ''));
    });
    content.append(stack);
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
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const visibleImages = [...grid.querySelectorAll('.tweet-image-button img')]
          .filter(img => img.complete && img.naturalWidth > 0)
          .map(img => img.currentSrc || img.src)
          .filter(Boolean);
        const current = image.currentSrc || image.src;
        const index = Math.max(0, visibleImages.indexOf(current));
        if (visibleImages.length) openImageViewer(visibleImages, index);
      });
      grid.append(button);
    });
    content.append(grid);
  }

  const candidates = linkCandidatesForPost(item, author);
  const youtubeIds = [...new Set(candidates.map(youtubeVideoIdFromUrl).filter(Boolean))].slice(0, 3);
  if (youtubeIds.length) {
    const youtubeStack = el('div', { class: 'tweet-youtube-stack' });
    youtubeIds.forEach(videoId => youtubeStack.append(makeTweetYouTubeCard(videoId)));
    content.append(youtubeStack);
  }

  const extra = candidates.filter(url => !youtubeVideoIdFromUrl(url));
  if (extra.length) {
    const links = el('div', { class: 'tweet-external-links' });
    extra.forEach(url => {
      const label = isXUrl(url) ? 'Xのリンク' : '外部リンク';
      links.append(el('a', {
        class: 'tweet-external-link',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `${label}を開く`,
        style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;text-decoration:none;'
      }, [
        el('span', { text: label }),
        el('span', { text: '開く ↗', style: 'color:var(--muted);font-size:11px;white-space:nowrap;' })
      ]));
    });
    content.append(links);
  }

  card.append(content);
  const openPost = () => openExternalUrl(canonicalPostUrl(item));
  card.addEventListener('click', event => {
    if (event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('a,button,video,iframe,.tweet-quote-card')) return;
    if (String(window.getSelection?.()?.toString() || '').trim()) return;
    openPost();
  });
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof Element && event.target.closest('a,button')) return;
    event.preventDefault();
    openPost();
  });
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

function postIdentity(item) {
  const id = tweetIdOf(item) || String(item?.id || '').trim();
  if (id) return `id:${id}`;
  const raw = String(item?.url || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://x.com/');
    if (url.hostname === 'twitter.com' || url.hostname.endsWith('.twitter.com')) url.hostname = 'x.com';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.href.toLowerCase()}`;
  } catch {
    return `url:${raw.toLowerCase()}`;
  }
}

function postTimestamp(item) {
  const time = Date.parse(String(item?.createdAt || ''));
  return Number.isFinite(time) ? time : 0;
}

export async function renderTwitter(root, { navigate, refresh = false }) {
  installXNavBirdIcon();
  const generation = ++renderGeneration;
  const feed = X_FEED;

  let cached = { posts: [], fetchedAt: 0 };
  try {
    cached = await readXPostCache();
  } catch (error) {
    console.warn('[x-cache-read]', error?.message || error);
  }
  if (generation !== renderGeneration) return;

  let requestRefresh = () => Promise.resolve();
  const screen = el('section', { class: 'screen' });
  screen.append(topbar('X', {
    subtitle: 'タイムライン',
    actions: [
      { label: '↻', title: '更新', onClick: () => requestRefresh() },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const updateStatus = el('div', {
    class: 'twitter-update-status media-meta',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
    style: 'min-height:16px;margin:0 4px 4px;opacity:.82;'
  });
  updateStatus.hidden = true;

  const pullIndicator = el('div', { class: 'twitter-pull-refresh', 'aria-hidden': 'true' }, [
    el('span', { class: 'twitter-pull-spinner', text: '↻' }),
    el('span', { class: 'twitter-pull-label', text: '下に引いて更新' })
  ]);
  const host = el('div', {
    class: 'twitter-feed-host',
    style: 'display:block;margin:0 -14px;padding:0;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;overflow:visible;'
  });
  screen.append(updateStatus, pullIndicator, host);

  let visiblePosts = [];
  const draw = posts => {
    if (generation !== renderGeneration) return;
    const list = Array.isArray(posts) ? posts : [];
    if (!list.length) return;
    visiblePosts = [...list];
    host.replaceChildren(...list.map(tweetCard));
  };

  const mergeNewPosts = posts => {
    if (generation !== renderGeneration) return 0;
    const list = Array.isArray(posts) ? posts : [];
    if (!list.length) return 0;
    if (!visiblePosts.length) {
      draw(list);
      return list.length;
    }

    const scrollTop = Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));
    const scrollAnchor = scrollTop > 1
      ? [...host.children].find(child => child.getBoundingClientRect().bottom > 0)
      : null;
    const scrollAnchorTop = scrollAnchor?.getBoundingClientRect().top ?? 0;

    const freshByIdentity = new Map(list.map(item => [postIdentity(item), item]).filter(([identity]) => identity));
    visiblePosts.forEach((existing, index) => {
      const fresh = freshByIdentity.get(postIdentity(existing));
      const freshAvatar = String(fresh?.author?.avatar || '').trim();
      const currentAvatar = String(existing?.author?.avatar || '').trim();
      if (!fresh || !freshAvatar || freshAvatar === currentAvatar) return;
      existing.author = { ...(existing.author || {}), ...(fresh.author || {}) };
      const avatarNode = host.children[index]?.querySelector('.tweet-main-avatar');
      if (avatarNode) avatarNode.replaceWith(makeTimelineAvatar(existing.author, { main: true }));
    });

    const known = new Set(visiblePosts.map(postIdentity).filter(Boolean));
    const incoming = [];
    for (const item of list) {
      const identity = postIdentity(item);
      if (!identity || known.has(identity)) continue;
      known.add(identity);
      incoming.push(item);
    }
    incoming.sort((a, b) => postTimestamp(b) - postTimestamp(a));

    for (const item of incoming) {
      const time = postTimestamp(item);
      let index = visiblePosts.findIndex(existing => postTimestamp(existing) < time);
      if (index < 0) index = visiblePosts.length;
      host.insertBefore(tweetCard(item), host.children[index] || null);
      visiblePosts.splice(index, 0, item);
    }

    while (visiblePosts.length > 100) {
      visiblePosts.pop();
      host.lastElementChild?.remove();
    }

    if (incoming.length && scrollAnchor?.isConnected) {
      const delta = scrollAnchor.getBoundingClientRect().top - scrollAnchorTop;
      if (Number.isFinite(delta) && Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    }
    return incoming.length;
  };

  if (cached?.posts?.length) {
    draw(cached.posts);
  } else {
    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: 'X履歴を読み込み中…' }),
      el('span', { text: 'Upstash履歴を先に確認し、Renderは裏で起動します' })
    ]));
  }

  let statusTimer = null;
  let refreshSerial = 0;
  const setUpdateStatus = (text = '', autoHideMs = 0) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    if (!text) {
      updateStatus.textContent = '';
      updateStatus.hidden = true;
      return;
    }
    updateStatus.textContent = text;
    updateStatus.hidden = false;
    if (autoHideMs > 0) {
      statusTimer = setTimeout(() => {
        if (!updateStatus.isConnected) return;
        updateStatus.textContent = '';
        updateStatus.hidden = true;
      }, autoHideMs);
    }
  };

  const applyMergedResult = async result => {
    if (generation !== renderGeneration) return false;
    let posts = Array.isArray(result?.posts) ? result.posts : [];
    if (!posts.length) posts = (await readXPostCache()).posts || [];
    if (generation !== renderGeneration || !posts.length) return false;
    mergeNewPosts(posts);
    return true;
  };

  const watchBackgroundResult = job => job.then(applyMergedResult).catch(error => {
    console.warn('[x-sync-background]', error?.message || error);
    return false;
  });

  requestRefresh = () => {
    const serial = ++refreshSerial;
    setUpdateStatus('更新中…');

    const history = historyJobFor(feed);
    const renderWarm = renderJobFor(feed);

    history.then(async result => {
      await applyMergedResult(result);
      if (generation === renderGeneration && serial === refreshSerial) setUpdateStatus('');
    }).catch(error => {
      console.warn('[x-manual-refresh-history]', error?.message || error);
      if (generation === renderGeneration && serial === refreshSerial) {
        setUpdateStatus('更新できませんでした（履歴を表示中）', 2600);
      }
    });

    renderWarm.then(async result => {
      await applyMergedResult(result);
      if (generation === renderGeneration && serial === refreshSerial) setUpdateStatus('');
    }).catch(error => {
      console.warn('[x-manual-refresh-render]', error?.message || error);
    });

    // Pull-to-refresh should release immediately; Render may keep waking in the background for ~1 minute.
    return Promise.resolve();
  };

  root.replaceChildren(screen);
  attachPullToRefresh(screen, pullIndicator, () => requestRefresh());

  const history = historyJobFor(feed);
  const renderWarm = renderJobFor(feed);
  watchBackgroundResult(history);
  watchBackgroundResult(renderWarm);

  if (refresh) requestRefresh();

  // Cached posts stay visible and are never replaced while Render wakes.
  if (cached?.posts?.length) return;

  try {
    const first = await Promise.any([history, renderWarm]);
    await applyMergedResult(first);
  } catch {
    if (generation !== renderGeneration) return;
    const fallback = await readXPostCache();
    if (generation !== renderGeneration || !fallback?.posts?.length) return;
    draw(fallback.posts);
  }
}
