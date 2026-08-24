const uiTimers = new WeakMap();

function showTemporaryControls(panel) {
  if (!panel?.isConnected || !panel.classList.contains('youtube-css-landscape')) return;
  const previous = uiTimers.get(panel);
  if (previous) clearTimeout(previous);
  panel.classList.add('pdv2-landscape-ui-visible');
  const timer = setTimeout(() => {
    uiTimers.delete(panel);
    if (panel.isConnected) panel.classList.remove('pdv2-landscape-ui-visible');
  }, 2800);
  uiTimers.set(panel, timer);
}

function ensureTapCatcher(panel) {
  if (!panel?.isConnected || !panel.classList.contains('youtube-css-landscape')) return;
  const viewport = panel.querySelector('.youtube-landscape-viewport');
  if (!viewport) return;
  let catcher = viewport.querySelector(':scope > .media-landscape-tap-catcher');
  if (!catcher) {
    catcher = document.createElement('button');
    catcher.type = 'button';
    catcher.className = 'media-landscape-tap-catcher';
    catcher.setAttribute('aria-label', '操作ボタンを表示');
    viewport.append(catcher);
  }
  if (catcher.dataset.pdv2MediaTap !== '1') {
    catcher.dataset.pdv2MediaTap = '1';
    catcher.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      showTemporaryControls(panel);
    });
  }
  showTemporaryControls(panel);
}

function reenterTwitchLandscape(host) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const panel = host?.querySelector?.('.twitch-inline-player');
    const button = panel?.querySelector?.('.twitch-orientation-btn.youtube-orientation-btn');
    if (button && !panel.classList.contains('youtube-css-landscape')) button.click();
  }));
}

// Twitchの横表示中だけ、前/次でrender()されても横表示を維持する。
document.addEventListener('click', event => {
  const button = event.target?.closest?.('.youtube-landscape-action');
  const panel = button?.closest?.('.twitch-inline-player.twitch-youtube-landscape-player.youtube-css-landscape');
  if (!button || !panel) return;
  const controls = button.closest('.youtube-landscape-controls');
  if (!controls) return;
  const actions = [...controls.querySelectorAll(':scope > .youtube-landscape-action')];
  const index = actions.indexOf(button);
  if (index !== 0 && index !== 2) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  const host = panel.parentElement;
  const portraitButtons = [...panel.querySelectorAll('.twitch-inline-info .twitch-inline-controls > button')];
  const target = index === 0 ? portraitButtons[0] : portraitButtons[1];
  if (!target || target.disabled) return;
  target.click();
  reenterTwitchLandscape(host);
}, true);

// 既存runtimeのcatcher生成を待ってから補強する。iframe内タップは親documentへ
// bubbleしないため、catcher自身で再表示を完結させる。
document.addEventListener('click', event => {
  const button = event.target?.closest?.('.youtube-orientation-btn');
  const panel = button?.closest?.('.twitch-inline-player');
  if (!button || !panel) return;
  setTimeout(() => ensureTapCatcher(panel), 40);
});
