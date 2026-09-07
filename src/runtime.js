/* Active browser runtime.
 * Consolidated from the former version-layer runtime chain.
 * Keep future runtime changes in this file instead of creating runtime-vXXXX.js files.
 */
const pdv2NativeFetch = window.fetch.bind(window);

// ---------------------------------------------------------------------------
// Runtime base: summary/Wikipedia coordination + Reader/Twitch/SNS motion.
// ---------------------------------------------------------------------------
{
const nativeFetch = pdv2NativeFetch;
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
}

// ---------------------------------------------------------------------------
// Runtime summary streaming/prefetch and Wikipedia fast path.
// ---------------------------------------------------------------------------
{
const rawFetchV2184 = pdv2NativeFetch;
const inheritedFetchV2184 = window.fetch.bind(window);

const summaryCacheV2184 = new Map();
const summaryInflightV2184 = new Map();
const prefetchInflightV2184 = new Map();
const typingV2184 = new WeakMap();

function cleanV2184(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseBodyV2184(init) {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body);
  } catch {}
  return {};
}

function summaryKeyV2184(body = {}) {
  return `${cleanV2184(body.url || body.link) || cleanV2184(body.title)}::${cleanV2184(body.mode) || 'auto'}::v2184`;
}

function jsonResponseV2184(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function hrefV2184(value = '') {
  try { return new URL(value, location.href).href; } catch { return String(value || ''); }
}

function cardForBodyV2184(body = {}) {
  const cards = [...document.querySelectorAll('.reader-swipe-card')];
  const wanted = hrefV2184(body.url || body.link || '');
  if (wanted) {
    const hit = cards.find(card => hrefV2184(card.querySelector('.reader-story-open')?.href || '') === wanted);
    if (hit) return hit;
  }
  const title = cleanV2184(body.title);
  return cards.find(card => cleanV2184(card.querySelector('[data-reader-title]')?.textContent || '') === title) || null;
}

function typeTowardV2184(node, target) {
  if (!node) return;
  const wanted = String(target || '');
  let state = typingV2184.get(node);
  if (!state) {
    state = { target: '', shown: '', raf: 0 };
    typingV2184.set(node, state);
  }
  state.target = wanted;
  if (!state.target.startsWith(state.shown)) state.shown = '';
  if (state.raf) return;

  const tick = () => {
    state.raf = 0;
    if (!node.isConnected) return;
    const chars = Array.from(state.target);
    const current = Array.from(state.shown).length;
    if (current >= chars.length) return;
    const remaining = chars.length - current;
    const step = remaining > 42 ? 4 : remaining > 18 ? 3 : 2;
    state.shown = chars.slice(0, current + step).join('');
    node.textContent = state.shown;
    if (Array.from(state.shown).length < chars.length) state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function partialTaggedV2184(text = '') {
  const source = String(text || '').replace(/\r/g, '');
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const out = {};
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const startMatch = new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'm').exec(source);
    if (!startMatch) continue;
    const start = startMatch.index + startMatch[0].length;
    let end = source.length;
    for (let j = i + 1; j < labels.length; j += 1) {
      const next = new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`, 'm').exec(source.slice(start));
      if (next) { end = start + next.index; break; }
    }
    out[label] = cleanV2184(source.slice(start, end));
  }
  return out;
}

function paintStreamV2184(body, accumulated) {
  const card = cardForBodyV2184(body);
  if (!card) return;
  card.dataset.summaryProvider = 'gemini-stream-v2184';
  const partial = partialTaggedV2184(accumulated);
  if (partial['タイトル']) typeTowardV2184(card.querySelector('[data-reader-title]'), partial['タイトル']);
  const rows = [...card.querySelectorAll('.reader-story-summary-row')];
  ['結論/事実','背景/特徴','影響/展望'].forEach((label, index) => {
    if (!partial[label]) return;
    typeTowardV2184(rows[index]?.querySelector('.reader-story-summary-text'), partial[label]);
  });
  const label = card.querySelector('[data-reader-loading-text]');
  if (label) label.textContent = 'AI要約を生成中';
  const bar = card.querySelector('[data-reader-progress-bar]');
  if (bar) bar.style.width = '90%';
  const value = card.querySelector('[data-reader-progress-value]');
  if (value) value.textContent = '90%';
}

function nextPayloadV2184(body) {
  const card = cardForBodyV2184(body);
  const next = card?.nextElementSibling?.matches?.('.reader-swipe-card') ? card.nextElementSibling : null;
  if (!next) return null;
  const url = next.querySelector('.reader-story-open')?.href || '';
  if (!url) return null;
  return {
    url,
    title: cleanV2184(next.querySelector('[data-reader-title]')?.textContent || ''),
    description: '',
    source: cleanV2184(next.querySelector('.reader-story-source-name')?.textContent || ''),
    category: cleanV2184(next.querySelector('.reader-story-category-badge')?.textContent || ''),
    mode: cleanV2184(body.mode) || '',
    allowAi: true,
    fast: true,
    prefetch: true
  };
}

function prefetchNextV2184(body) {
  const payload = nextPayloadV2184(body);
  if (!payload) return;
  const key = summaryKeyV2184(payload);
  if (summaryCacheV2184.has(key) || prefetchInflightV2184.has(key)) return;
  const task = rawFetchV2184('/api/summary?prefetch=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(14_000)
  }).then(async response => {
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (data?.lines?.length === 3 && !['unavailable','insufficient'].includes(String(data?.provider || ''))) {
      summaryCacheV2184.set(key, data);
    }
    return data;
  }).catch(() => null).finally(() => prefetchInflightV2184.delete(key));
  prefetchInflightV2184.set(key, task);
}

async function consumeStreamV2184(body) {
  const response = await rawFetchV2184('/api/summary?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    cache: 'no-store',
    body: JSON.stringify({
      ...body,
      description: Array.from(cleanV2184(body.description)).slice(0, 500).join('')
    }),
    signal: AbortSignal.timeout(24_000)
  });
  if (!response.ok || !response.body) throw new Error(`summary stream ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finalSummary = null;
  let prefetchStarted = false;

  const consumeLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'delta' && event.text) {
      accumulated += event.text;
      paintStreamV2184(body, accumulated);
      if (!prefetchStarted) {
        prefetchStarted = true;
        setTimeout(() => prefetchNextV2184(body), 180);
      }
    } else if (event.type === 'done' && event.summary) {
      finalSummary = event.summary;
    } else if (event.type === 'error') {
      throw new Error(event.error || 'summary stream error');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!prefetchStarted) prefetchNextV2184(body);
  if (!finalSummary?.lines?.length) throw new Error('summary stream ended without usable result');
  return finalSummary;
}

async function fastSummaryV2184(body) {
  const key = summaryKeyV2184(body);
  if (summaryCacheV2184.has(key)) return summaryCacheV2184.get(key);
  if (summaryInflightV2184.has(key)) return summaryInflightV2184.get(key);

  const task = consumeStreamV2184(body).catch(async () => {
    const response = await rawFetchV2184('/api/summary?retry=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        ...body,
        description: Array.from(cleanV2184(body.description)).slice(0, 500).join('')
      }),
      signal: AbortSignal.timeout(18_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `summary ${response.status}`);
    return data;
  }).then(summary => {
    if (summary?.cacheable !== false && summary?.lines?.length === 3) summaryCacheV2184.set(key, summary);
    return summary;
  }).finally(() => summaryInflightV2184.delete(key));

  summaryInflightV2184.set(key, task);
  return task;
}

async function wikipediaDailyFastV2184(input, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await rawFetchV2184(input, { ...(init || {}), signal: controller.signal });
  } catch (error) {
    return inheritedFetchV2184(input, init);
  } finally {
    clearTimeout(timer);
  }
}

window.fetch = async function pdv2184Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetchV2184(input, init); }

  if (url.origin === location.origin && url.pathname === '/api/summary' && String(init?.method || 'GET').toUpperCase() === 'POST') {
    return jsonResponseV2184(await fastSummaryV2184(parseBodyV2184(init)));
  }
  if (url.origin === location.origin && url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return wikipediaDailyFastV2184(input, init);
  }
  return inheritedFetchV2184(input, init);
};

try {
  if (localStorage.getItem('pdv2:runtime:v2184') !== '1') {
    localStorage.removeItem('reader-summary-cache-v2180');
    localStorage.setItem('pdv2:runtime:v2184', '1');
  }
} catch {}
}

// ---------------------------------------------------------------------------
// Runtime summary UX/cache and Wikipedia direct fallback.
// ---------------------------------------------------------------------------
{
const nativeFetch2185 = pdv2NativeFetch;
const inheritedFetch2185 = window.fetch.bind(window);

const summaryCache2185 = new Map();
const summaryInflight2185 = new Map();
const typing2185 = new WeakMap();
const GENERIC_RE = /(?:記事の要点をわかりやすく整理|についての記事です|背景や特徴.*(?:整理|確認)|影響や今後.*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事)/i;

function clean2185(v=''){return String(v||'').replace(/\s+/g,' ').trim()}
function body2185(init){try{return typeof init?.body==='string'?JSON.parse(init.body):{}}catch{return{}}}
function key2185(b={}){return `${clean2185(b.url||b.link)||clean2185(b.title)}::${clean2185(b.mode)||'auto'}::v2185`}
function json2185(v,status=200){return new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
function href2185(v=''){try{return new URL(v,location.href).href}catch{return String(v||'')}}
function card2185(b={}){const cards=[...document.querySelectorAll('.reader-swipe-card')];const wanted=href2185(b.url||b.link||'');if(wanted){const hit=cards.find(c=>href2185(c.querySelector('.reader-story-open')?.href||'')===wanted);if(hit)return hit}const title=clean2185(b.title);return cards.find(c=>clean2185(c.querySelector('[data-reader-title]')?.textContent||'')===title)||null}

function cancelTyping2185(card){if(!card)return;for(const node of card.querySelectorAll('[data-reader-title],.reader-story-summary-text')){const state=typing2185.get(node);if(state?.raf)cancelAnimationFrame(state.raf);typing2185.delete(node)}}
function type2185(node,target){if(!node)return;const wanted=String(target||'');let state=typing2185.get(node);if(!state){state={target:'',shown:'',raf:0};typing2185.set(node,state)}state.target=wanted;if(!state.target.startsWith(state.shown))state.shown='';if(state.raf)return;const tick=()=>{state.raf=0;if(!node.isConnected)return;const chars=Array.from(state.target),n=Array.from(state.shown).length;if(n>=chars.length)return;state.shown=chars.slice(0,n+(chars.length-n>30?4:2)).join('');node.textContent=state.shown;if(Array.from(state.shown).length<chars.length)state.raf=requestAnimationFrame(tick)};state.raf=requestAnimationFrame(tick)}
function partial2185(text=''){const source=String(text||'').replace(/\r/g,'');const labels=['タイトル','結論/事実','背景/特徴','影響/展望'];const out={};for(let i=0;i<labels.length;i++){const label=labels[i],m=new RegExp(`(?:^|\\n)${label}\\s*[:：]`,'m').exec(source);if(!m)continue;const start=m.index+m[0].length;let end=source.length;for(let j=i+1;j<labels.length;j++){const n=new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`,'m').exec(source.slice(start));if(n){end=start+n.index;break}}out[label]=clean2185(source.slice(start,end))}return out}
function paint2185(body,text){const card=card2185(body);if(!card)return;const p=partial2185(text);if(p['タイトル']&&!GENERIC_RE.test(p['タイトル']))type2185(card.querySelector('[data-reader-title]'),p['タイトル']);const rows=[...card.querySelectorAll('.reader-story-summary-row')];['結論/事実','背景/特徴','影響/展望'].forEach((label,i)=>{if(p[label]&&!GENERIC_RE.test(p[label]))type2185(rows[i]?.querySelector('.reader-story-summary-text'),p[label])})}

async function streamedSummary2185(body){
  const response=await nativeFetch2185('/api/summary?stream=1',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},cache:'no-store',body:JSON.stringify(body),signal:AbortSignal.timeout(28000)});
  if(!response.ok||!response.body)throw new Error(`summary stream ${response.status}`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',acc='',final=null;
  const consume=line=>{if(!line.trim())return;let event;try{event=JSON.parse(line)}catch{return}if(event.type==='delta'&&event.text){acc+=event.text;paint2185(body,acc)}else if(event.type==='done'&&event.summary){final=event.summary}else if(event.type==='error')throw new Error(event.error||'summary stream error')};
  try{while(true){const{value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';lines.forEach(consume)}buffer+=decoder.decode();if(buffer.trim())consume(buffer)}finally{try{reader.releaseLock()}catch{}}
  cancelTyping2185(card2185(body));
  if(!final)throw new Error('summary stream ended without result');
  return final;
}
async function summary2185(body){const key=key2185(body);if(summaryCache2185.has(key))return summaryCache2185.get(key);if(summaryInflight2185.has(key))return summaryInflight2185.get(key);const task=streamedSummary2185(body).catch(async()=>{cancelTyping2185(card2185(body));const response=await nativeFetch2185('/api/summary?retry=1',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify(body),signal:AbortSignal.timeout(22000)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data?.error||`summary ${response.status}`);return data}).then(v=>{if(v?.cacheable!==false&&v?.lines?.length===3&&!v.lines.some(r=>GENERIC_RE.test(String(r?.text||''))))summaryCache2185.set(key,v);return v}).finally(()=>{cancelTyping2185(card2185(body));summaryInflight2185.delete(key)});summaryInflight2185.set(key,task);return task}

const WIKI_API2185='https://ja.wikipedia.org/w/api.php';
const WIKI_FALLBACK={classic:[['八甲田雪中行軍遭難事件','極限状況の判断と組織の失敗'],['三毛別羆事件','日本史上最大級の熊害'],['地方病 (日本住血吸虫症)','原因究明から撲滅までの記録'],['ディアトロフ峠事件','不可解な遭難事件'],['フランクリン遠征','北極圏で消えた探検隊'],['メアリー・セレスト','無人で発見された船の謎'],['ツングースカ大爆発','シベリアで起きた巨大爆発'],['ボイニッチ手稿','今も解読されない写本'],['ロアノーク植民地','住民が消えた植民地'],['コティングリー妖精事件','妖精写真をめぐる騒動']],deep:[['ジョーンズタウン','集団心理とカルトの事例'],['ミルグラム実験','権威への服従を扱った心理実験'],['スタンフォード監獄実験','役割と権力をめぐる実験'],['タスキギー梅毒実験','研究倫理の転換点'],['セイラム魔女裁判','恐怖と集団心理の歴史'],['カーゴ・カルト','物質文化と信仰が交差した現象'],['ダンシングマニア','人々が踊り続けた集団現象'],['チューリップ・バブル','投機熱の象徴'],['共有地の悲劇','個人合理性が全体を壊す考え方'],['傍観者効果','集団の中で援助が遅れる心理現象']],trivia:[['エミュー戦争','軍隊が鳥の群れに手を焼いた珍事件'],['風船おじさん','風船で太平洋横断を試みた人物'],['ダーウィン賞','信じがたい失敗談を集めた風刺的な賞'],['イグノーベル賞','笑えて考えさせられる研究'],['空飛ぶスパゲッティ・モンスター教','風刺から生まれた宗教運動'],['ミラクルフルーツ','酸っぱい物を甘く感じさせる果実'],['水中ホッケー','プールの底で行う競技'],['妻問婚','通い婚という婚姻形態'],['トースト・サンドイッチ','パンでパンを挟む料理'],['シュレーディンガーの猫','量子論を説明する思考実験']]};
function jst2185(){const iso=new Date(Date.now()+9*3600000).toISOString();return{date:iso.slice(0,10),month:Number(iso.slice(5,7)),day:Number(iso.slice(8,10))}}
async function wikiGet2185(params,timeout=6500){const url=new URL(WIKI_API2185);Object.entries({format:'json',formatversion:'2',origin:'*',...params}).forEach(([k,v])=>url.searchParams.set(k,String(v)));const response=await nativeFetch2185(url.href,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeout)});const data=await response.json().catch(()=>({}));if(!response.ok||data?.error)throw new Error(data?.error?.info||`Wikipedia direct ${response.status}`);return data}
function wikiClean2185(v=''){return String(v||'').replace(/\[[0-9０-９]+\]/g,'').replace(/\s+/g,' ').trim()}
async function wikiDailyDirect2185(){
  const{date,month,day}=jst2185();const today=[];
  try{const parsed=await wikiGet2185({action:'parse',page:`${month}月${day}日`,prop:'text',redirects:'1'});const doc=new DOMParser().parseFromString(`<main>${parsed?.parse?.text||''}</main>`,'text/html');const headings=[...doc.querySelectorAll('h2,h3')];const start=headings.find(n=>/^(できごと|出来事)$/.test(wikiClean2185(n.textContent).replace(/\[編集\]$/,'')));if(start){let cursor=(start.closest('.mw-heading')||start).nextElementSibling;while(cursor&&today.length<18){if(/^H[23]$/.test(cursor.tagName)||cursor.matches?.('.mw-heading'))break;for(const li of cursor.querySelectorAll?.('li')||[]){const text=wikiClean2185(li.textContent);const a=[...li.querySelectorAll('a[title]')].find(x=>{const t=wikiClean2185(x.getAttribute('title'));return t&&!t.includes(':')&&!t.includes('#')&&!/^(?:紀元前)?\d{1,4}年$/.test(t)});if(a)today.push([wikiClean2185(a.getAttribute('title')),`${month}月${day}日 — ${text.slice(0,140)}`]);if(today.length>=18)break}cursor=cursor.nextElementSibling}}}catch(error){console.warn('[wiki2185 today]',error?.message||error)}
  const requested=[...today.slice(0,18),...WIKI_FALLBACK.classic,...WIKI_FALLBACK.deep,...WIKI_FALLBACK.trivia];const titles=requested.map(r=>r[0]);const data=await wikiGet2185({action:'query',prop:'extracts|pageimages|info',titles:titles.join('|'),redirects:'1',exintro:'1',explaintext:'1',exchars:'420',piprop:'thumbnail',pithumbsize:'720',inprop:'url'});const map=new Map();for(const n of data?.query?.normalized||[])map.set(n.from,n.to);for(const r of data?.query?.redirects||[])map.set(r.from,r.to);const resolve=t=>{let x=t;for(let i=0;i<5&&map.has(x);i++)x=map.get(x);return x};const pages=new Map((data?.query?.pages||[]).filter(p=>!p.missing).map(p=>[p.title,p]));const items=[];const add=(rows,kind,label)=>{let i=0;for(const[title,reason]of rows){if(i>=10)break;const p=pages.get(resolve(title));if(!p)continue;items.push({id:`${date}:${kind}:${p.pageid||i}`,date,kind,category:label,categoryShort:label,title:p.title,reason,extract:String(p.extract||'').trim(),thumbnail:p.thumbnail?.source||'',url:p.fullurl||`https://ja.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g,'_'))}`});i++}};add(today,'today','今日の出来事');add(WIKI_FALLBACK.classic,'classic','王道・文学系');add(WIKI_FALLBACK.deep,'deep','考察・読み物系');add(WIKI_FALLBACK.trivia,'trivia','雑学・トリビア系');return{date,dateLabel:`${month}月${day}日`,counts:{today:items.filter(x=>x.kind==='today').length,classic:10,deep:10,trivia:10},items,direct:true}}
async function wikiDaily2185(input,init){const direct=wikiDailyDirect2185();const server=nativeFetch2185(input,{...(init||{}),signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw new Error(`server ${r.status}`);return r});try{return await Promise.any([direct.then(v=>json2185(v)),server])}catch{return inheritedFetch2185(input,init)}}

window.fetch=async function pdv2185Fetch(input,init){let url;try{url=new URL(input instanceof Request?input.url:String(input),location.href)}catch{return inheritedFetch2185(input,init)}if(url.origin===location.origin&&url.pathname==='/api/summary'&&String(init?.method||'GET').toUpperCase()==='POST')return json2185(await summary2185(body2185(init)));if(url.origin===location.origin&&url.pathname==='/api/wikipedia'&&url.searchParams.get('mode')==='daily')return wikiDaily2185(input,init);return inheritedFetch2185(input,init)};
try{if(localStorage.getItem('pdv2:runtime:v2185')!=='1'){localStorage.removeItem('reader-summary-cache-v2180');localStorage.removeItem('pdv2:wikipediaDaily:v213');localStorage.setItem('pdv2:runtime:v2185','1')}}catch{}
}

// ---------------------------------------------------------------------------
// Runtime final fetch routing: direct summary POST + corrected Wikipedia today.
// ---------------------------------------------------------------------------
{
const nativeFetch2192 = pdv2NativeFetch;
const inheritedFetch2192 = window.fetch.bind(window);

const WIKI_API2192 = 'https://ja.wikipedia.org/w/api.php';
const WIKI_HUB2192 = 'Wikipedia:今日は何の日';

function clean2192(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function json2192(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function jstParts2192() {
  const iso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}
function wikiClean2192(value = '') {
  return String(value || '').replace(/\[[0-9０-９]+\]/g, '').replace(/\s+/g, ' ').trim();
}
async function wikiGet2192(params, timeout = 8500) {
  const url = new URL(WIKI_API2192);
  Object.entries({ format: 'json', formatversion: '2', origin: '*', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await nativeFetch2192(url.href, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error?.info || `Wikipedia direct ${response.status}`);
  return data;
}
function wikiDoc2192(html = '') { return new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html'); }
function wikiHeading2192(node) { return wikiClean2192(node?.textContent).replace(/\[編集\]$/, '').trim(); }
function wikiSection2192(start) {
  if (!start) return [];
  const block = start.closest('.mw-heading') || start;
  const rows = [];
  const isHeading = node => /^H[23]$/.test(node?.tagName || '') || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
  let cursor = block.nextElementSibling;
  while (cursor && !isHeading(cursor)) { rows.push(cursor); cursor = cursor.nextElementSibling; }
  return rows;
}
function validWikiTarget2192(title = '') {
  const value = wikiClean2192(title);
  if (!value || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value) || /^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  return !/^(?:Help|Wikipedia|Template|Category|Portal|File|Special):/i.test(value);
}
function wikiCandidates2192(nodes, month, day, sourcePage) {
  const rows = [];
  for (const node of nodes) {
    const lis = node.matches?.('ul,ol') ? [...node.querySelectorAll(':scope > li')] : [...(node.querySelectorAll?.('li') || [])];
    for (const li of lis) {
      const eventText = wikiClean2192(li.textContent);
      if (eventText.length < 7) continue;
      const target = [...li.querySelectorAll('a[title]')]
        .map(a => ({ title: wikiClean2192(a.getAttribute('title')), text: wikiClean2192(a.textContent) }))
        .filter(row => validWikiTarget2192(row.title) && row.text.length)
        .sort((a, b) => Math.min(b.text.length, 28) - Math.min(a.text.length, 28))[0]?.title;
      if (target) rows.push({ title: target, reason: `${month}月${day}日 — ${eventText.slice(0, 155)}`, sourcePage });
    }
  }
  const seen = new Set();
  return rows.filter(row => { const key = row.title.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
async function todayCandidates2192(month, day) {
  try {
    const hub = await wikiGet2192({ action: 'parse', page: WIKI_HUB2192, prop: 'text', redirects: '1' });
    const doc = wikiDoc2192(hub?.parse?.text || '');
    const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2192(node) === 'テンプレート');
    if (heading) {
      const nodes = wikiSection2192(heading);
      const rendered = wikiClean2192(nodes.map(node => node.textContent || '').join(' ')).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!rendered || (Number(rendered[2]) === month && Number(rendered[3]) === day)) {
        const rows = wikiCandidates2192(nodes, month, day, WIKI_HUB2192);
        if (rows.length) return { rows, sourcePage: WIKI_HUB2192, sourceMode: 'hub-template' };
      }
    }
  } catch (error) { console.warn('[wikipedia-v2192 hub]', error?.message || error); }

  const monthPage = `${WIKI_HUB2192} ${month}月`;
  const monthly = await wikiGet2192({ action: 'parse', page: monthPage, prop: 'text', redirects: '1' });
  const doc = wikiDoc2192(monthly?.parse?.text || '');
  const wanted = `${month}月${day}日`;
  const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2192(node) === wanted);
  if (!heading) throw new Error(`${wanted} の「今日は何の日」欄が見つかりませんでした`);
  return { rows: wikiCandidates2192(wikiSection2192(heading), month, day, monthPage), sourcePage: monthPage, sourceMode: 'hub-monthly' };
}
function wikiResolver2192(query = {}) {
  const map = new Map();
  for (const row of query.normalized || []) map.set(row.from, row.to);
  for (const row of query.redirects || []) map.set(row.from, row.to);
  return title => { let current = title; for (let i = 0; i < 6 && map.has(current); i += 1) current = map.get(current); return current; };
}
async function loadToday2192() {
  const { date, month, day } = jstParts2192();
  const source = await todayCandidates2192(month, day);
  const wanted = source.rows.slice(0, 30);
  const data = await wikiGet2192({
    action: 'query', prop: 'extracts|pageimages|info', titles: wanted.map(row => row.title).join('|'), redirects: '1',
    exintro: '1', explaintext: '1', exchars: '420', piprop: 'thumbnail', pithumbsize: '720', inprop: 'url'
  });
  const resolve = wikiResolver2192(data.query || {});
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
  return { date, dateLabel: `${month}月${day}日`, todaySource: source.sourcePage, todaySourceMode: source.sourceMode, items };
}
async function wikipediaDaily2192(input, init) {
  const todayPromise = loadToday2192();
  const basePromise = nativeFetch2192(input, init).then(async response => {
    if (!response.ok) throw new Error(`Wikipedia base ${response.status}`);
    const data = await response.clone().json().catch(() => null);
    if (!data?.items) throw new Error('Wikipedia base response invalid');
    return data;
  });
  let today;
  try { today = await todayPromise; }
  catch (error) { console.warn('[wikipedia-v2192 today]', error?.message || error); return inheritedFetch2192(input, init); }
  let base = null;
  try { base = await basePromise; } catch (error) { console.warn('[wikipedia-v2192 base]', error?.message || error); }
  const otherItems = Array.isArray(base?.items) ? base.items.filter(item => item?.kind !== 'today') : [];
  return json2192({
    ...(base || {}), date: today.date, dateLabel: today.dateLabel, todaySource: today.todaySource,
    todaySourceMode: today.todaySourceMode, counts: { ...(base?.counts || {}), today: today.items.length },
    items: [...today.items, ...otherItems]
  });
}

window.fetch = function pdv2192Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2192(input, init); }

  if (
    url.origin === location.origin
    && url.pathname === '/api/summary'
    && String(init?.method || 'GET').toUpperCase() === 'POST'
  ) {
    return nativeFetch2192(input, init);
  }

  if (url.origin === location.origin && url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return wikipediaDaily2192(input, init);
  }

  return inheritedFetch2192(input, init);
};

try { localStorage.setItem('pdv2:runtime:v2192', '1'); } catch {}
}

// ---------------------------------------------------------------------------
// Runtime UI enhancements: Reader gesture, SNS sticky header, media resume/UI.
// ---------------------------------------------------------------------------
{
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const lerp=(a,b,p)=>a+(b-a)*p;
const easeOut=p=>1-Math.pow(1-clamp(p),3);

let readerGesture=null;
let readerSuppressClickUntil=0;
let readerFab=null;
let readerFabSource=null;
let readerFabScreen=null;

function activeButton(container){return [...(container?.querySelectorAll?.('button')||[])].find(button=>button.classList.contains('active')||button.getAttribute('aria-selected')==='true')||null;}
function buttons(container){return [...(container?.querySelectorAll?.('button')||[])];}
function modeInfo(screen){const container=screen?.querySelector('.reader-mode-nav .segmented');const list=buttons(container);let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}
function sourceInfo(screen){const container=screen?.querySelector('.reader-feed-chips');const list=buttons(container).filter(button=>button.classList.contains('chip'));let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}
function trackInfo(screen){const container=screen?.querySelector('.paper-track-level .segmented');const list=buttons(container);let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}

function selectReaderEdge(targetModeIndex,edge,attempt=0){
  if(attempt>24)return;
  const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
  if(!screen){setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),35);return;}
  const mode=modeInfo(screen);
  if(mode.index!==targetModeIndex){setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),35);return;}
  if(targetModeIndex===2){
    const track=trackInfo(screen);
    if(track.list.length){
      const desired=edge==='first'?0:track.list.length-1;
      if(track.index!==desired){track.list[desired]?.click();setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),45);return;}
      if(desired===track.list.length-1){const source=sourceInfo(screen);const button=edge==='first'?source.list[0]:source.list.at(-1);if(button&&!button.classList.contains('active'))button.click();}
    }
    return;
  }
  const source=sourceInfo(screen);const button=edge==='first'?source.list[0]:source.list.at(-1);if(button&&!button.classList.contains('active'))button.click();
}

function readerPlan(screen,direction){
  const mode=modeInfo(screen);if(!mode.list.length)return null;
  const source=sourceInfo(screen);
  if(mode.index<2){
    const next=source.index+direction;
    if(source.list.length&&next>=0&&next<source.list.length)return{container:source.container,from:source.list[source.index],to:source.list[next],commit:()=>source.list[next]?.click()};
    const nextMode=mode.index+direction;if(nextMode<0||nextMode>=mode.list.length)return null;
    return{container:mode.container,from:mode.list[mode.index],to:mode.list[nextMode],commit:()=>{mode.list[nextMode]?.click();setTimeout(()=>selectReaderEdge(nextMode,direction>0?'first':'last'),35);}};
  }
  const track=trackInfo(screen);
  if(track.list.length&&track.index===0){
    if(direction>0&&track.list[1])return{container:track.container,from:track.list[0],to:track.list[1],commit:()=>{track.list[1].click();setTimeout(()=>selectReaderEdge(2,'first'),35);}};
    if(direction<0&&mode.index>0)return{container:mode.container,from:mode.list[mode.index],to:mode.list[mode.index-1],commit:()=>{mode.list[mode.index-1].click();setTimeout(()=>selectReaderEdge(mode.index-1,'last'),35);}};
    return null;
  }
  if(track.list.length&&track.index>0){
    const next=source.index+direction;
    if(source.list.length&&next>=0&&next<source.list.length)return{container:source.container,from:source.list[source.index],to:source.list[next],commit:()=>source.list[next]?.click()};
    if(direction<0)return{container:track.container,from:track.list[track.index],to:track.list[0],commit:()=>track.list[0]?.click()};
  }
  return null;
}

function swipeIndicator(container){
  if(!container)return null;
  let indicator=container.querySelector(':scope > .reader-swipe-progress-indicator');
  if(indicator)return indicator;
  indicator=document.createElement('span');indicator.className='reader-swipe-progress-indicator';indicator.setAttribute('aria-hidden','true');container.append(indicator);return indicator;
}
function paintReaderPlan(plan,progress){
  if(!plan?.container||!plan.from||!plan.to)return;
  const p=clamp(progress);const indicator=swipeIndicator(plan.container);if(!indicator)return;
  plan.container.classList.add('reader-swipe-progress-active');
  const x=lerp(plan.from.offsetLeft,plan.to.offsetLeft,p);const width=lerp(plan.from.offsetWidth,plan.to.offsetWidth,p);
  indicator.style.width=`${Math.max(1,width)}px`;indicator.style.transform=`translate3d(${x}px,0,0)`;indicator.style.opacity='1';
}
function clearReaderPlan(plan){if(!plan?.container)return;const indicator=plan.container.querySelector(':scope > .reader-swipe-progress-indicator');if(indicator)indicator.style.opacity='0';plan.container.classList.remove('reader-swipe-progress-active');}
function readerIgnore(target){return Boolean(target?.closest?.('input,textarea,select,a,.reader-source-dock,.reader-mode-nav,.paper-track-level,.reader-bento-search,.reader-global-recommend-fab'));}
function readerTravel(width){return Math.max(92,Math.min(150,Math.max(1,width)*.36));}
function directionalDistance(g){if(!g?.direction)return 0;return g.direction>0?Math.max(0,-g.dx):Math.max(0,g.dx);}
function captureRailPositions(screen){return{
  mode:screen?.querySelector('.reader-mode-nav .segmented')?.scrollLeft||0,
  source:screen?.querySelector('.reader-feed-chips')?.scrollLeft||0,
  track:screen?.querySelector('.paper-track-level .segmented')?.scrollLeft||0
};}
function freezeReaderRails(positions,duration=320){
  const started=performance.now();
  const tick=()=>{
    const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
    if(!screen||performance.now()-started>duration)return;
    const rows=[['.reader-mode-nav .segmented',positions.mode],['.reader-feed-chips',positions.source],['.paper-track-level .segmented',positions.track]];
    for(const [selector,left] of rows){const node=screen.querySelector(selector);if(node&&Math.abs(node.scrollLeft-left)>.5)node.scrollLeft=left;}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

document.addEventListener('touchstart',event=>{
  if(event.touches?.length!==1)return;
  const target=event.target;const host=target?.closest?.('.reader-screen:not(.reader-focus-open) .reader-content-host');if(!host||readerIgnore(target))return;
  const touch=event.touches[0];readerGesture={host,screen:host.closest('.reader-screen'),startX:touch.clientX,startY:touch.clientY,startAt:performance.now(),dx:0,dy:0,horizontal:false,direction:0,planResolved:false,plan:null,visual:host.querySelector('.reader-bento-view')||host.firstElementChild,railPositions:captureRailPositions(host.closest('.reader-screen'))};
},{capture:true,passive:true});

document.addEventListener('touchmove',event=>{
  const g=readerGesture;if(!g||event.touches?.length!==1)return;
  const touch=event.touches[0];g.dx=touch.clientX-g.startX;g.dy=touch.clientY-g.startY;
  if(!g.horizontal){
    if(Math.abs(g.dy)>12&&Math.abs(g.dy)>Math.abs(g.dx)*1.08){readerGesture=null;return;}
    if(Math.abs(g.dx)<7||Math.abs(g.dx)<=Math.abs(g.dy)*1.08)return;
    g.horizontal=true;g.direction=g.dx<0?1:-1;g.plan=readerPlan(g.screen,g.direction);g.planResolved=true;g.visual?.classList.add('reader-horizontal-live');
  }
  if(event.cancelable)event.preventDefault();
  const distance=directionalDistance(g);const travel=readerTravel(g.host.clientWidth);const p=clamp(distance/travel);
  paintReaderPlan(g.plan,p);
  if(g.visual){const signed=g.direction>0?-distance:distance;g.visual.style.transform=`translate3d(${(signed*.18).toFixed(1)}px,0,0)`;}
},{capture:true,passive:false});

document.addEventListener('touchend',event=>{
  const g=readerGesture;readerGesture=null;if(!g?.horizontal)return;
  event.preventDefault();event.stopImmediatePropagation();readerSuppressClickUntil=Date.now()+360;
  const distance=directionalDistance(g);const elapsed=Math.max(16,performance.now()-g.startAt);const speed=distance/elapsed;const travel=readerTravel(g.host.clientWidth);const p=clamp(distance/travel);const quickFlick=distance>=36&&speed>=.46;const commit=Boolean(g.plan&&(p>=.5||quickFlick));
  if(g.visual){g.visual.style.transition='transform 150ms cubic-bezier(.2,.82,.2,1)';g.visual.style.transform=commit?`translate3d(${g.direction>0?'-38px':'38px'},0,0)`:'translate3d(0,0,0)';setTimeout(()=>{if(g.visual){g.visual.style.transition='';g.visual.style.transform='';g.visual.classList.remove('reader-horizontal-live');}},185);}
  if(g.plan){paintReaderPlan(g.plan,commit?1:0);setTimeout(()=>clearReaderPlan(g.plan),160);}
  if(commit){freezeReaderRails(g.railPositions,340);setTimeout(()=>g.plan?.commit?.(),95);}
},{capture:true,passive:false});

document.addEventListener('touchcancel',()=>{if(readerGesture?.plan)clearReaderPlan(readerGesture.plan);readerGesture=null;},{capture:true,passive:true});
document.addEventListener('click',event=>{if(Date.now()<readerSuppressClickUntil&&event.target?.closest?.('.reader-content-host')){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});

function ensureReaderFab(){
  const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
  if(!screen){readerFab?.remove();readerFab=null;readerFabSource=null;readerFabScreen=null;return false;}
  const source=screen.querySelector('.reader-recommend-overlay');if(!source)return false;source.classList.add('reader-recommend-source-hidden');
  if(readerFabScreen!==screen||readerFabSource!==source||!readerFab?.isConnected){
    readerFab?.remove();readerFabSource=source;readerFabScreen=screen;readerFab=document.createElement('button');readerFab.type='button';readerFab.className='reader-global-recommend-fab';readerFab.setAttribute('aria-label','おすすめへ');readerFab.title='おすすめへ';readerFab.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 13.8 8l5.2 1.8-5.2 1.8L12 17l-1.8-5.4L5 9.8 10.2 8 12 2.8Z"/><path d="m18.2 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>';
    readerFab.addEventListener('click',()=>{if(readerFabSource?.isConnected)readerFabSource.click();});document.body.append(readerFab);
  }
  return true;
}

let twitterCleanup=null;
function installTwitterHeader(){
  const host=document.querySelector('.twitter-feed-host');const screen=host?.closest('.screen');if(!screen)return false;if(screen.dataset.pdv2195Twitter==='1')return true;
  twitterCleanup?.();const topbar=screen.querySelector(':scope > .topbar');const chips=screen.querySelector(':scope > .twitter-list-chips');if(!topbar||!chips)return false;
  screen.dataset.pdv2195Twitter='1';const wrapper=document.createElement('div');wrapper.className='twitter-rich-sticky';screen.insertBefore(wrapper,topbar);wrapper.append(topbar,chips);
  const actions=topbar.querySelector('.topbar-actions');const copy=topbar.querySelector('.topbar-copy');let raf=0,destroyed=false,openHeight=0,actionsY=0,chipsY=0;
  const paint=()=>{raf=0;if(destroyed||!wrapper.isConnected)return;const raw=clamp((window.scrollY||document.scrollingElement?.scrollTop||0)/112);const p=easeOut(raw);wrapper.style.setProperty('--sns-progress',p.toFixed(4));wrapper.style.height=`${lerp(openHeight,52,p).toFixed(1)}px`;if(actions)actions.style.transform=`translate3d(0,${((8-actionsY)*p).toFixed(1)}px,0) scale(${(1-.14*p).toFixed(4)})`;chips.style.transform=`translate3d(0,${((8-chipsY)*p).toFixed(1)}px,0) scale(${(1-.08*p).toFixed(4)})`;chips.style.width=`calc(100% - ${(142*p).toFixed(1)}px)`;if(copy){copy.style.opacity=(1-p).toFixed(3);copy.style.transform=`translate3d(0,${(-12*p).toFixed(1)}px,0)`;}};
  const measure=()=>{const wr=wrapper.getBoundingClientRect();openHeight=Math.max(86,topbar.offsetHeight+chips.offsetHeight+8);wrapper.style.height=`${openHeight}px`;actionsY=(actions?.getBoundingClientRect().top||wr.top)-wr.top;chipsY=chips.getBoundingClientRect().top-wr.top;paint();};
  const onScroll=()=>{if(!raf)raf=requestAnimationFrame(paint);};window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',measure,{passive:true});requestAnimationFrame(measure);
  twitterCleanup=()=>{if(destroyed)return;destroyed=true;if(raf)cancelAnimationFrame(raf);window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',measure);};return true;
}

const YT_RESUME_KEY='pdv2:youtubeResume:v2193';
function readResume(){try{const value=JSON.parse(localStorage.getItem(YT_RESUME_KEY)||'{}');return value&&typeof value==='object'?value:{}}catch{return{}}}
function writeResume(map){try{const rows=Object.entries(map).sort((a,b)=>Number(b[1]?.at||0)-Number(a[1]?.at||0)).slice(0,120);localStorage.setItem(YT_RESUME_KEY,JSON.stringify(Object.fromEntries(rows)));}catch{}}
function resumeAt(videoId){const row=readResume()[String(videoId||'')];if(!row||Date.now()-Number(row.at||0)>90*24*3600*1000)return 0;return Math.max(0,Number(row.t||0));}
function clearResume(videoId){const key=String(videoId||'');if(!key)return;const map=readResume();if(key in map){delete map[key];writeResume(map);}}
function savePlayerProgress(instance,videoId){const key=String(videoId||'');if(!instance||!key)return;try{const data=instance.getVideoData?.()||{};if(data.isLive)return;const t=Number(instance.getCurrentTime?.()||0),duration=Number(instance.getDuration?.()||0);if(!Number.isFinite(t)||t<3)return;if(duration>0&&(duration-t<=12||t/duration>=.96)){clearResume(key);return;}const map=readResume();map[key]={t:Math.floor(t),duration:Math.floor(duration||0),at:Date.now()};writeResume(map);}catch{}}
function patchYouTubePlayer(){
  const YT=window.YT;if(!YT?.Player||YT.Player.__pdv2195Resume)return false;const Original=YT.Player;
  function WrappedPlayer(element,options={}){
    const elementId=typeof element==='string'?element:String(element?.id||'');if(!/^yt-v2170-player-/.test(elementId))return new Original(element,options);
    let currentId=String(options?.videoId||'');let timer=null;let instance=null;const events={...(options.events||{})};const originalReady=events.onReady,originalState=events.onStateChange;const start=resumeAt(currentId);const wrapped={...options,playerVars:{...(options.playerVars||{})},events};if(start>0&&wrapped.playerVars.start==null)wrapped.playerVars.start=Math.floor(start);
    events.onReady=event=>{instance=event.target;const t=resumeAt(currentId);if(t>0){try{event.target.seekTo(t,true);}catch{}}if(timer)clearInterval(timer);timer=setInterval(()=>savePlayerProgress(instance,currentId),4000);originalReady?.(event);};
    events.onStateChange=event=>{const state=Number(event.data);if(state===2)savePlayerProgress(event.target,currentId);if(state===0)clearResume(currentId);originalState?.(event);};
    const created=new Original(element,wrapped);instance=created;const load=created.loadVideoById?.bind(created);if(load)created.loadVideoById=(arg,startSeconds,...rest)=>{savePlayerProgress(created,currentId);if(arg&&typeof arg==='object'){const next={...arg};currentId=String(next.videoId||currentId);const saved=resumeAt(currentId);if(saved>0&&Number(next.startSeconds||0)<=0)next.startSeconds=saved;return load(next,...rest);}currentId=String(arg||currentId);const saved=resumeAt(currentId);return load(arg,saved>0?saved:startSeconds,...rest);};
    const destroy=created.destroy?.bind(created);if(destroy)created.destroy=(...args)=>{savePlayerProgress(created,currentId);if(timer)clearInterval(timer);timer=null;return destroy(...args);};return created;
  }
  WrappedPlayer.prototype=Original.prototype;Object.assign(WrappedPlayer,Original);WrappedPlayer.__pdv2195Resume=true;YT.Player=WrappedPlayer;return true;
}
(function installYouTubePatch(){if(patchYouTubePlayer())return;let stored=window.onYouTubeIframeAPIReady;try{Object.defineProperty(window,'onYouTubeIframeAPIReady',{configurable:true,get(){return stored;},set(fn){stored=function(...args){patchYouTubePlayer();return fn?.apply(this,args);};}});}catch{}const timer=setInterval(()=>{if(patchYouTubePlayer())clearInterval(timer);},250);setTimeout(()=>clearInterval(timer),20000);})();

const landscapeState=new WeakMap();
function showLandscapeUi(panel,state){if(!panel||!state)return;panel.classList.add('pdv2-landscape-ui-visible');if(state.timer)clearTimeout(state.timer);state.timer=setTimeout(()=>{state.timer=null;if(panel.isConnected)panel.classList.remove('pdv2-landscape-ui-visible');},3000);}
function enterLandscape(panel){
  if(!panel?.classList.contains('youtube-css-landscape'))return;
  let state=landscapeState.get(panel);if(state){showLandscapeUi(panel,state);return;}
  const viewport=panel.querySelector('.youtube-landscape-viewport');const controls=panel.querySelector('.youtube-landscape-controls');if(!viewport||!controls)return;
  const catcher=document.createElement('button');catcher.type='button';catcher.className='media-landscape-tap-catcher';catcher.setAttribute('aria-label','操作ボタンを表示');viewport.append(catcher);
  state={catcher,controls,timer:null};landscapeState.set(panel,state);
  catcher.addEventListener('click',()=>showLandscapeUi(panel,state));controls.addEventListener('pointerdown',()=>showLandscapeUi(panel,state),{passive:true});controls.addEventListener('click',()=>showLandscapeUi(panel,state));showLandscapeUi(panel,state);
}
function exitLandscape(panel){const state=landscapeState.get(panel);if(!state)return;if(state.timer)clearTimeout(state.timer);panel.classList.remove('pdv2-landscape-ui-visible');state.catcher.remove();landscapeState.delete(panel);}
function syncLandscape(panel){if(!panel?.isConnected)return;if(panel.classList.contains('youtube-css-landscape'))enterLandscape(panel);else exitLandscape(panel);}
document.addEventListener('click',event=>{const button=event.target?.closest?.('.youtube-orientation-btn');if(!button)return;const panel=button.closest('.twitch-inline-player');if(panel)setTimeout(()=>syncLandscape(panel),0);});

let enhancementRaf=0;
const enhancementObserver=new MutationObserver(()=>{if(!enhancementRaf)enhancementRaf=requestAnimationFrame(()=>{enhancementRaf=0;ensureReaderFab();if(!installTwitterHeader()&&twitterCleanup){twitterCleanup();twitterCleanup=null;}});});
enhancementObserver.observe(document.documentElement,{subtree:true,childList:true});
requestAnimationFrame(()=>{ensureReaderFab();installTwitterHeader();});
}
