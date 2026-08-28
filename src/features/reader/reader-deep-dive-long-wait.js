const SEARCH_ROUTE = 'reader-deep-dive';
const SEARCH_MAX_MS = 7800;
const ENRICH_MAX_MS = 10000;
const SOFT_WAIT_MS = 3000;
const FINGERPRINT_MARKER = 'reader-deep-dive-fingerprint-version';
const FINGERPRINT_VERSION = 'fingerprint-source-language-v4-ja-output-dots';

function clearPreFingerprintCache() {
  try {
    if (localStorage.getItem(FINGERPRINT_MARKER) === FINGERPRINT_VERSION) return;
    localStorage.removeItem('reader-deep-dive-cache-v1');
    localStorage.removeItem('reader-deep-dive-cache-v2');
    localStorage.setItem(FINGERPRINT_MARKER, FINGERPRINT_VERSION);
  } catch {}
}

function detectLanguage(value = '') {
  const text = String(value || '');
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return ja >= 4 && ja >= latin * 0.35 ? 'ja' : 'en';
}

function parseDeepDive(input, init = {}) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  try {
    const url = new URL(typeof input === 'string' ? input : input?.url || '', location.href);
    if (url.pathname !== '/api/research' || url.searchParams.get('__route') !== SEARCH_ROUTE) return null;
    const body = JSON.parse(init.body);
    if (!body || !['search', 'enrich'].includes(body.phase)) return null;
    return { body, url };
  } catch {
    return null;
  }
}

function jsonResponse(data, sourceResponse) {
  const headers = new Headers(sourceResponse?.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), {
    status: sourceResponse?.status || 200,
    statusText: sourceResponse?.statusText || 'OK',
    headers
  });
}

async function fetchWithTimeout(upstream, input, init, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await upstream(input, { ...init, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function blankDisplay(data, sourceLanguage) {
  return {
    ...data,
    timeline: [], perspectives: [], regionGap: [], future: [], nextWatch: [],
    sourceLanguage,
    enriched: false,
    translationPending: true
  };
}

function installLongSearchWait() {
  if (window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V4) return;
  window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V4 = true;
  const upstream = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function readerDeepLongWaitFetch(input, init = {}) {
    const parsed = parseDeepDive(input, init);
    if (!parsed || parsed.body.phase !== 'search') return upstream(input, init);

    const sourceLanguage = parsed.body.sourceLanguage === 'ja' || parsed.body.sourceLanguage === 'en'
      ? parsed.body.sourceLanguage
      : detectLanguage(parsed.body.title || parsed.body.summary);
    const searchBody = { ...parsed.body, sourceLanguage };
    const searchResponse = await fetchWithTimeout(upstream, input, init, searchBody, SEARCH_MAX_MS);
    if (!searchResponse.ok) return searchResponse;

    const searchData = await searchResponse.clone().json().catch(() => null);
    if (!searchData || sourceLanguage === 'ja' || !Array.isArray(searchData.evidence) || !searchData.evidence.length) {
      return searchData ? jsonResponse({ ...searchData, sourceLanguage }, searchResponse) : searchResponse;
    }

    // Foreign-language sources are searched in their source language, but the UI must remain Japanese.
    // Enrich immediately with the already-fetched Tavily evidence; this does NOT issue another Tavily search.
    try {
      const enrichBody = { ...searchBody, phase: 'enrich', evidence: searchData.evidence };
      const enrichResponse = await fetchWithTimeout(upstream, input, init, enrichBody, ENRICH_MAX_MS);
      if (enrichResponse.ok) {
        const enriched = await enrichResponse.clone().json().catch(() => null);
        if (enriched) {
          return jsonResponse({
            ...searchData,
            ...enriched,
            evidence: searchData.evidence,
            sourceCount: searchData.sourceCount,
            sourceLanguage,
            translationPending: false
          }, searchResponse);
        }
      }
    } catch {}

    // Never flash English/foreign fallback text. The existing delayed enrich path can retry later.
    return jsonResponse(blankDisplay(searchData, sourceLanguage), searchResponse);
  };
}

function installDeepUiPatchStyle() {
  if (document.getElementById('reader-deep-ui-patch-v4')) return;
  const style = document.createElement('style');
  style.id = 'reader-deep-ui-patch-v4';
  style.textContent = `
.reader-deep-idle-dots{bottom:126px!important}
.reader-story-card.reader-deep-enabled .reader-deep-idle-dots{display:none!important}
.reader-deep-view>.reader-deep-badge{align-items:center!important;justify-content:center!important}
`;
  document.head.append(style);
}

function syncDeepTitles(card) {
  if (!(card instanceof Element) || !card.classList.contains('reader-deep-enabled')) return;
  const nowTitle = String(card.querySelector('.reader-deep-now [data-reader-title]')?.textContent || '').trim();
  if (!nowTitle || detectLanguage(nowTitle) !== 'ja') return;
  card.querySelectorAll('.reader-deep-title').forEach(title => {
    if (String(title.textContent || '').trim() !== nowTitle) title.textContent = nowTitle;
  });
}

function ensureIdleDots(card) {
  if (!(card instanceof Element) || !card.matches('.reader-story-card') || !card.closest('.reader-focus-open')) return;
  if (card.classList.contains('reader-deep-enabled')) return;
  if (card.querySelector(':scope > .reader-deep-idle-dots')) return;
  const wrap = document.createElement('div');
  wrap.className = 'reader-deep-dots reader-deep-idle-dots';
  for (let index = 0; index < 4; index += 1) {
    const dot = document.createElement('span');
    dot.className = `reader-deep-dot${index === 0 ? ' is-active' : ''}`;
    wrap.append(dot);
  }
  card.append(wrap);
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
    if (root.matches('.reader-story-card')) ensureIdleDots(root);
    syncDeepTitles(root.closest?.('.reader-story-card'));
  }
  root.querySelectorAll?.('.reader-deep-loading').forEach(armLoading);
  root.querySelectorAll?.('.reader-deep-error').forEach(fixError);
  root.querySelectorAll?.('.reader-story-card').forEach(card => { ensureIdleDots(card); syncDeepTitles(card); });
}

function observe() {
  installDeepUiPatchStyle();
  scan(document);
  new MutationObserver(records => {
    for (const record of records) {
      syncDeepTitles(record.target?.closest?.('.reader-story-card'));
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

if (typeof window !== 'undefined') {
  clearPreFingerprintCache();
  installLongSearchWait();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
}
