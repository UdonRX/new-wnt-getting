const RAIL_SELECTOR = '.reader-source-dock .reader-feed-chips';
const FOCUS_SELECTOR = '.reader-focus-open .reader-swipe-feed';
const railOffsets = new Map();
let touchStart = null;

function railKey(rail) {
  return [...rail.querySelectorAll(':scope > .chip')]
    .map(node => String(node.textContent || '').trim())
    .join('|');
}

function targetScrollLeft(rail, active) {
  const chips = [...rail.querySelectorAll(':scope > .chip')];
  const index = chips.indexOf(active);
  const maxLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
  if (index <= 0) return 0;
  if (index === chips.length - 1) return maxLeft;
  const railRect = rail.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const centered = rail.scrollLeft + (activeRect.left - railRect.left) - (railRect.width - activeRect.width) / 2;
  return Math.min(maxLeft, Math.max(0, centered));
}

function alignRail(rail, { behavior = 'smooth' } = {}) {
  if (!rail?.isConnected || rail.clientWidth <= 0) return false;
  const active = rail.querySelector(':scope > .chip.active');
  if (!active) return false;
  const left = targetScrollLeft(rail, active);
  if (Math.abs(rail.scrollLeft - left) <= 1) return true;
  rail.scrollTo({ left, behavior });
  return true;
}

function prepareRail(rail) {
  if (!rail || rail.dataset.pdv2ReaderRailUx === '1') return;
  rail.dataset.pdv2ReaderRailUx = '1';
  const key = railKey(rail);
  const remembered = railOffsets.get(key);
  if (Number.isFinite(remembered)) {
    const maxLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    rail.scrollLeft = Math.min(maxLeft, Math.max(0, remembered));
  }
  let raf = 0;
  rail.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      railOffsets.set(key, rail.scrollLeft);
    });
  }, { passive: true });

  // v2.19.16: DOM差し替え直後の0px位置を見せず、前位置→選択タブへ滑らかに追従する。
  requestAnimationFrame(() => requestAnimationFrame(() => alignRail(rail, { behavior: 'smooth' })));
  setTimeout(() => alignRail(rail, { behavior: 'smooth' }), 120);
}

function prepareVisibleRails(root = document) {
  root.querySelectorAll?.(RAIL_SELECTOR).forEach(prepareRail);
  if (root.matches?.(RAIL_SELECTOR)) prepareRail(root);
}

function rememberRemovedRails(node) {
  if (!(node instanceof Element)) return;
  const rails = node.matches(RAIL_SELECTOR) ? [node] : [...node.querySelectorAll(RAIL_SELECTOR)];
  for (const rail of rails) railOffsets.set(railKey(rail), rail.scrollLeft);
}

function horizontalFocusGesture(event) {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest(FOCUS_SELECTOR) || null;
}

function onTouchStart(event) {
  const feed = horizontalFocusGesture(event);
  if (!feed || event.touches?.length !== 1) { touchStart = null; return; }
  const touch = event.touches[0];
  touchStart = { feed, x: touch.clientX, y: touch.clientY };
}

function onTouchEnd(event) {
  if (!touchStart || !event.changedTouches?.length) { touchStart = null; return; }
  const start = touchStart;
  touchStart = null;
  if (!start.feed?.isConnected) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;

  // AI要約/記事フォーカスでは左右スワイプをタブ切替へ伝播させない。
  event.stopImmediatePropagation();
  if (event.cancelable) event.preventDefault();
}

if (typeof window !== 'undefined' && !window.__PDV2_READER_LIST_UX_INSTALLED) {
  window.__PDV2_READER_LIST_UX_INSTALLED = true;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.removedNodes.forEach(rememberRemovedRails);
      record.addedNodes.forEach(node => {
        if (node instanceof Element) prepareVisibleRails(node);
      });
    }
  });
  const start = () => {
    prepareVisibleRails();
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
}

export { alignRail, targetScrollLeft };
