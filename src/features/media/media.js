import { state, update } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar, segmented } from '../../shared/components.js';
import { renderYouTube } from '../youtube/youtube.js';
import { renderTwitch } from '../twitch/twitch.js';
import { applyTheme } from '../../app/router.js';

export async function renderMedia(root, { navigate, refresh = false }) {
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate', { detail: { screen: 'media', internal: true } }));
  const mode = state.mediaMode || 'youtube';
  const screen = el('section', { class: 'screen' });
  screen.append(topbar('動画', {
    subtitle: 'YouTube / Twitch',
    actions: [
      { label: '↻', title: '更新', onClick: () => renderMedia(root, { navigate, refresh: true }) },
      { label: '⚙︎', title: '設定', onClick: () => navigate('settings') }
    ]
  }));
  const segHost = el('div', { class: 'media-mode-nav' });
  const host = el('div');
  screen.append(segHost, host);
  root.replaceChildren(screen);

  segHost.replaceChildren(segmented([
    { value: 'youtube', label: 'YouTube' },
    { value: 'twitch', label: 'Twitch' }
  ], mode, value => {
    if (value === state.mediaMode) return;
    window.dispatchEvent(new CustomEvent('pdv2:before-navigate', { detail: { screen: 'media', mediaMode: value, internal: true } }));
    update('lastMediaMode', value);
    applyTheme();
    renderMedia(root, { navigate });
  }));

  if (mode === 'twitch') await renderTwitch(host, { refresh });
  else await renderYouTube(host, { refresh });
}
