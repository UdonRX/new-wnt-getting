import { isInstagramCacheFresh, readInstagramCaches } from './instagram-cache.js';

const PROFILE_CONCURRENCY = 3;
const QUALITY_CONCURRENCY = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FORCE_NETWORK_WINDOW_MS = 5000;
const QUALITY_INITIAL_DELAY_MS = 700;
const QUALITY_PROFILE_QUIET_MS = 220;
const QUALITY_PROFILE_WAIT_MAX_MS = 4500;
const activeInstalls = new WeakMap();

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)));
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  let disposed = false;

  const drain = () => {
    if (disposed) return;
    while (active < limit && queue.length) {
      const job = queue.shift();
      if (!job) break;
      active += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          drain();
        });
    }
  };

  return {
    run(fn) {
      if (disposed) return Promise.reject(new DOMException('Instagram limiter disposed', 'AbortError'));
      return new Promise((resolve, reject) => {
        queue.push({ run: fn, resolve, reject });
        drain();
      });
    },
    dispose() {
      disposed = true;
      const error = new DOMException('Instagram limiter disposed', 'AbortError');
      queue.splice(0).forEach(job => job.reject(error));
    },
    stats() { return { active, queued: queue.length }; }
  };
}

function requestUrl(input) {
  try {
    if (input instanceof Request) return new URL(input.url, window.location.href);
    return new URL(String(input || ''), window.location.href);
  } catch {
    return null;
  }
}

function isGetRequest(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  return method === 'GET';
}

function cachedProfileResponse(record, username) {
  const items = Array.isArray(record?.items) ? record.items.slice(0, 12) : [];
  if (!items.length) return null;
  const first = items[0] || {};
  const account = {
    username,
    profileUrl: first?.account?.profileUrl || `https://www.instagram.com/${encodeURIComponent(username)}/`,
    avatarUrl: first?.account?.avatarUrl || null
  };
  const body = {
    ok: true,
    source: 'instagram',
    account,
    count: items.length,
    items,
    hasMore: Boolean(record?.nextCursor || (Array.isArray(record?.items) && record.items.length > items.length)),
    nextCursor: record?.nextCursor || null,
    diagnostics: { source: 'device-cache-stability', checkedAt: record?.checkedAt || 0 }
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-PDV2-Instagram-Cache': 'device'
    }
  });
}

function installCardContainment(root, disposers) {
  const tune = node => {
    if (!(node instanceof Element)) return;
    const cards = node.matches?.('.instagram-timeline-item')
      ? [node]
      : [...(node.querySelectorAll?.('.instagram-timeline-item') || [])];
    cards.forEach(card => {
      if (card.dataset.igStabilityTuned === '1') return;
      card.dataset.igStabilityTuned = '1';
      card.style.contentVisibility = 'auto';
      card.style.containIntrinsicSize = '520px';
      card.style.contain = 'layout paint style';
      card.querySelectorAll('img').forEach(image => {
        if (!image.closest('.instagram-media-gallery')) return;
        image.loading = 'lazy';
        try { image.fetchPriority = 'auto'; } catch {}
      });
    });
  };

  tune(root);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(tune);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  disposers.push(() => observer.disconnect());
}

export function disposeInstagramStability(root) {
  const dispose = activeInstalls.get(root);
  if (!dispose) return;
  activeInstalls.delete(root);
  try { dispose(); } catch {}
}

export function installInstagramStability(root) {
  if (!root) return () => {};
  disposeInstagramStability(root);

  const previousFetch = window.fetch;
  const originalFetch = (input, init) => previousFetch.call(window, input, init);
  const profileLimiter = createLimiter(PROFILE_CONCURRENCY);
  const qualityLimiter = createLimiter(QUALITY_CONCURRENCY);
  const disposers = [];
  let disposed = false;
  let forceNetworkUntil = 0;
  const qualityNotBefore = performance.now() + QUALITY_INITIAL_DELAY_MS;

  const onClick = event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target?.closest('.instagram-screen')) return;
    const label = String(target.getAttribute('title') || target.getAttribute('aria-label') || '').trim();
    if (label === '更新') forceNetworkUntil = Date.now() + FORCE_NETWORK_WINDOW_MS;
  };
  document.addEventListener('click', onClick, true);
  disposers.push(() => document.removeEventListener('click', onClick, true));

  const waitForProfileQuiet = async () => {
    const deadline = performance.now() + QUALITY_PROFILE_WAIT_MAX_MS;
    while (!disposed && performance.now() < deadline) {
      const initialDelay = qualityNotBefore - performance.now();
      if (initialDelay > 0) {
        await sleep(Math.min(120, initialDelay));
        continue;
      }

      const before = profileLimiter.stats();
      if (before.active === 0 && before.queued === 0) {
        // Give the timeline a short chance to enqueue the next account before spending
        // bandwidth/CPU on high-resolution upgrades.
        await sleep(QUALITY_PROFILE_QUIET_MS);
        const after = profileLimiter.stats();
        if (after.active === 0 && after.queued === 0) return;
      } else {
        await sleep(90);
      }
    }
  };

  const patchedFetch = async (input, init) => {
    const url = requestUrl(input);
    if (!url || !isGetRequest(input, init) || url.origin !== window.location.origin) {
      return originalFetch(input, init);
    }

    if (url.pathname === '/api/instagram-profile') {
      const username = String(url.searchParams.get('username') || '').trim().toLowerCase();
      const cursor = String(url.searchParams.get('cursor') || '').trim();

      // Account-manager close asks the timeline to re-evaluate accounts. Reuse a fresh
      // device cache for already-loaded accounts; only a new/stale account hits Instagram.
      if (username && !cursor && Date.now() >= forceNetworkUntil) {
        try {
          const records = await readInstagramCaches([username]);
          const record = records.get(username);
          if (record?.items?.length && isInstagramCacheFresh(record, CACHE_TTL_MS)) {
            const cached = cachedProfileResponse(record, username);
            if (cached) return cached;
          }
        } catch {}
      }

      return profileLimiter.run(() => originalFetch(input, init));
    }

    if (url.pathname === '/api/instagram-image') {
      return qualityLimiter.run(async () => {
        // Data required for the timeline gets priority. High-res image discovery waits
        // until profile requests have gone quiet, while the low-res/direct image can paint.
        await waitForProfileQuiet();
        if (disposed) throw new DOMException('Instagram stability disposed', 'AbortError');
        return originalFetch(input, init);
      });
    }

    return originalFetch(input, init);
  };

  window.fetch = patchedFetch;

  installCardContainment(root, disposers);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (window.fetch === patchedFetch) window.fetch = previousFetch;
    profileLimiter.dispose();
    qualityLimiter.dispose();
    disposers.splice(0).reverse().forEach(fn => {
      try { fn(); } catch {}
    });
  };

  window.addEventListener('pdv2:before-navigate', dispose, { once: true });
  disposers.push(() => window.removeEventListener('pdv2:before-navigate', dispose));
  activeInstalls.set(root, dispose);
  return dispose;
}
