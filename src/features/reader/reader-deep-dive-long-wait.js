const SEARCH_ROUTE = 'reader-deep-dive';
const SEARCH_MAX_MS = 7800;
const SOFT_WAIT_MS = 3000;

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

if (typeof window !== 'undefined') {
  installLongSearchWait();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
}
