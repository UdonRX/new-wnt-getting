/*
 * Personal Dashboard v2.18.1 runtime reliability patch.
 * Loaded by src/main.js before the application boots.
 *
 * - Serializes reader summary requests so a fast swipe cannot burst Gemini.
 * - Avoids a duplicate paper-title Gemini call while a summary is in flight.
 * - Replaces only Wikipedia's "today" rows from Wikipedia:今日は何の日.
 * - Makes Reader list chrome fade continuously with scroll distance.
 * - Reverses Reader list horizontal swipe semantics:
 *     left swipe => move right / next source, then next major category.
 *     right swipe => move left / previous source/category.
 */

const nativeFetch = window.fetch.bind(window);
const BUILD_KEY = 'pdv2:runtime:v2181';
const WIKI_API = 'https://ja.wikipedia.org/w/api.php';
const WIKI_HUB = 'Wikipedia:今日は何の日';
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

function jstParts() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

function cleanWiki(value = '') {
  return String(value || '').replace(/\[[0-9０-９]+\]/g, '').replace(/\s+/g, ' ').trim();
}

async function wikiApi(params) {
  const url = new URL(WIKI_API);
  Object.entries({ action: 'query', format: 'json', formatversion: '2', origin: '*', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await nativeFetch(url.href, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Wikipedia API HTTP ${response.status}`);
  return response.json();
}

async function wikiParse(page) {
  const data = await wikiApi({ action: 'parse', page, prop: 'text', redirects: '1' });
  const html = data?.parse?.text || '';
  if (!html) throw new Error(`${page} を取得できませんでした`);
  return new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
}

function wikiHeadingText(node) {
  return cleanWiki(node?.textContent).replace(/\[編集\]$/, '').trim();
}

function wikiSectionNodes(start) {
  if (!start) return [];
  const block = start.closest('.mw-heading') || start;
  const out = [];
  const isHeading = node =>
    /^H[23]$/.test(node?.tagName || '')
    || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
  let cursor = block.nextElementSibling;
  while (cursor && !isHeading(cursor)) {
    out.push(cursor);
    cursor = cursor.nextElementSibling;
  }
  return out;
}

function validWikiTarget(title) {
  const value = cleanWiki(title);
  if (!value || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value)) return false;
  if (/^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  if (/^(?:Help|Wikipedia|Template|Category|Portal|File|Special):/i.test(value)) return false;
  return true;
}

function wikiCandidates(nodes, month, day, sourcePage) {
  const rows = [];
  for (const node of nodes) {
    const items = node.matches?.('ul,ol')
      ? Array.from(node.querySelectorAll(':scope > li'))
      : Array.from(node.querySelectorAll?.('li') || []);

    for (const li of items) {
      const eventText = cleanWiki(li.textContent);
      if (eventText.length < 7) continue;
      const anchors = Array.from(li.querySelectorAll('a[title]'))
        .map(a => ({ title: cleanWiki(a.getAttribute('title')), text: cleanWiki(a.textContent) }))
        .filter(row => validWikiTarget(row.title) && row.text.length);
      if (!anchors.length) continue;
      const target = [...anchors]
        .sort((a, b) => Math.min(b.text.length, 24) - Math.min(a.text.length, 24))[0]?.title;
      if (!target) continue;
      rows.push({
        title: target,
        reason: `${month}月${day}日 — ${eventText.slice(0, 150)}`,
        sourcePage
      });
    }
  }

  const seen = new Set();
  return rows.filter(row => {
    const key = row.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function wikiTodayCandidates(month, day) {
  try {
    const hub = await wikiParse(WIKI_HUB);
    const heading = Array.from(hub.querySelectorAll('h2,h3'))
      .find(node => wikiHeadingText(node) === 'テンプレート');
    if (heading) {
      const nodes = wikiSectionNodes(heading);
      const sectionText = cleanWiki(nodes.map(node => node.textContent || '').join(' '));
      const rendered = sectionText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!rendered || (Number(rendered[2]) === month && Number(rendered[3]) === day)) {
        const rows = wikiCandidates(nodes, month, day, WIKI_HUB);
        if (rows.length) return { rows, sourcePage: WIKI_HUB };
      }
    }
  } catch (error) {
    console.warn('[wikipedia-v2181] hub fallback:', error?.message || error);
  }

  const page = `${WIKI_HUB} ${month}月`;
  const monthly = await wikiParse(page);
  const wanted = `${month}月${day}日`;
  const heading = Array.from(monthly.querySelectorAll('h2,h3'))
    .find(node => wikiHeadingText(node) === wanted);
  if (!heading) throw new Error(`${wanted} の節が見つかりませんでした`);
  return { rows: wikiCandidates(wikiSectionNodes(heading), month, day, page), sourcePage: page };
}

function wikiTitleResolver(query = {}) {
  const map = new Map();
  for (const row of query.normalized || []) map.set(row.from, row.to);
  for (const row of query.redirects || []) map.set(row.from, row.to);
  return title => {
    let current = title;
    for (let i = 0; i < 6 && map.has(current); i += 1) current = map.get(current);
    return current;
  };
}

async function loadWikipediaTodayDirect() {
  const { date, month, day } = jstParts();
  const { rows, sourcePage } = await wikiTodayCandidates(month, day);
  const wanted = rows.slice(0, 30);

  const data = await wikiApi({
    action: 'query',
    prop: 'extracts|pageimages|info',
    titles: wanted.map(row => row.title).join('|'),
    redirects: '1',
    exintro: '1',
    explaintext: '1',
    exchars: '420',
    piprop: 'thumbnail',
    pithumbsize: '720',
    inprop: 'url'
  });

  const resolve = wikiTitleResolver(data.query || {});
  const pages = new Map(
    (data.query?.pages || []).filter(page => !page.missing).map(page => [page.title, page])
  );
  const items = [];
  const used = new Set();

  for (const candidate of wanted) {
    if (items.length >= 10) break;
    const page = pages.get(resolve(candidate.title));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    items.push({
      id: `${date}:today:${page.pageid || items.length}`,
      date,
      kind: 'today',
      category: '今日の出来事',
      categoryShort: '今日',
      title: page.title,
      reason: candidate.reason,
      extract: String(page.extract || '').trim(),
      thumbnail: page.thumbnail?.source || '',
      url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`
    });
  }

  return { date, dateLabel: `${month}月${day}日`, todaySource: sourcePage, items };
}

async function mergedWikipediaDaily(input, init) {
  const baseInput = input instanceof Request ? new Request(input) : input;
  const baseResponse = await nativeFetch(baseInput, init);
  if (!baseResponse.ok) return baseResponse;

  try {
    const [base, today] = await Promise.all([
      baseResponse.clone().json(),
      loadWikipediaTodayDirect()
    ]);
    if (!Array.isArray(base?.items) || !Array.isArray(today?.items) || !today.items.length) return baseResponse;

    const merged = {
      ...base,
      date: today.date || base.date,
      dateLabel: today.dateLabel || base.dateLabel,
      counts: { ...(base.counts || {}), today: today.items.length },
      todaySource: today.todaySource,
      items: [...today.items, ...base.items.filter(item => item?.kind !== 'today')]
    };
    return jsonResponse(merged, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    console.warn('[wikipedia-v2181] direct today fallback failed:', error?.message || error);
    return baseResponse;
  }
}

window.fetch = async function pdv2181Fetch(input, init) {
  const url = pathOf(input);
  if (!url || url.origin !== location.origin) return nativeFetch(input, init);

  if (url.pathname === '/api/summary') {
    return withSummarySlot(() => nativeFetch(input, init));
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
