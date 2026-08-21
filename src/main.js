import { setScreen, renderNav, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';

/*
 * Personal Dashboard v2.14.19
 *
 * Reader quota/UI/request gating is installed before main.js from index.html.
 * v2.14.15 で導入した feature isolation は維持しつつ、
 * Reader / SNS をタップした時に「動的 import 待ちの空画面」にならないよう修正。
 *
 * - 画面を消してから import しない。まず loading shell を表示する。
 * - Reader / SNS は Home 表示後に先読みする。
 * - import にタイムアウトを設け、versioned URL -> canonical URL の順で再試行する。
 * - 成功した module はメモリに保持し、画面切替ごとの再 import を避ける。
 * - 失敗時は必ず画面上に再試行ボタンを出す。
 */

const BUILD = '21419';
const root = document.getElementById('app-main');
let renderSerial = 0;

const modulePromises = new Map();
const importFailures = new Map();

const SCREEN = {
  home:      { path: './features/home/home.js',           exportName: 'renderHome',      label: 'ホーム' },
  weather:   { path: './features/weather/weather.js',     exportName: 'renderWeather',   label: '天気' },
  reader:    { path: './features/reader/reader.js',       exportName: 'renderReader',    label: '読む' },
  media:     { path: './features/media/media.js',         exportName: 'renderMedia',     label: '動画' },
  twitter:   { path: './features/twitter/twitter.js',     exportName: 'renderTwitter',   label: 'SNS' },
  wikipedia: { path: './features/wikipedia/wikipedia.js', exportName: 'renderWikipedia', label: 'Wikipedia' },
  settings:  { path: './features/settings/settings.js',   exportName: 'renderSettings',  label: '設定' }
};

function versioned(path) {
  return `${path}?v=${BUILD}`;
}

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

function timeoutPromise(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} の読み込みがタイムアウトしました`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function importAttempt(path, url, timeoutMs) {
  return timeoutPromise(import(url), timeoutMs, path);
}

async function importResilient(path) {
  // 1回目: build query 付き。新しいデプロイを最優先。
  try {
    return await importAttempt(path, versioned(path), 6500);
  } catch (firstError) {
    console.warn('[pdv2 module retry: versioned]', path, firstError);
    importFailures.set(path, firstError);
  }

  // 2回目: query なし。Service Worker の ignoreSearch fallback / precache を使える。
  try {
    return await importAttempt(path, path, 4500);
  } catch (secondError) {
    console.warn('[pdv2 module retry: canonical]', path, secondError);
    const first = importFailures.get(path);
    const error = new Error(
      `${path} を読み込めませんでした。${secondError?.message || first?.message || ''}`.trim()
    );
    error.cause = secondError;
    throw error;
  }
}

function loadModule(path, { force = false } = {}) {
  if (force) modulePromises.delete(path);
  if (!modulePromises.has(path)) {
    const promise = importResilient(path).catch(error => {
      // 失敗を永久キャッシュしない。次回タップの再試行を許可する。
      modulePromises.delete(path);
      throw error;
    });
    modulePromises.set(path, promise);
  }
  return modulePromises.get(path);
}

async function loadRenderer(screen, { force = false } = {}) {
  const config = SCREEN[screen];
  if (!config) throw new Error(`Unknown screen: ${screen}`);
  const module = await loadModule(config.path, { force });
  const renderer = module?.[config.exportName];
  if (typeof renderer !== 'function') {
    throw new Error(`${config.path} に ${config.exportName} がありません`);
  }
  return { module, renderer };
}

function loadingText(screen) {
  if (screen === 'reader') return '読むカードを準備しています…';
  if (screen === 'twitter') return 'SNSカードを準備しています…';
  return `${SCREEN[screen]?.label || '画面'}を準備しています…`;
}

function renderLoading(screen) {
  if (!root) return;
  root.innerHTML = `
    <section class="screen pd-feature-loading" data-pdv2-loading-screen="${screen}">
      <div class="card pd-feature-loading-card" role="status" aria-live="polite">
        <div class="pd-feature-loading-spinner" aria-hidden="true"></div>
        <div class="pd-feature-loading-title">${loadingText(screen)}</div>
      </div>
    </section>`;
}

async function clearDashboardRuntime() {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.allSettled(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.allSettled(
        keys
          .filter(key => key.startsWith('personal-dashboard-'))
          .map(key => caches.delete(key))
      );
    }
  } catch (error) {
    console.warn('[pdv2 clear runtime]', error);
  }
}

function renderScreenError(screen, error, options = {}) {
  if (!root) return;
  const label = SCREEN[screen]?.label || '画面';
  root.innerHTML = `
    <section class="screen pd-feature-error">
      <div class="error-box">
        <strong>${label}を表示できませんでした</strong><br>
        <small>${safeMessage(error)}</small>
        <div class="pd-feature-error-actions">
          <button type="button" class="soft-button" data-pdv2-feature-retry>もう一度試す</button>
          <button type="button" class="soft-button" data-pdv2-feature-cache>キャッシュを更新</button>
        </div>
      </div>
    </section>`;

  root.querySelector('[data-pdv2-feature-retry]')?.addEventListener('click', () => {
    const path = SCREEN[screen]?.path;
    if (path) modulePromises.delete(path);
    navigate(screen, { ...options, forceModuleReload: true });
  });

  root.querySelector('[data-pdv2-feature-cache]')?.addEventListener('click', async () => {
    await clearDashboardRuntime();
    location.replace(`/?v=${BUILD}&feature-recovery=${encodeURIComponent(screen)}`);
  });
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
    await clearDashboardRuntime();
    location.replace(`/?v=${BUILD}&recovered=1`);
  });
}

export async function navigate(screen, options = {}) {
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate', { detail: { screen } }));
  if (!SCREEN[screen]) screen = 'home';

  if (options.readerMode) update('lastReaderMode', options.readerMode);

  // 動画カード/下部タブから普通に「動画」へ入る時はYouTubeを初期表示。
  // ホームのTwitchカードなどmediaModeを明示した遷移だけTwitchを開く。
  if (screen === 'media' && !options.mediaMode) update('lastMediaMode', 'youtube');
  else if (options.mediaMode) update('lastMediaMode', options.mediaMode);

  if (options.paperTrack) update('paperTrack', options.paperTrack);

  setScreen(screen);
  renderNav(navigate);

  const serial = ++renderSerial;

  // v2.14.15 の root.replaceChildren() だけの空白待ちを廃止。
  // module import が遅くても必ず画面には状態を出す。
  renderLoading(screen);

  try {
    const { renderer } = await loadRenderer(screen, { force: Boolean(options.forceModuleReload) });
    if (serial !== renderSerial) return;

    await renderer(root, {
      navigate,
      refresh: Boolean(options.refresh)
    });

    // renderer が異常終了せず戻ったのに何も描画しなかった場合も空画面にしない。
    if (serial === renderSerial && root && !root.childElementCount) {
      throw new Error(`${SCREEN[screen].label} の描画結果が空です`);
    }
  } catch (error) {
    console.error('[pdv2] render failed:', screen, error);
    if (serial === renderSerial) renderScreenError(screen, error, options);
  }
}

function idle(callback, delay = 0) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: Math.max(1000, delay + 1500) });
  } else {
    setTimeout(callback, delay);
  }
}

function preloadFeature(screen, { warm = false } = {}) {
  const config = SCREEN[screen];
  if (!config) return;

  loadModule(config.path)
    .then(module => {
      if (screen === 'reader') {
        // 自然な日本語改行補助。失敗してもReader本体には影響させない。
        loadModule('./features/reader/reader-summary-wrap.js')
          .catch(error => console.warn('[reader-summary-wrap]', error));
        if (warm) return module.warmReaderRecommendations?.();
      }
      if (screen === 'twitter' && warm) return module.warmTwitterFeeds?.();
      return undefined;
    })
    .catch(error => console.warn(`[${screen}-preload]`, error));
}

function startBackgroundJobs() {
  // SNS / Reader はユーザーがタブを押す前に module graph を解決しておく。
  // v2.14.15 の「タップしてから初めて import」をやめる。
  idle(() => preloadFeature('reader', { warm: true }), 80);
  idle(() => preloadFeature('twitter', { warm: true }), 180);

  // その他の画面もアイドル時に軽く先読み。
  idle(() => preloadFeature('weather'), 450);
  idle(() => preloadFeature('media'), 700);
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

  // Twitch OAuthは失敗してもホームを止めない。
  loadModule('./features/twitch/twitch-chat.js')
    .then(module => module.handleTwitchOAuthReturn?.())
    .catch(error => console.warn('[twitch-oauth]', error));

  renderNav(navigate);
  await navigate('home');
  startBackgroundJobs();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`/sw.js?v=${BUILD}`, { updateViaCache: 'none' })
      .then(async registration => {
        try { await registration.update(); } catch (_) {}
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      })
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
