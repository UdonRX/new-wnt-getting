/*
 * Personal Dashboard v2.18.1 runtime reliability patch.
 * Loaded by src/main.js before the application boots.
 *
 * - Serializes reader summary requests so a fast swipe cannot burst Gemini.
 * - Routes summaries to the v2.18.1 endpoint with per-request retry.
 * - Avoids a duplicate paper-title Gemini call while a summary is in flight.
 * - Replaces only Wikipedia's "today" rows with Wikipedia:今日は何の日 data.
 * - Makes Reader list chrome fade continuously with scroll distance.
 * - Reverses Reader list horizontal swipe semantics:
 *     left swipe => move right / next source, then next major category.
 *     right swipe => move left / previous source/category.
 */

const nativeFetch = window.fetch.bind(window);
const BUILD_KEY = 'pdv2:runtime:v2181';
let activeSummaryRequests = 0;
const summaryWaiters = [];

function pathOf(input) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function rewriteInput(input, pathname) {
  const url = pathOf(input);
  if (!url) return input;
  url.pathname = pathname;
  if (input instanceof Request) return new Request(url.href, input);
  return url.href;
}

async function withSummarySlot(task) {
  if (activeSummaryRequests >= 1) {
    await new Promise(resolve => summaryWaiters.push(resolve));
  }
  activeSummaryRequests += 1;
  try {
    return await task();
  } finally {
    activeSummaryRequests = Math.max(0, activeSummaryRequests - 1);
    summaryWaiters.shift()?.();
  }
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

async function mergedWikipediaDaily(input, init) {
  const baseInput = input instanceof Request ? new Request(input) : input;
  const [baseResult, todayResult] = await Promise.allSettled([
    nativeFetch(baseInput, init),
    nativeFetch('/api/wikipedia-today-v2181', { cache: 'no-store' })
  ]);

  if (baseResult.status !== 'fulfilled') throw baseResult.reason;
  const baseResponse = baseResult.value;
  if (!baseResponse.ok || todayResult.status !== 'fulfilled' || !todayResult.value.ok) {
    return baseResponse;
  }

  try {
    const [base, today] = await Promise.all([
      baseResponse.clone().json(),
      todayResult.value.json()
    ]);
    if (!Array.isArray(base?.items) || !Array.isArray(today?.items)) return baseResponse;

    const nonToday = base.items.filter(item => item?.kind !== 'today');
    const merged = {
      ...base,
      date: today.date || base.date,
      dateLabel: today.dateLabel || base.dateLabel,
      counts: { ...(base.counts || {}), today: today.items.length },
      todaySource: today.todaySource || 'Wikipedia:今日は何の日',
      items: [...today.items, ...nonToday]
    };
    return jsonResponse(merged, 200, { 'Cache-Control': 'no-store' });
  } catch {
    return baseResponse;
  }
}

window.fetch = async function pdv2181Fetch(input, init) {
  const url = pathOf(input);
  if (!url || url.origin !== location.origin) return nativeFetch(input, init);

  if (url.pathname === '/api/summary') {
    return withSummarySlot(() => nativeFetch(rewriteInput(input, '/api/summary-v2181'), init));
  }

  if (url.pathname === '/api/paper-titles' && activeSummaryRequests > 0) {
    return jsonResponse({ translations: [], skipped: 'summary-in-flight-v2181' });
  }

  if (url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return mergedWikipediaDaily(input, init);
  }

  return nativeFetch(input, init);
};

try {
  if (localStorage.getItem(BUILD_KEY) !== '1') {
    localStorage.removeItem('reader-summary-cache-v2180');
    localStorage.removeItem('pdv2:wikipediaDaily:v213');
    localStorage.setItem(BUILD_KEY, '1');
  }
} catch {}

const clamp01 = value => Math.max(0, Math.min(1, value));

let fadeRaf = 0;
function paintReaderListFade() {
  fadeRaf = 0;
  const screen = document.querySelector('.reader-screen.reader-list-open');
  if (!screen) return;

  const y = Math.max(0, window.scrollY || document.scrollingElement?.scrollTop || 0);
  const general = clamp01((y - 4) / 92);
  const sources = clamp01((y - 2) / 72);

  const fade = (node, progress, distance = 12) => {
    if (!node) return;
    node.style.opacity = String(1 - progress);
    node.style.transform = `translate3d(0, ${(-distance * progress).toFixed(2)}px, 0) scale(${(1 - progress * .015).toFixed(4)})`;
    node.style.pointerEvents = progress > .94 ? 'none' : '';
  };

  fade(screen.querySelector(':scope > .topbar'), general, 13);
  fade(screen.querySelector(':scope > .reader-mode-nav'), general, 11);
  fade(screen.querySelector(':scope > .paper-track-level'), general, 9);

  const rail = screen.querySelector('.reader-source-scroll');
  if (rail) {
    rail.style.opacity = String(1 - sources);
    rail.style.transform = `translate3d(${(-10 * sources).toFixed(2)}px, 0, 0) scale(${(1 - sources * .012).toFixed(4)})`;
    rail.style.pointerEvents = sources > .92 ? 'none' : '';
  }
}

function requestReaderFadePaint() {
  if (fadeRaf) return;
  fadeRaf = requestAnimationFrame(paintReaderListFade);
}

window.addEventListener('scroll', requestReaderFadePaint, { passive: true });
window.addEventListener('pdv2:before-navigate', () => requestAnimationFrame(requestReaderFadePaint));
new MutationObserver(() => requestReaderFadePaint()).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class']
});
requestReaderFadePaint();

let swipeStart = null;
let suppressClickUntil = 0;

function listScreen() {
  return document.querySelector('.reader-screen.reader-list-open');
}

function ignoredSwipeTarget(target) {
  return Boolean(target?.closest?.(
    'input,textarea,select,a,button,.reader-source-dock,.reader-mode-nav,.paper-track-level'
  ));
}

function activeButton(nodes) {
  return nodes.findIndex(node => node.classList.contains('active'));
}

function afterRender(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function setBoundarySource(direction) {
  const screen = listScreen();
  if (!screen) return;
  const modeButtons = [...screen.querySelectorAll('.reader-mode-nav .segmented button')];
  const modeIndex = activeButton(modeButtons);
  const modeLabel = modeButtons[modeIndex]?.textContent?.trim() || '';

  if (modeLabel === '論文') {
    const tracks = [...screen.querySelectorAll('.paper-track-level .segmented button')];
    const core = tracks.find(button => /製品・熱研究/.test(button.textContent || ''));
    if (direction > 0 && core && !core.classList.contains('active')) core.click();
    return;
  }

  const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
  if (!chips.length) return;
  const target = direction > 0 ? chips[0] : chips.at(-1);
  if (target && !target.classList.contains('active')) target.click();
}

function switchMajorMode(modeButtons, modeIndex, direction) {
  const next = modeIndex + direction;
  if (next < 0 || next >= modeButtons.length) return false;
  modeButtons[next]?.click();
  afterRender(() => setBoundarySource(direction));
  return true;
}

function stepReaderList(direction) {
  const screen = listScreen();
  if (!screen || ![-1, 1].includes(direction)) return false;

  const modeButtons = [...screen.querySelectorAll('.reader-mode-nav .segmented button')];
  const modeIndex = activeButton(modeButtons);
  if (modeIndex < 0) return false;
  const modeLabel = modeButtons[modeIndex]?.textContent?.trim() || '';

  if (modeLabel === '論文') {
    const tracks = [...screen.querySelectorAll('.paper-track-level .segmented button')];
    const trackIndex = activeButton(tracks);
    const creative = trackIndex >= 0 && /独創研究/.test(tracks[trackIndex]?.textContent || '');

    if (!creative) {
      if (direction > 0) {
        const creativeButton = tracks.find(button => /独創研究/.test(button.textContent || ''));
        if (!creativeButton) return false;
        creativeButton.click();
        afterRender(() => {
          const nextScreen = listScreen();
          const chips = [...(nextScreen?.querySelectorAll('.reader-source-scroll .chip') || [])];
          if (chips[0] && !chips[0].classList.contains('active')) chips[0].click();
        });
        return true;
      }
      return switchMajorMode(modeButtons, modeIndex, -1);
    }

    const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
    const chipIndex = activeButton(chips);
    const nextChip = chipIndex + direction;
    if (nextChip >= 0 && nextChip < chips.length) {
      chips[nextChip].click();
      return true;
    }
    if (direction < 0) {
      const coreButton = tracks.find(button => /製品・熱研究/.test(button.textContent || ''));
      coreButton?.click();
      return Boolean(coreButton);
    }
    return false;
  }

  const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
  const chipIndex = activeButton(chips);
  const nextChip = chipIndex + direction;
  if (nextChip >= 0 && nextChip < chips.length) {
    chips[nextChip].click();
    return true;
  }
  return switchMajorMode(modeButtons, modeIndex, direction);
}

document.addEventListener('touchstart', event => {
  const screen = listScreen();
  if (!screen || event.touches?.length !== 1) return;
  if (!screen.contains(event.target) || ignoredSwipeTarget(event.target)) return;
  if (!event.target?.closest?.('.reader-content-host')) return;
  const touch = event.touches[0];
  swipeStart = { x: touch.clientX, y: touch.clientY };
}, { capture: true, passive: true });

document.addEventListener('touchend', event => {
  if (!swipeStart || !event.changedTouches?.length) {
    swipeStart = null;
    return;
  }
  const touch = event.changedTouches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  swipeStart = null;

  if (Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy) * 1.35) return;

  const direction = dx < 0 ? 1 : -1;
  if (!stepReaderList(direction)) return;

  suppressClickUntil = Date.now() + 420;
  event.preventDefault();
  event.stopImmediatePropagation();
}, { capture: true, passive: false });

document.addEventListener('click', event => {
  if (Date.now() >= suppressClickUntil) return;
  const screen = listScreen();
  if (!screen || !screen.contains(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
