/* Personal Dashboard v2.18.7
 * Reader summary pipeline cleanup:
 * - do not import runtime-v2186 (its Safari helper built requests from DOM only)
 * - all normal /api/summary calls go directly to the server through one wrapper
 * - Safari fallback reconstructs the ORIGINAL item from reader cache before requesting
 * - stream output is painted progressively, but only successful final summaries are stored
 * - keep the v2.18.6 Wikipedia "今日は何の日" direct source behavior
 */

const nativeFetch2187 = window.fetch.bind(window);
await import('./runtime-v2185.js');
const inheritedFetch2187 = window.fetch.bind(window);

const isIOSSafari2187 = /iP(?:hone|ad|od)/i.test(navigator.userAgent)
  && /WebKit/i.test(navigator.userAgent)
  && !/(?:CriOS|FxiOS|EdgiOS|OPiOS)/i.test(navigator.userAgent);

const SUMMARY_STORAGE_KEY = 'reader-summary-cache-v2180';
const summaryMemory2187 = new Map();
const summaryInflight2187 = new Map();
const safariAttemptAt2187 = new Map();
const boundFeeds2187 = new WeakSet();
let readerItemIndex2187 = null;
let readerItemIndexAt2187 = 0;

function clean2187(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hash2187(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseBody2187(init) {
  try { return typeof init?.body === 'string' ? JSON.parse(init.body) : {}; }
  catch { return {}; }
}

function mode2187(body = {}) {
  return clean2187(body.mode) || 'auto';
}

function summaryKey2187(body = {}) {
  const url = clean2187(body.url || body.link);
  const title = clean2187(body.title);
  const description = Array.from(clean2187(body.description)).slice(0, 500).join('');
  return `${url || title}::${mode2187(body)}::${hash2187(`${title}\n${description}`)}`;
}

function jsonResponse2187(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function href2187(value = '') {
  try { return new URL(value, location.href).href; }
  catch { return String(value || ''); }
}

function cardForBody2187(body = {}) {
  const wanted = href2187(body.url || body.link || '');
  const cards = [...document.querySelectorAll('.reader-swipe-card')];
  if (wanted) {
    const card = cards.find(node => href2187(node.querySelector('.reader-story-open')?.href || '') === wanted);
    if (card) return card;
  }
  const title = clean2187(body.title);
  return title ? cards.find(node => clean2187(node.querySelector('[data-reader-title]')?.textContent || '') === title) || null : null;
}

function taggedPartial2187(text = '') {
  const source = String(text || '').replace(/\r/g, '');
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const result = {};
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
    result[label] = clean2187(source.slice(start, end));
  }
  return result;
}

function paintPartial2187(body, accumulated) {
  const card = cardForBody2187(body);
  if (!card?.isConnected) return;
  const partial = taggedPartial2187(accumulated);
  if (partial['タイトル']) {
    const title = card.querySelector('[data-reader-title]');
    if (title) title.textContent = partial['タイトル'];
  }
  const rows = [...card.querySelectorAll('.reader-story-summary-text')];
  ['結論/事実', '背景/特徴', '影響/展望'].forEach((label, index) => {
    if (partial[label] && rows[index]) rows[index].textContent = partial[label];
  });
  const label = card.querySelector('[data-reader-loading-text]');
  if (label) label.textContent = 'AI要約を生成中';
  const bar = card.querySelector('[data-reader-progress-bar]');
  if (bar) bar.style.width = '88%';
  const value = card.querySelector('[data-reader-progress-value]');
  if (value) value.textContent = '88%';
}

function usable2187(summary) {
  if (!summary || !Array.isArray(summary.lines) || summary.lines.length !== 3) return false;
  if (/^(?:pending|unavailable|insufficient)$/i.test(String(summary.provider || ''))) return false;
  return summary.lines.every(row => clean2187(row?.text).length >= 12);
}

function paintFinal2187(body, summary) {
  if (!usable2187(summary)) return;
  const card = cardForBody2187(body);
  if (!card?.isConnected) return;
  const title = card.querySelector('[data-reader-title]');
  if (title && clean2187(summary.headline)) title.textContent = clean2187(summary.headline);
  const texts = [...card.querySelectorAll('.reader-story-summary-text')];
  summary.lines.slice(0, 3).forEach((row, index) => {
    if (texts[index]) texts[index].textContent = clean2187(row?.text);
  });
  card.querySelector('[data-reader-summary]')?.classList.remove('is-pending', 'is-unavailable');
  card.querySelector('[data-reader-progress]')?.remove();
  card.dataset.summaryProvider = String(summary.provider || 'gemini-v2187');
}

function persistSummary2187(body, summary) {
  if (!usable2187(summary)) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    const link = clean2187(body.url || body.link || body.title);
    const mode = mode2187(body);
    const key = `${link}::${mode}::v2180`;
    raw[key] = { value: summary, ts: Date.now(), mode };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, 84);
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

async function readNdjsonSummary2187(body) {
  const response = await nativeFetch2187('/api/summary?stream=1&client=2187', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    cache: 'no-store',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(34_000)
  });
  if (!response.ok || !response.body) throw new Error(`summary stream ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finalSummary = null;

  const consume = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'delta' && event.text) {
      accumulated += event.text;
      paintPartial2187(body, accumulated);
    } else if (event.type === 'done' && event.summary) {
      finalSummary = event.summary;
    } else if (event.type === 'error') {
      throw new Error(event.error || 'summary stream error');
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (!finalSummary) throw new Error('summary stream ended without final result');
  return finalSummary;
}

async function summaryData2187(body = {}) {
  const normalized = {
    ...body,
    url: body.url || body.link || '',
    title: clean2187(body.title),
    description: Array.from(clean2187(body.description)).slice(0, 16_000).join(''),
    mode: mode2187(body)
  };
  const key = summaryKey2187(normalized);
  if (summaryMemory2187.has(key)) return summaryMemory2187.get(key);
  if (summaryInflight2187.has(key)) return summaryInflight2187.get(key);

  const task = readNdjsonSummary2187(normalized).catch(async error => {
    console.warn('[summary-v2187 stream]', error?.message || error);
    const response = await nativeFetch2187('/api/summary?retry=1&client=2187', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(normalized),
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `summary ${response.status}`);
    return data;
  }).then(summary => {
    if (usable2187(summary)) {
      summaryMemory2187.set(key, summary);
      persistSummary2187(normalized, summary);
      paintFinal2187(normalized, summary);
      while (summaryMemory2187.size > 120) summaryMemory2187.delete(summaryMemory2187.keys().next().value);
    }
    return summary;
  }).finally(() => summaryInflight2187.delete(key));

  summaryInflight2187.set(key, task);
  return task;
}

function readReaderItems2187() {
  if (readerItemIndex2187 && Date.now() - readerItemIndexAt2187 < 15_000) return readerItemIndex2187;
  const map = new Map();
  const keys = [
    'pdv2:readerCache:news',
    'pdv2:readerCache:knowledge',
    'pdv2:readerCache:papers:core',
    'pdv2:readerCache:papers:creative',
    'pdv2:readerCache:papers'
  ];
  for (const storageKey of keys) {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey) || 'null');
      for (const item of data?.items || []) {
        const link = href2187(item?.link || item?.url || '');
        if (link && !map.has(link)) map.set(link, item);
      }
    } catch {}
  }
  readerItemIndex2187 = map;
  readerItemIndexAt2187 = Date.now();
  return map;
}

function payloadForCard2187(card) {
  const link = href2187(card?.querySelector('.reader-story-open')?.href || '');
  if (!link) return null;
  const item = readReaderItems2187().get(link);
  if (!item) return null;
  const description = clean2187(item.description || '');
  const title = clean2187(item.title || '');
  // Never repeat the v2.18.6 bug: Safari fallback is allowed only when it has
  // actual article metadata, not a DOM placeholder with an empty description.
  if (!title || description.length < 20) return null;
  const category = clean2187(card.querySelector('.reader-story-category-badge')?.textContent || '');
  const mode = category.startsWith('論文') ? 'papers' : category.startsWith('知識') ? 'knowledge' : 'news';
  return {
    url: link,
    title,
    description,
    source: clean2187(item.source || item.feedName || card.querySelector('.reader-story-source-name')?.textContent || ''),
    category,
    mode,
    allowAi: true,
    fast: mode !== 'papers'
  };
}

function cardReady2187(card) {
  const provider = clean2187(card?.dataset?.summaryProvider || '');
  if (provider && !/^(?:pending|unavailable|insufficient)$/i.test(provider)) return true;
  const box = card?.querySelector('[data-reader-summary]');
  return Boolean(box && !box.classList.contains('is-pending') && !box.classList.contains('is-unavailable') && !card.querySelector('[data-reader-progress]'));
}

function nextCard2187(card) {
  let next = card?.nextElementSibling || null;
  while (next && !next.matches?.('.reader-swipe-card')) next = next.nextElementSibling;
  return next;
}

async function ensureCardSummary2187(card, { prefetch = false } = {}) {
  if (!isIOSSafari2187 || !card?.isConnected || cardReady2187(card)) return;
  const payload = payloadForCard2187(card);
  if (!payload) return;
  const key = summaryKey2187(payload);
  const last = Number(safariAttemptAt2187.get(key) || 0);
  if (!summaryInflight2187.has(key) && Date.now() - last < 12_000) return;
  safariAttemptAt2187.set(key, Date.now());
  const summary = await summaryData2187(payload).catch(() => null);
  if (!prefetch && summary) paintFinal2187(payload, summary);
}

function nearestCard2187(feed) {
  const cards = [...feed.querySelectorAll(':scope > .reader-swipe-card')];
  if (!cards.length) return null;
  const root = feed.getBoundingClientRect();
  const center = root.top + root.height * 0.5;
  let best = cards[0];
  let bestDistance = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const distance = Math.abs((rect.top + rect.bottom) * 0.5 - center);
    if (distance < bestDistance) { best = card; bestDistance = distance; }
  }
  return best;
}

function syncReaderFeed2187(feed) {
  if (!isIOSSafari2187 || !feed?.isConnected) return;
  const card = nearestCard2187(feed);
  if (!card) return;
  ensureCardSummary2187(card);
  const next = nextCard2187(card);
  if (next && (cardReady2187(card) || summaryMemory2187.has(summaryKey2187(payloadForCard2187(card) || {})))) {
    setTimeout(() => ensureCardSummary2187(next, { prefetch: true }), 300);
  }
}

function bindReaderFeed2187(feed) {
  if (!isIOSSafari2187 || !feed || boundFeeds2187.has(feed)) return;
  boundFeeds2187.add(feed);
  let raf = 0;
  let settle = 0;
  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = 0; syncReaderFeed2187(feed); });
    clearTimeout(settle);
    settle = setTimeout(() => syncReaderFeed2187(feed), 140);
  };
  feed.addEventListener('scroll', schedule, { passive: true });
  feed.addEventListener('touchend', () => setTimeout(schedule, 60), { passive: true });
  if ('onscrollend' in feed) feed.addEventListener('scrollend', schedule, { passive: true });
  setTimeout(schedule, 420);
}

function bindReaderFeeds2187(root = document) {
  if (!isIOSSafari2187) return;
  root.querySelectorAll?.('.reader-swipe-feed').forEach(bindReaderFeed2187);
}

if (isIOSSafari2187) {
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('.reader-swipe-feed')) bindReaderFeed2187(node);
        bindReaderFeeds2187(node);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => bindReaderFeeds2187(), 160);
  });
  setTimeout(() => bindReaderFeeds2187(), 600);
}

// Wikipedia: keep the direct Action API route from v2.18.6 without importing
// runtime-v2186 (which contained the problematic Safari summary helper).
const WIKI_API2187 = 'https://ja.wikipedia.org/w/api.php';
const WIKI_HUB2187 = 'Wikipedia:今日は何の日';

function jstParts2187() {
  const iso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

function wikiClean2187(value = '') {
  return String(value || '').replace(/\[[0-9０-９]+\]/g, '').replace(/\s+/g, ' ').trim();
}

async function wikiGet2187(params, timeout = 8500) {
  const url = new URL(WIKI_API2187);
  Object.entries({ format: 'json', formatversion: '2', origin: '*', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await nativeFetch2187(url.href, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error?.info || `Wikipedia direct ${response.status}`);
  return data;
}

function wikiDoc2187(html = '') {
  return new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
}
function wikiHeading2187(node) { return wikiClean2187(node?.textContent).replace(/\[編集\]$/, '').trim(); }
function wikiSection2187(start) {
  if (!start) return [];
  const block = start.closest('.mw-heading') || start;
  const rows = [];
  const isHeading = node => /^H[23]$/.test(node?.tagName || '') || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
  let cursor = block.nextElementSibling;
  while (cursor && !isHeading(cursor)) { rows.push(cursor); cursor = cursor.nextElementSibling; }
  return rows;
}
function validWikiTarget2187(title = '') {
  const value = wikiClean2187(title);
  if (!value || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value) || /^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  return !/^(?:Help|Wikipedia|Template|Category|Portal|File|Special):/i.test(value);
}
function wikiCandidates2187(nodes, month, day, sourcePage) {
  const rows = [];
  for (const node of nodes) {
    const lis = node.matches?.('ul,ol') ? [...node.querySelectorAll(':scope > li')] : [...(node.querySelectorAll?.('li') || [])];
    for (const li of lis) {
      const eventText = wikiClean2187(li.textContent);
      if (eventText.length < 7) continue;
      const target = [...li.querySelectorAll('a[title]')]
        .map(a => ({ title: wikiClean2187(a.getAttribute('title')), text: wikiClean2187(a.textContent) }))
        .filter(row => validWikiTarget2187(row.title) && row.text.length)
        .sort((a, b) => Math.min(b.text.length, 28) - Math.min(a.text.length, 28))[0]?.title;
      if (target) rows.push({ title: target, reason: `${month}月${day}日 — ${eventText.slice(0, 155)}`, sourcePage });
    }
  }
  const seen = new Set();
  return rows.filter(row => { const key = row.title.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
async function todayCandidates2187(month, day) {
  try {
    const hub = await wikiGet2187({ action: 'parse', page: WIKI_HUB2187, prop: 'text', redirects: '1' });
    const doc = wikiDoc2187(hub?.parse?.text || '');
    const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2187(node) === 'テンプレート');
    if (heading) {
      const nodes = wikiSection2187(heading);
      const rendered = wikiClean2187(nodes.map(node => node.textContent || '').join(' ')).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!rendered || (Number(rendered[2]) === month && Number(rendered[3]) === day)) {
        const rows = wikiCandidates2187(nodes, month, day, WIKI_HUB2187);
        if (rows.length) return { rows, sourcePage: WIKI_HUB2187, sourceMode: 'hub-template' };
      }
    }
  } catch (error) { console.warn('[wikipedia-v2187 hub]', error?.message || error); }
  const monthPage = `${WIKI_HUB2187} ${month}月`;
  const monthly = await wikiGet2187({ action: 'parse', page: monthPage, prop: 'text', redirects: '1' });
  const doc = wikiDoc2187(monthly?.parse?.text || '');
  const wanted = `${month}月${day}日`;
  const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2187(node) === wanted);
  if (!heading) throw new Error(`${wanted} の「今日は何の日」欄が見つかりませんでした`);
  return { rows: wikiCandidates2187(wikiSection2187(heading), month, day, monthPage), sourcePage: monthPage, sourceMode: 'hub-monthly' };
}
function wikiResolver2187(query = {}) {
  const map = new Map();
  for (const row of query.normalized || []) map.set(row.from, row.to);
  for (const row of query.redirects || []) map.set(row.from, row.to);
  return title => { let current = title; for (let i = 0; i < 6 && map.has(current); i += 1) current = map.get(current); return current; };
}
async function loadToday2187() {
  const { date, month, day } = jstParts2187();
  const source = await todayCandidates2187(month, day);
  const wanted = source.rows.slice(0, 30);
  const data = await wikiGet2187({ action: 'query', prop: 'extracts|pageimages|info', titles: wanted.map(row => row.title).join('|'), redirects: '1', exintro: '1', explaintext: '1', exchars: '420', piprop: 'thumbnail', pithumbsize: '720', inprop: 'url' });
  const resolve = wikiResolver2187(data.query || {});
  const pages = new Map((data.query?.pages || []).filter(page => !page.missing).map(page => [page.title, page]));
  const items = [];
  const used = new Set();
  for (const candidate of wanted) {
    if (items.length >= 10) break;
    const page = pages.get(resolve(candidate.title));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    items.push({ id: `${date}:today:${page.pageid || items.length}`, date, kind: 'today', category: '今日の出来事', categoryShort: '今日', title: page.title, reason: candidate.reason, extract: String(page.extract || '').trim(), thumbnail: page.thumbnail?.source || '', url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}` });
  }
  return { date, dateLabel: `${month}月${day}日`, todaySource: source.sourcePage, todaySourceMode: source.sourceMode, items };
}
async function wikipediaDaily2187(input, init) {
  const todayPromise = loadToday2187();
  const basePromise = inheritedFetch2187(input, init).then(async response => {
    if (!response.ok) throw new Error(`Wikipedia base ${response.status}`);
    const data = await response.clone().json().catch(() => null);
    if (!data?.items) throw new Error('Wikipedia base response invalid');
    return data;
  });
  let today;
  try { today = await todayPromise; }
  catch (error) { console.warn('[wikipedia-v2187 today]', error?.message || error); return inheritedFetch2187(input, init); }
  let base = null;
  try { base = await basePromise; } catch (error) { console.warn('[wikipedia-v2187 base]', error?.message || error); }
  const otherItems = Array.isArray(base?.items) ? base.items.filter(item => item?.kind !== 'today') : [];
  return jsonResponse2187({ ...(base || {}), date: today.date, dateLabel: today.dateLabel, todaySource: today.todaySource, todaySourceMode: today.todaySourceMode, counts: { ...(base?.counts || {}), today: today.items.length }, items: [...today.items, ...otherItems] });
}

window.fetch = async function pdv2187Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2187(input, init); }

  if (url.origin === location.origin && url.pathname === '/api/summary' && String(init?.method || 'GET').toUpperCase() === 'POST') {
    try { return jsonResponse2187(await summaryData2187(parseBody2187(init))); }
    catch (error) { return jsonResponse2187({ error: String(error?.message || error), provider: 'unavailable', cacheable: false }, 500); }
  }
  if (url.origin === location.origin && url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return wikipediaDaily2187(input, init);
  }
  return inheritedFetch2187(input, init);
};

try {
  if (localStorage.getItem('pdv2:runtime:v2187') !== '1') {
    // Force a clean verification of the corrected pipeline.  Old successful
    // summaries explained why exactly the same articles kept appearing healthy.
    localStorage.removeItem(SUMMARY_STORAGE_KEY);
    localStorage.removeItem('pdv2:wikipediaDaily:v213');
    localStorage.setItem('pdv2:runtime:v2187', '1');
  }
} catch {}
