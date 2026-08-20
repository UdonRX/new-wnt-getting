import { setScreen, renderNav, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';

/*
 * Personal Dashboard v2.14.15
 * Startup isolation:
 * - Feature screens are loaded only when needed.
 * - A broken optional feature (Twitter/Reader/etc.) no longer prevents Home from booting.
 * - Non-critical warm-up / OAuth / viewport helpers are isolated behind dynamic imports.
 */

const BUILD = '21415';
const root = document.getElementById('app-main');
let renderSerial = 0;

function versioned(path) {
  return `${path}?v=${BUILD}`;
}

async function loadModule(path) {
  return import(versioned(path));
}

const screenLoaders = {
  home: async () => (await loadModule('./features/home/home.js')).renderHome,
  weather: async () => (await loadModule('./features/weather/weather.js')).renderWeather,
  reader: async () => {
    const module = await loadModule('./features/reader/reader.js');

    // v2.14.13の自然な日本語改行はReaderを開いた時だけ読み込む。
    // 補助モジュールが失敗してもReader本体は表示できる。
    loadModule('./features/reader/reader-summary-wrap.js')
      .catch(error => console.warn('[reader-summary-wrap]', error));

    return module.renderReader;
  },
  media: async () => (await loadModule('./features/media/media.js')).renderMedia,
  twitter: async () => (await loadModule('./features/twitter/twitter.js')).renderTwitter,
  wikipedia: async () => (await loadModule('./features/wikipedia/wikipedia.js')).renderWikipedia,
  settings: async () => (await loadModule('./features/settings/settings.js')).renderSettings
};

function safeMessage(error) {
  const message = String(error?.message || error || '不明なエラー');
  return message.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function renderBootError(error) {
  console.error('[pdv2] boot failed:', error);
  if (!root) return;

  root.innerHTML = `
    <section class="screen pd-startup-error">
      <div class="error-box">
        <strong>アプリの起動に失敗しました</strong><br>
        <small>${safeMessage(error)}</small>
        <div class="pd-startup-error-actions">
          <button type="button" class="soft-button" data-pdv2-reload>再読み込み</button>
          <button type="button" class="soft-button" data-pdv2-clear-cache>キャッシュを更新</button>
        </div>
      </div>
    </section>`;

  root.querySelector('[data-pdv2-reload]')?.addEventListener('click', () => location.reload());
  root.querySelector('[data-pdv2-clear-cache]')?.addEventListener('click', async () => {
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations.map(registration => registration.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.allSettled(keys
          .filter(key => key.startsWith('personal-dashboard-'))
          .map(key => caches.delete(key)));
      }
    } catch (cacheError) {
      console.warn('[pdv2] cache recovery failed:', cacheError);
    }
    location.replace(`/?v=${BUILD}&recovered=1`);
  });
}

export async function navigate(screen, options = {}) {
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate', { detail: { screen } }));
  if (!screenLoaders[screen]) screen = 'home';

  if (options.readerMode) update('lastReaderMode', options.readerMode);

  // 動画カード/下部タブから普通に「動画」へ入る時はYouTubeを初期表示。
  // ホームのTwitchカードなどmediaModeを明示した遷移だけTwitchを開く。
  if (screen === 'media' && !options.mediaMode) update('lastMediaMode', 'youtube');
  else if (options.mediaMode) update('lastMediaMode', options.mediaMode);

  if (options.paperTrack) update('paperTrack', options.paperTrack);

  setScreen(screen);
  renderNav(navigate);

  const serial = ++renderSerial;
  root?.replaceChildren();

  try {
    const renderer = await screenLoaders[screen]();
    if (typeof renderer !== 'function') throw new Error(`${screen} renderer が見つかりません`);
    if (serial !== renderSerial) return;
    await renderer(root, { navigate, refresh: Boolean(options.refresh) });
  } catch (error) {
    console.error('[pdv2] render failed:', screen, error);
    if (serial === renderSerial && root) {
      root.innerHTML = `
        <section class="screen">
          <div class="error-box">
            <strong>${screen === 'home' ? 'ホーム' : 'この画面'}を表示できませんでした</strong><br>
            <small>${safeMessage(error)}</small>
          </div>
        </section>`;
    }
  }
}

function startBackgroundJobs() {
  // Twitterの壊れたモジュールがあってもアプリ起動を巻き込まない。
  setTimeout(() => {
    loadModule('./features/twitter/twitter.js')
      .then(module => module.warmTwitterFeeds?.())
      .catch(error => console.warn('[twitter-warm]', error));
  }, 120);

  // Readerおすすめのウォームアップもホーム描画後に分離実行。
  setTimeout(() => {
    loadModule('./features/reader/reader.js')
      .then(module => module.warmReaderRecommendations?.())
      .catch(error => console.warn('[reader-warm]', error));
  }, 450);
}

async function boot() {
  if (!root) throw new Error('#app-main が見つかりません');

  try {
    applyTheme();
  } catch (error) {
    console.warn('[theme-init]', error);
  }

  // viewport補助は失敗しても画面描画を止めない。
  loadModule('./shared/viewport-stability.js')
    .then(module => module.initViewportStability?.())
    .catch(error => console.warn('[viewport-stability]', error));

  // v2.14のおすすめキャッシュ方式へ切替。
  try {
    if (localStorage.getItem('pdv2:creativeCacheVersion') !== 'v214') {
      localStorage.removeItem('pdv2:readerCache:papers:creative');
      localStorage.removeItem('pdv2:mixedRecommendations:v211');
      localStorage.setItem('pdv2:creativeCacheVersion', 'v214');
    }
  } catch (error) {
    console.warn('[cache-migration]', error);
  }

  // Twitch OAuthは必要だが、モジュール/処理失敗でホームを止めない。
  try {
    const twitchChat = await loadModule('./features/twitch/twitch-chat.js');
    await twitchChat.handleTwitchOAuthReturn?.();
  } catch (error) {
    console.warn('[twitch-oauth]', error);
  }

  renderNav(navigate);
  await navigate('home');
  startBackgroundJobs();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`/sw.js?v=${BUILD}`, { updateViaCache: 'none' })
      .then(registration => registration.update().catch(() => {}))
      .catch(error => console.warn('[sw]', error));
  }

  window.addEventListener('pdv2:settings-changed', () => {
    try { applyTheme(); } catch (error) { console.warn('[theme]', error); }
  });
  window.addEventListener('pdv2:context-changed', () => {
    try { applyTheme(); } catch (error) { console.warn('[theme]', error); }
    try { renderNav(navigate); } catch (error) { console.warn('[nav]', error); }
  });
  window.addEventListener('popstate', () => navigate(state.screen || 'home'));

  document.documentElement.dataset.pdv2Booted = '1';
  window.dispatchEvent(new CustomEvent('pdv2:booted', { detail: { build: BUILD } }));
}

boot().catch(renderBootError);
