/* Personal Dashboard v2.18.2 runtime coordination.
 * Keeps slow/external work bounded and moves scroll UI using compositor-only values.
 */

const nativeFetch = window.fetch.bind(window);
const BUILD_KEY = 'pdv2:runtime:v2182';
const WIKI_API = 'https://ja.wikipedia.org/w/api.php';
const WIKI_HUB = 'Wikipedia:今日は何の日';
const SUMMARY_TIMEOUT_MS = 40_000;
const SUMMARY_RETRY_DELAY_MS = 2_200;
let activeSummaryRequests = 0;
let lastSummaryStartedAt = 0;
const summaryWaiters = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

function pathOf(input) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

async function withSummarySlot(task) {
  if (activeSummaryRequests >= 1) await new Promise(resolve => summaryWaiters.push(resolve));
  activeSummaryRequests += 1;
  try {
    const wait = Math.max(0, 900 - (Date.now() - lastSummaryStartedAt));
    if (wait) await sleep(wait);
    lastSummaryStartedAt = Date.now();
    return await task();
  } finally {
    activeSummaryRequests = Math.max(0, activeSummaryRequests - 1);
    summaryWaiters.shift()?.();
  }
}

function summaryNeedsRetry(data = {}) {
  const provider = String(data?.provider || '');
  const reason = String(data?.fallbackReason || '');
  return provider === 'insufficient'
    || provider === 'unavailable'
    || /transient|quota|rate|timeout|unavailable|server-fallback/i.test(reason);
}

async function oneSummaryFetch(input, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    return await nativeFetch(input, { ...(init || {}), signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSummaryReliably(input, init) {
  let response = await oneSummaryFetch(input, init);
  let data = null;
  try { data = await response.clone().json(); } catch {}

  const transientHttp = !response.ok && ([408, 425, 429, 500, 502, 503, 504].includes(response.status));
  if (!transientHttp && !summaryNeedsRetry(data)) return response;

  await sleep(SUMMARY_RETRY_DELAY_MS);
  response = await oneSummaryFetch(input, init);
  return response;
}

function jstParts() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

function cleanWiki(value = '') {
  return String(value || '').replace(/\[[0-9０-９]+\]/g, '').replace(/\s+/g, ' ').trim();
}

async function wikiApi(params, { timeout = 10_000, attempts = 2 } = {}) {
  const url = new URL(WIKI_API);
  Object.entries({ action: 'query', format: 'json', formatversion: '2', origin: '*', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await nativeFetch(url.href, {
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && !data?.error) return data;
      const error = new Error(data?.error?.info || `Wikipedia API HTTP ${response.status}`);
      error.statusCode = response.status;
      lastError = error;
      if (attempt + 1 < attempts && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        await sleep(350 + attempt * 250);
        continue;
      }
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && (error?.name === 'AbortError' || /network|fetch failed/i.test(String(error?.message || '')))) {
        await sleep(300 + attempt * 250);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Wikipedia API error');
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
  const isHeading = node => /^H[23]$/.test(node?.tagName || '')
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
      const target = [...anchors].sort((a, b) => Math.min(b.text.length, 24) - Math.min(a.text.length, 24))[0]?.title;
      if (!target) continue;
      rows.push({ title: target, reason: `${month}月${day}日 — ${eventText.slice(0, 150)}`, sourcePage });
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
    const heading = Array.from(hub.querySelectorAll('h2,h3')).find(node => wikiHeadingText(node) === 'テンプレート');
    if (heading) {
      const nodes = wikiSectionNodes(heading);
      const text = cleanWiki(nodes.map(node => node.textContent || '').join(' '));
      const rendered = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!rendered || (Number(rendered[2]) === month && Number(rendered[3]) === day)) {
        const rows = wikiCandidates(nodes, month, day, WIKI_HUB);
        if (rows.length) return { rows, sourcePage: WIKI_HUB };
      }
    }
  } catch (error) {
    console.warn('[wikipedia-v2182] hub fallback:', error?.message || error);
  }

  const page = `${WIKI_HUB} ${month}月`;
  const monthly = await wikiParse(page);
  const wanted = `${month}月${day}日`;
  const heading = Array.from(monthly.querySelectorAll('h2,h3')).find(node => wikiHeadingText(node) === wanted);
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
    redirects: '1', exintro: '1', explaintext: '1', exchars: '420',
    piprop: 'thumbnail', pithumbsize: '720', inprop: 'url'
  });
  const resolve = wikiTitleResolver(data.query || {});
  const pages = new Map((data.query?.pages || []).filter(page => !page.missing).map(page => [page.title, page]));
  const items = [];
  const used = new Set();
  for (const candidate of wanted) {
    if (items.length >= 10) break;
    const page = pages.get(resolve(candidate.title));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    items.push({
      id: `${date}:today:${page.pageid || items.length}`,
      date, kind: 'today', category: '今日の出来事', categoryShort: '今日',
      title: page.title, reason: candidate.reason, extract: String(page.extract || '').trim(),
      thumbnail: page.thumbnail?.source || '',
      url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`
    });
  }
  return { date, dateLabel: `${month}月${day}日`, todaySource: sourcePage, items };
}

async function mergedWikipediaDaily(input, init) {
  const basePromise = nativeFetch(input instanceof Request ? new Request(input) : input, init);
  const todayPromise = loadWikipediaTodayDirect().catch(error => {
    console.warn('[wikipedia-v2182] today direct failed:', error?.message || error);
    return null;
  });
  const baseResponse = await basePromise;
  if (!baseResponse.ok) return baseResponse;
  const today = await todayPromise;
  if (!today?.items?.length) return baseResponse;
  try {
    const base = await baseResponse.clone().json();
    if (!Array.isArray(base?.items)) return baseResponse;
    return jsonResponse({
      ...base,
      date: today.date || base.date,
      dateLabel: today.dateLabel || base.dateLabel,
      counts: { ...(base.counts || {}), today: today.items.length },
      todaySource: today.todaySource,
      items: [...today.items, ...base.items.filter(item => item?.kind !== 'today')]
    }, 200, { 'Cache-Control': 'no-store' });
  } catch {
    return baseResponse;
  }
}

const WIKI_SKIP_HEADINGS = /^(脚注|注釈|出典|参考文献|参考資料|関連項目|外部リンク|参考|文献|ギャラリー|一覧)$/;
function wikipediaArticleFromHtml(title, html) {
  const doc = new DOMParser().parseFromString(`<main>${html || ''}</main>`, 'text/html');
  doc.querySelectorAll('script,style,table,figure,.thumb,.mw-editsection,.navbox,.infobox,.sidebar,.metadata,.hatnote,sup.reference,.reflist')
    .forEach(node => node.remove());
  const blocks = [];
  let totalChars = 0;
  let skip = false;
  for (const node of doc.querySelectorAll('h2,h3,p,li')) {
    if (/^H[23]$/.test(node.tagName)) {
      const heading = cleanWiki(node.textContent).replace(/\[編集\]$/, '').trim();
      skip = WIKI_SKIP_HEADINGS.test(heading);
      if (!skip && heading) { blocks.push({ type: 'heading', text: heading }); totalChars += heading.length; }
      continue;
    }
    if (skip) continue;
    const value = cleanWiki(node.textContent);
    if (value.length < 18) continue;
    blocks.push({ type: node.tagName === 'LI' ? 'list' : 'paragraph', text: value });
    totalChars += value.length;
    if (totalChars > 65_000) break;
  }
  if (!blocks.length) throw new Error('Wikipedia本文を解析できませんでした');
  const cleanTitle = cleanWiki(String(title || '').replace(/<[^>]+>/g, ''));
  return {
    title: cleanTitle,
    blocks,
    text: blocks.map(block => block.text).join('\n\n'),
    url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(cleanTitle.replace(/ /g, '_'))}`
  };
}

async function wikipediaArticleDirect(title) {
  const data = await wikiApi({ action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1' }, { timeout: 11_000, attempts: 2 });
  const html = data?.parse?.text || '';
  if (!html) throw new Error('Wikipedia本文を取得できませんでした');
  return wikipediaArticleFromHtml(data?.parse?.displaytitle || title, html);
}

function firstSuccessful(promises) {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    let lastError = null;
    for (const promise of promises) {
      Promise.resolve(promise).then(resolve).catch(error => {
        lastError = error;
        remaining -= 1;
        if (!remaining) reject(lastError || new Error('すべての取得経路に失敗しました'));
      });
    }
  });
}

async function wikipediaArticleRace(input, init, title) {
  const server = nativeFetch(input instanceof Request ? new Request(input) : input, init).then(async response => {
    if (!response.ok) throw new Error(`Wikipedia server HTTP ${response.status}`);
    const data = await response.clone().json().catch(() => null);
    if (!data?.blocks?.length) throw new Error('Wikipedia server response was incomplete');
    return response;
  });
  const direct = wikipediaArticleDirect(title).then(data => jsonResponse(data, 200, { 'Cache-Control': 'no-store' }));
  return firstSuccessful([direct, server]);
}

window.fetch = async function pdv2182Fetch(input, init) {
  const url = pathOf(input);
  if (!url || url.origin !== location.origin) return nativeFetch(input, init);

  if (url.pathname === '/api/summary') {
    return withSummarySlot(() => fetchSummaryReliably(input, init));
  }
  if (url.pathname === '/api/paper-titles' && activeSummaryRequests > 0) {
    return jsonResponse({ translations: [], skipped: 'summary-in-flight-v2182' });
  }
  if (url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return mergedWikipediaDaily(input, init);
  }
  if (url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'article') {
    const title = String(url.searchParams.get('title') || '').trim();
    if (title) return wikipediaArticleRace(input, init, title);
  }
  return nativeFetch(input, init);
};

try {
  if (localStorage.getItem(BUILD_KEY) !== '1') {
    localStorage.removeItem('reader-summary-cache-v2180');
    localStorage.removeItem('pdv2:wikipediaDaily:v213');
    localStorage.removeItem('pdv2:youtubeCache:v2160');
    localStorage.setItem(BUILD_KEY, '1');
  }
} catch {}

const nativeElementScrollTo = Element.prototype.scrollTo;
if (typeof nativeElementScrollTo === 'function') {
  Element.prototype.scrollTo = function pdv2182ElementScrollTo(arg1, arg2) {
    if (this?.classList?.contains('reader-source-scroll')) {
      const active = this.querySelector('.chip.active');
      if (active) {
        const maxLeft = Math.max(0, this.scrollWidth - this.clientWidth);
        const left = Math.max(0, Math.min(maxLeft, active.offsetLeft - 2));
        const behavior = typeof arg1 === 'object' && arg1 ? arg1.behavior : 'auto';
        return nativeElementScrollTo.call(this, { left, top: this.scrollTop || 0, behavior });
      }
    }
    return nativeElementScrollTo.call(this, arg1, arg2);
  };
}

function listScreen() { return document.querySelector('.reader-screen.reader-list-open'); }
function activeButton(nodes) { return nodes.findIndex(node => node.classList.contains('active')); }
function afterRender(callback) { requestAnimationFrame(() => requestAnimationFrame(callback)); }

function setBoundarySource(direction) {
  const screen = listScreen();
  if (!screen) return;
  const modeButtons = [...screen.querySelectorAll('.reader-mode-nav .segmented button')];
  const modeIndex = activeButton(modeButtons);
  const modeLabel = modeButtons[modeIndex]?.textContent?.trim() || '';
  if (modeLabel === '論文') {
    const tracks = [...screen.querySelectorAll('.paper-track-level .segmented button')];
    const target = direction > 0
      ? tracks.find(button => /製品・熱研究/.test(button.textContent || ''))
      : tracks.find(button => /独創研究/.test(button.textContent || ''));
    target?.click();
    if (direction < 0) {
      afterRender(() => {
        const chips = [...(listScreen()?.querySelectorAll('.reader-source-scroll .chip') || [])];
        chips.at(-1)?.click();
      });
    }
    return;
  }
  const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
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
        const target = tracks.find(button => /独創研究/.test(button.textContent || ''));
        target?.click();
        afterRender(() => listScreen()?.querySelector('.reader-source-scroll .chip')?.click());
        return Boolean(target);
      }
      return switchMajorMode(modeButtons, modeIndex, -1);
    }

    const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
    const index = activeButton(chips);
    const next = index + direction;
    if (next >= 0 && next < chips.length) { chips[next].click(); return true; }
    if (direction < 0) {
      const core = tracks.find(button => /製品・熱研究/.test(button.textContent || ''));
      core?.click();
      return Boolean(core);
    }
    return false;
  }

  const chips = [...screen.querySelectorAll('.reader-source-scroll .chip')];
  const index = activeButton(chips);
  const next = index + direction;
  if (next >= 0 && next < chips.length) { chips[next].click(); return true; }
  return switchMajorMode(modeButtons, modeIndex, direction);
}

let readerSwipeStart = null;
document.addEventListener('touchstart', event => {
  const screen = listScreen();
  if (!screen || event.touches?.length !== 1 || !screen.contains(event.target)) return;
  if (!event.target?.closest?.('.reader-content-host')) return;
  if (event.target?.closest?.('input,textarea,select,a,button')) return;
  const touch = event.touches[0];
  readerSwipeStart = { x: touch.clientX, y: touch.clientY };
}, { capture: true, passive: true });

document.addEventListener('touchend', event => {
  if (!readerSwipeStart || !event.changedTouches?.length) { readerSwipeStart = null; return; }
  const touch = event.changedTouches[0];
  const dx = touch.clientX - readerSwipeStart.x;
  const dy = touch.clientY - readerSwipeStart.y;
  readerSwipeStart = null;
  if (Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy) * 1.35) return;
  const direction = dx < 0 ? 1 : -1;
  if (!stepReaderList(direction)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, { capture: true, passive: false });

let stickyRaf = 0;
function paintStickyScreens() {
  stickyRaf = 0;
  const y = Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));
  const progress = clamp01((y - 4) / 96);
  const scale = 1 - progress * 0.12;
  const translate = -4 * progress;

  const twitterChips = document.querySelector('.twitter-list-chips');
  const twitterScreen = twitterChips?.closest('section.screen');
  if (twitterScreen) twitterScreen.classList.add('twitter-list-screen');

  const targets = [document.querySelector('.media-screen-twitch'), twitterScreen].filter(Boolean);
  for (const node of targets) {
    node.style.setProperty('--v2182-sticky-progress', progress.toFixed(4));
    node.style.setProperty('--v2182-sticky-scale', scale.toFixed(4));
    node.style.setProperty('--v2182-sticky-y', `${translate.toFixed(2)}px`);
  }
}
function requestStickyPaint() {
  if (stickyRaf) return;
  stickyRaf = requestAnimationFrame(paintStickyScreens);
}
window.addEventListener('scroll', requestStickyPaint, { passive: true });
window.addEventListener('pdv2:before-navigate', () => requestAnimationFrame(requestStickyPaint));
new MutationObserver(requestStickyPaint).observe(document.documentElement, { childList: true, subtree: true });
requestStickyPaint();
