const DEFAULT_MIN_START_GAP_MS = 0;

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
  let displayTail = Promise.resolve();
  let prefetchTail = Promise.resolve();
  let lastNetworkStartAt = 0;
  let hasNetworkStart = false;
  let requestSequence = 0;

  const nextRequestId = (articleId, requestType = 'display') => {
    requestSequence = (requestSequence + 1) % 1_000_000_000;
    return `${safeIdPart(articleId)}-${requestType}-${now()}-${requestSequence}`;
  };

  const scheduleOnTail = (tail, task) => tail.catch(() => {}).then(async () => {
    if (hasNetworkStart && Number(minStartGapMs) > 0) {
      const elapsed = Math.max(0, now() - lastNetworkStartAt);
      const wait = Math.max(0, Number(minStartGapMs) - elapsed);
      if (wait > 0) await sleepFn(wait);
    }
    hasNetworkStart = true;
    lastNetworkStartAt = now();
    return task();
  });

  const scheduleNetwork = (task, requestType = 'display') => {
    if (requestType === 'display') {
      // 表示中の記事同士は従来どおり直列化するが、別記事のprefetch完了は待たない。
      // 同一記事の重複排除はinFlightで維持し、GeminiのRPM保護はサーバー側に任せる。
      const run = scheduleOnTail(displayTail, task);
      displayTail = run.then(() => undefined, () => undefined);
      return run;
    }

    const run = scheduleOnTail(prefetchTail, task);
    // prefetch同士だけを別レーンで直列化し、裏読み同士でFunctionを膨らませない。
    prefetchTail = run.then(() => undefined, () => undefined);
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
    promise = scheduleNetwork(
      () => task({ requestId, articleId, requestType }),
      requestType
    ).finally(() => {
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
