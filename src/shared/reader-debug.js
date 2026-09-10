const TRACE_LIMIT = 1200;
const IMAGE_DIAGNOSTIC_ENDPOINT = '/api/reader-image-diagnostic';
const IMAGE_RESOLVE_ENDPOINT = '/api/reader-image-resolve';
const IMAGE_LAYOUT_STYLE_ID = 'pdv2-reader-image-layout-only';
const IMAGE_RESOLVE_BUDGET_MS = 1300;
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
    /* Reader focus layout only: source -> title -> image -> 3 summary cards -> article button -> dots. */
    .reader-screen.reader-focus-open .reader-story-card.reader-story-card {
      --reader-card-gap: clamp(8px, 1.05dvh, 10px);
      --reader-footer-height: clamp(76px, 8.8dvh, 86px);
      box-sizing: border-box !important;
      grid-template-rows: clamp(322px, 39.5dvh, 346px) minmax(0, 1fr) var(--reader-footer-height) !important;
      gap: var(--reader-card-gap) !important;
      align-content: stretch !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero.reader-story-hero {
      position: relative !important;
      height: auto !important;
      min-height: 0 !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      display: grid !important;
      grid-template-rows: auto minmax(72px, auto) minmax(0, 1fr) !important;
      align-content: stretch !important;
      gap: clamp(8px, 1.05dvh, 11px) !important;
      padding: 14px 16px !important;
      border-radius: 20px !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero::after {
      content: none !important;
      display: none !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-bottom {
      display: none !important;
    }
    .reader-screen.reader-focus-open .reader-story-title-slot {
      position: relative !important;
      z-index: 3 !important;
      min-width: 0 !important;
      min-height: 72px !important;
      box-sizing: border-box !important;
      display: flex !important;
      align-items: center !important;
      overflow: hidden !important;
      padding: 8px 2px 10px !important;
    }
    .reader-screen.reader-focus-open .reader-story-title.reader-swipe-title {
      position: relative !important;
      z-index: 3 !important;
      width: 100% !important;
      display: -webkit-box !important;
      margin: 0 !important;
      padding: 0 !important;
      -webkit-box-orient: vertical !important;
      -webkit-line-clamp: 2 !important;
      line-clamp: 2 !important;
      overflow: hidden !important;
      max-height: calc(2 * 1.22em) !important;
      color: rgba(255,255,255,.97) !important;
      font-size: 20px !important;
      font-weight: 760 !important;
      line-height: 1.22 !important;
      letter-spacing: -.025em !important;
    }
    .reader-screen.reader-focus-open .reader-story-media-frame {
      position: relative !important;
      z-index: 1 !important;
      width: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      height: 100% !important;
      overflow: hidden !important;
      align-self: stretch !important;
      border: 1px solid rgba(255,255,255,.06) !important;
      border-radius: 15px !important;
      background: #0d1117 !important;
      isolation: isolate !important;
    }
    .reader-screen.reader-focus-open .reader-story-media-frame:empty {
      background: linear-gradient(145deg, rgba(255,255,255,.035), rgba(255,255,255,.012)) !important;
    }
    .reader-screen.reader-focus-open .reader-story-brand-fallback {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      box-sizing: border-box !important;
      border: 0 !important;
      object-fit: contain !important;
      object-position: center center !important;
      padding: 42px !important;
      z-index: 1 !important;
      background: #0d1117 !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      box-sizing: border-box !important;
      border: 0 !important;
      border-radius: inherit !important;
      -webkit-clip-path: none !important;
      clip-path: none !important;
      z-index: 1 !important;
      background: #0d1117 !important;
      opacity: 1 !important;
      filter: none !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image[data-reader-resolved-image="1"] {
      z-index: 2 !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image.reader-story-hero-image--contain {
      object-fit: contain !important;
      object-position: center center !important;
      padding: 18px !important;
    }
    .reader-screen.reader-focus-open .reader-story-hero-image.reader-story-hero-image--cover {
      object-fit: cover !important;
      object-position: center center !important;
      padding: 0 !important;
    }
    .reader-screen.reader-focus-open .reader-story-content.reader-story-content {
      display: flex !important;
      flex-direction: column !important;
      min-height: 0 !important;
      gap: 6px !important;
      padding: 0 2px !important;
      overflow: hidden !important;
    }
    .reader-screen.reader-focus-open .reader-story-summary.reader-ai-summary {
      flex: 1 1 auto !important;
      height: auto !important;
      min-height: 0 !important;
      display: grid !important;
      grid-template-rows: repeat(3, minmax(0, 1fr)) !important;
      gap: var(--reader-card-gap) !important;
      align-content: stretch !important;
    }
    .reader-screen.reader-focus-open .reader-story-summary-row {
      height: auto !important;
      min-height: 0 !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
    .reader-screen.reader-focus-open .reader-story-content > [data-reader-progress] {
      flex: 0 0 auto !important;
    }
    .reader-screen.reader-focus-open .reader-story-actions {
      position: relative !important;
      z-index: 7 !important;
      align-self: stretch !important;
      height: 100% !important;
      min-height: 0 !important;
      box-sizing: border-box !important;
      margin: 0 !important;
      padding: 10px 2px 24px !important;
      display: flex !important;
      align-items: flex-start !important;
    }
    .reader-screen.reader-focus-open .reader-story-open {
      position: relative !important;
      z-index: 1 !important;
      width: 100% !important;
      min-height: 42px !important;
    }
    @media (max-height: 760px) {
      .reader-screen.reader-focus-open .reader-story-card.reader-story-card {
        --reader-card-gap: 7px;
        --reader-footer-height: 66px;
        grid-template-rows: 282px minmax(0, 1fr) var(--reader-footer-height) !important;
      }
      .reader-screen.reader-focus-open .reader-story-hero.reader-story-hero {
        grid-template-rows: auto minmax(58px, auto) minmax(0, 1fr) !important;
        gap: 7px !important;
        padding: 11px 12px !important;
        border-radius: 18px !important;
      }
      .reader-screen.reader-focus-open .reader-story-title-slot {
        min-height: 58px !important;
        padding: 5px 2px 7px !important;
      }
      .reader-screen.reader-focus-open .reader-story-title.reader-swipe-title {
        font-size: 18px !important;
      }
      .reader-screen.reader-focus-open .reader-story-media-frame {
        border-radius: 13px !important;
      }
      .reader-screen.reader-focus-open .reader-story-brand-fallback {
        padding: 30px !important;
      }
      .reader-screen.reader-focus-open .reader-story-hero-image.reader-story-hero-image--contain {
        padding: 12px !important;
      }
      .reader-screen.reader-focus-open .reader-story-actions {
        padding: 8px 2px 16px !important;
      }
      .reader-screen.reader-focus-open .reader-story-open {
        min-height: 40px !important;
      }
    }
  `;
  (document.head || document.documentElement).append(style);
}

function ensureHeroStructure(card) {
  if (!card?.isConnected) return null;
  const hero = card.querySelector('.reader-story-hero');
  const title = card.querySelector('[data-reader-title]');
  const top = hero?.querySelector('.reader-story-hero-top');
  if (!hero || !title) return null;

  let titleSlot = hero.querySelector('.reader-story-title-slot');
  if (!titleSlot) {
    titleSlot = document.createElement('div');
    titleSlot.className = 'reader-story-title-slot';
  }
  if (titleSlot.parentElement !== hero || (top && top.nextElementSibling !== titleSlot)) {
    if (top) top.after(titleSlot);
    else hero.append(titleSlot);
  }
  if (title.parentElement !== titleSlot) titleSlot.append(title);

  let frame = hero.querySelector('.reader-story-media-frame');
  if (!frame) {
    frame = document.createElement('div');
    frame.className = 'reader-story-media-frame';
    frame.setAttribute('aria-hidden', 'true');
  }
  if (frame.parentElement !== hero || titleSlot.nextElementSibling !== frame) titleSlot.after(frame);

  const image = hero.querySelector('img.reader-story-hero-image');
  if (image && image.parentElement !== frame) frame.append(image);
  return frame;
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

function publisherSourceUrlOf(card) {
  const stored = compactText(card?.dataset?.readerSourceUrl || '', 1200);
  if (stored) return stored;
  const link = articleLinkOf(card);
  try {
    const url = new URL(link);
    return url.hostname.toLowerCase() === 'news.google.com' ? '' : url.href;
  } catch { return ''; }
}

function publisherBrandUrl(sourceUrl = '') {
  try {
    const url = new URL(String(sourceUrl || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    return `https://www.google.com/s2/favicons?sz=256&domain_url=${encodeURIComponent(url.origin)}`;
  } catch { return ''; }
}

function ensureBrandFallback(card, frame = ensureHeroStructure(card)) {
  if (!card?.isConnected || !frame || frame.querySelector('img.reader-story-hero-image')) return null;
  const existing = frame.querySelector('img.reader-story-brand-fallback');
  if (existing) return existing;
  const sourceUrl = publisherSourceUrlOf(card);
  const src = publisherBrandUrl(sourceUrl);
  if (!src) return null;
  const image = document.createElement('img');
  image.className = 'reader-story-brand-fallback';
  image.dataset.readerImageKind = 'site-brand';
  image.src = src;
  image.alt = '';
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => {
    readerTrace('hero-image-brand-ready', {
      articleId: compactText(card.dataset.articleId || card.dataset.key || '', 700),
      sourceUrl
    });
    sendImageDiagnostic(card, 'site-brand-loaded', image.currentSrc || image.src || src);
  }, { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  frame.append(image);
  return image;
}

function appendResolvedHeroImage(card, imageUrl, imageKind = '') {
  if (!card?.isConnected || !imageUrl || card.querySelector('img.reader-story-hero-image')) return false;
  const frame = ensureHeroStructure(card);
  if (!frame) return false;
  const image = document.createElement('img');
  image.className = 'reader-story-hero-image';
  image.dataset.readerResolvedImage = '1';
  image.src = imageUrl;
  image.alt = '';
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.style.visibility = 'hidden';
  setResolvedImageFit(image, imageKind);
  image.addEventListener('load', () => {
    image.style.visibility = 'visible';
    frame.querySelector('img.reader-story-brand-fallback')?.remove();
    card.dataset.readerImageResolved = '1';
    card.dataset.readerImageFailed = '0';
    sendImageDiagnostic(card, 'resolved-on-demand', image.currentSrc || image.src || imageUrl);
  }, { once: true });
  frame.append(image);
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
  const sourceUrl = publisherSourceUrlOf(card);
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
    const timer = setTimeout(() => controller.abort(), IMAGE_RESOLVE_BUDGET_MS);
    request = fetch(IMAGE_RESOLVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, title, source, sourceUrl, link }),
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
    card.dataset.readerImageResolve = error?.name === 'AbortError' ? 'deadline' : 'error';
    readerTrace('hero-image-resolve-error', { articleId, source, error: String(error?.name || 'Error') + ':' + String(error?.message || error) });
    sendImageDiagnostic(card, error?.name === 'AbortError' ? 'photo-deadline-site-brand-kept' : 'resolve-request-error');
  });
}

function scheduleMissingHeroImage(card, { delayMs = 0 } = {}) {
  if (!card?.isConnected || card.dataset.readerImagePrefetchScheduled === '1') return;
  card.dataset.readerImagePrefetchScheduled = '1';
  const started = Date.now();
  setTimeout(() => {
    if (!card?.isConnected) return;
    card.dataset.readerImagePrefetchScheduled = '0';
    if (card.querySelector('img.reader-story-hero-image')) return;
    sendImageDiagnostic(card, 'missing-item-image');
    readerTrace('hero-image-background-start', {
      articleId: compactText(card.dataset.articleId || card.dataset.key || '', 700),
      summaryProvider: compactText(card.dataset.summaryProvider || '', 80),
      waitedMs: Date.now() - started
    });
    resolveMissingHeroImage(card);
  }, Math.max(0, Number(delayMs) || 0));
}

function observeImageCard(card) {
  if (!card?.matches?.('.reader-story-card') || card.dataset.readerImageObserved === '1') return;
  card.dataset.readerImageObserved = '1';
  const frame = ensureHeroStructure(card);
  const existing = frame?.querySelector('img.reader-story-hero-image') || card.querySelector('img.reader-story-hero-image');
  if (existing) setResolvedImageFit(existing, existing.dataset.readerImageKind || '');
  if (imageIntersectionObserver) {
    imageIntersectionObserver.observe(card);
    return;
  }
  if (!existing) {
    ensureBrandFallback(card, frame);
    scheduleMissingHeroImage(card);
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
        const frame = ensureHeroStructure(card);
        const image = frame?.querySelector('img.reader-story-hero-image') || card.querySelector('img.reader-story-hero-image');
        if (image) setResolvedImageFit(image, image.dataset.readerImageKind || '');
        if (!image) {
          ensureBrandFallback(card, frame);
          scheduleMissingHeroImage(card);
        }
        imageIntersectionObserver.unobserve(card);
      }
    }, { threshold: [0], rootMargin: '45% 0px 45% 0px' });
  }

  document.addEventListener('error', event => {
    const image = event.target;
    if (!image?.matches?.('img.reader-story-hero-image')) return;
    const card = image.closest('.reader-story-card');
    if (!card) return;
    const failedUrl = image.currentSrc || image.src || '';
    const wasResolved = image.dataset.readerResolvedImage === '1';
    sendImageDiagnostic(card, wasResolved ? 'resolved-browser-image-error' : 'browser-image-error', failedUrl);
    image.remove();
    card.dataset.readerImageResolved = '0';
    card.dataset.readerImageFailed = '1';
    ensureBrandFallback(card, ensureHeroStructure(card));
    if (!wasResolved) {
      card.dataset.readerImageResolve = '';
      scheduleMissingHeroImage(card);
    }
  }, true);

  scanImageCards(document);
  imageMutationObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node?.nodeType === 1) scanImageCards(node);
      }
      if (mutation.type === 'attributes' && mutation.target?.matches?.('.reader-story-card')) ensureHeroStructure(mutation.target);
    }
  });
  imageMutationObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-summary-provider'] });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installReaderImageDiagnostics, { once: true });
  else queueMicrotask(installReaderImageDiagnostics);
}
