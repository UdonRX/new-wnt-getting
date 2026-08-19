let settleRaf = 0;
let settleTimers = [];

function navElement() {
  return document.getElementById('bottom-nav');
}

function repinBottomNav() {
  const nav = navElement();
  if (!nav) return;

  // top/bottomの古いinline値が残っていた場合も必ず下端へ戻す。
  nav.style.setProperty('position', 'fixed', 'important');
  nav.style.setProperty('left', '0', 'important');
  nav.style.setProperty('right', '0', 'important');
  nav.style.setProperty('top', 'auto', 'important');
  nav.style.setProperty('bottom', '0', 'important');

  // layout readを1回入れてSafariのVisual Viewport復帰後に再計算させる。
  void nav.getBoundingClientRect();
}

export function settleBottomNavigation() {
  if (settleRaf) cancelAnimationFrame(settleRaf);
  settleRaf = requestAnimationFrame(() => {
    settleRaf = 0;
    repinBottomNav();
  });

  settleTimers.forEach(clearTimeout);
  settleTimers = [80, 180, 420].map(delay => setTimeout(repinBottomNav, delay));
}

export function initViewportStability() {
  const visual = window.visualViewport;

  window.addEventListener('pdv2:sheet-closed', settleBottomNavigation);
  window.addEventListener('pdv2:viewport-settle', settleBottomNavigation);
  window.addEventListener('resize', settleBottomNavigation, { passive: true });
  window.addEventListener('orientationchange', settleBottomNavigation, { passive: true });
  visual?.addEventListener('resize', settleBottomNavigation, { passive: true });

  // app-mainが追加/編集後に丸ごと再描画されてもnavを下端へ再固定する。
  const main = document.getElementById('app-main');
  if (main) {
    new MutationObserver(() => settleBottomNavigation()).observe(main, {
      childList: true,
      subtree: false
    });
  }

  settleBottomNavigation();
}
