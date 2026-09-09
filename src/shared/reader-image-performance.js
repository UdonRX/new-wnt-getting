const DIAGNOSTIC_ENDPOINT = '/api/reader-image-diagnostic';
const observedCards = new WeakSet();
const observedImages = new WeakSet();
const reportedLoaded = new WeakSet();
const activeCards = new WeakSet();
const imageObservedAt = new WeakMap();
const cardObservedAt = new WeakMap();
let observer = null;
let mutationObserver = null;
let activeScreen = null;
let readerSession = null;
let scanQueued = false;

function perfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
}

function epochNow() {
  return Date.now();
}

function compact(value = '', max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : -1;
}

function hostOf(value = '') {
  try { return new URL(String(value || ''), location.href).hostname.toLowerCase(); }
  catch { return ''; }
}

function articleLinkOf(card) {
  const raw = card?.querySelector?.('a.reader-story-open[href]')?.href || '';
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function articleTitleOf(card) {
  return compact(card?.dataset?.readerOriginalTitle
    || card?.querySelector?.('[data-reader-title]')?.textContent
    || '', 260);
}

function sourceOf(card) {
  return compact(card?.querySelector?.('.reader-story-source-name')?.textContent || '', 120);
}

function readerModeOf(screen) {
  const text = compact(screen?.querySelector?.('.segmented .active, .segment.active, [role="tab"][aria-selected="true"]')?.textContent || '', 80);
  if (/ニュース|news/i.test(text)) return 'news';
  if (/知識|knowledge/i.test(text)) return 'knowledge';
  if (/技術|論文|research|papers/i.test(text)) return 'papers';
  return 'unknown';
}

function hash32(value = '') {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function imageRequestIdFor(card) {
  const articleId = compact(card?.dataset?.articleId || card?.dataset?.key || '', 700);
  const key = articleId || articleLinkOf(card) || articleTitleOf(card);
  return `img-${hash32(key)}`;
}

function newReaderSession(screen) {
  activeScreen = screen;
  readerSession = {
    id: `reader-${epochNow().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    startedPerf: perfNow(),
    startedEpochMs: epochNow(),
    mode: readerModeOf(screen),
    dataReadySent: false
  };
  postDiagnostic(null, 'reader-start', '', {
    readerRequestId: readerSession.id,
    readerMode: readerSession.mode,
    readerStartedAtEpochMs: readerSession.startedEpochMs,
    readerToPhaseMs: 0,
    imageRequestId: ''
  });
}

function ensureReaderSession(card = null) {
  const screen = card?.closest?.('.reader-screen.reader-focus-open')
    || document.querySelector('.reader-screen.reader-focus-open');
  if (!screen) return null;
  if (!readerSession || activeScreen !== screen || !activeScreen?.isConnected) newReaderSession(screen);
  return readerSession;
}

function currentResourceEntry(url = '') {
  if (!url || typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return null;
  try {
    const rows = performance.getEntriesByName(url, 'resource');
    return rows.length ? rows[rows.length - 1] : null;
  } catch { return null; }
}

function resourceMetrics(url = '') {
  const entry = currentResourceEntry(url);
  if (!entry) {
    return {
      resourceTiming: 'none',
      resourceStartAfterNavigationMs: -1,
      fetchStartMs: -1,
      requestStartMs: -1,
      responseStartMs: -1,
      responseEndMs: -1,
      redirectStartMs: -1,
      redirectEndMs: -1,
      redirectMs: -1,
      redirectCount: -1,
      redirectVisibility: 'unavailable',
      queueMs: -1,
      ttfbMs: -1,
      downloadMs: -1,
      resourceDurationMs: -1,
      transferSize: -1,
      encodedBodySize: -1,
      decodedBodySize: -1,
      responseStatus: -1,
      nextHopProtocol: '',
      deliveryType: '',
      browserCache: 'UNKNOWN'
    };
  }
  const fetchStart = Number(entry.fetchStart || entry.startTime || 0);
  const requestStart = Number(entry.requestStart || 0);
  const responseStart = Number(entry.responseStart || 0);
  const responseEnd = Number(entry.responseEnd || 0);
  const redirectStart = Number(entry.redirectStart || 0);
  const redirectEnd = Number(entry.redirectEnd || 0);
  const transferSize = Number(entry.transferSize);
  const encoded = Number(entry.encodedBodySize);
  const deliveryType = compact(entry.deliveryType || '', 40);
  const detailed = requestStart > 0 && responseStart > 0 && responseEnd > 0;
  let cache = 'UNKNOWN';
  if (/cache/i.test(deliveryType)) cache = 'HIT';
  else if (Number.isFinite(transferSize) && transferSize > 0) cache = 'MISS';
  else if (Number.isFinite(transferSize) && transferSize === 0 && Number.isFinite(encoded) && encoded > 0) cache = 'HIT';
  return {
    resourceTiming: detailed ? 'detailed' : 'limited-cross-origin',
    resourceStartAfterNavigationMs: round(entry.startTime),
    fetchStartMs: round(fetchStart),
    requestStartMs: detailed ? round(requestStart) : -1,
    responseStartMs: detailed ? round(responseStart) : -1,
    responseEndMs: responseEnd > 0 ? round(responseEnd) : -1,
    redirectStartMs: redirectStart > 0 ? round(redirectStart) : -1,
    redirectEndMs: redirectEnd > 0 ? round(redirectEnd) : -1,
    redirectMs: redirectStart > 0 && redirectEnd >= redirectStart ? round(redirectEnd - redirectStart) : -1,
    redirectCount: -1,
    redirectVisibility: redirectStart > 0 ? 'timing-only-count-unavailable' : 'none-or-cross-origin-hidden',
    queueMs: detailed ? round(Math.max(0, requestStart - fetchStart)) : -1,
    ttfbMs: detailed ? round(Math.max(0, responseStart - requestStart)) : -1,
    downloadMs: detailed ? round(Math.max(0, responseEnd - responseStart)) : -1,
    resourceDurationMs: round(entry.duration),
    transferSize: Number.isFinite(transferSize) ? transferSize : -1,
    encodedBodySize: Number.isFinite(encoded) ? encoded : -1,
    decodedBodySize: Number.isFinite(Number(entry.decodedBodySize)) ? Number(entry.decodedBodySize) : -1,
    responseStatus: Number.isFinite(Number(entry.responseStatus)) && Number(entry.responseStatus) > 0 ? Number(entry.responseStatus) : -1,
    nextHopProtocol: compact(entry.nextHopProtocol || '', 40),
    deliveryType,
    browserCache: cache
  };
}

function networkMetrics() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    effectiveType: compact(connection?.effectiveType || '', 24),
    downlinkMbps: Number.isFinite(Number(connection?.downlink)) ? Number(connection.downlink) : -1,
    rttMs: Number.isFinite(Number(connection?.rtt)) ? Number(connection.rtt) : -1,
    saveData: Boolean(connection?.saveData)
  };
}

function basePayload(card, phase, imageUrl = '') {
  const session = ensureReaderSession(card);
  const articleId = compact(card?.dataset?.articleId || card?.dataset?.key || '', 700);
  const link = articleLinkOf(card);
  const image = compact(imageUrl, 1100);
  return {
    diagnosticVersion: 2,
    phase: compact(phase, 80),
    readerRequestId: session?.id || '',
    imageRequestId: card ? imageRequestIdFor(card) : '',
    readerMode: session?.mode || 'unknown',
    articleId,
    title: articleTitleOf(card),
    source: sourceOf(card),
    articleHost: hostOf(link),
    imageUrl: image,
    imageHost: hostOf(image),
    summaryProvider: compact(card?.dataset?.summaryProvider || '', 80),
    viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}@${window.devicePixelRatio || 1}`,
    online: navigator.onLine !== false,
    readerStartedAtEpochMs: session?.startedEpochMs || -1,
    clientEpochMs: epochNow(),
    readerToPhaseMs: session ? round(perfNow() - session.startedPerf) : -1,
    ...networkMetrics()
  };
}

function postDiagnostic(card, phase, imageUrl = '', extra = {}) {
  if (typeof fetch !== 'function') return;
  const payload = {
    ...basePayload(card, phase, imageUrl),
    ...extra
  };
  fetch(DIAGNOSTIC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    keepalive: true
  }).catch(() => {});
}

function imageOrigin(image) {
  if (image?.dataset?.readerResolvedImage === '1') return 'reader-image-resolver';
  return 'rss-item';
}

function imageUrlOf(image) {
  return compact(image?.currentSrc || image?.src || '', 1100);
}

function reportImageLoaded(image, card, observedPerf, origin) {
  if (reportedLoaded.has(image)) return;
  reportedLoaded.add(image);
  const url = imageUrlOf(image);
  const session = ensureReaderSession(card);
  const metrics = resourceMetrics(url);
  postDiagnostic(card, 'browser-image-loaded', url, {
    imageUrlSource: origin,
    imageObservedToLoadMs: round(perfNow() - observedPerf),
    imageNaturalWidth: Number(image?.naturalWidth || 0),
    imageNaturalHeight: Number(image?.naturalHeight || 0),
    contentType: 'unavailable-native-img',
    contentLength: -1,
    headerVisibility: 'unavailable-native-img',
    totalReaderToImageLoadedMs: session ? round(perfNow() - session.startedPerf) : -1,
    resourceStartAfterReaderMs: session && metrics.resourceStartAfterNavigationMs >= 0
      ? round(metrics.resourceStartAfterNavigationMs - session.startedPerf)
      : -1,
    ...metrics
  });
}

function instrumentImage(image, card) {
  if (!image?.matches?.('img.reader-story-hero-image') || observedImages.has(image)) return;
  if (!card?.closest?.('.reader-screen.reader-focus-open')) return;
  observedImages.add(image);
  const observedPerf = perfNow();
  imageObservedAt.set(image, observedPerf);
  const origin = imageOrigin(image);
  const url = imageUrlOf(image);
  postDiagnostic(card, 'image-src-observed', url, {
    imageUrlSource: origin,
    imageLoading: compact(image.loading || '', 24),
    imageDecoding: compact(image.decoding || '', 24),
    imageCompleteAtObservation: Boolean(image.complete),
    contentType: 'unavailable-native-img',
    contentLength: -1,
    headerVisibility: 'unavailable-native-img'
  });

  image.addEventListener('load', () => reportImageLoaded(image, card, observedPerf, origin), { once: true });
  image.addEventListener('error', () => {
    const failedUrl = imageUrlOf(image) || url;
    postDiagnostic(card, 'browser-image-error-v2', failedUrl, {
      imageUrlSource: origin,
      imageObservedToErrorMs: round(perfNow() - observedPerf),
      contentType: 'unavailable-native-img',
      contentLength: -1,
      headerVisibility: 'unavailable-native-img',
      ...resourceMetrics(failedUrl)
    });
  }, { once: true });

  if (image.complete && image.naturalWidth > 0) {
    queueMicrotask(() => {
      if (image.isConnected || card.isConnected) reportImageLoaded(image, card, observedPerf, origin);
    });
  }
}

function observeCard(card) {
  if (!card?.matches?.('.reader-story-card') || observedCards.has(card)) return;
  if (!card.closest('.reader-screen.reader-focus-open')) return;
  observedCards.add(card);
  cardObservedAt.set(card, perfNow());
  const session = ensureReaderSession(card);
  if (session?.mode === 'unknown') session.mode = readerModeOf(card.closest('.reader-screen'));
  if (session && !session.dataReadySent) {
    session.dataReadySent = true;
    postDiagnostic(card, 'article-data-ready', '', {
      imageUrlSource: card.querySelector('img.reader-story-hero-image') ? 'rss-item' : 'none',
      articleDataReadyDefinition: 'first-focus-card-rendered'
    });
  }

  if (observer) {
    observer.observe(card);
  } else {
    card.querySelectorAll('img.reader-story-hero-image').forEach(image => instrumentImage(image, card));
  }
}

function scan(root = document) {
  const screen = document.querySelector('.reader-screen.reader-focus-open');
  if (screen) ensureReaderSession(screen.querySelector('.reader-story-card'));
  else {
    activeScreen = null;
    readerSession = null;
  }

  if (root?.matches?.('.reader-story-card')) observeCard(root);
  root?.querySelectorAll?.('.reader-screen.reader-focus-open .reader-story-card').forEach(observeCard);

  if (root?.matches?.('img.reader-story-hero-image')) {
    const card = root.closest('.reader-story-card');
    if (card && (!observer || activeCards.has(card))) instrumentImage(root, card);
  }
  root?.querySelectorAll?.('.reader-screen.reader-focus-open img.reader-story-hero-image').forEach(image => {
    const card = image.closest('.reader-story-card');
    if (card && (!observer || activeCards.has(card))) instrumentImage(image, card);
  });
}

function scheduleScan(root = document) {
  if (scanQueued) return;
  scanQueued = true;
  queueMicrotask(() => {
    scanQueued = false;
    scan(root);
  });
}

export function installReaderImagePerformanceDiagnostics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        activeCards.add(card);
        const image = card.querySelector('img.reader-story-hero-image');
        if (image) instrumentImage(image, card);
        else {
          postDiagnostic(card, 'image-missing-at-visible', '', {
            imageUrlSource: 'none',
            cardObservedToVisibleMs: round(perfNow() - (cardObservedAt.get(card) || perfNow()))
          });
        }
        observer.unobserve(card);
      }
    }, { threshold: [0], rootMargin: '45% 0px 45% 0px' });
  }

  mutationObserver = new MutationObserver(mutations => {
    let needsScan = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.target?.matches?.('.reader-screen')) needsScan = true;
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node?.nodeType !== 1) continue;
        needsScan = true;
        if (node.matches?.('img.reader-story-hero-image')) {
          const card = node.closest('.reader-story-card');
          if (card && (!observer || activeCards.has(card))) instrumentImage(node, card);
        } else {
          node.querySelectorAll?.('img.reader-story-hero-image').forEach(image => {
            const card = image.closest('.reader-story-card');
            if (card && (!observer || activeCards.has(card))) instrumentImage(image, card);
          });
        }
      }
    }
    if (needsScan) scheduleScan(document);
  });

  const root = document.body || document.documentElement;
  mutationObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  scan(document);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installReaderImagePerformanceDiagnostics, { once: true });
  } else {
    queueMicrotask(installReaderImagePerformanceDiagnostics);
  }
}
