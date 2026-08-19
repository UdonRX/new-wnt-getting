import { el, showToast } from '../../shared/dom.js';

let apiPromise = null;
let player = null;
let activeHost = null;
let activePanel = null;
let endedTimer = null;
let generation = 0;

const autoNext = () => localStorage.getItem('pdv2:youtubeAutoNext') !== '0';

function ensureApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = reject;
      document.head.append(script);
    }
    setTimeout(() => window.YT?.Player && resolve(window.YT), 5000);
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
  if (endedTimer) clearTimeout(endedTimer);
  endedTimer = null;
  try { player?.pauseVideo?.(); } catch {}
  try { player?.destroy?.(); } catch {}
  player = null;
  if (activePanel) setLandscape(activePanel, false);
  activePanel = null;
  if (activeHost?.isConnected) activeHost.replaceChildren();
  activeHost = null;
  document.documentElement.classList.remove('media-player-open');
}

window.addEventListener('pdv2:before-navigate', cleanupYouTubePlayer);

function toggleLandscape(panel) {
  const on = !panel.classList.contains('twitch-css-landscape');
  setLandscape(panel, on);
  showToast(on ? '動画を90°回転しました。端末を横向きにして見られます。' : '通常表示に戻しました');
}

export function mountYouTubePlayer({ host, queue, index = 0, shorts = false } = {}) {
  cleanupYouTubePlayer();
  if (!host || !Array.isArray(queue) || !queue.length) return null;
  activeHost = host;
  let current = Math.max(0, Math.min(index, queue.length - 1));
  const myGeneration = generation;

  const render = async () => {
    if (myGeneration !== generation || !activeHost?.isConnected) return;
    if (activePanel) setLandscape(activePanel, false);
    try { player?.destroy?.(); } catch {}
    player = null;

    const item = queue[current];
    const panel = el('section', { class: `twitch-inline-player youtube-inline-player ${shorts ? 'youtube-shorts-inline' : ''}` });
    activePanel = panel;

    const head = el('div', { class: 'twitch-inline-head' });
    head.append(
      el('div', {}, [
        el('div', { class: 'twitch-inline-kicker', text: shorts ? 'SHORTS' : (item.kind === 'live' ? 'LIVE' : '動画') }),
        el('strong', { text: item.channelName || 'YouTube' })
      ]),
      el('button', { class: 'icon-button twitch-close', type: 'button', 'aria-label': 'プレイヤーを閉じる', text: '✕', onclick: cleanupYouTubePlayer })
    );

    const stage = el('div', { class: 'twitch-inline-stage youtube-inline-stage' });
    const holderId = `yt-v211-player-${Date.now()}-${current}`;
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
      class: 'player-soft youtube-orientation-btn', type: 'button', text: '↔ 横画面', onclick: () => toggleLandscape(panel)
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
      if (panel.isConnected) info.append(el('div', { class: 'error-box', text: `YouTubeプレイヤーを読み込めませんでした: ${error.message}` }));
    }
  };

  render();
  return { close: cleanupYouTubePlayer };
}

// 既存コード互換用。v2.11ではyoutube.jsからはmountYouTubePlayerを使用する。
export function openYouTubePlayer(items, startIndex = 0, { shorts = false, host } = {}) {
  if (!host) return null;
  return mountYouTubePlayer({ host, queue: items, index: startIndex, shorts });
}
