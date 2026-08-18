import { relativeTime } from './time.js';

function text(parent, selectors) {
  for (const s of selectors) {
    const n = parent.querySelector(s);
    const v = n?.textContent?.trim();
    if (v) return v;
  }
  return '';
}

export function parseFeed(xmlText, feedName = '') {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XMLパースエラー');
  const items = [...doc.querySelectorAll('item, entry')];
  return items.map((item, index) => {
    const title = text(item, ['title']) || '無題';
    let link = text(item, ['link','guid']);
    if (!link) link = item.querySelector('link[href]')?.getAttribute('href') || '';
    const dateRaw = text(item, ['pubDate','published','updated','dc\\:date','date']);
    const date = new Date(dateRaw);
    const description = text(item, ['description','content','content\\:encoded','summary']) || title;
    const source = text(item, ['source']) || feedName;
    const author = text(item, ['dc\\:creator','creator','author name','author']);
    return {
      id: `${link || title}-${dateRaw || index}`,
      title, link, description, source, author, feedName,
      pubDate: Number.isNaN(date.getTime()) ? new Date() : date,
      relative: relativeTime(Number.isNaN(date.getTime()) ? Date.now() : date)
    };
  });
}

export async function fetchFeed(feed) {
  const url = String(feed.url || '');
  const target = url.startsWith('/') ? url : `/api/rss?url=${encodeURIComponent(url)}`;
  const response = await fetch(target, { cache: 'no-store' });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`RSS取得エラー (${response.status})${detail ? `: ${detail.slice(0,120)}` : ''}`);
  }
  return parseFeed(await response.text(), feed.name || '');
}

export function dedupeSort(items, limit = 250) {
  const seen = new Set();
  return items.filter(item => {
    const key = (item.link || item.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b) => b.pubDate - a.pubDate).slice(0, limit);
}
