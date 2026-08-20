import { el, showToast } from '../../shared/dom.js';
import { watchPlayingTitle, clearPlayingTitle } from '../../shared/playing-title.js';

let apiPromise = null;
let player = null;
let activeHost = null;
let activePanel = null;
let shortsOverlay = null;
let endedTimer = null;
let generation = 0;

const autoNext = () => localStorage.getItem('pdv2:youtubeAutoNext') !== '0';

function ensureApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = reject;
      document.head.append(script);
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.YT?.Player) {
        clearInterval(timer);
        resolve(window.YT);
      } else if (Date.now() - startedAt > 10000) {
        clearInterval(timer);
        reject(new Error('YouTube Player APIの読み込みがタイムアウトしました'));
      }
    }, 120);
  });

  return apiPromise;
}

function setLandscape(panel, on) {
  if (!panel) return;
  panel.classList.toggle('twitch-css-landscape', Boolean(on));
  panel.classList.toggle('youtube-css-landscape', Boolean(on));
  document.documentElement.classList.toggle('media-player-open', Boolean(on));
  const button = panel.querySelector('.youtube-orientation-btn');
  if (button) button.textContent = on ? '↕ 縦画面' : '↔ 横画面';
}

export function cleanupYouTubePlayer() {
  generation += 1;
  clearPlayingTitle();
  if (endedTimer) clearTimeout(endedTimer);
  endedTimer = null;
  try { player?.pauseVideo?.(); } catch {}
  try { player?.destroy?.(); } catch {}
  player = null;
  if (activePanel) setLandscape(activePanel, false);
  activePanel = null;
  if (activeHost?.isConnected) activeHost.replaceChildren();
  activeHost = null;
  shortsOverlay?.remove();
  shortsOverlay = null;
  document.documentElement.classList.remove('media-player-open', 'youtube-shorts-open');
}

window.addEventListener('pdv2:before-navigate', cleanupYouTubePlayer);

function toggleLandscape(panel) {
  const on = !panel.classList.contains('twitch-css-landscape');
  setLandscape(panel, on);
  showToast(on
    ? '動画を90°回転しました。端末を横向きにして見られます。'
    : '通常表示に戻しました');
}

function clampIndex(index, queue) {
  return Math.max(0, Math.min(Number(index) || 0, queue.length - 1));
}

function mountShortsPlayer({ queue, index = 0 } = {}) {
  cleanupYouTubePlayer();
  if (!Array.isArray(queue) || !queue.length) return null;

  const myGeneration = generation;
  let current = clampIndex(index, queue);

  const overlayRoot = document.getElementById('overlay-root') || document.body;
  const overlay = el('section', {
    class: 'youtube-shorts-player',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'YouTube Shortsプレーヤー'
  });
  shortsOverlay = overlay;
  document.documentElement.classList.add('youtube-shorts-open', 'media-player-open');

  const top = el('header', { class: 'youtube-shorts-top' });
  const close = el('button', {
    class: 'youtube-shorts-close',
    type: 'button',
    'aria-label': 'Shortsを閉じる',
    text: '✕',
    onclick: cleanupYouTubePlayer
  });
  const meta = el('div', { class: 'youtube-shorts-meta' });
  const title = el('strong', { class: 'youtube-shorts-title' });
  const channel = el('span', { class: 'youtube-shorts-channel' });
  meta.append(title, channel);
  top.append(close, meta, el('span', { class: 'youtube-shorts-top-spacer', 'aria-hidden': 'true' }));

  const stage = el('div', { class: 'youtube-shorts-stage' });
  const holderId = `yt-v2141-shorts-${Date.now()}`;
  stage.append(el('div', { id: holderId, class: 'youtube-shorts-embed' }));

  const bottom = el('footer', { class: 'youtube-shorts-bottom' });
  const prev = el('button', { class: 'youtube-shorts-action', type: 'button', text: '‹ 前' });
  const next = el('button', { class: 'youtube-shorts-action', type: 'button', text: '次 ›' });
  const external = el('a', {
    class: 'youtube-shorts-action youtube-shorts-external',
    target: '_blank',
    rel: 'noopener noreferrer',
    text: 'YouTubeで開く ↗'
  });
  bottom.append(prev, next, external);
  overlay.append(top, stage, bottom);
  overlayRoot.append(overlay);

  const updateUi = () => {
    const item = queue[current] || {};
    title.textContent = item.title || 'Shorts';
    channel.textContent = item.channelName || 'YouTube';
    external.href = `https://www.youtube.com/shorts/${encodeURIComponent(item.videoId || '')}`;
    prev.disabled = current <= 0;
    next.disabled = current >= queue.length - 1;
    overlay.dataset.index = String(current);
  };

  const loadIndex = nextIndex => {
    if (nextIndex < 0) {
      showToast('最初のShortsです');
      return false;
    }
    if (nextIndex >= queue.length) {
      showToast('最後のShortsです');
      return false;
    }

    current = nextIndex;
    updateUi();
    const item = queue[current];
    if (player?.loadVideoById) {
      try {
        player.loadVideoById({ videoId: item.videoId, startSeconds: 0 });
        player.playVideo?.();
      } catch {}
    }
    return true;
  };

  prev.onclick = () => loadIndex(current - 1);
  next.onclick = () => loadIndex(current + 1);
  updateUi();

  ensureApi().then(YT => {
    if (myGeneration !== generation || !overlay.isConnected) return;
    const item = queue[current];
    player = new YT.Player(holderId, {
      videoId: item.videoId,
      playerVars: {
        autoplay: 1,
        playsinline: 1,
        rel: 0,
        cc_load_policy: 0,
        controls: 1,
        modestbranding: 1
      },
      events: {
        onReady: event => {
          try { event.target.playVideo(); } catch {}
        },
        onStateChange: event => {
          if (event.data !== YT.PlayerState.ENDED) return;
          if (endedTimer) clearTimeout(endedTimer);
          endedTimer = setTimeout(() => {
            // Shorts are always continuous. This deliberately ignores the
            // regular YouTube "continuous playback" preference.
            loadIndex(current + 1);
          }, 180);
        }
      }
    });
  }).catch(error => {
    if (!overlay.isConnected) return;
    stage.append(el('div', { class: 'youtube-shorts-error', text: `Shortsを再生できませんでした: ${error.message}` }));
  });

  return { close: cleanupYouTubePlayer };
}

function mountInlinePlayer({ host, queue, index = 0 } = {}) {
  cleanupYouTubePlayer();
  if (!host || !Array.isArray(queue) || !queue.length) return null;

  activeHost = host;
  let current = clampIndex(index, queue);
  const myGeneration = generation;

  const render = async () => {
    if (myGeneration !== generation || !activeHost?.isConnected) return;
    if (activePanel) setLandscape(activePanel, false);
    clearPlayingTitle();
    try { player?.destroy?.(); } catch {}
    player = null;

    const item = queue[current];
    const panel = el('section', { class: 'twitch-inline-player youtube-inline-player' });
    activePanel = panel;

    const head = el('div', { class: 'twitch-inline-head' });
    head.append(
      el('div', {}, [
        el('div', { class: 'twitch-inline-kicker', text: item.kind === 'live' ? 'LIVE' : '動画' }),
        el('strong', { text: item.channelName || 'YouTube' })
      ]),
      el('button', {
        class: 'icon-button media-portrait-return-btn',
        type: 'button',
        'aria-label': '縦画面へ戻す',
        text: '↕ 縦画面',
        onclick: () => setLandscape(panel, false)
      }),
      el('button', {
        class: 'icon-button twitch-close',
        type: 'button',
        'aria-label': 'プレイヤーを閉じる',
        text: '✕',
        onclick: cleanupYouTubePlayer
      })
    );

    const stage = el('div', { class: 'twitch-inline-stage youtube-inline-stage' });
    const holderId = `yt-v2141-player-${Date.now()}-${current}`;
    stage.append(el('div', { id: holderId, class: 'youtube-inline-embed' }));

    const info = el('div', { class: 'twitch-inline-info youtube-inline-info' });
    info.append(el('div', { class: 'player-title', text: item.title || 'YouTube' }));

    const controls = el('div', { class: 'twitch-inline-controls' });
    const prev = el('button', {
      class: 'player-soft', type: 'button', text: '‹ 前へ', disabled: current <= 0,
      onclick: () => { if (current > 0) { current -= 1; render(); } }
    });
    const next = el('button', {
      class: 'player-soft', type: 'button', text: '次へ ›', disabled: current >= queue.length - 1,
      onclick: () => { if (current < queue.length - 1) { current += 1; render(); } }
    });
    const landscape = el('button', {
      class: 'player-soft youtube-orientation-btn', type: 'button', text: '↔ 横画面',
      onclick: () => toggleLandscape(panel)
    });
    const external = el('a', {
      class: 'player-soft', target: '_blank', rel: 'noopener noreferrer',
      href: `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId || '')}`,
      text: 'YouTubeで開く ↗'
    });
    const auto = el('button', {
      class: 'player-soft youtube-auto-next-btn', type: 'button',
      text: `連続再生 ${autoNext() ? 'ON' : 'OFF'}`,
      onclick: event => {
        localStorage.setItem('pdv2:youtubeAutoNext', autoNext() ? '0' : '1');
        event.currentTarget.textContent = `連続再生 ${autoNext() ? 'ON' : 'OFF'}`;
      }
    });

    controls.append(prev, next, landscape, external, auto);
    info.append(controls);
    panel.append(head, stage, info);
    activeHost.replaceChildren(panel);

    watchPlayingTitle(stage, item.title || 'YouTube');
    requestAnimationFrame(() => activeHost?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

    try {
      const YT = await ensureApi();
      if (myGeneration !== generation || !panel.isConnected) return;

      player = new YT.Player(holderId, {
        videoId: item.videoId,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, cc_load_policy: 0 },
        events: {
          onReady: event => { try { event.target.playVideo(); } catch {} },
          onStateChange: event => {
            if (event.data === YT.PlayerState.ENDED && autoNext() && current < queue.length - 1) {
              endedTimer = setTimeout(() => { current += 1; render(); }, 250);
            }
          }
        }
      });
    } catch (error) {
      if (panel.isConnected) {
        info.append(el('div', { class: 'error-box', text: `YouTubeプレイヤーを読み込めませんでした: ${error.message}` }));
      }
    }
  };

  render();
  return { close: cleanupYouTubePlayer };
}

export function mountYouTubePlayer({ host, queue, index = 0, shorts = false } = {}) {
  if (shorts) return mountShortsPlayer({ queue, index });
  return mountInlinePlayer({ host, queue, index });
}

// Existing-code compatibility.
export function openYouTubePlayer(items, startIndex = 0, { shorts = false, host } = {}) {
  if (shorts) return mountShortsPlayer({ queue: items, index: startIndex });
  if (!host) return null;
  return mountInlinePlayer({ host, queue: items, index: startIndex });
}
