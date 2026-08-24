const LANDSCAPE_CLASS = 'youtube-css-landscape';
const UI_CLASS = 'pdv2-landscape-ui-visible';
const PANEL_SELECTOR = '.twitch-inline-player.youtube-css-landscape';
const VIEWPORT_SELECTOR = '.youtube-landscape-viewport';
const CONTROLS_SELECTOR = '.youtube-landscape-controls';
const HIDE_DELAY_MS = 2800;
const timers = new WeakMap();
let restoreTwitchLandscapeUntil = 0;

function viewportMetrics(panel) {
  const viewport = window.visualViewport;
  const width = Math.max(1, Number(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1));
  const height = Math.max(1, Number(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1));
  const left = Number(viewport?.offsetLeft || 0);
  const top = Number(viewport?.offsetTop || 0);
  panel.style.setProperty('--pdv2-media-vw', `${width}px`);
  panel.style.setProperty('--pdv2-media-vh', `${height}px`);
  panel.style.setProperty('--pdv2-media-left', `${left}px`);
  panel.style.setProperty('--pdv2-media-top', `${top}px`);
}

function clearTimer(panel) {
  const timer = timers.get(panel);
  if (timer) clearTimeout(timer);
  timers.delete(panel);
}

function hideUi(panel) {
  clearTimer(panel);
  panel?.classList.remove(UI_CLASS);
}

function showUi(panel) {
  if (!panel?.isConnected || !panel.classList.contains(LANDSCAPE_CLASS)) return;
  viewportMetrics(panel);
  rotateLandscapeControls(panel);
  panel.classList.add(UI_CLASS);
  clearTimer(panel);
  timers.set(panel, setTimeout(() => {
    if (panel.isConnected && panel.classList.contains(LANDSCAPE_CLASS)) panel.classList.remove(UI_CLASS);
    timers.delete(panel);
  }, HIDE_DELAY_MS));
}

// v2.19.17: プレーヤーstageと同じ時計回り90°へ操作バー全体を回す。
// 端末を動画と同じ向きに持ち替えた時、前・縦表示・次が自然な横並びになる位置へ置く。
function rotateLandscapeControls(panel) {
  if (!panel?.classList.contains(LANDSCAPE_CLASS)) return;
  const controls = panel.querySelector(CONTROLS_SELECTOR);
  if (!controls) return;
  controls.style.setProperty('position', 'absolute', 'important');
  controls.style.setProperty('left', 'max(48px, calc(env(safe-area-inset-left) + 42px))', 'important');
  controls.style.setProperty('top', '50%', 'important');
  controls.style.setProperty('bottom', 'auto', 'important');
  controls.style.setProperty('width', 'min(calc(var(--pdv2-media-vh, 100dvh) - 28px), 620px)', 'important');
  controls.style.setProperty('max-width', 'calc(var(--pdv2-media-vh, 100dvh) - 28px)', 'important');
  controls.style.setProperty('transform', 'translate3d(-50%, -50%, 0) rotate(90deg)', 'important');
  controls.style.setProperty('-webkit-transform', 'translate3d(-50%, -50%, 0) rotate(90deg)', 'important');
  controls.style.setProperty('transform-origin', 'center center', 'important');
  controls.style.setProperty('-webkit-transform-origin', 'center center', 'important');
}

function clearLandscapeControls(panel) {
  const controls = panel?.querySelector?.(CONTROLS_SELECTOR);
  if (!controls) return;
  for (const name of ['position','left','top','bottom','width','max-width','transform','-webkit-transform','transform-origin','-webkit-transform-origin']) {
    controls.style.removeProperty(name);
  }
}

function ensureTapCatcher(panel) {
  const viewport = panel.querySelector(VIEWPORT_SELECTOR);
  if (!viewport) return;
  let catcher = viewport.querySelector(':scope > .media-landscape-tap-catcher');
  if (!catcher) {
    catcher = document.createElement('button');
    catcher.type = 'button';
    catcher.className = 'media-landscape-tap-catcher';
    catcher.setAttribute('aria-label', 'プレーヤー操作を表示');
    viewport.append(catcher);
  }
  if (catcher.dataset.pdv2LandscapeUx !== '1') {
    catcher.dataset.pdv2LandscapeUx = '1';
    catcher.addEventListener('click', () => showUi(panel));
  }

  const controls = viewport.querySelector(CONTROLS_SELECTOR);
  if (controls && controls.dataset.pdv2LandscapeUx !== '1') {
    controls.dataset.pdv2LandscapeUx = '1';
    const keepVisible = () => showUi(panel);
    controls.addEventListener('pointerdown', keepVisible, { passive: true });
    controls.addEventListener('touchstart', keepVisible, { passive: true });
    controls.addEventListener('click', keepVisible);
  }
  rotateLandscapeControls(panel);
}

function isTwitchPanel(panel) {
  return panel?.classList.contains('twitch-youtube-landscape-player');
}

function forceLandscape(panel) {
  if (!panel?.isConnected) return;
  panel.classList.remove('twitch-css-landscape');
  panel.classList.add(LANDSCAPE_CLASS);
  document.documentElement.classList.add('media-player-open', 'youtube-landscape-open');
  document.body.classList.add('youtube-landscape-open');
  viewportMetrics(panel);
  ensureTapCatcher(panel);
  showUi(panel);
}

function preparePanel(panel) {
  if (!panel?.isConnected) return;
  viewportMetrics(panel);
  ensureTapCatcher(panel);
  showUi(panel);
}

function scan(root = document) {
  const panels = [];
  if (root.matches?.(PANEL_SELECTOR)) panels.push(root);
  root.querySelectorAll?.(PANEL_SELECTOR).forEach(panel => panels.push(panel));
  for (const panel of panels) preparePanel(panel);

  // Twitchの前/次は内部renderでpanelを作り直すため、横表示を復元する。
  if (Date.now() < restoreTwitchLandscapeUntil) {
    const twitch = [...document.querySelectorAll('.twitch-inline-player.twitch-youtube-landscape-player')].at(-1);
    if (twitch && !twitch.classList.contains(LANDSCAPE_CLASS)) forceLandscape(twitch);
  }
}

function onLandscapeAction(event) {
  const button = event.target instanceof Element ? event.target.closest('.youtube-landscape-action') : null;
  const panel = button?.closest('.twitch-inline-player');
  if (!button || !panel?.classList.contains(LANDSCAPE_CLASS)) return;
  showUi(panel);
  if (isTwitchPanel(panel) && /前の動画|次の動画/.test(button.getAttribute('aria-label') || '')) {
    restoreTwitchLandscapeUntil = Date.now() + 1200;
  }
}

function syncAll() {
  document.querySelectorAll(PANEL_SELECTOR).forEach(panel => {
    viewportMetrics(panel);
    rotateLandscapeControls(panel);
  });
}

if (typeof window !== 'undefined' && !window.__PDV2_MEDIA_LANDSCAPE_UX_INSTALLED) {
  window.__PDV2_MEDIA_LANDSCAPE_UX_INSTALLED = true;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const panel = record.target;
        const wasLandscape = String(record.oldValue || '').split(/\s+/).includes(LANDSCAPE_CLASS);
        const isLandscape = panel instanceof Element && panel.classList.contains(LANDSCAPE_CLASS);
        if (isLandscape && !wasLandscape) preparePanel(panel);
        else if (!isLandscape && wasLandscape && panel instanceof Element) {
          hideUi(panel);
          clearLandscapeControls(panel);
        }
      }
      record.addedNodes.forEach(node => { if (node instanceof Element) scan(node); });
    }
  });
  const start = () => {
    scan();
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  };
  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
  document.addEventListener('click', onLandscapeAction, true);
  window.addEventListener('resize', syncAll, { passive: true });
  window.visualViewport?.addEventListener('resize', syncAll, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncAll, { passive: true });
}

export { showUi, hideUi };
