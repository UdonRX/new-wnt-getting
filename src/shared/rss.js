import { relativeTime } from './time.js';

function text(parent, selectors) {
  for (const selector of selectors) {
    const node = parent.querySelector(selector);
    const value = node?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function attr(parent, selectors, name) {
  for (const selector of selectors) {
    const node = parent.querySelector(selector);
    const value = node?.getAttribute?.(name)?.trim();
    if (value) return value;
  }
  return '';
}

function safeHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function imageFromHtml(value = '') {
  const source = String(value || '').trim();
  if (!source || !/<img\b/i.test(source)) return '';
  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const images = [...doc.querySelectorAll('img')];
    for (const image of images) {
      const candidate = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original');
      const url = safeHttpUrl(candidate);
      if (url) return url;
    }
  } catch {}
  return '';
}

function itemImage(item, rawDescription = '') {
  const candidates = [
    attr(item, ['media\\:content[url]', 'media\\:thumbnail[url]', 'thumbnail[url]'], 'url'),
    attr(item, ['enclosure[type^="image"][url]', 'enclosure[url]'], 'url'),
    text(item, ['image > url', 'image'])
  ];

  for (const candidate of candidates) {
    const url = safeHttpUrl(candidate);
    if (url) return url;
  }
  return imageFromHtml(rawDescription);
}

function rawDescriptionOf(item) {
  for (const selector of ['content\\:encoded', 'content', 'description', 'summary']) {
    const node = item.querySelector(selector);
    if (!node) continue;
    const value = node.textContent?.trim() || '';
    if (value) return value;
  }
  return '';
}

function plainText(value = '') {
  const source = String(value || '');
  if (!source) return '';
  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    return (doc.body?.textContent || source).replace(/\s+/g, ' ').trim();
  } catch {
    return source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

export function parseFeed(xmlText, feedName = '') {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XMLパースエラー');

  const items = [...doc.querySelectorAll('item, entry')];
  return items.map((item, index) => {
    const title = text(item, ['title']) || '無題';
    let link = text(item, ['link', 'guid']);
    if (!link) {
      const alternate = [...item.querySelectorAll('link[href]')].find(node => {
        const rel = String(node.getAttribute('rel') || '').toLowerCase();
        return !rel || rel === 'alternate';
      });
      link = alternate?.getAttribute('href') || '';
    }

    const dateRaw = text(item, ['pubDate', 'published', 'updated', 'dc\\:date', 'date']);
    const date = new Date(dateRaw);
    const rawDescription = rawDescriptionOf(item);
    const description = plainText(rawDescription) || title;
    const source = text(item, ['source', 'category']) || feedName;
    const author = text(item, ['dc\\:creator', 'creator', 'author name', 'author']) || source;
    const image = itemImage(item, rawDescription);

    return {
      id: `${link || title}-${dateRaw || index}`,
      title,
      link,
      description,
      source,
      author,
      feedName,
      image,
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
    throw new Error(`RSS取得エラー (${response.status})${detail ? `: ${detail.slice(0, 120)}` : ''}`);
  }
  return parseFeed(await response.text(), feed.name || '');
}

export function dedupeSort(items, limit = 250) {
  const seen = new Set();
  return items.filter(item => {
    const key = (item.link || item.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.pubDate - a.pubDate).slice(0, limit);
}
