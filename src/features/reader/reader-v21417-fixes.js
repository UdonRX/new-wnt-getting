/*
 * Personal Dashboard v2.14.17 — Reader runtime fixes
 *
 * 1) Hide Reader category/feed chips while the full-screen summary card is open.
 * 2) Prevent Safari localStorage QuotaExceededError from escaping into the UI.
 * 3) Do not spend Gemini quota on off-screen summary prefetches: wait until that card
 *    actually becomes active, then request /api/summary.
 * 4) If an old deployment still returns quota/429, synthesize a readable local summary.
 */

const SUMMARY_ENDPOINT = '/api/summary';
const GEMINI_BLOCK_KEY = 'pdv2:geminiSummaryBlockedUntil:v21417';
const QUOTA_BLOCK_MS = 60 * 60 * 1000;
const BACKGROUND_WAIT_MS = 45 * 1000;

function isQuotaError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return error?.name === 'QuotaExceededError' ||
    error?.code === 22 ||
    /quota|storage.*full|exceeded/.test(text);
}

function storageAvailable() {
  try { return Boolean(window.localStorage); } catch { return false; }
}

function purgeDisposableCaches(storage, originalRemoveItem) {
  const exact = new Set([
    'pdv2:paperTitleJa',
    'pdv2:mixedRecommendations:v211'
  ]);
  const prefixes = [
    'reader-summary-cache-',
    'pdv2:readerCache:',
    'pdv2:twitterWarm:',
    'pdv2:mixedRecommendations:',
    'pdv2:rank:'
  ];

  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    if (exact.has(key) || prefixes.some(prefix => key.startsWith(prefix))) keys.push(key);
  }
  keys.forEach(key => {
    try { originalRemoveItem.call(storage, key); } catch (_) {}
  });
}

function installStorageQuotaGuard() {
  if (!storageAvailable() || window.__pdv21417StorageGuard) return;
  window.__pdv21417StorageGuard = true;

  const proto = Storage.prototype;
  const originalSetItem = proto.setItem;
  const originalRemoveItem = proto.removeItem;

  const disposableWrite = /^(?:reader-summary-cache-|pdv2:readerCache:|pdv2:twitterWarm:|pdv2:mixedRecommendations:|pdv2:rank:|pdv2:lastReaderSeen:|pdv2:read:)/;

  proto.setItem = function patchedSetItem(key, value) {
    try {
      return originalSetItem.call(this, key, value);
    } catch (error) {
      let isLocal = false;
      try { isLocal = this === window.localStorage; } catch (_) {}
      if (!isLocal || !isQuotaError(error)) throw error;

      // Delete only reproducible caches. User settings / feed registrations stay intact.
      purgeDisposableCaches(this, originalRemoveItem);

      try {
        return originalSetItem.call(this, key, value);
      } catch (retryError) {
        // Cache/history writes are optional. Never surface Safari's English quota error.
        if (disposableWrite.test(String(key || '')) || isQuotaError(retryError)) {
          console.warn('[reader-storage] local cache write skipped after quota cleanup:', key);
          return undefined;
        }
        throw retryError;
      }
    }
  };
}

function syncReaderChrome() {
  const screen = document.querySelector('.reader-screen');
  if (!screen) return;

  const summaryOpen = Boolean(screen.querySelector('.reader-swipe-feed'));
  screen.classList.toggle('reader-ai-summary-open', summaryOpen);

  const hideWhileSummary = [
    screen.querySelector('.reader-mode-nav'),
    screen.querySelector('.paper-track-level'),
    screen.querySelector('.reader-lowest-tabs-host')
  ];
  hideWhileSummary.forEach(node => {
    if (node) node.hidden = summaryOpen;
  });

  const sticky = screen.querySelector('.reader-sticky-context');
  if (sticky) sticky.classList.toggle('reader-summary-progress-only', summaryOpen);
}

function installReaderChromeObserver() {
  if (window.__pdv21417ReaderChromeObserver) return;
  const observer = new MutationObserver(() => requestAnimationFrame(syncReaderChrome));
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.__pdv21417ReaderChromeObserver = observer;
  syncReaderChrome();
}

function normalizeUrl(value = '') {
  try {
    const url = new URL(String(value || ''), location.href);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(value || '').replace(/\/$/, '');
  }
}

function activeReaderCard() {
  return document.querySelector('.reader-screen .reader-story-card.is-active') ||
    document.querySelector('.reader-screen .reader-story-card[data-index="0"]');
}

function requestMatchesActiveCard(payload) {
  const card = activeReaderCard();
  if (!card) return true;

  const activeHref = normalizeUrl(card.querySelector('.reader-story-open')?.href || '');
  const requestHref = normalizeUrl(payload?.url || payload?.link || '');
  if (activeHref && requestHref && activeHref === requestHref) return true;

  const activeTitle = String(card.querySelector('[data-reader-title]')?.textContent || '').replace(/\s+/g, ' ').trim();
  const requestTitle = String(payload?.title || '').replace(/\s+/g, ' ').trim();
  return Boolean(activeTitle && requestTitle && (activeTitle === requestTitle || activeTitle.includes(requestTitle) || requestTitle.includes(activeTitle)));
}

function waitUntilActive(payload, timeoutMs = BACKGROUND_WAIT_MS) {
  if (requestMatchesActiveCard(payload)) return Promise.resolve(true);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
      if (ok) resolve(true);
      else reject(error);
    };

    const check = () => {
      if (!document.querySelector('.reader-screen')) {
        const abortError = new DOMException('Readerを離れたため要約先読みを中止しました', 'AbortError');
        finish(false, abortError);
        return;
      }
      if (requestMatchesActiveCard(payload)) finish(true);
    };

    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const interval = setInterval(check, 450);
    const timer = setTimeout(() => {
      const abortError = new DOMException('未表示カードの要約先読みを中止しました', 'AbortError');
      finish(false, abortError);
    }, timeoutMs);
    check();
  });
}

function cleanText(value = '', max = 5000) {
  const div = document.createElement('div');
  div.innerHTML = String(value || '');
  return String(div.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sentenceRows(value = '') {
  return (cleanText(value).match(/[^。！？!?]+[。！？!?]?/g) || [])
    .map(row => row.trim())
    .filter(row => row.length >= 5);
}

function clampSentence(value = '', max = 40) {
  let text = cleanText(value, 400);
  if (!text) return '';
  if (Array.from(text).length <= max) return text;
  const head = Array.from(text).slice(0, max).join('');
  const matches = [...head.matchAll(/[。！？!?、，,]|(?:ため|ので|では|には|から|まで|より|は|が|を|で|に|へ|も|と)/g)]
    .map(match => match.index + match[0].length)
    .filter(index => index >= Math.floor(max * .58));
  const cut = matches.length ? matches[matches.length - 1] : max;
  text = Array.from(head).slice(0, cut).join('').replace(/[、，,\s]+$/g, '').trim();
  if (text && !/[。！？!?]$/.test(text)) text += '。';
  return text;
}

function clientFallback(payload, reason = 'client-fallback') {
  const title = cleanText(payload?.title, 500) || '記事のポイント';
  const rows = sentenceRows(payload?.description);
  const conclusion = clampSentence(rows[0] || title, 40) || '記事の中心となる内容を確認できます。';
  const background = clampSentence(rows[1] || '背景や特徴は元記事で詳しく確認できます。', 40);
  const impact = clampSentence(rows[2] || '今後の動きや影響に注目が必要です。', 40);
  return {
    headline: clampSentence(title, 35) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: conclusion },
      { label: '背景/特徴', text: background },
      { label: '影響/展望', text: impact }
    ],
    short: conclusion,
    points: [background, impact],
    tags: [],
    why: '',
    provider: 'local',
    model: '',
    contentSource: 'rss',
    extractedLength: cleanText(payload?.description).length,
    aiInputLength: 0,
    fastPath: 'client-instant-fallback-v21417',
    fallbackReason: reason,
    resolvedTitle: title
  };
}

function syntheticJsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function quotaBlocked() {
  return Date.now() < Number(safeStorageGet(GEMINI_BLOCK_KEY) || 0);
}

function blockQuota() {
  safeStorageSet(GEMINI_BLOCK_KEY, String(Date.now() + QUOTA_BLOCK_MS));
}

function isSummaryRequest(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    return url.origin === location.origin && url.pathname === SUMMARY_ENDPOINT;
  } catch {
    return false;
  }
}

function installSummaryFetchGate() {
  if (window.__pdv21417FetchGate) return;
  window.__pdv21417FetchGate = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function pdv21417Fetch(input, init = {}) {
    if (!isSummaryRequest(input, init)) return nativeFetch(input, init);

    let payload = {};
    try {
      payload = JSON.parse(String(init?.body || '{}'));
    } catch {
      return nativeFetch(input, init);
    }

    // reader-focus currently asks for current + next + next2 + previous.
    // Do not call Gemini for those hidden cards. Their pending Promise wakes as soon as
    // the user swipes the card into the active position.
    try {
      await waitUntilActive(payload);
    } catch (error) {
      throw error;
    }

    const nextPayload = {
      ...payload,
      // Normal news/knowledge stays on the fast RSS path.
      fast: payload.mode !== 'papers',
      preferFullText: payload.mode === 'papers' || Boolean(payload.preferFullText && cleanText(payload.description).length < 220),
      allowAi: quotaBlocked() ? false : payload.allowAi !== false
    };

    const nextInit = { ...init, body: JSON.stringify(nextPayload) };

    try {
      const response = await nativeFetch(input, nextInit);
      let data = null;
      try { data = await response.clone().json(); } catch (_) {}

      const message = `${data?.error || ''} ${data?.detail || ''} ${data?.fallbackReason || ''}`.toLowerCase();
      if (response.status === 429 || /quota|resource_exhausted|rate limit|too many requests|exceeded/.test(message)) {
        blockQuota();
        if (!response.ok) return syntheticJsonResponse(clientFallback(nextPayload, 'quota-client-fallback'));
      }
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Network/server trouble should not become an English error card in Reader.
      return syntheticJsonResponse(clientFallback(nextPayload, 'network-client-fallback'));
    }
  };
}

installStorageQuotaGuard();
installReaderChromeObserver();
installSummaryFetchGate();

window.addEventListener('pdv2:before-navigate', () => requestAnimationFrame(syncReaderChrome));
window.addEventListener('pdv2:booted', () => requestAnimationFrame(syncReaderChrome));
