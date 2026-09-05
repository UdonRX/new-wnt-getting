import { el, showToast } from '../../shared/dom.js';
import { watchPlayingTitle, clearPlayingTitle } from '../../shared/playing-title.js';
import { connectTwitchChat, hasTwitchChatToken, refreshTwitchChatStatus, startTwitchLogin } from './twitch-chat.js';

const TWITCH_PLAYBACK_KEY = 'pdv2:twitchPlayback:v1';
const TWITCH_PLAYBACK_TTL_MS = 5 * 60 * 1000;
const TWITCH_PLAYBACK_HEARTBEAT_MS = 30 * 1000;
const commentSchedulers = new WeakMap();
let cleanupChat = null;
let activeHost = null;
let landscapePanel = null;
let landscapeViewportCleanup = null;
let playbackHeartbeat = null;

function stopChat() {
  cleanupChat?.();
  cleanupChat = null;
}

function readPlaybackRecord() {
  try {
    const value = JSON.parse(localStorage.getItem(TWITCH_PLAYBACK_KEY) || 'null');
    const at = Number(value?.at || 0);
    if (!value || !value.broadcasterId || !at || Date.now() - at > TWITCH_PLAYBACK_TTL_MS) {
      localStorage.removeItem(TWITCH_PLAYBACK_KEY);
      return null;
    }
    return value;
  } catch {
    try { localStorage.removeItem(TWITCH_PLAYBACK_KEY); } catch {}
    return null;
  }
}

function savePlaybackRecord(entry) {
  const snapshot = entry?.snapshot;
  const broadcasterId = String(snapshot?.broadcaster?.id || '').trim();
  if (!broadcasterId) return;
  try {
    localStorage.setItem(TWITCH_PLAYBACK_KEY, JSON.stringify({
      at: Date.now(),
      broadcasterId,
      broadcasterLogin: String(snapshot?.broadcaster?.login || ''),
      videoId: String(entry?.videoId || '')
    }));
  } catch {}
}

function stopPlaybackHeartbeat({ clear = false } = {}) {
  if (playbackHeartbeat) clearInterval(playbackHeartbeat);
  playbackHeartbeat = null;
  if (clear) {
    try { localStorage.removeItem(TWITCH_PLAYBACK_KEY); } catch {}
  }
}

function startPlaybackHeartbeat(entry) {
  stopPlaybackHeartbeat({ clear: false });
  savePlaybackRecord(entry);
  playbackHeartbeat = setInterval(() => savePlaybackRecord(entry), TWITCH_PLAYBACK_HEARTBEAT_MS);
}

export function getRecentTwitchPlayback() {
  return readPlaybackRecord();
}

export function clearTwitchPlaybackRecovery() {
  stopPlaybackHeartbeat({ clear: true });
}

function orientationButtonHtml(landscape) {
  const label = landscape ? '縦表示' : '横表示';
  const icon = landscape
    ? '<rect x="8.3" y="3.5" width="7.4" height="17" rx="2"/><path d="M5.5 8.2 3.2 10.5l2.3 2.3M18.5 15.8l2.3-2.3-2.3-2.3"/>'
    : '<rect x="3.5" y="7.2" width="17" height="9.6" rx="2"/><path d="m9 4.5 2.2-2.2 2.2 2.2M15 19.5l-2.2 2.2-2.2-2.2"/>';
  return `<svg class="youtube-orientation-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${label}</span>`;
}

function syncLandscapeViewport(panel) {
  if (!panel) return;
  const viewport = window.visualViewport;
  const width = Math.max(1, Number(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1));
  const height = Math.max(1, Number(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1));
  const left = Number(viewport?.offsetLeft || 0);
  const top = Number(viewport?.offsetTop || 0);
  panel.style.setProperty('--pdv2-media-vw', `${width}px`);
  panel.style.setProperty('--pdv2-media-vh', `${height}px`);
  panel.style.setProperty('--pdv2-media-left', `${left}px`);
  panel.style.setProperty('--pdv2-media-top', `${top}px`);
  panel.style.setProperty('--pdv2-media-cx', `${left + width / 2}px`);
  panel.style.setProperty('--pdv2-media-cy', `${top + height / 2}px`);
}

function clearLandscapeViewport(panel) {
  if (!panel) return;
  for (const name of ['--pdv2-media-vw','--pdv2-media-vh','--pdv2-media-left','--pdv2-media-top','--pdv2-media-cx','--pdv2-media-cy']) panel.style.removeProperty(name);
}

function stopLandscapeViewportWatch() {
  landscapeViewportCleanup?.();
  landscapeViewportCleanup = null;
}

function startLandscapeViewportWatch(panel) {
  stopLandscapeViewportWatch();
  const sync = () => {
    if (panel?.isConnected && panel.classList.contains('youtube-css-landscape')) syncLandscapeViewport(panel);
  };
  window.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('scroll', sync, { passive: true });
  sync();
  landscapeViewportCleanup = () => {
    window.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
  };
}

function setLandscape(panel, on) {
  if (!panel) return;
  if (landscapePanel && landscapePanel !== panel) {
    landscapePanel.classList.remove('youtube-css-landscape', 'twitch-css-landscape', 'pdv2-landscape-ui-visible');
    clearLandscapeViewport(landscapePanel);
    stopLandscapeViewportWatch();
  }
  const enabled = Boolean(on);
  panel.classList.remove('twitch-css-landscape');
  panel.classList.toggle('youtube-css-landscape', enabled);
  landscapePanel = enabled ? panel : null;
  document.documentElement.classList.toggle('media-player-open', enabled);
  document.documentElement.classList.toggle('youtube-landscape-open', enabled);
  document.body.classList.toggle('youtube-landscape-open', enabled);
  if (enabled) startLandscapeViewportWatch(panel);
  else {
    clearLandscapeViewport(panel);
    stopLandscapeViewportWatch();
  }
  panel.querySelectorAll('.youtube-orientation-btn').forEach(button => {
    button.innerHTML = orientationButtonHtml(enabled);
    button.setAttribute('aria-label', enabled ? '縦表示に戻す' : '横表示にする');
    button.title = enabled ? '縦表示に戻す' : '横表示にする';
  });
  if (enabled) window.scrollTo({ top: 0, behavior: 'auto' });
}

export function cleanupTwitchPlayer({ clearRecovery = true } = {}) {
  clearPlayingTitle();
  stopChat();
  stopPlaybackHeartbeat({ clear: clearRecovery });
  if (landscapePanel) setLandscape(landscapePanel, false);
  stopLandscapeViewportWatch();
  landscapePanel = null;
  document.documentElement.classList.remove('media-player-open', 'youtube-landscape-open');
  document.body.classList.remove('youtube-landscape-open');
  if (activeHost?.isConnected) activeHost.replaceChildren();
  activeHost = null;
}

window.addEventListener('pdv2:before-navigate', event => {
  const detail = event?.detail || {};
  const stayingInTwitch = detail.screen === 'media' && detail.mediaMode === 'twitch';
  if (!stayingInTwitch) cleanupTwitchPlayer({ clearRecovery: true });
});

function prepareCommentOverlay(lane) {
  Object.assign(lane.style, {
    position: 'absolute', inset: '0', zIndex: '8', overflow: 'hidden',
    pointerEvents: 'none', background: 'transparent', border: '0', height: '100%'
  });
}

function appendCommentContent(comment, msg) {
  const fragments = Array.isArray(msg?.fragments) ? msg.fragments : [];
  if (!fragments.length) {
    comment.textContent = String(msg?.text || '').trim();
    return;
  }
  for (const fragment of fragments) {
    const text = String(fragment?.text || '');
    if (fragment?.type === 'emote' && fragment?.emoteId) {
      const img = document.createElement('img');
      img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(fragment.emoteId)}/default/dark/2.0`;
      img.alt = text;
      img.decoding = 'async';
      Object.assign(img.style, { height: '1.45em', width: 'auto', verticalAlign: 'middle', margin: '0 .08em' });
      img.addEventListener('error', () => img.replaceWith(document.createTextNode(text)));
      comment.append(img);
    } else {
      comment.append(document.createTextNode(text));
    }
  }
}

function schedulerFor(lane, density) {
  const trackCount = density === 'low' ? 3 : density === 'high' ? 7 : 5;
  let scheduler = commentSchedulers.get(lane);
  if (!scheduler || scheduler.trackCount !== trackCount) {
    if (scheduler?.timer) clearTimeout(scheduler.timer);
    scheduler = { queue: [], freeAt: Array(trackCount).fill(0), trackCount, timer: null };
    commentSchedulers.set(lane, scheduler);
  }
  return scheduler;
}

function drainComments(lane, scheduler) {
  scheduler.timer = null;
  if (!lane?.isConnected || !scheduler.queue.length) return;
  const now = performance.now();
  let track = 0;
  for (let i = 1; i < scheduler.freeAt.length; i += 1) if (scheduler.freeAt[i] < scheduler.freeAt[track]) track = i;
  const wait = Math.max(0, scheduler.freeAt[track] - now);
  if (wait > 8) {
    scheduler.timer = setTimeout(() => drainComments(lane, scheduler), Math.min(wait, 1000));
    return;
  }

  const msg = scheduler.queue.shift();
  const text = String(msg?.text || '').trim();
  if (!text && !Array.isArray(msg?.fragments)) {
    drainComments(lane, scheduler);
    return;
  }
  const comment = el('div', { class: 'flying-comment twitch-nico-comment' });
  appendCommentContent(comment, msg);
  Object.assign(comment.style, {
    position: 'absolute', left: '0', top: `${8 + track * (72 / Math.max(1, scheduler.trackCount - 1))}%`,
    zIndex: '9', maxWidth: 'none', whiteSpace: 'nowrap', pointerEvents: 'none',
    color: '#fff', fontSize: 'clamp(16px,4.4vw,22px)', fontWeight: '800', lineHeight: '1.25',
    textShadow: '0 1px 2px #000,0 0 5px #000', animation: 'none', transform: 'translate3d(0,0,0)',
    willChange: 'transform'
  });
  lane.append(comment);

  requestAnimationFrame(() => {
    if (!comment.isConnected) return;
    const width = Math.max(24, comment.getBoundingClientRect().width);
    const hostWidth = Math.max(240, lane.getBoundingClientRect().width);
    const speed = 88;
    const startX = hostWidth + 18;
    const endX = -(width + 24);
    const duration = Math.max(6200, Math.min(14000, ((startX - endX) / speed) * 1000));
    const releaseAfter = Math.max(1200, Math.min(duration * .55, ((width + 72) / speed) * 1000));
    scheduler.freeAt[track] = performance.now() + releaseAfter;
    const animation = comment.animate(
      [{ transform: `translate3d(${startX}px,0,0)` }, { transform: `translate3d(${endX}px,0,0)` }],
      { duration, easing: 'linear', fill: 'forwards' }
    );
    animation.finished.catch(() => {}).finally(() => comment.remove());
    if (scheduler.queue.length && !scheduler.timer) scheduler.timer = setTimeout(() => drainComments(lane, scheduler), 60);
  });
}

function addFlying(lane, msg, density = 'normal') {
  if (!lane || !msg) return;
  const scheduler = schedulerFor(lane, density);
  scheduler.queue.push(msg);
  if (scheduler.queue.length > 60) scheduler.queue.splice(0, scheduler.queue.length - 60);
  if (!scheduler.timer) drainComments(lane, scheduler);
}

function toggleLandscape(panel) {
  const on = !panel.classList.contains('youtube-css-landscape');
  setLandscape(panel, on);
  showToast(on ? '横表示に切り替えました' : '縦表示に戻しました');
}

function buildIframe(entry) {
  const live = !entry.videoId;
  const parent = location.hostname;
  const query = new URLSearchParams({ parent, autoplay: 'false', muted: 'false' });
  if (live) query.set('channel', entry.snapshot.broadcaster.login);
  else query.set('video', `v${String(entry.videoId).replace(/^v/, '')}`);
  return el('iframe', {
    src: `https://player.twitch.tv/?${query}`,
    allowfullscreen: 'true', allow: 'autoplay; fullscreen',
    title: live ? `${entry.snapshot.broadcaster.displayName} LIVE` : 'Twitch archive'
  });
}

export function mountTwitchPlayer({ host, queue, index = 0, settings }) {
  if (!host || !Array.isArray(queue) || !queue.length) return null;
  stopChat();
  stopPlaybackHeartbeat({ clear: false });
  clearPlayingTitle();
  if (landscapePanel) setLandscape(landscapePanel, false);
  activeHost = host;
  let current = Math.max(0, Math.min(index, queue.length - 1));

  const render = () => {
    stopChat();
    stopPlaybackHeartbeat({ clear: false });
    clearPlayingTitle();
    if (landscapePanel) setLandscape(landscapePanel, false);
    const entry = queue[current];
    startPlaybackHeartbeat(entry);
    const { snapshot, videoId = '' } = entry;
    const live = !videoId;
    const archive = live ? null : snapshot.archives.find(video => video.id === videoId);
    const playingTitle = live ? (snapshot.live?.title || `${snapshot.broadcaster.displayName} LIVE`) : (archive?.title || 'アーカイブ');

    const panel = el('section', { class: 'twitch-inline-player twitch-youtube-landscape-player' });
    const top = el('div', { class: 'twitch-inline-head youtube-player-head' });
    top.append(
      el('div', {}, [el('div', { class: 'twitch-inline-kicker', text: live ? 'LIVE' : 'アーカイブ' }), el('strong', { text: snapshot.broadcaster.displayName })]),
      el('button', { class: 'icon-button twitch-close', type: 'button', 'aria-label': 'プレイヤーを閉じる', text: '✕', onclick: () => cleanupTwitchPlayer({ clearRecovery: true }) })
    );

    const stage = el('div', { class: 'twitch-inline-stage youtube-inline-stage' });
    const min = el('div', { class: 'twitch-embed-min' });
    min.append(buildIframe(entry));
    stage.append(min);
    const commentLane = el('div', { class: 'twitch-comment-lane twitch-comment-overlay', 'aria-hidden': 'true' });
    prepareCommentOverlay(commentLane);
    if (live) stage.append(commentLane);

    const info = el('div', { class: 'twitch-inline-info' });
    info.append(el('div', { class: 'player-title', text: playingTitle }));
    const status = el('div', { class: 'source-note twitch-chat-status', 'aria-live': 'polite' });

    const prev = el('button', { class: 'player-soft', type: 'button', text: '‹ 前へ', disabled: current <= 0, onclick: () => { if (current > 0) { current -= 1; render(); } } });
    const next = el('button', { class: 'player-soft', type: 'button', text: '次へ ›', disabled: current >= queue.length - 1, onclick: () => { if (current < queue.length - 1) { current += 1; render(); } } });
    const landscape = el('button', { class: 'player-soft twitch-orientation-btn youtube-orientation-btn', type: 'button', html: orientationButtonHtml(false), 'aria-label': '横表示にする', title: '横表示にする', onclick: () => toggleLandscape(panel) });
    const external = el('a', { class: 'player-soft', target: '_blank', rel: 'noopener noreferrer', href: live ? snapshot.live.url : `https://www.twitch.tv/videos/${videoId}`, text: 'Twitchで開く ↗' });
    const controls = el('div', { class: 'twitch-inline-controls' }, [prev, next, landscape, external]);

    if (live) {
      const chatBtn = el('button', { class: 'player-soft', type: 'button', text: hasTwitchChatToken() ? 'コメント開始' : 'Twitch連携' });
      chatBtn.onclick = async () => {
        if (!hasTwitchChatToken()) {
          try { await startTwitchLogin(); } catch (err) { showToast(err.message); }
          return;
        }
        if (cleanupChat) {
          stopChat();
          chatBtn.textContent = 'コメント開始';
          status.textContent = 'コメントを停止しました';
          return;
        }
        console.info('[TWITCH CHAT] START');
        chatBtn.disabled = true;
        status.textContent = '接続中';
        try {
          const auth = await refreshTwitchChatStatus({ brief: true, strict: true });
          if (!auth.connected) {
            status.textContent = auth.error ? `Twitch認証確認失敗: ${auth.error}` : 'Twitch再連携が必要です';
            chatBtn.textContent = 'Twitch連携';
            return;
          }
          console.info('[TWITCH CHAT] AUTH_OK');
          status.textContent = 'Twitch認証確認済み';
          cleanupChat = connectTwitchChat({
            broadcasterId: snapshot.broadcaster.id,
            onMessage: message => addFlying(commentLane, message, settings?.twitchCommentDensity || 'normal'),
            onStatus: value => { status.textContent = value; }
          });
          chatBtn.textContent = 'コメント停止';
        } catch (error) {
          console.error(`[TWITCH CHAT] ERROR start ${String(error?.message || error || '').slice(0, 220)}`);
          status.textContent = error?.message || 'コメント接続エラー';
          chatBtn.textContent = hasTwitchChatToken() ? 'コメント開始' : 'Twitch連携';
          stopChat();
        } finally {
          chatBtn.disabled = false;
        }
      };
      controls.append(chatBtn);
    }

    info.append(controls, status);
    const landscapePrev = el('button', { class: 'youtube-landscape-action', type: 'button', text: '‹ 前', 'aria-label': '前の動画', disabled: current <= 0, onclick: () => { if (current > 0) { current -= 1; render(); } } });
    const portrait = el('button', { class: 'youtube-landscape-action twitch-orientation-btn youtube-orientation-btn', type: 'button', html: orientationButtonHtml(true), 'aria-label': '縦表示に戻す', title: '縦表示に戻す', onclick: () => setLandscape(panel, false) });
    const landscapeNext = el('button', { class: 'youtube-landscape-action', type: 'button', text: '次 ›', 'aria-label': '次の動画', disabled: current >= queue.length - 1, onclick: () => { if (current < queue.length - 1) { current += 1; render(); } } });
    const landscapeExternal = el('a', { class: 'youtube-landscape-action', target: '_blank', rel: 'noopener noreferrer', href: live ? snapshot.live.url : `https://www.twitch.tv/videos/${videoId}`, text: 'Twitch ↗', 'aria-label': 'Twitchで開く' });
    const landscapeControls = el('footer', { class: 'youtube-landscape-controls' }, [landscapePrev, portrait, landscapeNext, landscapeExternal]);
    const landscapeViewport = el('div', { class: 'youtube-landscape-viewport' }, [stage, landscapeControls]);
    panel.append(top, landscapeViewport, info);
    activeHost.replaceChildren(panel);
    watchPlayingTitle(stage, playingTitle);
    requestAnimationFrame(() => activeHost?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  render();
  return { close: () => cleanupTwitchPlayer({ clearRecovery: true }) };
}
