import { el, showToast } from '../../shared/dom.js';
import { connectTwitchChat, hasTwitchChatToken, startTwitchLogin } from './twitch-chat.js';

let cleanupChat = null;

// Twitch公式Embedを覆わないため、コメントはプレイヤー直下の専用レーンを流す。
function addFlying(lane, msg, density='normal') {
  const limit = density === 'low' ? 3 : density === 'high' ? 8 : 5;
  const existing = [...lane.querySelectorAll('.flying-comment')];
  while (existing.length >= limit) existing.shift()?.remove();
  const c = el('div', { class:'flying-comment', text:msg.text });
  c.style.top = `${6 + Math.random() * 54}%`;
  c.style.animationDuration = `${6 + Math.random() * 2}s`;
  lane.append(c);
  setTimeout(() => c.remove(), 9000);
}

function toggleLandscape(modal) {
  if (window.innerWidth < 400 && !modal.classList.contains('css-landscape')) {
    // Twitch公式Embedの最小幅400pxを下回るiPhone縦画面では横向き表示を維持する。
    modal.classList.add('css-landscape');
    showToast('Twitchは横画面表示で視聴します');
    return;
  }
  modal.classList.toggle('css-landscape');
}

export function openTwitchPlayer({ snapshot, videoId='', settings }) {
  const live = !videoId;
  const modal = el('section', { class:'player-modal twitch-player-modal' });
  const top = el('div', { class:'player-topbar' });
  const close = () => { cleanupChat?.(); cleanupChat=null; modal.remove(); };

  top.append(
    el('button', { class:'player-icon', type:'button', text:'✕', onclick:close }),
    el('strong', { text:snapshot.broadcaster.displayName }),
    el('button', { class:'player-icon', type:'button', text:'↔ 横画面', onclick:()=>toggleLandscape(modal) })
  );

  const stage = el('div', { class:'player-stage twitch-stage' });
  const parent = location.hostname;
  const q = new URLSearchParams({ parent, autoplay:'false', muted:'false' });
  if (live) q.set('channel', snapshot.broadcaster.login);
  else q.set('video', `v${String(videoId).replace(/^v/, '')}`);

  const iframe = el('iframe', {
    src:`https://player.twitch.tv/?${q}`,
    allowfullscreen:'true',
    allow:'autoplay; fullscreen',
    title:'Twitch player'
  });
  stage.append(iframe);

  const commentLane = el('div', { class:'twitch-comment-lane' });
  commentLane.append(el('div', { class:'comment-lane-placeholder', text:'コメント連携すると、ここをコメントが流れます' }));

  const body = el('div', { class:'player-body' });
  const archive = snapshot.archives.find(v => v.id === videoId);
  body.append(el('div', { class:'player-title', text:live ? snapshot.live.title : (archive?.title || 'アーカイブ') }));

  const status = el('div', { class:'source-note', text:'' });
  const actions = el('div', { class:'player-actions' });
  actions.append(el('a', {
    class:'player-soft', target:'_blank', rel:'noopener noreferrer',
    href:live ? snapshot.live.url : `https://www.twitch.tv/videos/${videoId}`,
    text:'Twitchで開く ↗'
  }));

  if (live) {
    const chatBtn = el('button', { class:'player-soft', type:'button', text:hasTwitchChatToken() ? '💬 コメント開始' : '💬 Twitch連携' });
    chatBtn.onclick = async () => {
      if (!hasTwitchChatToken()) {
        try { await startTwitchLogin(); } catch (err) { showToast(err.message); }
        return;
      }
      if (cleanupChat) {
        cleanupChat(); cleanupChat=null;
        chatBtn.textContent='💬 コメント開始';
        status.textContent='コメントを停止しました';
        return;
      }
      commentLane.querySelector('.comment-lane-placeholder')?.remove();
      cleanupChat = connectTwitchChat({
        broadcasterId:snapshot.broadcaster.id,
        onMessage:m=>addFlying(commentLane, m, settings?.twitchCommentDensity || 'normal'),
        onStatus:s=>status.textContent=s
      });
      chatBtn.textContent='💬 コメント停止';
    };
    actions.append(chatBtn);
  } else {
    commentLane.remove();
  }

  body.append(actions, status);
  modal.append(top, stage);
  if (live) modal.append(commentLane);
  modal.append(body);
  document.getElementById('overlay-root').append(modal);

  // 400px未満のiPhone縦幅では、公式Embed要件を満たすため最初から横向き表示。
  if (window.innerWidth < 400 && matchMedia('(orientation: portrait)').matches) {
    modal.classList.add('css-landscape');
  }
}
