import { setScreen, renderNav, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';
import { renderHome } from './features/home/home.js';
import { renderWeather } from './features/weather/weather.js';
import { renderReader } from './features/reader/reader.js';
import { renderMedia } from './features/media/media.js';
import { renderTwitter } from './features/twitter/twitter.js';
import { renderSettings } from './features/settings/settings.js';
import { handleTwitchOAuthReturn } from './features/twitch/twitch-chat.js';

const root = document.getElementById('app-main');
const renderers = {
  home: renderHome,
  weather: renderWeather,
  reader: renderReader,
  media: renderMedia,
  twitter: renderTwitter,
  settings: renderSettings
};

let renderSerial = 0;

export async function navigate(screen, options = {}) {
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate', { detail: { screen } }));
  if (!renderers[screen]) screen = 'home';
  if (options.readerMode) update('lastReaderMode', options.readerMode);
  if (options.mediaMode) update('lastMediaMode', options.mediaMode);
  if (options.paperTrack) update('paperTrack', options.paperTrack);
  setScreen(screen);
  renderNav(navigate);
  const serial = ++renderSerial;
  root.replaceChildren();
  const renderer = renderers[screen];
  try {
    await renderer(root, { navigate, refresh: Boolean(options.refresh) });
  } catch (err) {
    console.error('[pdv2] render failed:', screen, err);
    if (serial === renderSerial) {
      root.innerHTML = `<section class="screen"><div class="error-box">画面を表示できませんでした<br><small>${String(err?.message || err)}</small></div></section>`;
    }
  }
}

async function boot() {
  applyTheme();
  await handleTwitchOAuthReturn().catch(err => console.warn('[twitch-oauth]', err));
  renderNav(navigate);
  await navigate(state.screen || 'home');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[sw]', err));
  }

  window.addEventListener('pdv2:settings-changed', applyTheme);
  window.addEventListener('popstate', () => navigate(state.screen || 'home'));
}

boot();
