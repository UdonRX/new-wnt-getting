import { readerTrace } from '../../shared/reader-debug.js';
import { readerSummaryRequestCoordinator } from './summary-request-coordinator.js';

const nativeFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const FAILURE_PROVIDERS = new Set(['pending', 'instant', 'insufficient', 'unavailable']);
// v2.19.7: iOS Safari/PWAのscroll-snap中に一瞬だけarticleIdが外れる場合は、
// 即座に「取得不能」と確定せず短時間だけ表示位置の安定を待つ。
const CLIENT_SUPPRESSION_REASONS = new Set([
  'display-no-longer-active-before-network-start',
  'prefetch-outside-active-next-slot',
  'prefetch-active-summary-not-successful'
]);
const SAFARI_SNAP_SETTLE_ATTEMPTS = 8;
const SAFARI_SNAP_SETTLE_INTERVAL_MS = 90;
const FAST_PREFETCH_SETTLE_ATTEMPTS = 3;
const INSTANT_PREVIEW_LABELS = ['結論/事実', '背景/特徴', '影響/展望'];
const INSTANT_PREVIEW_PENDING = [
  '重要な事実をAIで確認しています…',
  '背景・特徴をAIで確認しています…',
  '影響・今後をAIで確認しています…'
];
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

function cleanInstantText(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function instantPreviewSentences(value = '') {
  const source = cleanInstantText(value);
  if (!source) return [];
  const pieces = source.match(/[^。！？!?]+[。！？!?]?/g) || [];
  const rows = [];
  const seen = new Set();
  for (const piece of pieces) {
    const text = String(piece || '').trim();
    if (text.length < 12) continue;
    const key = text.replace(/[\s。、，,.!！?？]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(text.length > 96 ? `${Array.from(text).slice(0, 94).join('')}…` : text);
    if (rows.length >= 3) break;
  }
  return rows;
}

function instantPreviewRows(body = {}) {
  const sentences = instantPreviewSentences(body?.description || '');
  return INSTANT_PREVIEW_LABELS.map((label, index) => ({
    label,
    text: sentences[index] || INSTANT_PREVIEW_PENDING[index],
    instant: Boolean(sentences[index])
  }));
}

function renderInstantPreview(parsed) {
  if (typeof document === 'undefined') return false;
  const position = currentReaderPosition(parsed.articleId);
  if (position.requestType !== 'display' || !position.activeCard || providerUsable(position.activeCard)) return false;
  const node = position.activeCard.querySelector('[data-reader-summary]');
  if (!node) return false;
  const rows = instantPreviewRows(parsed.body);
  const realCount = rows.filter(row => row.instant).length;
  if (!realCount) return false;

  node.replaceChildren();
  node.classList.remove('is-pending', 'is-unavailable');
  node.dataset.instantPreview = '1';
  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reader-story-summary-row';
    const copy = document.createElement('div');
    copy.className = 'reader-story-summary-copy';
    const label = document.createElement('span');
    label.className = 'reader-story-summary-label';
    label.textContent = row.label;
    const text = document.createElement('span');
    text.className = 'reader-story-summary-text';
    text.textContent = row.text;
    copy.append(label, text);
    wrapper.append(copy);
    node.append(wrapper);
  }
  try {
    node.animate?.([
      { opacity: 0.45, transform: 'translateY(3px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 160, easing: 'ease-out' });
  } catch {}
  readerTrace('summary-instant-preview', {
    articleId: parsed.articleId,
    title: String(parsed.body?.title || ''),
    lineCount: realCount,
    descriptionChars: cleanInstantText(parsed.body?.description || '').length
  });
  return true;
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

function shouldRunAtNetworkStart(articleId, originalType, positionFn = currentReaderPosition) {
  const position = positionFn(articleId);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForStableReaderNetworkGate(articleId, originalType, {
  positionFn = currentReaderPosition,
  sleepFn = sleep,
  settleAttempts = SAFARI_SNAP_SETTLE_ATTEMPTS,
  settleIntervalMs = SAFARI_SNAP_SETTLE_INTERVAL_MS
} = {}) {
  let gate = shouldRunAtNetworkStart(articleId, originalType, positionFn);
  if (gate.run || !CLIENT_SUPPRESSION_REASONS.has(String(gate.reason || ''))) return gate;

  const initialReason = gate.reason;
  const requestedAttempts = Math.max(0, Number(settleAttempts) || 0);
  // v2.19.12: displayのSafari snap回復余裕は維持しつつ、古くなったprefetchは
  // 最大270msで捨てて後続displayを詰まらせない。
  const attempts = originalType === 'prefetch'
    ? Math.min(requestedAttempts, FAST_PREFETCH_SETTLE_ATTEMPTS)
    : requestedAttempts;
  const interval = Math.max(0, Number(settleIntervalMs) || 0);
  for (let index = 0; index < attempts; index += 1) {
    if (interval > 0) await sleepFn(interval);
    gate = shouldRunAtNetworkStart(articleId, originalType, positionFn);
    if (gate.run) {
      return {
        ...gate,
        recoveredFrom: initialReason,
        settleChecks: index + 1,
        settleWaitMs: (index + 1) * interval
      };
    }
  }
  return { ...gate, initialReason, settleChecks: attempts, settleWaitMs: attempts * interval };
}

function clientSuppressionReason(snapshot) {
  const data = safeJson(snapshot?.body || '');
  const reason = String(data?.fallbackReason || '');
  return CLIENT_SUPPRESSION_REASONS.has(reason) ? reason : '';
}

async function executeReaderSummary(input, init, parsed, meta) {
  const gate = await waitForStableReaderNetworkGate(parsed.articleId, meta.requestType);
  if (!gate.run) {
    return suppressedSnapshot({
      articleId: parsed.articleId,
      requestId: meta.requestId,
      requestType: gate.requestType,
      reason: gate.reason
    });
  }

  if (gate.recoveredFrom) {
    readerTrace('gemini-snap-recovered', {
      requestId: meta.requestId,
      articleId: parsed.articleId,
      requestType: gate.requestType,
      recoveredFrom: gate.recoveredFrom,
      settleChecks: gate.settleChecks,
      settleWaitMs: gate.settleWaitMs
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

function createReaderSummaryRecord(key, input, init, parsed, requestType) {
  return readerSummaryRequestCoordinator.getOrCreate(key, {
    articleId: parsed.articleId,
    requestType
  }, meta => executeReaderSummary(input, init, parsed, meta));
}

async function responseWithDisplayRecovery(record, {
  key,
  input,
  init,
  parsed,
  requestedAs
}) {
  const firstSnapshot = await record.promise;
  const reason = requestedAs === 'display' ? clientSuppressionReason(firstSnapshot) : '';
  const position = requestedAs === 'display' ? currentReaderPosition(parsed.articleId) : null;
  if (!reason || position?.requestType !== 'display') return responseFromSnapshot(firstSnapshot);

  // v2.19.7: prefetch/displayの共有PromiseがSafariのsnap揺れで一度だけ抑止された場合、
  // その記事が実際に表示中なら同一articleIdを1回だけ再投入する。
  // 真の本文取得失敗やGemini失敗には再試行しない。
  readerTrace('gemini-client-suppression-retry', {
    articleId: parsed.articleId,
    originalRequestId: record.requestId,
    reason,
    requestType: 'display'
  });
  const retryRecord = createReaderSummaryRecord(key, input, init, parsed, 'display');
  const retrySnapshot = await retryRecord.promise;
  return responseFromSnapshot(retrySnapshot);
}

if (nativeFetch && typeof window !== 'undefined' && !window.__PDV2_SUMMARY_FETCH_GATE_INSTALLED) {
  window.__PDV2_SUMMARY_FETCH_GATE_INSTALLED = true;
  globalThis.fetch = function coordinatedFetch(input, init = {}) {
    const parsed = parseReaderSummary(input, init);
    if (!parsed) return nativeFetch(input, init);

    const initialPosition = currentReaderPosition(parsed.articleId);
    const initialType = initialPosition.requestType === 'display' ? 'display' : 'prefetch';
    // v2.19.12: Gemini待ちの空白をなくす。これはRSS本文からの引用的プレビューで、
    // 最終AI要約ではない。既存のprogressを残し、Gemini成功時にReader本体が同じ枠を上書きする。
    if (initialType === 'display') renderInstantPreview(parsed);
    const key = `${parsed.articleId}::${parsed.mode}`;
    const record = createReaderSummaryRecord(key, input, init, parsed, initialType);

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
    return responseWithDisplayRecovery(record, {
      key,
      input,
      init,
      parsed,
      requestedAs: initialType
    });
  };

  window.__PDV2_SUMMARY_COORDINATOR = {
    inFlight: () => readerSummaryRequestCoordinator.snapshot(),
    requestCount: () => actualRequestCount
  };
}
