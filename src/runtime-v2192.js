/* Personal Dashboard v2.19.2
 * Clean active runtime:
 * - no legacy Reader DOM/chunk/diagnostic helpers
 * - /api/summary POST goes directly to the server
 * - Reader batching/current-index logic lives only in reader-focus.js
 * - preserve the corrected Wikipedia「今日は何の日」direct-source behavior
 */
const nativeFetch2192 = window.fetch.bind(window);
await import('./runtime-v2185.js');
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
