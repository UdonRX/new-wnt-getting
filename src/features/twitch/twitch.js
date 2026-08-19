import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager } from '../../shared/components.js';
import { cleanupTwitchPlayer, mountTwitchPlayer } from './twitch-player.js';

let selected = localStorage.getItem('pdv2:twitchSelected') || 'all';
let cache = [];
let loadErrors = [];

async function loadOne(channel) {
  const value = channel.value || channel.url || channel.name;
  const response = await fetch(`/api/twitch-feed?channel=${encodeURIComponent(value)}&format=json`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${channel.name || value}: ${data.error || 'Twitch取得エラー'}`);
  return data;
}

async function loadAll(force = false) {
  const key = 'pdv2:twitchCache';
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.at < 60_000) {
        cache = cached.rows || [];
        loadErrors = cached.errors || [];
        return cache;
      }
    } catch {}
  }

  const settled = await Promise.allSettled(state.twitchChannels.map(loadOne));
  cache = settled.filter(row => row.status === 'fulfilled').map(row => row.value);
  loadErrors = settled
    .filter(row => row.status === 'rejected')
    .map(row => String(row.reason?.message || row.reason));

  localStorage.setItem(key, JSON.stringify({ at: Date.now(), rows: cache, errors: loadErrors }));
  if (!cache.length && loadErrors.length) throw new Error(loadErrors.join(' / '));
  return cache;
}

function manage(onDone) {
  let sheet;
  sheet = openSheet(collectionManager({
    items: state.twitchChannels,
    fields: [
      { key: 'name', label: '表示名', placeholder: '任意' },
      { key: 'value', label: 'Twitch URL / 配信者名', placeholder: 'https://www.twitch.tv/...' }
    ],
    onSave: draft => {
      update('twitchChannels', draft);
      localStorage.removeItem('pdv2:twitchCache');
      sheet.close();
      onDone();
    }
  }), { title: 'Twitch配信者編集' });
}

function picker(onChange, onEdit) {
  const wrap = el('div');
  let sheet;

  wrap.append(el('button', {
    class: 'list-item',
    type: 'button',
    text: 'すべての配信者',
    onclick: () => {
      selected = 'all';
      localStorage.setItem('pdv2:twitchSelected', selected);
      sheet?.close();
      onChange();
    }
  }));

  cache.forEach(snapshot => wrap.append(el('button', {
    class: 'list-item',
    type: 'button',
    text: snapshot.broadcaster.displayName,
    onclick: () => {
      selected = snapshot.broadcaster.id;
      localStorage.setItem('pdv2:twitchSelected', selected);
      sheet?.close();
      onChange();
    }
  })));

  wrap.append(el('button', {
    class: 'soft-button full-button',
    type: 'button',
    text: '＋追加 / 編集',
    onclick: () => {
      sheet?.close();
      onEdit();
    }
  }));

  sheet = openSheet(wrap, { title: 'Twitch配信者' });
}

function makeQueue(rows) {
  const queue = [];
  rows.filter(snapshot => snapshot.live.isLive)
    .forEach(snapshot => queue.push({ snapshot, videoId: '' }));

  rows.flatMap(snapshot => (snapshot.archives || []).map(video => ({
    snapshot,
    videoId: video.id,
    createdAt: video.createdAt
  })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach(entry => queue.push(entry));

  return queue;
}

function unusableThumbnail(url = '') {
  const value = String(url || '').trim();
  return !value || /(?:404[_-](?:preview|processing)|processing[_-]?preview|placeholder|question)/i.test(value);
}

function channelPreview(snapshot) {
  const login = String(snapshot?.broadcaster?.login || '').trim();
  return login
    ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-640x360.jpg`
    : '';
}

/*
 * VOD生成直後などでTwitchが404_preview/processing系の画像を返す場合、
 * 「？」画像をそのまま表示せず、チャンネルプレビュー → プロフィール画像の順でフォールバックする。
 */
function archiveThumb(snapshot, video) {
  const primary = String(video?.thumbnailUrl || '');
  const preview = channelPreview(snapshot);
  const profile = String(snapshot?.broadcaster?.profileImageUrl || '');
  return {
    src: unusableThumbnail(primary) ? (preview || profile) : primary,
    preview,
    profile
  };
}

function thumbnailElement(snapshot, video) {
  const sources = archiveThumb(snapshot, video);
  const img = el('img', {
    class: 'thumb twitch-archive-thumb',
    src: sources.src || sources.profile || '',
    alt: '',
    loading: 'lazy',
    decoding: 'async'
  });

  let fallbackStep = 0;
  img.addEventListener('error', () => {
    const candidates = [sources.preview, sources.profile].filter(Boolean);
    while (fallbackStep < candidates.length) {
      const next = candidates[fallbackStep++];
      if (next && next !== img.src) {
        img.src = next;
        return;
      }
    }
    img.removeAttribute('src');
    img.classList.add('thumb-missing');
  });
  return img;
}

export async function renderTwitch(host, { refresh = false } = {}) {
  cleanupTwitchPlayer();
  host.innerHTML = '<div class="loading">Twitchを読み込み中...</div>';

  if (!state.twitchChannels.length) {
    host.replaceChildren(
      el('div', { class: 'empty', text: '配信者を追加してください' }),
      el('button', {
        class: 'primary-button full-button',
        type: 'button',
        text: 'Twitch配信者を追加',
        onclick: () => manage(() => renderTwitch(host, { refresh: true }))
      })
    );
    return;
  }

  try {
    await loadAll(refresh);
    draw();
  } catch (err) {
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }

  function draw() {
    if (selected !== 'all' && !cache.some(snapshot => snapshot.broadcaster.id === selected)) selected = 'all';

    const rows = selected === 'all'
      ? cache
      : cache.filter(snapshot => snapshot.broadcaster.id === selected);
    const queue = makeQueue(rows);
    const playerHost = el('div', { class: 'twitch-inline-player-host' });

    const play = entry => {
      const index = queue.findIndex(item =>
        item.snapshot.broadcaster.id === entry.snapshot.broadcaster.id &&
        String(item.videoId || '') === String(entry.videoId || '')
      );
      mountTwitchPlayer({
        host: playerHost,
        queue,
        index: Math.max(0, index),
        settings: state.settings
      });
    };

    const pick = el('button', {
      class: 'soft-button channel-picker',
      type: 'button',
      onclick: () => picker(draw, () => manage(() => renderTwitch(host, { refresh: true })))
    });
    pick.append(
      el('span', { text: `配信者　${selected === 'all' ? 'すべて' : rows[0]?.broadcaster.displayName || '配信者'}` }),
      el('span', { text: '⌄' })
    );

    const content = el('div');
    if (loadErrors.length) content.append(el('div', { class: 'media-warning', text: loadErrors.join(' / ') }));

    const lives = rows.filter(snapshot => snapshot.live.isLive);
    if (lives.length) {
      const fixed = el('div', { class: 'twitch-live-zone' });
      lives.forEach(snapshot => {
        const card = el('button', {
          class: 'twitch-live-card',
          type: 'button',
          onclick: () => play({ snapshot, videoId: '' })
        });
        card.append(
          el('div', { class: 'live-badge', text: '● LIVE' }),
          el('div', { class: 'media-title twitch-live-title', text: snapshot.live.title }),
          el('div', {
            class: 'media-meta',
            text: `${snapshot.broadcaster.displayName} ・ ${Number(snapshot.live.viewerCount || 0).toLocaleString()}人視聴`
          })
        );
        fixed.append(card);
      });
      content.append(fixed);
    }

    const archives = rows.flatMap(snapshot => (snapshot.archives || []).map(video => ({ snapshot, video })))
      .sort((a, b) => new Date(b.video.createdAt) - new Date(a.video.createdAt));

    if (archives.length) {
      content.append(el('div', { class: 'section-label', text: 'アーカイブ' }));
      const list = el('div', { class: 'media-list' });

      archives.forEach(({ snapshot, video }) => {
        const row = el('button', {
          class: 'media-row',
          type: 'button',
          onclick: () => play({ snapshot, videoId: video.id })
        });
        row.append(
          thumbnailElement(snapshot, video),
          el('div', {}, [
            el('div', { class: 'media-title', text: video.title || 'アーカイブ' }),
            el('div', { class: 'media-meta', text: snapshot.broadcaster.displayName })
          ])
        );
        list.append(row);
      });
      content.append(list);
    }

    if (!lives.length && !archives.length) {
      content.append(el('div', { class: 'empty', text: '配信・アーカイブがありません' }));
    }

    host.replaceChildren(pick, playerHost, content);
  }
}
