/* Personal Dashboard v2.18.6
 * - Safari-safe Reader summary activation/prefetch
 * - Wikipedia "今日は何の日" extraction with monthly fallback
 */

const nativeFetch2186 = window.fetch.bind(window);
await import('./runtime-v2185.js');
const inheritedFetch2186 = window.fetch.bind(window);

const isIOSSafari2186 = /iP(?:hone|ad|od)/i.test(navigator.userAgent)
  && /WebKit/i.test(navigator.userAgent)
  && !/(?:CriOS|FxiOS|EdgiOS|OPiOS)/i.test(navigator.userAgent);

const readerCache2186 = new Map();
const readerInflight2186 = new Map();
const boundFeeds2186 = new WeakSet();

function clean2186(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readerPayload2186(card) {
  const url = card?.querySelector('.reader-story-open')?.href || '';
  let title = clean2186(card?.querySelector('[data-reader-title]')?.textContent || '');
  if (/^(?:日本語タイトルを生成中|記事の要点を整理中|記事のポイント)/.test(title)) title = '';
  const source = clean2186(card?.querySelector('.reader-story-source-name')?.textContent || '');
  const category = clean2186(card?.querySelector('.reader-story-category-badge')?.textContent || '');
  const mode = category.startsWith('論文') ? 'papers' : category.startsWith('知識') ? 'knowledge' : 'news';
  return { url, title, description: '', source, category, mode, allowAi: true, fast: mode !== 'papers' };
}

function readerKey2186(card) {
  const payload = readerPayload2186(card);
  return `${payload.url || payload.title}::${payload.mode}`;
}

function readerSummaryReady2186(card) {
  const provider = clean2186(card?.dataset?.summaryProvider || '');
  if (provider && !/^(?:pending|unavailable|insufficient)$/i.test(provider)) return true;
  const box = card?.querySelector('[data-reader-summary]');
  return Boolean(box && !box.classList.contains('is-pending') && !box.classList.contains('is-unavailable') && !card.querySelector('[data-reader-progress]'));
}

function usableSummary2186(summary) {
  if (!summary || !Array.isArray(summary.lines) || summary.lines.length !== 3) return false;
  if (/^(?:pending|unavailable|insufficient)$/i.test(String(summary.provider || ''))) return false;
  return summary.lines.every(row => clean2186(row?.text).length >= 8);
}

function paintReaderSummary2186(card, summary) {
  if (!card?.isConnected || !usableSummary2186(summary)) return;
  const title = card.querySelector('[data-reader-title]');
  if (title && clean2186(summary.headline)) title.textContent = clean2186(summary.headline);
  const box = card.querySelector('[data-reader-summary]');
  const texts = [...card.querySelectorAll('.reader-story-summary-text')];
  summary.lines.slice(0, 3).forEach((row, index) => {
    if (texts[index]) texts[index].textContent = clean2186(row?.text) || '—';
  });
  box?.classList.remove('is-pending', 'is-unavailable');
  card.querySelector('[data-reader-progress]')?.remove();
  card.dataset.summaryProvider = String(summary.provider || 'gemini-safari-v2186');
}

async function requestReaderSummary2186(card, { paint = true } = {}) {
  if (!card?.isConnected) return null;
  const payload = readerPayload2186(card);
  if (!payload.url) return null;
  const key = readerKey2186(card);
  if (readerCache2186.has(key)) {
    const hit = readerCache2186.get(key);
    if (paint) paintReaderSummary2186(card, hit);
    return hit;
  }
  if (readerInflight2186.has(key)) {
    const hit = await readerInflight2186.get(key);
    if (paint && hit) paintReaderSummary2186(card, hit);
    return hit;
  }

  const task = inheritedFetch2186('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload)
  }).then(async response => {
    const data = await response.json().catch(() => null);
    if (!response.ok || !usableSummary2186(data)) return null;
    readerCache2186.set(key, data);
    return data;
  }).catch(error => {
    console.warn('[reader-safari-v2186]', error?.message || error);
    return null;
  }).finally(() => readerInflight2186.delete(key));

  readerInflight2186.set(key, task);
  const result = await task;
  if (paint && result) paintReaderSummary2186(card, result);
  return result;
}

function nextReaderCard2186(card) {
  let next = card?.nextElementSibling || null;
  while (next && !next.matches?.('.reader-swipe-card')) next = next.nextElementSibling;
  return next;
}

function warmNextReader2186(card) {
  const next = nextReaderCard2186(card);
  if (!next || readerSummaryReady2186(next)) return;
  setTimeout(() => requestReaderSummary2186(next, { paint: true }), 260);
}

function nearestReaderCard2186(feed) {
  const cards = [...feed.querySelectorAll(':scope > .reader-swipe-card')];
  if (!cards.length) return null;
  const root = feed.getBoundingClientRect();
  const center = root.top + root.height * 0.5;
  let best = cards[0];
  let distance = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const d = Math.abs((rect.top + rect.bottom) * 0.5 - center);
    if (d < distance) { best = card; distance = d; }
  }
  return best;
}

function syncReaderFeed2186(feed) {
  if (!isIOSSafari2186 || !feed?.isConnected) return;
  const card = nearestReaderCard2186(feed);
  if (!card) return;
  const index = Number(card.dataset.index || 0);
  if (index > 0 && !readerSummaryReady2186(card)) requestReaderSummary2186(card, { paint: true });
  if (readerSummaryReady2186(card)) warmNextReader2186(card);
}

function bindReaderFeed2186(feed) {
  if (!isIOSSafari2186 || !feed || boundFeeds2186.has(feed)) return;
  boundFeeds2186.add(feed);
  let raf = 0;
  let settle = 0;
  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = 0; syncReaderFeed2186(feed); });
    clearTimeout(settle);
    settle = setTimeout(() => syncReaderFeed2186(feed), 110);
  };
  feed.addEventListener('scroll', schedule, { passive: true });
  feed.addEventListener('touchend', () => setTimeout(schedule, 40), { passive: true });
  if ('onscrollend' in feed) feed.addEventListener('scrollend', schedule, { passive: true });
  setTimeout(schedule, 350);
}

function bindAllReaderFeeds2186(root = document) {
  if (!isIOSSafari2186) return;
  root.querySelectorAll?.('.reader-swipe-feed').forEach(bindReaderFeed2186);
}

if (isIOSSafari2186) {
  const readerObserver2186 = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof Element)) return;
          if (node.matches?.('.reader-swipe-feed')) bindReaderFeed2186(node);
          bindAllReaderFeeds2186(node);
        });
      }
      if (mutation.type === 'attributes') {
        const card = mutation.target?.closest?.('.reader-swipe-card');
        if (card && readerSummaryReady2186(card)) warmNextReader2186(card);
      }
    }
  });
  readerObserver2186.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-summary-provider']
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => bindAllReaderFeeds2186(), 120);
  });
  setTimeout(() => bindAllReaderFeeds2186(), 500);
}

const WIKI_API2186 = 'https://ja.wikipedia.org/w/api.php';
const WIKI_HUB2186 = 'Wikipedia:今日は何の日';

function jstParts2186() {
  const iso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

function wikiClean2186(value = '') {
  return String(value || '').replace(/\[[0-9０-９]+\]/g, '').replace(/\s+/g, ' ').trim();
}

async function wikiGet2186(params, timeout = 8500) {
  const url = new URL(WIKI_API2186);
  Object.entries({ format: 'json', formatversion: '2', origin: '*', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await nativeFetch2186(url.href, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error?.info || `Wikipedia direct ${response.status}`);
  return data;
}

function wikiParseDoc2186(html = '') {
  return new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
}

function wikiHeading2186(node) {
  return wikiClean2186(node?.textContent).replace(/\[編集\]$/, '').trim();
}

function wikiSectionNodes2186(start) {
  if (!start) return [];
  const block = start.closest('.mw-heading') || start;
  const rows = [];
  const isHeading = node => /^H[23]$/.test(node?.tagName || '')
    || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
  let cursor = block.nextElementSibling;
  while (cursor && !isHeading(cursor)) {
    rows.push(cursor);
    cursor = cursor.nextElementSibling;
  }
  return rows;
}

function validWikiTarget2186(title = '') {
  const value = wikiClean2186(title);
  if (!value || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value)) return false;
  if (/^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  if (/^(?:Help|Wikipedia|Template|Category|Portal|File|Special):/i.test(value)) return false;
  return true;
}

function wikiCandidates2186(nodes, month, day, sourcePage) {
  const rows = [];
  for (const node of nodes) {
    const items = node.matches?.('ul,ol')
      ? [...node.querySelectorAll(':scope > li')]
      : [...(node.querySelectorAll?.('li') || [])];
    for (const li of items) {
      const eventText = wikiClean2186(li.textContent);
      if (eventText.length < 7) continue;
      const anchors = [...li.querySelectorAll('a[title]')]
        .map(a => ({ title: wikiClean2186(a.getAttribute('title')), text: wikiClean2186(a.textContent) }))
        .filter(row => validWikiTarget2186(row.title) && row.text.length);
      if (!anchors.length) continue;
      const target = [...anchors]
        .sort((a, b) => Math.min(b.text.length, 28) - Math.min(a.text.length, 28))[0]?.title;
      if (!target) continue;
      rows.push({ title: target, reason: `${month}月${day}日 — ${eventText.slice(0, 155)}`, sourcePage });
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

async function todayCandidatesFromHub2186(month, day) {
  try {
    const hub = await wikiGet2186({ action: 'parse', page: WIKI_HUB2186, prop: 'text', redirects: '1' });
    const doc = wikiParseDoc2186(hub?.parse?.text || '');
    const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2186(node) === 'テンプレート');
    if (heading) {
      const nodes = wikiSectionNodes2186(heading);
      const sectionText = wikiClean2186(nodes.map(node => node.textContent || '').join(' '));
      const rendered = sectionText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!rendered || (Number(rendered[2]) === month && Number(rendered[3]) === day)) {
        const rows = wikiCandidates2186(nodes, month, day, WIKI_HUB2186);
        if (rows.length) return { rows, sourcePage: WIKI_HUB2186, sourceMode: 'hub-template' };
      }
    }
  } catch (error) {
    console.warn('[wikipedia-v2186] hub template fallback', error?.message || error);
  }

  const monthPage = `${WIKI_HUB2186} ${month}月`;
  const monthly = await wikiGet2186({ action: 'parse', page: monthPage, prop: 'text', redirects: '1' });
  const doc = wikiParseDoc2186(monthly?.parse?.text || '');
  const wanted = `${month}月${day}日`;
  const heading = [...doc.querySelectorAll('h2,h3')].find(node => wikiHeading2186(node) === wanted);
  if (!heading) throw new Error(`${wanted} の「今日は何の日」欄が見つかりませんでした`);
  const rows = wikiCandidates2186(wikiSectionNodes2186(heading), month, day, monthPage);
  return { rows, sourcePage: monthPage, sourceMode: 'hub-monthly' };
}

function wikiTitleResolver2186(query = {}) {
  const map = new Map();
  for (const row of query.normalized || []) map.set(row.from, row.to);
  for (const row of query.redirects || []) map.set(row.from, row.to);
  return title => {
    let current = title;
    for (let i = 0; i < 6 && map.has(current); i += 1) current = map.get(current);
    return current;
  };
}

async function loadTodayItems2186() {
  const { date, month, day } = jstParts2186();
  const source = await todayCandidatesFromHub2186(month, day);
  const wanted = source.rows.slice(0, 30);
  const data = await wikiGet2186({
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
  const resolveTitle = wikiTitleResolver2186(data.query || {});
  const pages = new Map((data.query?.pages || []).filter(page => !page.missing).map(page => [page.title, page]));
  const items = [];
  const used = new Set();
  for (const candidate of wanted) {
    if (items.length >= 10) break;
    const page = pages.get(resolveTitle(candidate.title));
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
  return {
    date,
    dateLabel: `${month}月${day}日`,
    todaySource: source.sourcePage,
    todaySourceMode: source.sourceMode,
    items
  };
}

async function wikipediaDaily2186(input, init) {
  const todayPromise = loadTodayItems2186();
  const basePromise = inheritedFetch2186(input, init).then(async response => {
    if (!response.ok) throw new Error(`Wikipedia base ${response.status}`);
    const data = await response.clone().json().catch(() => null);
    if (!data?.items) throw new Error('Wikipedia base response invalid');
    return data;
  });

  let today;
  try {
    today = await todayPromise;
  } catch (error) {
    console.warn('[wikipedia-v2186] today source failed', error?.message || error);
    const response = await inheritedFetch2186(input, init);
    return response;
  }

  let base = null;
  try { base = await basePromise; } catch (error) { console.warn('[wikipedia-v2186] base fallback', error?.message || error); }
  const otherItems = Array.isArray(base?.items) ? base.items.filter(item => item?.kind !== 'today') : [];
  const merged = {
    ...(base || {}),
    date: today.date,
    dateLabel: today.dateLabel,
    todaySource: today.todaySource,
    todaySourceMode: today.todaySourceMode,
    counts: { ...(base?.counts || {}), today: today.items.length },
    items: [...today.items, ...otherItems]
  };
  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

window.fetch = async function pdv2186Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2186(input, init); }

  if (url.origin === location.origin && url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return wikipediaDaily2186(input, init);
  }
  return inheritedFetch2186(input, init);
};

try {
  if (localStorage.getItem('pdv2:runtime:v2186') !== '1') {
    localStorage.removeItem('pdv2:wikipediaDaily:v213');
    localStorage.setItem('pdv2:runtime:v2186', '1');
  }
} catch {}
