import { readerTrace } from '../../shared/reader-debug.js';
import { readerSummaryRequestCoordinator } from './summary-request-coordinator.js';

const nativeFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const FAILURE_PROVIDERS = new Set(['pending', 'instant', 'insufficient', 'unavailable']);
let actualRequestCount = 0;

function parseReaderSummary(input, init = {}) {
  if (!nativeFetch || typeof window === 'undefined') return null;
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }
  if (url.pathname !== SUMMARY_PATH || url.searchParams.has('batch') || url.searchParams.has('stream')) return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  const articleId = String(body?.articleId || '').trim();
  if (!articleId) return null;
  return { url, body, articleId, mode: String(body?.mode || 'auto') };
}

function readerCards() {
  return [...document.querySelectorAll('.reader-swipe-card[data-article-id]')];
}

function currentReaderPosition(articleId) {
  const cards = readerCards();
  const activeIndex = cards.findIndex(card => card.classList.contains('is-active'));
  const activeCard = activeIndex >= 0 ? cards[activeIndex] : null;
  const activeArticleId = String(activeCard?.dataset?.articleId || '');
  const nextArticleId = String(cards[activeIndex + 1]?.dataset?.articleId || '');
  let requestType = 'background';
  if (articleId && articleId === activeArticleId) requestType = 'display';
  else if (articleId && articleId === nextArticleId) requestType = 'prefetch';
  return { cards, activeIndex, activeCard, activeArticleId, nextArticleId, requestType };
}

function providerUsable(card) {
  const provider = String(card?.dataset?.summaryProvider || '');
  return Boolean(provider) && !FAILURE_PROVIDERS.has(provider);
}

function safeJson(text = '') {
  try { return JSON.parse(String(text || '')); }
  catch { return {}; }
}

function responseSummary(data = {}) {
  return {
    provider: String(data?.provider || ''),
    model: String(data?.model || ''),
    validated: Boolean(data?.validated),
    lineCount: Array.isArray(data?.lines) ? data.lines.length : 0,
    upstreamStatus: Number(data?.upstreamStatus || 0) || 0,
    fallbackReason: String(data?.fallbackReason || '').slice(0, 260)
  };
}

function snapshotResponse(response, text) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: String(text || '')
  };
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers
  });
}

function unavailableBody({ articleId, requestId, requestType, reason, upstreamStatus = 0 }) {
  return JSON.stringify({
    articleId,
    requestId,
    requestType,
    provider: 'unavailable',
    cacheable: false,
    validated: false,
    upstreamStatus,
    fallbackReason: reason
  });
}

function suppressedSnapshot({ articleId, requestId, requestType, reason }) {
  const body = unavailableBody({ articleId, requestId, requestType, reason });
  readerTrace('gemini-suppressed', { requestId, articleId, requestType, reason });
  return {
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store']],
    body
  };
}

function shouldRunAtNetworkStart(articleId, originalType) {
  const position = currentReaderPosition(articleId);
  if (position.requestType === 'display') return { run: true, requestType: 'display', position };
  if (position.requestType === 'prefetch') {
    if (!providerUsable(position.activeCard)) {
      return { run: false, requestType: 'prefetch', reason: 'prefetch-active-summary-not-successful', position };
    }
    return { run: true, requestType: 'prefetch', position };
  }
  if (originalType === 'display') {
    return { run: false, requestType: 'display', reason: 'display-no-longer-active-before-network-start', position };
  }
  return { run: false, requestType: 'prefetch', reason: 'prefetch-outside-active-next-slot', position };
}

async function executeReaderSummary(input, init, parsed, meta) {
  const gate = shouldRunAtNetworkStart(parsed.articleId, meta.requestType);
  if (!gate.run) {
    return suppressedSnapshot({
      articleId: parsed.articleId,
      requestId: meta.requestId,
      requestType: gate.requestType,
      reason: gate.reason
    });
  }

  const requestType = gate.requestType;
  const payload = {
    ...parsed.body,
    articleId: parsed.articleId,
    requestId: meta.requestId,
    requestType
  };
  const timeoutMs = String(parsed.mode).startsWith('papers') ? 32_000 : 28_000;
  const networkController = new AbortController();
  const networkTimer = setTimeout(() => networkController.abort(), timeoutMs);
  const { signal: _callerSignal, ...networkInit } = init || {};
  const startedAt = Date.now();
  actualRequestCount += 1;
  window.__PDV2_GEMINI_REQUEST_COUNT = actualRequestCount;
  readerTrace('gemini-start', {
    requestId: meta.requestId,
    articleId: parsed.articleId,
    title: String(parsed.body?.title || ''),
    requestType,
    requestNumber: actualRequestCount,
    startTime: new Date(startedAt).toISOString(),
    timeoutMs
  });

  try {
    const response = await nativeFetch(input, {
      ...networkInit,
      cache: 'no-store',
      signal: networkController.signal,
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    const data = safeJson(text);
    const endedAt = Date.now();
    const responseArticleId = String(data?.articleId || '');
    const articleIdMismatch = Boolean(responseArticleId && responseArticleId !== parsed.articleId);
    const finalText = articleIdMismatch
      ? unavailableBody({
          articleId: parsed.articleId,
          requestId: meta.requestId,
          requestType,
          reason: `article-id-mismatch:${responseArticleId}`,
          upstreamStatus: Number(data?.upstreamStatus || 0) || 0
        })
      : text;
    readerTrace(articleIdMismatch ? 'gemini-article-id-mismatch' : 'gemini-success', {
      requestId: meta.requestId,
      articleId: parsed.articleId,
      responseArticleId,
      title: String(parsed.body?.title || ''),
      requestType,
      httpStatus: response.status,
      startTime: new Date(startedAt).toISOString(),
      endTime: new Date(endedAt).toISOString(),
      elapsedMs: endedAt - startedAt,
      response: responseSummary(data)
    });
    return snapshotResponse(response, finalText);
  } catch (error) {
    const endedAt = Date.now();
    readerTrace('gemini-error', {
      requestId: meta.requestId,
      articleId: parsed.articleId,
      title: String(parsed.body?.title || ''),
      requestType,
      startTime: new Date(startedAt).toISOString(),
      endTime: new Date(endedAt).toISOString(),
      elapsedMs: endedAt - startedAt,
      errorName: String(error?.name || 'Error'),
      errorMessage: String(error?.message || error).slice(0, 500)
    });
    throw error;
  } finally {
    clearTimeout(networkTimer);
    readerTrace('gemini-finally', {
      requestId: meta.requestId,
      articleId: parsed.articleId,
      requestType,
      inFlightCount: readerSummaryRequestCoordinator.size()
    });
  }
}

if (nativeFetch && typeof window !== 'undefined' && !window.__PDV2_SUMMARY_FETCH_GATE_INSTALLED) {
  window.__PDV2_SUMMARY_FETCH_GATE_INSTALLED = true;
  globalThis.fetch = function coordinatedFetch(input, init = {}) {
    const parsed = parseReaderSummary(input, init);
    if (!parsed) return nativeFetch(input, init);

    const initialPosition = currentReaderPosition(parsed.articleId);
    const initialType = initialPosition.requestType === 'display' ? 'display' : 'prefetch';
    const key = `${parsed.articleId}::${parsed.mode}`;
    const record = readerSummaryRequestCoordinator.getOrCreate(key, {
      articleId: parsed.articleId,
      requestType: initialType
    }, meta => executeReaderSummary(input, init, parsed, meta));

    if (record.reused) {
      readerTrace('gemini-inflight-reuse', {
        requestId: record.requestId,
        articleId: parsed.articleId,
        originalRequestType: record.requestType,
        requestedAs: initialType
      });
    } else {
      readerTrace('gemini-queued', {
        requestId: record.requestId,
        articleId: parsed.articleId,
        requestType: initialType,
        title: String(parsed.body?.title || ''),
        queueSize: readerSummaryRequestCoordinator.size()
      });
    }
    return record.promise.then(responseFromSnapshot);
  };

  window.__PDV2_SUMMARY_COORDINATOR = {
    inFlight: () => readerSummaryRequestCoordinator.snapshot(),
    requestCount: () => actualRequestCount
  };
}
