import { setScreen, renderNav, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';
import { renderHome } from './features/home/home.js';
import { renderWeather } from './features/weather/weather.js';
import { renderReader, warmReaderRecommendations } from './features/reader/reader.js';
import { renderMedia } from './features/media/media.js';
import { renderTwitter, warmTwitterFeeds } from './features/twitter/twitter.js';
import { renderWikipedia } from './features/wikipedia/wikipedia.js';
import { renderSettings } from './features/settings/settings.js';
import { handleTwitchOAuthReturn } from './features/twitch/twitch-chat.js';

const root = document.getElementById('app-main');
const renderers = { home: renderHome, weather: renderWeather, reader: renderReader, media: renderMedia, twitter: renderTwitter, wikipedia: renderWikipedia, settings: renderSettings };
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
  try {
    await renderers[screen](root, { navigate, refresh: Boolean(options.refresh) });
  } catch (err) {
    console.error('[pdv2] render failed:', screen, err);
    if (serial === renderSerial) {
      root.innerHTML = `<section class="screen"><div class="error-box">画面を表示できませんでした<br><small>${String(err?.message || err)}</small></div></section>`;
    }
  }
}

async function boot() {
  applyTheme();

  // 独創研究の日付/検索ロジックをV2.9で変更したため、旧1/1補完データを1回だけ破棄する。
  if (localStorage.getItem('pdv2:creativeCacheVersion') !== 'v211') {
    localStorage.removeItem('pdv2:readerCache:papers:creative');
    localStorage.removeItem('pdv2:mixedRecommendations:v211');
    localStorage.setItem('pdv2:creativeCacheVersion', 'v211');
  }

  // SNSは画面を開く前から裏で取得開始。Render/RSSHubが寝ていても他画面を見ている間に起こす。
  warmTwitterFeeds().catch(err => console.warn('[twitter-warm]', err));

  await handleTwitchOAuthReturn().catch(err => console.warn('[twitch-oauth]', err));
  renderNav(navigate);

  // V2.9: PWA/ブラウザを起動した時は、前回終了画面に関係なく必ずホームから始める。
  await navigate('home');

  // V2.11: ホームを見ている間にReaderおすすめ候補を先に温める。
  // 画面表示をブロックせず、キャッシュがある場合はほぼ即完了する。
  setTimeout(() => {
    warmReaderRecommendations().catch(err => console.warn('[reader-warm]', err));
  }, 450);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[sw]', err));
  window.addEventListener('pdv2:settings-changed', applyTheme);
  window.addEventListener('pdv2:context-changed', () => { applyTheme(); renderNav(navigate); });
  window.addEventListener('popstate', () => navigate(state.screen || 'home'));
}

boot();
