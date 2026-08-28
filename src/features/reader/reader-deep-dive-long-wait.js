const SEARCH_ROUTE = 'reader-deep-dive';
const SEARCH_MAX_MS = 7800;
const ENRICH_MAX_MS = 10000;
const SOFT_WAIT_MS = 3000;
const FINGERPRINT_MARKER = 'reader-deep-dive-fingerprint-version';
const FINGERPRINT_VERSION = 'fingerprint-source-language-v6-active-dots-future-diagnostics';
const futureReasons = new Map();

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

function articleKey(value = '') { return String(value || '').trim(); }
function rememberFutureReason(articleId, reason = '') {
  const key = articleKey(articleId);
  if (!key) return;
  if (reason) futureReasons.set(key, reason);
  else futureReasons.delete(key);
}
function syncFutureReason(body = {}, data = {}) {
  if (body.lane !== 'future') return;
  const hasFuture = (Array.isArray(data.future) && data.future.length) || (Array.isArray(data.nextWatch) && data.nextWatch.length);
  if (hasFuture) {
    rememberFutureReason(body.articleId, '');
    return;
  }
  if (data.futureEmptyReason) {
    rememberFutureReason(body.articleId, data.futureEmptyReason);
    return;
  }
  if (Array.isArray(body.evidence) && body.evidence.length) rememberFutureReason(body.articleId, 'evidence-no-grounded-future');
}

function installLongSearchWait() {
  if (window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V6) return;
  window.__PDV2_READER_DEEP_LONG_WAIT_INSTALLED_V6 = true;
  const upstream = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function readerDeepLongWaitFetch(input, init = {}) {
    const parsed = parseDeepDive(input, init);
    if (!parsed) return upstream(input, init);

    if (parsed.body.phase === 'enrich') {
      const response = await upstream(input, init);
      if (!response.ok) return response;
      const data = await response.clone().json().catch(() => null);
      if (!data) return response;
      const sanitized = sanitizeDeepData(data, parsed.body.sourceLanguage);
      syncFutureReason(parsed.body, sanitized);
      return jsonResponse(sanitized, response);
    }

    const sourceLanguage = parsed.body.sourceLanguage === 'ja' || parsed.body.sourceLanguage === 'en'
      ? parsed.body.sourceLanguage
      : detectLanguage(parsed.body.title || parsed.body.summary);
    const searchBody = { ...parsed.body, sourceLanguage };
    const searchResponse = await fetchWithTimeout(upstream, input, init, searchBody, SEARCH_MAX_MS);
    if (!searchResponse.ok) return searchResponse;

    const searchData = await searchResponse.clone().json().catch(() => null);
    if (searchData) syncFutureReason(searchBody, searchData);
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
          const merged = sanitizeDeepData({
            ...searchData,
            ...enriched,
            evidence: searchData.evidence,
            sourceCount: searchData.sourceCount,
            sourceLanguage,
            translationPending: false
          }, sourceLanguage);
          syncFutureReason(enrichBody, merged);
          return jsonResponse(merged, searchResponse);
        }
      }
    } catch {}

    // Do not flash raw foreign-language fallback text. The delayed enrich path
    // may retry, but until then the UI stays in Japanese-only safe state.
    const blank = blankDisplay(searchData, sourceLanguage);
    syncFutureReason({ ...searchBody, evidence: searchData.evidence }, blank);
    return jsonResponse(blank, searchResponse);
  };
}

function installDeepUiPatchStyle() {
  if (document.getElementById('reader-deep-ui-patch-v6')) return;
  const style = document.createElement('style');
  style.id = 'reader-deep-ui-patch-v6';
  style.textContent = `
.reader-focus-open .reader-story-card.is-active:not(.reader-deep-enabled){position:relative}
.reader-focus-open .reader-story-card.is-active:not(.reader-deep-enabled)::after{
  content:'';position:absolute;z-index:14;left:50%;bottom:12px;width:43px;height:5px;transform:translateX(-50%);pointer-events:none;
  background:
    radial-gradient(circle at center,color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff) 0 2.5px,transparent 2.6px) 0 0/5px 5px no-repeat,
    linear-gradient(color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff),color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff)) 2.5px 0/8px 5px no-repeat,
    radial-gradient(circle at center,color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff) 0 2.5px,transparent 2.6px) 8px 0/5px 5px no-repeat,
    radial-gradient(circle at center,rgba(255,255,255,.22) 0 2.5px,transparent 2.6px) 18px 0/5px 5px no-repeat,
    radial-gradient(circle at center,rgba(255,255,255,.22) 0 2.5px,transparent 2.6px) 28px 0/5px 5px no-repeat,
    radial-gradient(circle at center,rgba(255,255,255,.22) 0 2.5px,transparent 2.6px) 38px 0/5px 5px no-repeat;
}
.reader-focus-open .reader-story-card.is-active:not(.reader-deep-enabled)>.reader-story-actions{transform:translateY(-42px)}
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

function conciseEmptyMessage(node) {
  const heading = String(node?.closest?.('.reader-deep-page')?.querySelector?.('.reader-deep-heading')?.textContent || '');
  if (/なぜ今/.test(heading)) return '裏付けのある過去イベントは確認できませんでした。';
  if (/どう見られている/.test(heading)) return '裏付けのある異なる視点や国内外差は確認できませんでした。';
  if (/次に何が起こる/.test(heading)) return '裏付けのある今後の予定・見解は確認できませんでした。';
  return '';
}
function fixDeepEmpty(node) {
  if (!(node instanceof Element) || !node.matches('.reader-deep-empty')) return;
  const text = conciseEmptyMessage(node);
  if (text && node.textContent !== text) node.textContent = text;
}

function scan(root = document) {
  if (root instanceof Element) {
    armLoading(root);
    fixError(root);
    fixDeepEmpty(root);
    syncDeepTitles(root.closest?.('.reader-story-card'));
  }
  root.querySelectorAll?.('.reader-deep-loading').forEach(armLoading);
  root.querySelectorAll?.('.reader-deep-error').forEach(fixError);
  root.querySelectorAll?.('.reader-deep-empty').forEach(fixDeepEmpty);
  const card = root instanceof Element ? root.closest?.('.reader-story-card') : null;
  if (card) syncDeepTitles(card);
}

function observe() {
  installDeepUiPatchStyle();
  scan(document);
  new MutationObserver(records => {
    for (const record of records) {
      const card = record.target?.closest?.('.reader-story-card');
      if (card) syncDeepTitles(card);
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
