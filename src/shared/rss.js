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

function imageUrlsFromHtml(value = '') {
  const source = String(value || '').trim();
  if (!source || !/<img\b/i.test(source)) return [];

  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const urls = [];

    for (const image of doc.querySelectorAll('img')) {
      const candidates = [
        image.getAttribute('src'),
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-lazy-src')
      ];

      const srcset = image.getAttribute('srcset') || image.getAttribute('data-srcset') || '';
      if (srcset) {
        const largest = srcset
          .split(',')
          .map(part => part.trim().split(/\s+/)[0])
          .filter(Boolean)
          .pop();
        if (largest) candidates.unshift(largest);
      }

      for (const candidate of candidates) {
        const url = safeHttpUrl(candidate);
        if (url) {
          urls.push(url);
          break;
        }
      }
    }

    return [...new Set(urls)];
  } catch {
    return [];
  }
}

function looksLikeVideoUrl(value = '') {
  const url = safeHttpUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (/\.(?:mp4|m3u8|webm|mov)$/i.test(path)) return true;
    if (host === 'video.twimg.com' && /\/(?:vid|pl|tweet_video)\//i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function videoUrlsFromHtml(value = '') {
  const source = String(value || '').trim();
  if (!source || !/(?:<video\b|<source\b|video\.twimg\.com)/i.test(source)) {
    return { urls: [], posters: [] };
  }

  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const urls = [];
    const posters = [];

    const pushVideo = value => {
      const url = safeHttpUrl(value);
      if (url && looksLikeVideoUrl(url)) urls.push(url);
    };
    const pushPoster = value => {
      const url = safeHttpUrl(value);
      if (url) posters.push(url);
    };

    for (const video of doc.querySelectorAll('video')) {
      pushVideo(video.getAttribute('src'));
      pushPoster(video.getAttribute('poster'));
      for (const sourceNode of video.querySelectorAll('source[src]')) {
        pushVideo(sourceNode.getAttribute('src'));
      }
    }

    for (const sourceNode of doc.querySelectorAll('source[src]')) {
      const type = String(sourceNode.getAttribute('type') || '').toLowerCase();
      if (type.startsWith('video/') || /mpegurl|m3u8/.test(type) || looksLikeVideoUrl(sourceNode.getAttribute('src'))) {
        pushVideo(sourceNode.getAttribute('src'));
      }
    }

    for (const anchor of doc.querySelectorAll('a[href]')) {
      if (looksLikeVideoUrl(anchor.getAttribute('href'))) pushVideo(anchor.getAttribute('href'));
    }

    return {
      urls: [...new Set(urls)].slice(0, 12),
      posters: [...new Set(posters)].slice(0, 12)
    };
  } catch {
    return { urls: [], posters: [] };
  }
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

function mediaImagesOf(item, rawDescription = '') {
  const urls = [];
  const push = value => {
    const url = safeHttpUrl(value);
    if (url) urls.push(url);
  };

  // XML namespace付き要素も確実に拾うため、querySelectorだけに依存しない。
  for (const node of item.getElementsByTagName('*')) {
    const name = String(node.nodeName || '').toLowerCase();
    const local = String(node.localName || '').toLowerCase();
    const url = node.getAttribute?.('url') || '';
    const type = String(node.getAttribute?.('type') || '').toLowerCase();
    const medium = String(node.getAttribute?.('medium') || '').toLowerCase();
    const isVideo =
      medium === 'video' ||
      type.startsWith('video/') ||
      /mpegurl|m3u8/.test(type) ||
      looksLikeVideoUrl(url);

    if (name === 'media:thumbnail' || local === 'thumbnail') {
      push(url);
      continue;
    }

    if (name === 'media:content' || local === 'content') {
      if (!isVideo && (!medium || medium === 'image' || type.startsWith('image/'))) push(url);
      continue;
    }

    if (local === 'enclosure' && url) {
      if (!isVideo && (!type || type.startsWith('image/'))) push(url);
    }
  }

  const imageNodeUrl = text(item, ['image > url', 'image']);
  push(imageNodeUrl);

  imageUrlsFromHtml(rawDescription).forEach(push);
  return [...new Set(urls)].slice(0, 12);
}

function mediaVideosOf(item, rawDescription = '') {
  const urls = [];
  const posters = [];
  const pushVideo = value => {
    const url = safeHttpUrl(value);
    if (url && looksLikeVideoUrl(url)) urls.push(url);
  };
  const pushPoster = value => {
    const url = safeHttpUrl(value);
    if (url) posters.push(url);
  };

  for (const node of item.getElementsByTagName('*')) {
    const name = String(node.nodeName || '').toLowerCase();
    const local = String(node.localName || '').toLowerCase();
    const url = node.getAttribute?.('url') || node.getAttribute?.('href') || '';
    const type = String(node.getAttribute?.('type') || '').toLowerCase();
    const medium = String(node.getAttribute?.('medium') || '').toLowerCase();

    if (
      (name === 'media:content' || local === 'content' || local === 'enclosure') &&
      (
        medium === 'video' ||
        type.startsWith('video/') ||
        /mpegurl|m3u8/.test(type) ||
        looksLikeVideoUrl(url)
      )
    ) {
      pushVideo(url);
    }

    if (name === 'media:thumbnail' || local === 'thumbnail') {
      pushPoster(node.getAttribute?.('url') || '');
    }

    if (local === 'video') {
      pushVideo(node.getAttribute?.('src') || url);
      pushPoster(node.getAttribute?.('poster') || '');
    }
  }

  const fromHtml = videoUrlsFromHtml(rawDescription);
  fromHtml.urls.forEach(pushVideo);
  fromHtml.posters.forEach(pushPoster);

  return {
    urls: [...new Set(urls)].slice(0, 12),
    posters: [...new Set(posters)].slice(0, 12)
  };
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
    const images = mediaImagesOf(item, rawDescription);
    const videoMedia = mediaVideosOf(item, rawDescription);

    return {
      id: `${link || title}-${dateRaw || index}`,
      title,
      link,
      description,
      // Twitter/Xのように本文HTML内の画像・動画を使う画面向けに元HTMLを保持する。
      rawDescription,
      source,
      author,
      feedName,
      image: images[0] || '',
      images,
      video: videoMedia.urls[0] || '',
      videos: videoMedia.urls,
      videoPosters: videoMedia.posters,
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
