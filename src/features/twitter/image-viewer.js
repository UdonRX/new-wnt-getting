import { el } from '../../shared/dom.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function cleanUrl(value) {
  return String(value || '').trim();
}

function paintedPreviewFor(fullUrl) {
  const target = cleanUrl(fullUrl);
  if (!target) return '';

  const images = document.querySelectorAll('.instagram-media-gallery img[data-instagram-media-index]');
  for (const image of images) {
    const markers = [
      image.getAttribute('src'),
      image.currentSrc,
      image.dataset.igDeferredUpgrade,
      image.dataset.igUpgradePending,
      image.dataset.igUpgradeScheduled
    ].map(cleanUrl).filter(Boolean);

    if (!markers.includes(target)) continue;

    const painted = [
      image.dataset.igLastGoodSrc,
      image.dataset.igInitialRemoteSrc,
      image.complete && image.naturalWidth > 0 ? image.currentSrc : '',
      image.complete && image.naturalWidth > 0 ? image.getAttribute('src') : ''
    ].map(cleanUrl).find(Boolean);

    if (painted) return painted;
  }
  return '';
}

function normalizeEntry(value) {
  if (typeof value === 'string') {
    const fullUrl = cleanUrl(value);
    const previewUrl = paintedPreviewFor(fullUrl) || fullUrl;
    return fullUrl ? { previewUrl, fullUrl } : null;
  }

  if (!value || typeof value !== 'object') return null;
  const fullUrl = cleanUrl(value.fullUrl || value.highResUrl || value.url || value.src || value.previewUrl);
  const explicitPreview = cleanUrl(value.previewUrl || value.thumbnailUrl || value.posterUrl);
  const previewUrl = explicitPreview || paintedPreviewFor(fullUrl) || fullUrl;
  return fullUrl || previewUrl ? { previewUrl: previewUrl || fullUrl, fullUrl: fullUrl || previewUrl } : null;
}

export function openImageViewer(images, startIndex = 0) {
  const seen = new Set();
  const list = (images || []).map(normalizeEntry).filter(entry => {
    if (!entry) return false;
    const key = `${entry.previewUrl}\n${entry.fullUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!list.length) return;

  let index = clamp(Number(startIndex) || 0, 0, list.length - 1);
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let gestureStart = null;
  let rafId = 0;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let showToken = 0;
  const pointers = new Map();
  const warm = new Map();

  const overlay = el('div', { class: 'image-viewer', 'aria-label': '画像ビューア' });
  const stage = el('div', { class: 'image-viewer-stage' });
  const img = el('img', {
    class: 'image-viewer-img',
    alt: '拡大画像',
    draggable: 'false',
    decoding: 'async',
    loading: 'eager',
    referrerpolicy: 'no-referrer'
  });
  try { img.fetchPriority = 'high'; } catch {}

  const close = el('button', { class: 'image-viewer-close', type: 'button', 'aria-label': '閉じる', text: '✕' });
  const count = el('div', { class: 'image-viewer-count' });

  const applyNow = () => {
    rafId = 0;
    img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  };
  const scheduleApply = () => {
    if (!rafId) rafId = requestAnimationFrame(applyNow);
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    scheduleApply();
  };

  const twoPointers = () => {
    const iterator = pointers.values();
    const a = iterator.next().value;
    const b = iterator.next().value;
    return a && b ? [a, b] : null;
  };
  const pointerDistance = () => {
    const pair = twoPointers();
    return pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
  };
  const pointerMidpoint = () => {
    const pair = twoPointers();
    return pair ? { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 } : { x: 0, y: 0 };
  };

  const preloadUrl = (url, priority = 'low') => {
    const src = cleanUrl(url);
    if (!src || warm.has(src)) return warm.get(src) || null;
    const preload = new Image();
    preload.decoding = 'async';
    preload.referrerPolicy = 'no-referrer';
    try { preload.fetchPriority = priority; } catch {}
    preload.src = src;
    warm.set(src, preload);
    return preload;
  };

  const upgradeCurrent = (entry, token) => {
    if (!entry?.fullUrl || entry.fullUrl === entry.previewUrl) return;
    const preload = preloadUrl(entry.fullUrl, 'high');
    if (!preload) return;

    const swap = () => {
      if (token !== showToken || !overlay.isConnected || index < 0 || list[index] !== entry) return;
      img.src = entry.fullUrl;
    };

    if (preload.complete && preload.naturalWidth > 0) {
      swap();
      return;
    }
    preload.addEventListener('load', swap, { once: true });
  };

  const preloadAround = () => {
    if (list.length < 2) return;
    const neighbors = [(index + 1) % list.length, (index - 1 + list.length) % list.length];
    neighbors.forEach(i => {
      const entry = list[i];
      preloadUrl(entry.previewUrl || entry.fullUrl, 'low');
    });
  };

  const show = () => {
    const token = ++showToken;
    const entry = list[index];
    const preview = entry.previewUrl || entry.fullUrl;
    const full = entry.fullUrl || preview;

    count.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    reset();

    if (preview) img.src = preview;
    else if (full) img.src = full;

    if (full && full !== preview) upgradeCurrent(entry, token);
    preloadAround();
  };

  const change = dir => {
    if (list.length < 2) return;
    index = (index + dir + list.length) % list.length;
    show();
  };

  const toggleZoomAt = (x, y) => {
    if (scale > 1.05) {
      reset();
      return;
    }
    scale = 2.5;
    const rect = stage.getBoundingClientRect();
    tx = (rect.left + rect.width / 2 - x) * (scale - 1) / scale;
    ty = (rect.top + rect.height / 2 - y) * (scale - 1) / scale;
    scheduleApply();
  };

  const remove = () => {
    showToken += 1;
    if (rafId) cancelAnimationFrame(rafId);
    warm.clear();
    overlay.remove();
  };

  close.onclick = remove;
  overlay.addEventListener('click', event => {
    if (event.target === overlay) remove();
  });

  stage.addEventListener('dblclick', event => toggleZoomAt(event.clientX, event.clientY));
  stage.addEventListener('pointerdown', event => {
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      gestureStart = { x: event.clientX, y: event.clientY, tx, ty, scale, time: performance.now() };
    } else if (pointers.size === 2) {
      gestureStart = { distance: pointerDistance(), scale, mid: pointerMidpoint(), tx, ty, time: performance.now() };
    }
  });

  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && gestureStart?.distance) {
      const d = pointerDistance();
      const mid = pointerMidpoint();
      scale = clamp(gestureStart.scale * (d / Math.max(1, gestureStart.distance)), 1, 5);
      tx = gestureStart.tx + (mid.x - gestureStart.mid.x);
      ty = gestureStart.ty + (mid.y - gestureStart.mid.y);
      scheduleApply();
      return;
    }
    if (pointers.size === 1 && gestureStart?.x != null && scale > 1.01) {
      const p = pointers.values().next().value;
      tx = gestureStart.tx + (p.x - gestureStart.x);
      ty = gestureStart.ty + (p.y - gestureStart.y);
      scheduleApply();
    }
  }, { passive: true });

  const finishPointer = event => {
    const previous = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (pointers.size === 0 && gestureStart?.x != null) {
      const endX = previous?.x ?? event.clientX;
      const endY = previous?.y ?? event.clientY;
      const dx = endX - gestureStart.x;
      const dy = endY - gestureStart.y;
      const elapsed = performance.now() - gestureStart.time;
      const moved = Math.hypot(dx, dy);
      if (scale <= 1.01 && Math.abs(dy) > 64 && Math.abs(dy) > Math.abs(dx) * 1.15 && elapsed < 850) {
        gestureStart = null;
        remove();
        return;
      }
      if (scale <= 1.01 && Math.abs(dx) > 52 && Math.abs(dx) > Math.abs(dy) && elapsed < 750) {
        change(dx < 0 ? 1 : -1);
      } else if (scale <= 1.01) {
        tx = 0;
        ty = 0;
        scheduleApply();
        const now = performance.now();
        if (moved < 12 && now - lastTapAt < 330 && Math.hypot(endX - lastTapX, endY - lastTapY) < 42) {
          lastTapAt = 0;
          toggleZoomAt(endX, endY);
        } else if (moved < 12) {
          lastTapAt = now;
          lastTapX = endX;
          lastTapY = endY;
        }
      }
      gestureStart = null;
    } else if (pointers.size === 1) {
      const one = pointers.values().next().value;
      gestureStart = { x: one.x, y: one.y, tx, ty, scale, time: performance.now() };
    }
  };

  stage.addEventListener('pointerup', finishPointer, { passive: true });
  stage.addEventListener('pointercancel', finishPointer, { passive: true });
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    scale = clamp(scale + (event.deltaY < 0 ? 0.25 : -0.25), 1, 5);
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    scheduleApply();
  }, { passive: false });

  stage.append(img);
  overlay.append(stage, close, count);
  document.getElementById('overlay-root').append(overlay);
  show();
}
