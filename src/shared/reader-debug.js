const TRACE_LIMIT = 1200;
const IMAGE_DIAGNOSTIC_ENDPOINT = '/api/reader-image-diagnostic';
const IMAGE_RESOLVE_ENDPOINT = '/api/reader-image-resolve';
const IMAGE_LAYOUT_STYLE_ID = 'pdv2-reader-image-layout-only';
const imageDiagnosticSeen = new Set();
const imageResolveInflight = new Map();
const imageResolveCache = new Map();
let imageDiagnosticsInstalled = false;
let imageIntersectionObserver = null;
let imageMutationObserver = null;

function globalScope() {
  return typeof window !== 'undefined' ? window : globalThis;
}

export function readerDebugEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    const query = new URLSearchParams(window.location.search);
    return query.get('readerDebug') === '1' || localStorage.getItem('pdv2:readerDebug') === '1';
  } catch { return false; }
}

function traceBuffer() {
  const scope = globalScope();
  if (!Array.isArray(scope.__PDV2_READER_TRACE)) scope.__PDV2_READER_TRACE = [];
  return scope.__PDV2_READER_TRACE;
}

export function readerTrace(event, payload = {}) {
  const entry = {
    at: new Date().toISOString(),
    event: String(event || 'reader'),
    ...(payload && typeof payload === 'object' ? payload : { value: payload })
  };
  const buffer = traceBuffer();
  buffer.push(entry);
  if (buffer.length > TRACE_LIMIT) buffer.splice(0, buffer.length - TRACE_LIMIT);
  if (readerDebugEnabled() && typeof console !== 'undefined') console.log(`[reader:${entry.event}]`, entry);
  return entry;
}

export function readerTable(event, rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  readerTrace(event, { count: values.length });
  if (readerDebugEnabled() && typeof console !== 'undefined' && typeof console.table === 'function') console.table(values);
}

export function articleDateDebug(item = {}, index = 0) {
  const original = item?.originalDate ?? item?.pubDate ?? '';
  const explicit = Number(item?.publishedTimestamp);
  const parsed = new Date(item?.pubDate || 0).getTime();
  const timestamp = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : (Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
  return {
    index,
    id: String(item?.id || ''),
    source: String(item?.feedName || item?.source || ''),
    title: String(item?.title || ''),
    originalDate: String(original || ''),
    normalizedDate: timestamp ? new Date(timestamp).toISOString() : '',
    timestamp
  };
}

function compactText(value = '', max = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const IMAGE_TITLE_PLACEHOLDER_RE = /^(?:記事の要点を整理中…?|日本語タイトルを生成中…?|記事|—)$/;

function originalArticleTitleFromTrace(articleId = '') {
  const target = compactText(articleId, 700);
  if (!target) return '';
  const rows = traceBuffer();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index] || {};
    const entryId = compactText(entry.articleId || entry.currentArticleId || '', 700);
    if (entryId !== target) continue;
    const candidate = compactText(entry.title || entry.currentTitle || '', 260);
    if (candidate && !IMAGE_TITLE_PLACEHOLDER_RE.test(candidate)) return candidate;
  }
  return '';
}

function articleTitleOf(card) {
  const articleId = compactText(card?.dataset?.articleId || card?.dataset?.key || '', 700);
  const stored = compactText(card?.dataset?.readerOriginalTitle || '', 260);
  if (stored && !IMAGE_TITLE_PLACEHOLDER_RE.test(stored)) return stored;
  const traced = originalArticleTitleFromTrace(articleId);
  if (traced) return traced;
  const visible = compactText(card?.querySelector?.('[data-reader-title]')?.textContent || '', 260);
  return IMAGE_TITLE_PLACEHOLDER_RE.test(visible) ? '' : visible;
}

function installReaderImageLayoutOnly() {
  if (typeof document === 'undefined' || document.getElementById(IMAGE_LAYOUT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = IMAGE_LAYOUT_STYLE_ID;
  style.textContent = `
    /* Reader image-only layout adjustment. Title/summary/action layout is intentionally untouched. */
    .reader-screen.reader-focus-open .reader-story-hero {
      height: calc(100% + 22px) !important;
      min-height: calc(100% + 22px) !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image {
      bottom: 12px !important;
      z-index: 1 !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image.reader-story-hero-image--contain {
      object-fit: contain !important;
      object-position: center center !important;
      background: #0d1117 !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image.reader-story-hero-image--cover {
      object-fit: cover !important;
      object-position: center center !important;
    }
    @media (max-height: 700px) {
      .reader-screen.reader-focus-open .reader-story-hero {
        height: calc(100% + 12px) !important;
        min-height: calc(100% + 12px) !important;
      }
      .reader-screen.reader-focus-open .reader-story-hero-image {
        bottom: 12px !important;
      }
    }
  `;
  (document.head || document.documentElement).append(style);
}

function setResolvedImageFit(image, imageKind = '') {
  if (!image?.matches?.('img.reader-story-hero-image')) return;
  const kind = compactText(imageKind || image.dataset.readerImageKind || '', 40);
  if (kind) image.dataset.readerImageKind = kind;
  const contain = kind === 'site-brand';
  image.classList.toggle('reader-story-hero-image--contain', contain);
  image.classList.toggle('reader-story-hero-image--cover', !contain);
}

function imageDiagnosticPayload(card, phase, imageUrl = '') {
  const articleId = compactText(card?.dataset?.articleId || card?.dataset?.key || '', 700);
  const title = articleTitleOf(card);
  const source = compactText(card?.querySelector?.('.reader-story-source-name')?.textContent || '', 120);
  let imageHost = '';
  try { imageHost = new URL(String(imageUrl || '')).hostname; } catch {}
  return {
    phase: compactText(phase, 80),
    articleId,
    title,
    source,
    imageUrl: compactText(imageUrl, 1100),
    imageHost,
    summaryProvider: compactText(card?.dataset?.summaryProvider || '', 80),
    viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}@${window.devicePixelRatio || 1}`,
    online: navigator.onLine !== false
  };
}

function sendImageDiagnostic(card, phase, imageUrl = '') {
  if (!card || typeof fetch !== 'function') return;
  const payload = imageDiagnosticPayload(card, phase, imageUrl);
  const key = `${payload.phase}|${payload.articleId}|${payload.imageUrl}`;
  if (imageDiagnosticSeen.has(key)) return;
  imageDiagnosticSeen.add(key);
  while (imageDiagnosticSeen.size > 240) imageDiagnosticSeen.delete(imageDiagnosticSeen.values().next().value);
  readerTrace('hero-image-diagnostic', payload);
  fetch(IMAGE_DIAGNOSTIC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    keepalive: true
  }).catch(() => {});
}

function articleLinkOf(card) {
  const raw = card?.querySelector?.('a.reader-story-open[href]')?.href || '';
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function appendResolvedHeroImage(card, imageUrl, imageKind = '') {
  if (!card?.isConnected || !imageUrl || card.querySelector('img.reader-story-hero-image')) return false;
  const hero = card.querySelector('.reader-story-hero');
  if (!hero) return false;
  const image = document.createElement('img');
  image.className = 'reader-story-hero-image';
  image.src = imageUrl;
  image.alt = '';
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  setResolvedImageFit(image, imageKind);
  image.addEventListener('load', () => {
    card.dataset.readerImageResolved = '1';
    card.dataset.readerImageFailed = '0';
    sendImageDiagnostic(card, 'resolved-on-demand', image.currentSrc || image.src || imageUrl);
  }, { once: true });
  hero.prepend(image);
  return true;
}

function resolveMissingHeroImage(card) {
  if (!card?.isConnected || typeof fetch !== 'function') return;
  if (card.querySelector('img.reader-story-hero-image')) return;
  if (card.dataset.readerImageResolve === 'pending' || card.dataset.readerImageResolve === 'done') return;
  const link = articleLinkOf(card);
  if (!link) return;

  const articleId = compactText(card.dataset.articleId || card.dataset.key || '', 700);
  const title = articleTitleOf(card);
  const source = compactText(card.querySelector('.reader-story-source-name')?.textContent || '', 120);
  if (!title) return;
  card.dataset.readerImageResolve = 'pending';

  const cached = imageResolveCache.get(link);
  if (cached?.image) {
    if (appendResolvedHeroImage(card, cached.image, cached.imageKind || '')) card.dataset.readerImageResolve = 'done';
    return;
  }

  let request = imageResolveInflight.get(link);
  if (!request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    request = fetch(IMAGE_RESOLVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, title, source, link }),
      signal: controller.signal,
      cache: 'no-store'
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (data?.image) {
        imageResolveCache.set(link, {
          image: compactText(data.image, 2200),
          imageKind: compactText(data.imageKind || '', 40),
          method: compactText(data.method || '', 120),
          publisherUrl: compactText(data.publisherUrl || '', 700)
        });
        while (imageResolveCache.size > 80) imageResolveCache.delete(imageResolveCache.keys().next().value);
      }
      return data;
    }).finally(() => {
      clearTimeout(timer);
      if (imageResolveInflight.get(link) === request) imageResolveInflight.delete(link);
    });
    imageResolveInflight.set(link, request);
  }

  request.then(data => {
    if (!card.isConnected) return;
    const imageUrl = compactText(data?.image || '', 2200);
    const imageKind = compactText(data?.imageKind || '', 40);
    if (imageUrl && appendResolvedHeroImage(card, imageUrl, imageKind)) {
      card.dataset.readerImageResolve = 'done';
      readerTrace('hero-image-resolve-success', {
        articleId,
        source,
        method: compactText(data?.method || '', 120),
        publisherUrl: compactText(data?.publisherUrl || '', 700),
        imageUrl
      });
      return;
    }
    card.dataset.readerImageResolve = 'none';
    sendImageDiagnostic(card, 'resolve-no-image');
  }).catch(error => {
    if (!card.isConnected) return;
    card.dataset.readerImageResolve = 'error';
    readerTrace('hero-image-resolve-error', { articleId, source, error: String(error?.name || 'Error') + ':' + String(error?.message || error) });
    sendImageDiagnostic(card, 'resolve-request-error');
  });
}

function observeImageCard(card) {
  if (!card?.matches?.('.reader-story-card') || card.dataset.readerImageObserved === '1') return;
  card.dataset.readerImageObserved = '1';
  const existing = card.querySelector('img.reader-story-hero-image');
  if (existing) setResolvedImageFit(existing, existing.dataset.readerImageKind || '');
  if (imageIntersectionObserver) {
    imageIntersectionObserver.observe(card);
    return;
  }
  if (!existing && card.dataset.readerImageFailed !== '1') {
    sendImageDiagnostic(card, 'missing-item-image');
    resolveMissingHeroImage(card);
  }
}

function scanImageCards(root = document) {
  if (root?.matches?.('.reader-story-card')) observeImageCard(root);
  root?.querySelectorAll?.('.reader-story-card').forEach(observeImageCard);
}

export function installReaderImageDiagnostics() {
  if (imageDiagnosticsInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  imageDiagnosticsInstalled = true;
  installReaderImageLayoutOnly();

  if (typeof IntersectionObserver !== 'undefined') {
    imageIntersectionObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        const image = card.querySelector('img.reader-story-hero-image');
        if (image) setResolvedImageFit(image, image.dataset.readerImageKind || '');
        if (!image && card.dataset.readerImageFailed !== '1') {
          sendImageDiagnostic(card, 'missing-item-image');
          resolveMissingHeroImage(card);
        }
        imageIntersectionObserver.unobserve(card);
      }
    }, { threshold: [0], rootMargin: '110% 0px 110% 0px' });
  }

  document.addEventListener('error', event => {
    const image = event.target;
    if (!image?.matches?.('img.reader-story-hero-image')) return;
    const card = image.closest('.reader-story-card');
    if (!card) return;
    card.dataset.readerImageFailed = '1';
    sendImageDiagnostic(card, 'browser-image-error', image.currentSrc || image.src || '');
  }, true);

  scanImageCards(document);
  imageMutationObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node?.nodeType === 1) scanImageCards(node);
      }
    }
  });
  imageMutationObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installReaderImageDiagnostics, { once: true });
  else queueMicrotask(installReaderImageDiagnostics);
}
