import { el, showToast } from '../../shared/dom.js';
import { watchPlayingTitle, clearPlayingTitle } from '../../shared/playing-title.js';
import { connectTwitchChat, hasTwitchChatToken, startTwitchLogin } from './twitch-chat.js';

let cleanupChat = null;
let activeHost = null;
let landscapePanel = null;

function stopChat() {
  cleanupChat?.();
  cleanupChat = null;
}

function setLandscape(panel, on) {
  if (landscapePanel && landscapePanel !== panel) {
    landscapePanel.classList.remove('twitch-css-landscape');
  }
  panel?.classList.toggle('twitch-css-landscape', Boolean(on));
  landscapePanel = on ? panel : null;
  document.documentElement.classList.toggle('media-player-open', Boolean(on));
  const button = panel?.querySelector('.twitch-orientation-btn');
  if (button) button.textContent = on ? '↕ 縦画面' : '↔ 横画面';
}

export function cleanupTwitchPlayer() {
  clearPlayingTitle();
  stopChat();
  if (landscapePanel) landscapePanel.classList.remove('twitch-css-landscape');
  landscapePanel = null;
  document.documentElement.classList.remove('media-player-open');
  if (activeHost?.isConnected) activeHost.replaceChildren();
  activeHost = null;
}

window.addEventListener('pdv2:before-navigate', cleanupTwitchPlayer);

// Twitch公式Embedを覆わないため、コメントはプレイヤー直下の専用レーンを流す。
function addFlying(lane, msg, density = 'normal') {
  const limit = density === 'low' ? 3 : density === 'high' ? 8 : 5;
  const existing = [...lane.querySelectorAll('.flying-comment')];
  while (existing.length >= limit) existing.shift()?.remove();
  const comment = el('div', { class: 'flying-comment', text: msg.text });
  comment.style.top = `${5 + Math.random() * 48}%`;
  comment.style.animationDuration = `${6 + Math.random() * 2}s`;
  lane.append(comment);
  setTimeout(() => comment.remove(), 9000);
}

function toggleLandscape(panel) {
  const on = !panel.classList.contains('twitch-css-landscape');
  setLandscape(panel, on);
  showToast(on
    ? '動画を90°回転しました。端末を横向きにして見られます。'
    : '通常表示に戻しました');
}

function buildIframe(entry) {
  const live = !entry.videoId;
  const parent = location.hostname;
  const query = new URLSearchParams({ parent, autoplay: 'false', muted: 'false' });
  if (live) query.set('channel', entry.snapshot.broadcaster.login);
  else query.set('video', `v${String(entry.videoId).replace(/^v/, '')}`);

  return el('iframe', {
    src: `https://player.twitch.tv/?${query}`,
    allowfullscreen: 'true',
    allow: 'autoplay; fullscreen',
    title: live ? `${entry.snapshot.broadcaster.displayName} LIVE` : 'Twitch archive'
  });
}

export function mountTwitchPlayer({ host, queue, index = 0, settings }) {
  if (!host || !Array.isArray(queue) || !queue.length) return null;

  stopChat();
  clearPlayingTitle();
  if (landscapePanel) setLandscape(landscapePanel, false);
  activeHost = host;
  let current = Math.max(0, Math.min(index, queue.length - 1));

  const render = () => {
    stopChat();
    clearPlayingTitle();
    if (landscapePanel) setLandscape(landscapePanel, false);

    const entry = queue[current];
    const { snapshot, videoId = '' } = entry;
    const live = !videoId;
    const archive = live ? null : snapshot.archives.find(video => video.id === videoId);
    const playingTitle = live
      ? (snapshot.live?.title || `${snapshot.broadcaster.displayName} LIVE`)
      : (archive?.title || 'アーカイブ');

    const panel = el('section', { class: 'twitch-inline-player' });
    const top = el('div', { class: 'twitch-inline-head' });
    top.append(
      el('div', {}, [
        el('div', { class: 'twitch-inline-kicker', text: live ? 'LIVE' : 'アーカイブ' }),
        el('strong', { text: snapshot.broadcaster.displayName })
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
        onclick: () => cleanupTwitchPlayer()
      })
    );

    const stage = el('div', { class: 'twitch-inline-stage' });
    const min = el('div', { class: 'twitch-embed-min' });
    min.append(buildIframe(entry));
    stage.append(min);

    const commentLane = el('div', { class: 'twitch-comment-lane' });
    commentLane.append(el('div', {
      class: 'comment-lane-placeholder',
      text: 'Twitch連携すると、ここをコメントが流れます'
    }));

    const info = el('div', { class: 'twitch-inline-info' });
    info.append(el('div', { class: 'player-title', text: playingTitle }));
    const status = el('div', { class: 'source-note' });

    const controls = el('div', { class: 'twitch-inline-controls' });
    const prev = el('button', {
      class: 'player-soft',
      type: 'button',
      text: '‹ 前へ',
      disabled: current <= 0,
      onclick: () => {
        if (current > 0) {
          current -= 1;
          render();
        }
      }
    });
    const next = el('button', {
      class: 'player-soft',
      type: 'button',
      text: '次へ ›',
      disabled: current >= queue.length - 1,
      onclick: () => {
        if (current < queue.length - 1) {
          current += 1;
          render();
        }
      }
    });
    const landscape = el('button', {
      class: 'player-soft twitch-orientation-btn',
      type: 'button',
      text: '↔ 横画面',
      onclick: () => toggleLandscape(panel)
    });
    const external = el('a', {
      class: 'player-soft',
      target: '_blank',
      rel: 'noopener noreferrer',
      href: live ? snapshot.live.url : `https://www.twitch.tv/videos/${videoId}`,
      text: 'Twitchで開く ↗'
    });
    controls.append(prev, next, landscape, external);

    if (live) {
      const chatBtn = el('button', {
        class: 'player-soft',
        type: 'button',
        text: hasTwitchChatToken() ? 'コメント開始' : 'Twitch連携'
      });

      chatBtn.onclick = async () => {
        if (!hasTwitchChatToken()) {
          try { await startTwitchLogin(); }
          catch (err) { showToast(err.message); }
          return;
        }

        if (cleanupChat) {
          stopChat();
          chatBtn.textContent = 'コメント開始';
          status.textContent = 'コメントを停止しました';
          return;
        }

        commentLane.querySelector('.comment-lane-placeholder')?.remove();
        cleanupChat = connectTwitchChat({
          broadcasterId: snapshot.broadcaster.id,
          onMessage: message => addFlying(commentLane, message, settings?.twitchCommentDensity || 'normal'),
          onStatus: value => { status.textContent = value; }
        });
        chatBtn.textContent = 'コメント停止';
      };
      controls.append(chatBtn);
    }

    info.append(controls, status);
    panel.append(top, stage);
    if (live) panel.append(commentLane);
    panel.append(info);
    activeHost.replaceChildren(panel);

    // Twitch iframeはその場に残し、画面外へ出た時だけ再生中タイトルを固定。
    watchPlayingTitle(stage, playingTitle);
    requestAnimationFrame(() => activeHost?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  render();
  return { close: cleanupTwitchPlayer };
}
