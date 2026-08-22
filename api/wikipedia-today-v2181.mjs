import { JSDOM } from 'jsdom';

const API = 'https://ja.wikipedia.org/w/api.php';
const HUB_PAGE = 'Wikipedia:今日は何の日';
const USER_AGENT = 'PersonalDashboardWikipedia/2.18.1';

function jstParts() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const iso = now.toISOString();
  return {
    date: iso.slice(0, 10),
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10))
  };
}

function clean(value = '') {
  return String(value || '')
    .replace(/\[[0-9０-９]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function api(params, timeout = 16000) {
  const url = new URL(API);
  Object.entries({ format: 'json', formatversion: '2', ...params })
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`Wikipedia API HTTP ${response.status}`);
  return response.json();
}

function headingText(node) {
  return clean(node?.textContent).replace(/\[編集\]$/, '').trim();
}

function sectionNodes(start) {
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

function validTargetTitle(title) {
  const value = clean(title);
  if (!value || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value)) return false;
  if (/^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  if (/^(?:Help|Wikipedia|Template|Category|Portal|File|Special):/i.test(value)) return false;
  return true;
}

function candidatesFromNodes(nodes, { month, day, sourcePage }) {
  const rows = [];
  for (const node of nodes) {
    const listItems = node.matches?.('ul,ol')
      ? Array.from(node.querySelectorAll(':scope > li'))
      : Array.from(node.querySelectorAll?.('li') || []);

    for (const li of listItems) {
      const eventText = clean(li.textContent);
      if (eventText.length < 7) continue;

      const anchors = Array.from(li.querySelectorAll('a[title]'))
        .map(a => ({
          title: clean(a.getAttribute('title')),
          text: clean(a.textContent)
        }))
        .filter(row => validTargetTitle(row.title) && row.text.length >= 1);

      if (!anchors.length) continue;

      const target = [...anchors]
        .sort((a, b) => Math.min(b.text.length, 24) - Math.min(a.text.length, 24))[0]?.title;
      if (!target) continue;

      rows.push({
        title: target,
        eventText,
        sourcePage,
        reason: `${month}月${day}日 — ${eventText.slice(0, 150)}`
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

async function parsePage(page) {
  const data = await api({
    action: 'parse',
    page,
    prop: 'text',
    redirects: '1'
  });
  const html = data?.parse?.text || '';
  if (!html) throw new Error(`${page} を取得できませんでした`);
  return html;
}

async function fromHub(month, day) {
  const html = await parsePage(HUB_PAGE);
  const dom = new JSDOM(`<main>${html}</main>`);
  try {
    const doc = dom.window.document;
    const heading = Array.from(doc.querySelectorAll('h2,h3'))
      .find(node => headingText(node) === 'テンプレート');
    if (!heading) return [];

    const nodes = sectionNodes(heading);
    const sectionText = clean(nodes.map(node => node.textContent || '').join(' '));
    const renderedDate = sectionText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);

    if (renderedDate && (Number(renderedDate[2]) !== month || Number(renderedDate[3]) !== day)) {
      return [];
    }

    return candidatesFromNodes(nodes, { month, day, sourcePage: HUB_PAGE });
  } finally {
    dom.window.close();
  }
}

async function fromMonthly(month, day) {
  const page = `${HUB_PAGE} ${month}月`;
  const html = await parsePage(page);
  const dom = new JSDOM(`<main>${html}</main>`);
  try {
    const doc = dom.window.document;
    const wanted = `${month}月${day}日`;
    const heading = Array.from(doc.querySelectorAll('h2,h3'))
      .find(node => headingText(node) === wanted);
    if (!heading) throw new Error(`${wanted} の節が見つかりませんでした`);
    return candidatesFromNodes(sectionNodes(heading), { month, day, sourcePage: page });
  } finally {
    dom.window.close();
  }
}

function titleResolver(query = {}) {
  const map = new Map();
  for (const row of query.normalized || []) map.set(row.from, row.to);
  for (const row of query.redirects || []) map.set(row.from, row.to);
  return title => {
    let current = title;
    for (let i = 0; i < 6 && map.has(current); i += 1) current = map.get(current);
    return current;
  };
}

async function fetchCards(titles) {
  if (!titles.length) return { resolve: title => title, pages: new Map() };
  const data = await api({
    action: 'query',
    prop: 'extracts|pageimages|info',
    titles: titles.slice(0, 40).join('|'),
    redirects: '1',
    exintro: '1',
    explaintext: '1',
    exchars: '420',
    piprop: 'thumbnail',
    pithumbsize: '720',
    inprop: 'url'
  });

  return {
    resolve: titleResolver(data.query || {}),
    pages: new Map(
      (data.query?.pages || [])
        .filter(page => !page.missing)
        .map(page => [page.title, page])
    )
  };
}

function rowFromPage(page, candidate, date, index) {
  return {
    id: `${date}:today:${page.pageid || index}`,
    date,
    kind: 'today',
    category: '今日の出来事',
    categoryShort: '今日',
    title: page.title,
    reason: candidate.reason,
    extract: String(page.extract || '').trim(),
    thumbnail: page.thumbnail?.source || '',
    url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`
  };
}

async function buildToday() {
  const { date, month, day } = jstParts();

  let candidates = [];
  let todaySource = HUB_PAGE;

  try {
    candidates = await fromHub(month, day);
  } catch (error) {
    console.warn('[wikipedia-today-v2181] hub:', error?.message || error);
  }

  if (!candidates.length) {
    todaySource = `${HUB_PAGE} ${month}月`;
    candidates = await fromMonthly(month, day);
  }

  const wanted = candidates.slice(0, 30);
  const { resolve, pages } = await fetchCards(wanted.map(row => row.title));
  const items = [];
  const used = new Set();

  for (const candidate of wanted) {
    if (items.length >= 10) break;
    const page = pages.get(resolve(candidate.title));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    items.push(rowFromPage(page, candidate, date, items.length));
  }

  return {
    date,
    dateLabel: `${month}月${day}日`,
    todaySource,
    items
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    return res.status(200).json(await buildToday());
  } catch (error) {
    console.error('[wikipedia-today-v2181]', error);
    return res.status(500).json({ error: String(error?.message || error) });
  }
}
