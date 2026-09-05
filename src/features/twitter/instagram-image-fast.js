const MEDIA_PATH_PREFIX = '/__pdv2_ig_media/';
const GALLERY_ROOT_MARGIN = '220px 0px 220px 0px';
const UPGRADE_AFTER_FIRST_PAINT_MS = 420;
const activeInstalls = new WeakMap();

function isInstagramRemote(src) {
  try {
    const url = new URL(String(src || ''), window.location.href);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return false;
    return host === 'instagram.com' || host.endsWith('.instagram.com') || host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

function isFastPath(src) {
  try {
    const url = new URL(String(src || ''), window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith(MEDIA_PATH_PREFIX);
  } catch {
    return false;
  }
}

function mediaContext(image) {
  const card = image.closest('.instagram-timeline-item');
  const key = String(card?.dataset?.instagramItemKey || '').trim();
  const index = Math.max(0, Number(image.dataset.instagramMediaIndex || 0) || 0);
  if (!key) return null;
  return { key, index };
}

function stablePath(key, index, remoteSrc = '', { refresh = false } = {}) {
  const pathname = `${MEDIA_PATH_PREFIX}${encodeURIComponent(key)}/${index}`;
  if (!remoteSrc && !refresh) return pathname;
  const params = new URLSearchParams();
  if (remoteSrc) params.set('src', remoteSrc);
  if (refresh) params.set('refresh', '1');
  return `${pathname}?${params}`;
}

function setImageSrc(image, src) {
  if (!src || image.getAttribute('src') === src) return;
  image.dataset.igFastInternal = '1';
  image.setAttribute('src', src);
  queueMicrotask(() => {
    if (image.dataset.igFastInternal === '1') delete image.dataset.igFastInternal;
  });
}

function serviceWorkerMessage(message) {
  try {
    const worker = navigator.serviceWorker?.controller;
    if (worker) worker.postMessage(message);
  } catch {}
}

function evictStable(image) {
  const context = mediaContext(image);
  if (!context) return;
  serviceWorkerMessage({
    type: 'IG_MEDIA_EVICT',
    path: stablePath(context.key, context.index)
  });
}

function rememberGood(image) {
  const current = image.currentSrc || image.getAttribute('src') || '';
  if (!current || image.naturalWidth <= 0) return;
  image.dataset.igLastGoodSrc = current;
}

function scheduleUpgrade(image, remoteSrc, delay = UPGRADE_AFTER_FIRST_PAINT_MS) {
  if (!image?.isConnected || !isInstagramRemote(remoteSrc)) return;
  if (image.dataset.igUpgradeScheduled === remoteSrc || image.dataset.igUpgradePending === remoteSrc) return;
  image.dataset.igUpgradeScheduled = remoteSrc;
  window.setTimeout(() => {
    if (!image.isConnected || image.dataset.igUpgradeScheduled !== remoteSrc) return;
    delete image.dataset.igUpgradeScheduled;
    preloadUpgrade(image, remoteSrc);
  }, Math.max(0, delay));
}

function preloadUpgrade(image, remoteSrc) {
  if (!image?.isConnected || !isInstagramRemote(remoteSrc)) return;
  if (image.dataset.igUpgradePending === remoteSrc) return;

  const previous = image.dataset.igLastGoodSrc || image.dataset.igInitialRemoteSrc || '';
  image.dataset.igUpgradePending = remoteSrc;
  if (previous && image.getAttribute('src') !== previous) setImageSrc(image, previous);

  // Keep the already-painted image in place. Load the higher-quality URL separately at
  // low priority and swap only after it is decoded/cached by the browser.
  const probe = new Image();
  probe.decoding = 'async';
  probe.loading = 'eager';
  probe.referrerPolicy = 'no-referrer';
  try { probe.fetchPriority = 'low'; } catch {}
  probe.onload = () => {
    if (!image.isConnected || image.dataset.igUpgradePending !== remoteSrc) return;
    delete image.dataset.igUpgradePending;
    setImageSrc(image, remoteSrc);
    image.dataset.igLastGoodSrc = remoteSrc;
    image.style.filter = '';
    image.style.transform = '';
  };
  probe.onerror = () => {
    if (image.dataset.igUpgradePending === remoteSrc) delete image.dataset.igUpgradePending;
  };
  probe.src = remoteSrc;
}

function warmGallery(gallery) {
  if (!gallery || gallery.dataset.igFastWarmed === '1') return;
  gallery.dataset.igFastWarmed = '1';
  const images = [...gallery.querySelectorAll('img[data-instagram-media-index]')];

  images.forEach((image, index) => {
    const src = image.getAttribute('src') || '';
    if (isInstagramRemote(src) && !image.dataset.igInitialRemoteSrc) {
      image.dataset.igInitialRemoteSrc = src;
    }

    // Only the first slide of a near-viewport carousel competes for first-paint
    // bandwidth. Hidden 2/3, 3/3 slides stay lazy/low-priority until needed.
    if (index === 0) {
      image.loading = 'eager';
      try { image.fetchPriority = 'high'; } catch {}
    } else {
      image.loading = 'lazy';
      try { image.fetchPriority = 'low'; } catch {}
    }

    // Do not rewrite a fresh remote image to the Service Worker path here. The previous
    // fast path restarted the same download and was especially expensive on carousels.
  });
}

function installGalleryObserver(root, disposers) {
  if (!('IntersectionObserver' in window)) {
    root.querySelectorAll('.instagram-media-gallery').forEach(warmGallery);
    return null;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      warmGallery(entry.target);
    });
  }, { rootMargin: GALLERY_ROOT_MARGIN });
  const watch = gallery => {
    if (!gallery || gallery.dataset.igFastObserved === '1') return;
    gallery.dataset.igFastObserved = '1';
    observer.observe(gallery);
  };
  root.querySelectorAll('.instagram-media-gallery').forEach(watch);
  disposers.push(() => observer.disconnect());
  return watch;
}

export function disposeInstagramImageFastPath(root) {
  const dispose = activeInstalls.get(root);
  if (!dispose) return;
  activeInstalls.delete(root);
  try { dispose(); } catch {}
}

export function installInstagramImageFastPath(root) {
  if (!root) return () => {};
  disposeInstagramImageFastPath(root);

  const disposers = [];
  const watchGallery = installGalleryObserver(root, disposers);

  const onLoad = event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest('.instagram-media-gallery')) return;
    rememberGood(image);
    image.style.filter = '';
    image.style.transform = '';

    const deferred = String(image.dataset.igDeferredUpgrade || '').trim();
    if (deferred) {
      delete image.dataset.igDeferredUpgrade;
      scheduleUpgrade(image, deferred);
    }
  };

  const onError = event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest('.instagram-media-gallery')) return;
    const src = image.getAttribute('src') || '';

    if (isFastPath(src)) {
      evictStable(image);
      try {
        const url = new URL(src, window.location.href);
        const fallback = url.searchParams.get('src') || '';
        if (isInstagramRemote(fallback)) setImageSrc(image, fallback);
      } catch {}
      return;
    }

    // If the lightweight first image itself fails, fall through to a deferred high-res
    // candidate instead of leaving the card black.
    const deferred = String(image.dataset.igDeferredUpgrade || '').trim();
    if (isInstagramRemote(deferred) && deferred !== src) {
      delete image.dataset.igDeferredUpgrade;
      setImageSrc(image, deferred);
    }
  };

  root.addEventListener('load', onLoad, true);
  root.addEventListener('error', onError, true);
  disposers.push(() => root.removeEventListener('load', onLoad, true));
  disposers.push(() => root.removeEventListener('error', onError, true));

  const processImageMutation = image => {
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.closest('.instagram-media-gallery')) return;
    if (image.dataset.igFastInternal === '1') return;
    const src = image.getAttribute('src') || '';
    if (!isInstagramRemote(src)) return;

    const initial = String(image.dataset.igInitialRemoteSrc || '').trim();
    const good = String(image.dataset.igLastGoodSrc || '').trim();

    if (!initial) {
      image.dataset.igInitialRemoteSrc = src;
      return;
    }

    if (src === initial || src === good) return;

    if (good) {
      // A high-res resolver changed src. Keep the painted source visible, then upgrade in
      // the background without a black/blank transition.
      setImageSrc(image, good);
      scheduleUpgrade(image, src);
      return;
    }

    // The initial image is still loading. Undo an early high-res swap and remember it for
    // after first paint rather than restarting the visible request.
    image.dataset.igDeferredUpgrade = src;
    setImageSrc(image, initial);
  };

  const mutations = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        processImageMutation(record.target);
        continue;
      }
      if (record.type !== 'childList') continue;
      record.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        if (node.matches('.instagram-media-gallery')) watchGallery?.(node);
        node.querySelectorAll?.('.instagram-media-gallery').forEach(gallery => watchGallery?.(gallery));
      });
    }
  });
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  disposers.push(() => mutations.disconnect());

  const dispose = () => {
    disposers.splice(0).reverse().forEach(fn => {
      try { fn(); } catch {}
    });
  };
  activeInstalls.set(root, dispose);
  return dispose;
}
