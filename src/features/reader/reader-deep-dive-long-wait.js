const SEARCH_ROUTE = 'reader-deep-dive';
const SEARCH_MAX_MS = 7800;
const SOFT_WAIT_MS = 3000;
const FINGERPRINT_MARKER = 'reader-deep-dive-fingerprint-version';
const FINGERPRINT_VERSION = 'fingerprint-filter-v2';

function clearPreFingerprintCache() {
  try {
    if (localStorage.getItem(FINGERPRINT_MARKER) === FINGERPRINT_VERSION) return;
    localStorage.removeItem('reader-deep-dive-cache-v1');
    localStorage.removeItem('reader-deep-dive-cache-v2');
    localStorage.setItem(FINGERPRINT_MARKER, FINGERPRINT_VERSION);
  } catch {}
}

function parseSearch(input, init = {}) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  try {
    const url = new URL(typeof input === 'string' ? input : input?.url || '', location.href);
    if (url.pathname !== '/api/research' || url.searchParams.get('__route') !== SEARCH_ROUTE) return null;
    const body = JSON.parse(init.body);
    return body?.phase === 'search' ? body : null;
  } catch {
    return null;
  }
}

function installLongSearchWait() {
  if (window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED) return;
  window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED = true;
  const upstream = globalThis.fetch.bind(globalThis);

  globalThis.fetch = function readerDeepLongWaitFetch(input, init = {}) {
    const body = parseSearch(input, init);
    if (!body) return upstream(input, init);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_MAX_MS);
    return upstream(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

const armed = new WeakSet();
function armLoading(node) {
  if (!(node instanceof Element) || !node.matches('.reader-deep-loading') || armed.has(node)) return;
  armed.add(node);
  const label = node.firstElementChild;
  const initial = String(label?.textContent || '');
  setTimeout(() => {
    if (!node.isConnected || !label || String(label.textContent || '') !== initial) return;
    label.textContent = '検索を続けています… Tavilyの応答を待っています';
  }, SOFT_WAIT_MS);
}

function fixError(node) {
  if (!(node instanceof Element) || !node.matches('.reader-deep-error')) return;
  if (/約3秒以内に検索結果を取得できませんでした/.test(node.textContent || '')) {
    node.textContent = 'Tavily検索が7秒以内に完了しませんでした。';
  }
}

function scan(root = document) {
  if (root instanceof Element) {
    armLoading(root);
    fixError(root);
  }
  root.querySelectorAll?.('.reader-deep-loading').forEach(armLoading);
  root.querySelectorAll?.('.reader-deep-error').forEach(fixError);
}

function observe() {
  scan(document);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

let gesture = null;
function restoreFeed(shot) {
  if (!shot?.feed || !shot.feed.isConnected || !shot.feedLocked) return;
  shot.feedLocked = false;
  if (shot.restoreTimer) clearTimeout(shot.restoreTimer);
  shot.restoreTimer = 0;
  shot.feed.style.scrollSnapType = shot.snapType;
  shot.feed.style.scrollBehavior = shot.scrollBehavior;
}
function scheduleRestore(shot) {
  if (!shot?.feedLocked) return;
  if (shot.restoreTimer) clearTimeout(shot.restoreTimer);
  shot.restoreTimer = setTimeout(() => restoreFeed(shot), 520);
}
function lockFeed(shot) {
  if (!shot?.feed || shot.feedLocked) return;
  shot.feedLocked = true;
  shot.snapType = shot.feed.style.scrollSnapType;
  shot.scrollBehavior = shot.feed.style.scrollBehavior;
  shot.feed.style.scrollSnapType = 'none';
  shot.feed.style.scrollBehavior = 'auto';
}
function holdVerticalPosition(shot) {
  if (!shot?.feed || !shot.feed.isConnected) return;
  if (Math.abs(Number(shot.feed.scrollTop || 0) - shot.scrollTop) > 0.5) shot.feed.scrollTop = shot.scrollTop;
}
function clearGesture() {
  if (!gesture) return;
  restoreFeed(gesture);
  gesture = null;
}

function installDeepDiveGestureGuard() {
  if (window.__PDV2_READER_DEEP_GESTURE_GUARD_V2) return;
  window.__PDV2_READER_DEEP_GESTURE_GUARD_V2 = true;

  document.addEventListener('touchstart', event => {
    clearGesture();
    if (event.touches?.length !== 1) return;
    const target = event.target;
    if (target?.closest?.('a,button,input,textarea,select')) return;
    const card = target?.closest?.('.reader-story-card.reader-deep-enabled');
    if (!card) return;
    const point = event.touches[0];
    const feed = card.closest('.reader-swipe-feed');
    gesture = {
      card,
      feed,
      x: point.clientX,
      y: point.clientY,
      scrollTop: Number(feed?.scrollTop || 0),
      lock: 'pending',
      feedLocked: false,
      snapType: '',
      scrollBehavior: '',
      restoreTimer: 0
    };
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', event => {
    const shot = gesture;
    if (!shot || event.touches?.length !== 1 || !shot.card?.isConnected) return;
    const point = event.touches[0];
    const dx = point.clientX - shot.x;
    const dy = point.clientY - shot.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);

    if (shot.lock === 'pending' && Math.max(ax, ay) >= 10) {
      if (ax > ay * 1.18) {
        shot.lock = 'horizontal';
        lockFeed(shot);
      } else if (ay > ax * 1.18) {
        shot.lock = 'vertical';
      }
    }

    if (shot.lock !== 'horizontal') return;
    if (event.cancelable) event.preventDefault();
    holdVerticalPosition(shot);
    scheduleRestore(shot);
  }, { passive: false, capture: true });

  document.addEventListener('touchend', event => {
    const shot = gesture;
    if (!shot || !event.changedTouches?.length) return;
    const point = event.changedTouches[0];
    const dx = point.clientX - shot.x;
    const dy = point.clientY - shot.y;
    const horizontal = shot.lock === 'horizontal' || (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.18);

    if (horizontal) {
      if (event.cancelable) event.preventDefault();
      holdVerticalPosition(shot);
      // The deep-dive carousel owns every horizontal gesture, including NOW/NEXT edges.
      // This prevents the older Reader feed-switch handler from receiving the same swipe.
      event.stopImmediatePropagation();
    }
    clearGesture();
  }, { passive: false, capture: true });

  document.addEventListener('touchcancel', clearGesture, { passive: true, capture: true });
}

if (typeof window !== 'undefined') {
  clearPreFingerprintCache();
  installLongSearchWait();
  installDeepDiveGestureGuard();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
}
