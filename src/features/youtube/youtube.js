import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager, segmented } from '../../shared/components.js';
import { attachSwipe } from '../../shared/gestures.js';
import { cleanupYouTubePlayer, mountYouTubePlayer } from './youtube-player.js';

const TABS = ['long', 'short', 'live'];
let tab = localStorage.getItem('pdv2:youtubeTab') || 'long';
if (!TABS.includes(tab)) tab = 'long';
let selected = localStorage.getItem('pdv2:youtubeSelected') || 'all';
let cache = [];
let loadWarnings = [];
let listSwipeDetach = null;

async function loadChannel(ch) {
  const input = ch.value || ch.url || ch.name;
  const response = await fetch(`/api/youtube-feed?channel=${encodeURIComponent(input)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${ch.name || input}: ${data.error || `YouTube取得エラー (${response.status})`}${data.reason ? ` [${data.reason}]` : ''}`);
  return data;
}
function apiWarning(row) {
  if (!row?.warning) return '';
  const reason = String(row.apiReason || '').trim();
  const detail = String(row.apiError || '').trim();
  const hay = `${reason} ${detail}`;
  if (/YOUTUBE_API_KEY.*設定/i.test(detail)) return 'YouTube Data APIキーがVercelに設定されていないため、公開フィードで表示しています。';
  if (/keyInvalid|API_KEY_INVALID|key not valid|keyExpired/i.test(hay)) return `YouTube Data APIキーが無効または期限切れです${reason ? `（${reason}）` : ''}。`;
  if (/quota|dailyLimit|rateLimit|RESOURCE_EXHAUSTED/i.test(hay)) return `YouTube Data APIの利用上限に達しています${reason ? `（${reason}）` : ''}。`;
  return `YouTube Data APIを利用できなかったため公開フィードで表示中${reason ? `（${reason}）` : ''}。${detail || ''}`;
}
async function loadAll(force = false) {
  const key = 'pdv2:youtubeCache';
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        cache = cached.rows || [];
        loadWarnings = cached.warnings || [];
        return cache;
      }
    } catch {}
  }
  const settled = await Promise.allSettled(state.youtubeChannels.map(loadChannel));
  cache = settled.filter(row => row.status === 'fulfilled').map(row => row.value);
  const failures = settled.filter(row => row.status === 'rejected').map(row => String(row.reason?.message || row.reason));
  loadWarnings = [...failures, ...cache.map(apiWarning).filter(Boolean)];
  localStorage.setItem(key, JSON.stringify({ at: Date.now(), rows: cache, warnings: loadWarnings }));
  if (!cache.length && failures.length) throw new Error(failures.join(' / '));
  return cache;
}
function channelSheet(onChange, onEdit) {
  const wrap = el('div'); let sheet;
  wrap.append(el('button', { class: `list-item ${selected === 'all' ? 'selected' : ''}`, type: 'button', text: 'すべてのチャンネル', onclick: () => { selected = 'all'; localStorage.setItem('pdv2:youtubeSelected', selected); sheet?.close(); onChange(); } }));
  cache.forEach(row => wrap.append(el('button', { class: 'list-item', type: 'button', text: row.channel?.name || 'YouTube', onclick: () => { selected = row.channel?.id || 'all'; localStorage.setItem('pdv2:youtubeSelected', selected); sheet?.close(); onChange(); } })));
  wrap.append(el('button', { class: 'soft-button full-button', type: 'button', text: '＋追加 / 編集', onclick: () => { sheet?.close(); onEdit(); } }));
  sheet = openSheet(wrap, { title: 'YouTubeチャンネル' });
}
function manage(onDone) {
  let sheet;
  sheet = openSheet(collectionManager({
    items: state.youtubeChannels,
    fields: [
      { key: 'name', label: '表示名', placeholder: '任意の名前' },
      { key: 'value', label: 'チャンネルURL / @handle / Channel ID', placeholder: '例：UCDn8Lqf-x0zD8hmFUg08f6w' }
    ],
    onSave: draft => { update('youtubeChannels', draft); localStorage.removeItem('pdv2:youtubeCache'); sheet.close(); onDone(); }
  }), { title: 'YouTubeチャンネル編集' });
}
function normalizeKind(item) { if (item.kind === 'videos') return 'long'; if (item.kind === 'shorts') return 'short'; return item.kind || 'long'; }

export async function renderYouTube(host, { refresh = false } = {}) {
  cleanupYouTubePlayer();
  listSwipeDetach?.(); listSwipeDetach = null;
  host.innerHTML = '<div class="loading">YouTubeを読み込み中...</div>';
  if (!state.youtubeChannels.length) {
    host.replaceChildren(
      el('div', { class: 'empty', text: 'チャンネルを追加してください' }),
      el('button', { class: 'primary-button full-button', type: 'button', text: 'YouTubeチャンネルを追加', onclick: () => manage(() => renderYouTube(host, { refresh: true })) })
    );
    return;
  }
  try { await loadAll(refresh); draw(); } catch (error) { host.replaceChildren(el('div', { class: 'error-box', text: error.message })); }

  function changeTab(next) {
    if (!TABS.includes(next) || next === tab) return;
    cleanupYouTubePlayer();
    tab = next;
    localStorage.setItem('pdv2:youtubeTab', tab);
    draw();
  }
  function cycleTab(delta) {
    const index = TABS.indexOf(tab);
    const next = Math.max(0, Math.min(TABS.length - 1, index + delta));
    if (next !== index) changeTab(TABS[next]);
  }
  function draw() {
    cleanupYouTubePlayer();
    if (selected !== 'all' && !cache.some(row => row.channel?.id === selected)) selected = 'all';
    const selectedRows = selected === 'all' ? cache : cache.filter(row => row.channel?.id === selected);
    const picker = el('button', { class: 'soft-button channel-picker', type: 'button', html: `<span>チャンネル　${selected === 'all' ? 'すべて' : selectedRows[0]?.channel?.name || 'YouTube'}</span><span>⌄</span>`, onclick: () => channelSheet(draw, () => manage(() => renderYouTube(host, { refresh: true }))) });
    const tabBar = el('div', { class: 'media-sticky-tabs' });
    tabBar.append(segmented([{ value: 'long', label: '動画' }, { value: 'short', label: 'Shorts' }, { value: 'live', label: 'LIVE' }], tab, changeTab));
    const playerHost = el('div', { class: 'youtube-inline-player-host twitch-inline-player-host' });
    const items = selectedRows.flatMap(row => (row.items || []).map(item => ({ ...item, kind: normalizeKind(item) })))
      .filter(item => item.kind === tab)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const list = el('div', { class: 'media-list media-swipe-list' });
    items.forEach((item, index) => {
      const row = el('button', { class: 'media-row', type: 'button', onclick: () => mountYouTubePlayer({ host: playerHost, queue: items, index, shorts: tab === 'short' }) });
      const liveLabel = tab === 'live' ? (item.liveType === 'archive' ? '<span class="archive-badge">配信録画</span> ' : item.liveType === 'upcoming' ? '<span class="upcoming-badge">配信予定</span> ' : '<span class="live-badge">LIVE</span> ') : '';
      row.innerHTML = `<img class="thumb ${tab === 'short' ? 'short-thumb' : ''}" src="${item.thumbnail || ''}" alt=""><div><div>${liveLabel}<span class="media-title">${item.title}</span></div><div class="media-meta">${item.channelName || ''}${item.premiere ? ' ・ プレミア公開' : ''}${item.liveType === 'archive' ? ' ・ 配信アーカイブ' : ''}</div></div>`;
      list.append(row);
    });
    if (!items.length) list.append(el('div', { class: 'empty', text: `${tab === 'short' ? 'Shorts' : tab === 'live' ? 'LIVE / 配信録画' : '動画'}が見つかりません` }));
    const children = [picker, tabBar, playerHost];
    if (loadWarnings.length) children.push(el('div', { class: 'media-warning', text: loadWarnings.join(' / ') }));
    children.push(list);
    host.replaceChildren(...children);
    listSwipeDetach = attachSwipe(list, { left: () => cycleTab(1), right: () => cycleTab(-1), threshold: 68 });
  }
}
