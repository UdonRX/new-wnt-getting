const DEFAULT_MIN_START_GAP_MS = 4300;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeIdPart(value = '') {
  return String(value || 'article')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-28) || 'article';
}

export function createSummaryRequestCoordinator({
  minStartGapMs = DEFAULT_MIN_START_GAP_MS,
  now = () => Date.now(),
  sleepFn = defaultSleep
} = {}) {
  const inFlight = new Map();
  let networkTail = Promise.resolve();
  let lastNetworkStartAt = 0;
  let hasNetworkStart = false;
  let requestSequence = 0;

  const nextRequestId = (articleId, requestType = 'display') => {
    requestSequence = (requestSequence + 1) % 1_000_000_000;
    return `${safeIdPart(articleId)}-${requestType}-${now()}-${requestSequence}`;
  };

  const scheduleNetwork = task => {
    const run = networkTail.catch(() => {}).then(async () => {
      if (hasNetworkStart) {
        const elapsed = Math.max(0, now() - lastNetworkStartAt);
        const wait = Math.max(0, Number(minStartGapMs) - elapsed);
        if (wait > 0) await sleepFn(wait);
      }
      hasNetworkStart = true;
      lastNetworkStartAt = now();
      return task();
    });
    // The next request waits for the complete previous request, not only its start.
    // This prevents display/prefetch from creating concurrent Gemini function calls.
    networkTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const getOrCreate = (key, {
    articleId = '',
    requestType = 'display'
  } = {}, task) => {
    const normalizedKey = String(key || articleId || '');
    const existing = inFlight.get(normalizedKey);
    if (existing) return { ...existing, reused: true };

    const requestId = nextRequestId(articleId, requestType);
    let promise;
    promise = scheduleNetwork(() => task({ requestId, articleId, requestType })).finally(() => {
      if (inFlight.get(normalizedKey)?.promise === promise) inFlight.delete(normalizedKey);
    });

    const record = {
      promise,
      requestId,
      articleId: String(articleId || ''),
      requestType: String(requestType || 'display'),
      queuedAt: now()
    };
    inFlight.set(normalizedKey, record);
    return { ...record, reused: false };
  };

  return {
    getOrCreate,
    get: key => inFlight.get(String(key || '')) || null,
    has: key => inFlight.has(String(key || '')),
    size: () => inFlight.size,
    snapshot: () => [...inFlight.entries()].map(([key, row]) => ({
      key,
      requestId: row.requestId,
      articleId: row.articleId,
      requestType: row.requestType,
      queuedAt: row.queuedAt
    }))
  };
}

export const readerSummaryRequestCoordinator = createSummaryRequestCoordinator();
