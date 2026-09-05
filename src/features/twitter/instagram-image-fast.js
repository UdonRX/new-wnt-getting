const MEDIA_PATH_PREFIX = '/__pdv2_ig_media/';
const GALLERY_ROOT_MARGIN = '500px 0px 500px 0px';
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

function warmRemoteThroughFastPath(image, remoteSrc, { refresh = false } = {}) {
  const context = mediaContext(image);
  if (!context || !isInstagramRemote(remoteSrc)) return;
  image.loading = 'eager';
  try { image.fetchPriority = 'high'; } catch {}
  setImageSrc(image, stablePath(context.key, context.index, remoteSrc, { refresh }));
}

function preloadUpgrade(image, remoteSrc) {
  const context = mediaContext(image);
  if (!context || !isInstagramRemote(remoteSrc)) return;
  if (image.dataset.igUpgradePending === remoteSrc) return;

  const previous = image.dataset.igLastGoodSrc || '';
  image.dataset.igUpgradePending = remoteSrc;
  if (previous) setImageSrc(image, previous);

  const probe = new Image();
  probe.decoding = 'async';
  probe.loading = 'eager';
  try { probe.fetchPriority = 'low'; } catch {}
  probe.onload = () => {
    if (!image.isConnected || image.dataset.igUpgradePending !== remoteSrc) return;
    const finalSrc = stablePath(context.key, context.index, remoteSrc);
    delete image.dataset.igUpgradePending;
    setImageSrc(image, finalSrc);
    image.dataset.igLastGoodSrc = finalSrc;
    image.style.filter = '';
    image.style.transform = '';
  };
  probe.onerror = () => {
    if (image.dataset.igUpgradePending === remoteSrc) delete image.dataset.igUpgradePending;
  };
  probe.src = stablePath(context.key, context.index, remoteSrc, { refresh: true });
}

function warmGallery(gallery) {
  if (!gallery || gallery.dataset.igFastWarmed === '1') return;
  gallery.dataset.igFastWarmed = '1';
  const images = [...gallery.querySelectorAll('img[data-instagram-media-index]')];
  images.forEach(image => {
    image.loading = 'eager';
    const src = image.getAttribute('src') || '';
    if (isFastPath(src)) return;
    if (isInstagramRemote(src)) warmRemoteThroughFastPath(image, src);
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
  };

  const onError = event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest('.instagram-media-gallery')) return;
    const src = image.getAttribute('src') || '';
    if (!isFastPath(src)) return;
    evictStable(image);
    try {
      const url = new URL(src, window.location.href);
      const fallback = url.searchParams.get('src') || '';
      if (isInstagramRemote(fallback)) setImageSrc(image, fallback);
    } catch {}
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

    const gallery = image.closest('.instagram-media-gallery');
    if (image.dataset.igLastGoodSrc) {
      preloadUpgrade(image, src);
      return;
    }
    if (gallery?.dataset.igFastWarmed === '1') warmRemoteThroughFastPath(image, src);
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
