const SEARCH_ROUTE = 'reader-deep-dive';
const SEARCH_MAX_MS = 7800;
const ENRICH_MAX_MS = 10000;
const SOFT_WAIT_MS = 3000;
const FINGERPRINT_MARKER = 'reader-deep-dive-fingerprint-version';
const FINGERPRINT_VERSION = 'fingerprint-source-language-v5-ja-output-view-validation';

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

function hasJapanese(value = '') {
  return (String(value || '').match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 4;
}
function japaneseSentenceCount(value = '') {
  return (String(value || '').match(/[。！？]/g) || []).length;
}
function perspectiveLike(value = '') {
  return /(と述べ|と語|と評価|と指摘|と表明|と批判|と支持|と歓迎|と警告|と懸念|と追悼|計り知れない損失|悲し|悼|懸念|支持|批判|歓迎|警告|期待|評価|見解|主張)/.test(String(value || ''));
}
function sanitizeDeepData(data = {}, sourceLanguage = '') {
  const language = sourceLanguage || data.sourceLanguage || 'ja';
  const foreign = language !== 'ja';
  const out = { ...data, sourceLanguage: language };

  if (Array.isArray(out.timeline)) {
    out.timeline = out.timeline.filter(item => {
      if (!foreign) return true;
      const text = String(item?.text || '');
      const count = japaneseSentenceCount(text);
      return hasJapanese(text) && count >= 2 && count <= 3;
    }).slice(0, 4);
  }

  if (Array.isArray(out.perspectives)) {
    out.perspectives = out.perspectives.map(issue => {
      const views = (Array.isArray(issue?.views) ? issue.views : []).filter(view => {
        const text = String(view?.text || '');
        return hasJapanese(text) && perspectiveLike(text) && String(view?.actor || '').trim();
      }).slice(0, 2);
      if (views.length !== 2) return null;
      const actors = new Set(views.map(view => String(view.actor || '').replace(/\s+/g, '').toLowerCase()));
      return actors.size === 2 ? { ...issue, views } : null;
    }).filter(Boolean).slice(0, 2);
  }

  if (Array.isArray(out.regionGap) && foreign) {
    out.regionGap = out.regionGap.filter(item => hasJapanese(item?.japan) && hasJapanese(item?.overseas)).slice(0, 1);
  }
  if (Array.isArray(out.future) && foreign) {
    out.future = out.future.filter(item => hasJapanese(item?.text)).slice(0, 3);
  }
  if (Array.isArray(out.nextWatch) && foreign) {
    out.nextWatch = out.nextWatch.filter(item => hasJapanese(item?.event)).slice(0, 2);
  }
  return out;
}

function installLongSearchWait() {
  if (window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V5) return;
  window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V5 = true;
  const upstream = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function readerDeepLongWaitFetch(input, init = {}) {
    const parsed = parseDeepDive(input, init);
    if (!parsed) return upstream(input, init);

    if (parsed.body.phase === 'enrich') {
      const response = await upstream(input, init);
      if (!response.ok) return response;
      const data = await response.clone().json().catch(() => null);
      return data ? jsonResponse(sanitizeDeepData(data, parsed.body.sourceLanguage), response) : response;
    }

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

    // Search foreign-language publishers in their source language first, then
    // translate/summarize the already-fetched evidence. No second Tavily search.
    try {
      const enrichBody = { ...searchBody, phase: 'enrich', evidence: searchData.evidence };
      const enrichResponse = await fetchWithTimeout(upstream, input, init, enrichBody, ENRICH_MAX_MS);
      if (enrichResponse.ok) {
        const enriched = await enrichResponse.clone().json().catch(() => null);
        if (enriched) {
          return jsonResponse(sanitizeDeepData({
            ...searchData,
            ...enriched,
            evidence: searchData.evidence,
            sourceCount: searchData.sourceCount,
            sourceLanguage,
            translationPending: false
          }, sourceLanguage), searchResponse);
        }
      }
    } catch {}

    // Do not flash raw foreign-language fallback text. The delayed enrich path
    // may retry, but until then the UI stays in Japanese-only safe state.
    return jsonResponse(blankDisplay(searchData, sourceLanguage), searchResponse);
  };
}

function installDeepUiPatchStyle() {
  if (document.getElementById('reader-deep-ui-patch-v5')) return;
  const style = document.createElement('style');
  style.id = 'reader-deep-ui-patch-v5';
  style.textContent = `
.reader-focus-open .reader-story-card{position:relative}
.reader-deep-idle-dots{bottom:12px!important;z-index:14!important}
.reader-story-card.reader-deep-idle-ready:not(.reader-deep-enabled)>.reader-story-actions{transform:translateY(-42px)}
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
  card.classList.add('reader-deep-idle-ready');
  if (card.querySelector(':scope > .reader-deep-idle-dots')) return;
  const wrap = document.createElement('div');
  wrap.className = 'reader-deep-dots reader-deep-idle-dots';
  wrap.setAttribute('aria-hidden', 'true');
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
    const card = root.closest?.('.reader-story-card');
    if (card) { ensureIdleDots(card); syncDeepTitles(card); }
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
      const card = record.target?.closest?.('.reader-story-card');
      if (card) { ensureIdleDots(card); syncDeepTitles(card); }
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
