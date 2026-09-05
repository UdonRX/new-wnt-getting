import { parseFeed } from '../../shared/rss.js';

function absoluteHttpUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, location.href);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function isXUrl(value = '') {
  try {
    const host = new URL(String(value || ''), location.href).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch { return false; }
}

function xUrl(value = '') {
  const href = absoluteHttpUrl(value);
  if (!href) return '';
  try {
    const url = new URL(href);
    if (url.hostname === 'twitter.com' || url.hostname.endsWith('.twitter.com')) url.hostname = 'x.com';
    return url.href;
  } catch { return href; }
}

function statusIdFrom(value = '') {
  return String(value || '').match(/(?:x\.com|twitter\.com)\/[^\s/?#]+\/status(?:es)?\/(\d{5,})/i)?.[1]
    || String(value || '').match(/\/status(?:es)?\/(\d{5,})/i)?.[1]
    || '';
}

function handleFromStatusUrl(value = '') {
  try {
    const match = new URL(String(value || ''), location.href).pathname.match(/^\/([^/]+)\/status(?:es)?\/\d+/i);
    const handle = match?.[1] || '';
    return handle && handle !== 'i' ? `@${handle.replace(/^@/, '')}` : '';
  } catch { return ''; }
}

function handleFromProfileUrl(value = '') {
  try {
    const url = new URL(String(value || ''), location.href);
    if (!isXUrl(url.href)) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 1 && parts[0] !== 'i' ? `@${parts[0].replace(/^@/, '')}` : '';
  } catch { return ''; }
}

function profileUrlFromHandle(handle = '') {
  const clean = String(handle || '').trim().replace(/^@/, '');
  return clean ? `https://x.com/${clean}` : '';
}

export function normalizeTweetImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !(host === 'pbs.twimg.com' || host.endsWith('.twimg.com')) || !/^\/media\//i.test(url.pathname)) return '';
    if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    return url.href;
  } catch { return ''; }
}

export function normalizeProfileImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !(host === 'pbs.twimg.com' || host.endsWith('.twimg.com')) || !/^\/profile_images\//i.test(url.pathname)) return '';
    url.searchParams.delete('name');
    return url.href.replace(/_(?:normal|bigger|mini)(?=\.[a-z0-9]+(?:$|\?))/i, '_200x200');
  } catch { return ''; }
}

export function normalizeTweetVideoUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const videoHost = host === 'video.twimg.com' || (host.endsWith('.twimg.com') && host !== 'pbs.twimg.com');
    if (!/^https?:$/.test(url.protocol) || !videoHost) return '';
    if (!/\.(?:mp4|m3u8|webm|mov)$/i.test(path) && !/\/(?:vid|pl|tweet_video)\//i.test(path)) return '';
    return url.href;
  } catch { return ''; }
}

export function normalizeTweetVideoPosterUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !(host === 'pbs.twimg.com' || host.endsWith('.twimg.com'))) return '';
    if (!/^\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//i.test(url.pathname)) return '';
    if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    return url.href;
  } catch { return ''; }
}

function tweetImageIdentity(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^\/media\//i.test(url.pathname)) return '';
    const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '').replace(/\.(?:jpe?g|png|webp|gif|avif)$/i, '').toLowerCase();
    return leaf ? `twitter-photo:${leaf}` : '';
  } catch { return ''; }
}

function tweetVideoIdentity(value = '') {
  const normalized = normalizeTweetVideoUrl(value);
  if (!normalized) return '';
  try {
    const path = decodeURIComponent(new URL(normalized).pathname);
    const id = path.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//i)?.[1];
    if (id) return `twitter-video:${id}`;
    const tweetVideo = path.match(/\/tweet_video\/([^/?#.]+)/i)?.[1];
    if (tweetVideo) return `twitter-video:${tweetVideo.replace(/\.(?:mp4|m3u8|webm|mov)$/i, '').toLowerCase()}`;
    return `twitter-video:${path.replace(/\/vid\/(?:[^/]+\/)?\d+x\d+\//i, '/vid/').replace(/\.(?:mp4|m3u8|webm|mov)$/i, '').toLowerCase()}`;
  } catch { return normalized.toLowerCase(); }
}

function videoVariantScore(value = '') {
  const normalized = normalizeTweetVideoUrl(value);
  if (!normalized) return -1;
  try {
    const path = new URL(normalized).pathname;
    const resolution = path.match(/\/vid\/(?:[^/]+\/)?(\d+)x(\d+)\//i);
    const area = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;
    if (/\.mp4$/i.test(path)) return 1_000_000_000 + area;
    if (/\.m3u8$/i.test(path)) return 500_000_000 + area;
    if (/\.webm$/i.test(path)) return 300_000_000 + area;
    return 100_000_000 + area;
  } catch { return 0; }
}

function nestedMarkupSources(html = '') {
  const sources = [];
  let current = String(html || '').trim();
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (!sources.includes(current)) sources.push(current);
    const doc = new DOMParser().parseFromString(`<div>${current}</div>`, 'text/html');
    const decoded = String(doc.body?.textContent || '').trim();
    if (!decoded || decoded === current || !/<(?:img|video|source|a|blockquote|div)\b/i.test(decoded)) break;
    current = decoded;
  }
  return sources;
}

function bestMarkupRoot(html = '') {
  let fallback = null;
  for (const source of nestedMarkupSources(html)) {
    const doc = new DOMParser().parseFromString(`<div data-x-normalizer-root>${source}</div>`, 'text/html');
    const root = doc.querySelector('[data-x-normalizer-root]');
    if (!root) continue;
    fallback ||= root;
    if (root.querySelector('img, video, source, a, .rsshub-quote')) return root;
  }
  return fallback;
}

function mediaPartsFromRoot(root) {
  const images = [], videos = [], posters = [], avatars = [], links = [];
  if (!root) return { images, videos, posters, avatars, links };
  root.querySelectorAll('img').forEach(image => {
    [image.getAttribute('src'), image.getAttribute('data-src'), image.getAttribute('data-original'), image.getAttribute('data-lazy-src')].filter(Boolean).forEach(candidate => {
      const avatar = normalizeProfileImageUrl(candidate); if (avatar) avatars.push(avatar);
      const poster = normalizeTweetVideoPosterUrl(candidate); if (poster) posters.push(poster);
      const photo = normalizeTweetImageUrl(candidate); if (photo) images.push(photo);
    });
  });
  root.querySelectorAll('video').forEach(video => {
    const direct = normalizeTweetVideoUrl(video.getAttribute('src')); if (direct) videos.push(direct);
    const poster = normalizeTweetVideoPosterUrl(video.getAttribute('poster')); if (poster) posters.push(poster);
    video.querySelectorAll('source[src]').forEach(source => { const url = normalizeTweetVideoUrl(source.getAttribute('src')); if (url) videos.push(url); });
  });
  root.querySelectorAll('source[src]').forEach(source => { const url = normalizeTweetVideoUrl(source.getAttribute('src')); if (url) videos.push(url); });
  root.querySelectorAll('a[href]').forEach(anchor => {
    const href = absoluteHttpUrl(anchor.getAttribute('href') || anchor.href || '');
    if (!href) return;
    const video = normalizeTweetVideoUrl(href); if (video) videos.push(video); else links.push(xUrl(href) || href);
  });
  for (const match of String(root.textContent || '').matchAll(/https?:\/\/[^\s<]+/gi)) {
    const href = absoluteHttpUrl(match[0].replace(/[),.!?。、「」]+$/, ''));
    if (!href) continue;
    const video = normalizeTweetVideoUrl(href); if (video) videos.push(video); else links.push(xUrl(href) || href);
  }
  return { images: [...new Set(images)], videos: [...new Set(videos)], posters: [...new Set(posters)], avatars: [...new Set(avatars)], links: [...new Set(links)] };
}

function chooseImages(candidates = [], excluded = new Set()) {
  const seen = new Set(), output = [];
  for (const candidate of candidates) {
    const url = normalizeTweetImageUrl(candidate), identity = tweetImageIdentity(url);
    if (!url || !identity || excluded.has(identity) || seen.has(identity)) continue;
    seen.add(identity); output.push(url); if (output.length >= 4) break;
  }
  return output;
}

function chooseVideos(candidates = [], excluded = new Set()) {
  const best = new Map();
  for (const candidate of candidates) {
    const url = normalizeTweetVideoUrl(candidate), identity = tweetVideoIdentity(url);
    if (!url || !identity || excluded.has(identity)) continue;
    const current = best.get(identity);
    if (!current || videoVariantScore(url) > videoVariantScore(current)) best.set(identity, url);
  }
  return [...best.values()].slice(0, 4);
}

function choosePosters(candidates = [], excluded = new Set()) {
  const output = [];
  for (const candidate of candidates) {
    const url = normalizeTweetVideoPosterUrl(candidate);
    if (!url || excluded.has(url) || output.includes(url)) continue;
    output.push(url); if (output.length >= 4) break;
  }
  return output;
}

function mediaObjects({ images = [], videos = [], posters = [] }) {
  const output = [];
  videos.forEach((url, index) => output.push({ type: 'video', url, poster: posters[index] || posters[0] || '' }));
  if (!videos.length && posters.length) output.push({ type: 'video', url: '', poster: posters[0] });
  images.forEach(url => output.push({ type: 'image', url, poster: '' }));
  return output;
}

function plainText(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function meaningfulName(value = '') {
  const name = plainText(value).replace(/\s*\(@[A-Za-z0-9_]+\)\s*$/, '').trim();
  return name && !/^(?:X|Twitter\s*\/\s*X)$/i.test(name) ? name : '';
}
function quoteNamePrefix(text = '') {
  const match = plainText(text).match(/^([^:：]{1,80})\s*[:：]\s+(.+)$/);
  if (!match) return '';
  const name = meaningfulName(match[1]);
  return name && !/^@/.test(name) && !/^https?:\/\//i.test(name) ? name : '';
}
function stripNamedPrefix(text = '', name = '') {
  if (!name) return plainText(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return plainText(text).replace(new RegExp(`^${escaped}\\s*[:：]\\s*`, 'i'), '').trim();
}

function stripAuthorPrefix(text, author) {
  let value = plainText(text);
  const variants = [author?.name, author?.handle, String(author?.handle || '').replace(/^@/, '')].filter(Boolean);
  for (const variant of variants) {
    const escaped = String(variant).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`^${escaped}\\s*[:：]\\s*`, 'i'), '');
  }
  return value.replace(/^(?:↩️\s*|Re\s+@?[A-Za-z0-9_]+\s*[:：]?\s*)/i, '').trim();
}

function mediaFreeText(value = '') {
  let current = String(value || '');
  for (let pass = 0; pass < 3 && current; pass += 1) {
    current = current
      .replace(/<\s*(video|audio|picture)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<\s*\/?\s*(?:video|audio|picture|img|source|track)\b[^>]*>?/gi, ' ')
      .replace(/<\s*br\s*\/?\s*>/gi, ' ');
    const doc = new DOMParser().parseFromString(`<div data-clean>${current}</div>`, 'text/html');
    const root = doc.querySelector('[data-clean]');
    root?.querySelectorAll('script,style,video,audio,picture,img,source,track').forEach(node => node.remove());
    const decoded = String(root?.textContent || current);
    if (decoded === current) break;
    current = decoded;
  }
  return plainText(current)
    .replace(/<\s*\/?\s*(?:video|audio|picture|img|source|track|br)\b[^>]*>?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromRoot(root, author) {
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('.rsshub-quote, script, style, img, video, audio, picture, source, track, hr').forEach(node => node.remove());
  clone.querySelectorAll('small').forEach(node => node.remove());
  const profileUrl = author?.profileUrl || '';
  clone.querySelectorAll('a[href]').forEach(anchor => {
    const href = xUrl(anchor.getAttribute('href') || anchor.href || '');
    if (profileUrl && href === profileUrl) anchor.remove();
  });
  return stripAuthorPrefix(mediaFreeText(clone.innerHTML || clone.textContent || ''), author);
}

function profileAnchor(root, preferredHandle = '') {
  if (!root) return null;
  const preferred = String(preferredHandle || '').replace(/^@/, '').toLowerCase();
  const anchors = [...root.querySelectorAll('a[href]')];
  if (preferred) {
    const match = anchors.find(anchor => handleFromProfileUrl(anchor.getAttribute('href') || anchor.href || '').replace(/^@/, '').toLowerCase() === preferred);
    if (match) return match;
  }
  return anchors.find(anchor => handleFromProfileUrl(anchor.getAttribute('href') || anchor.href || '')) || null;
}

function xmlAuthorMeta(node) {
  if (!node) return { name: '', handle: '', avatar: '', profileUrl: '' };
  const elements = [...node.getElementsByTagName('*')];
  const authorNode = elements.find(element => String(element.localName || element.nodeName || '').toLowerCase().replace(/^.*:/, '') === 'author');
  if (!authorNode) return { name: '', handle: '', avatar: '', profileUrl: '' };
  const children = [...authorNode.getElementsByTagName('*')];
  const childText = names => {
    const wanted = new Set(names);
    return plainText(children.find(element => wanted.has(String(element.localName || element.nodeName || '').toLowerCase().replace(/^.*:/, '')))?.textContent || '');
  };
  const profileUrl = xUrl(authorNode.getAttribute?.('url') || authorNode.getAttribute?.('href') || childText(['uri', 'url', 'profileurl', 'profile_url']));
  const handle = handleFromProfileUrl(profileUrl) || String(authorNode.getAttribute?.('handle') || '').trim();
  const avatar = normalizeProfileImageUrl(authorNode.getAttribute?.('avatar') || childText(['avatar', 'image', 'icon', 'profile_image_url']));
  return { name: meaningfulName(childText(['name']) || plainText(authorNode.textContent || '')), handle: handle ? (handle.startsWith('@') ? handle : `@${handle}`) : '', avatar, profileUrl };
}

function authorFrom(item, root, xmlNode, forcedProfileUrl = '') {
  const xmlAuthor = xmlAuthorMeta(xmlNode);
  const statusHandle = handleFromStatusUrl(item?.link || item?.guid || '') || xmlAuthor.handle;
  const profile = profileAnchor(root, statusHandle);
  const profileUrl = xUrl(forcedProfileUrl || profile?.getAttribute('href') || profile?.href || xmlAuthor.profileUrl || profileUrlFromHandle(statusHandle));
  const handle = statusHandle || handleFromProfileUrl(profileUrl);
  const parsed = String(item?.author || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const parsedMatch = parsed.match(/^(.+?)\s*(?:\((@[A-Za-z0-9_]+)\)|(@[A-Za-z0-9_]+))?$/);
  const strong = [...(root?.querySelectorAll('strong') || [])].find(node => !node.closest('.rsshub-quote'));
  let name = meaningfulName(strong?.textContent || profile?.textContent || xmlAuthor.name || parsedMatch?.[1] || parsed);
  if (!name) name = handle || 'X';
  const parts = mediaPartsFromRoot(root);
  return { name, handle: handle || parsedMatch?.[2] || parsedMatch?.[3] || '', avatar: parts.avatars[0] || xmlAuthor.avatar || '', profileUrl: profileUrl || profileUrlFromHandle(handle) };
}

function dateIso(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : '';
}
function typedExtra(rawXml = '', type = '') {
  const escaped = String(type).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:type\\s*=\\s*["']${escaped}["']|<type>\\s*${escaped}\\s*</type>|["']type["']\\s*:\\s*["']${escaped}["'])`, 'i').test(String(rawXml || ''));
}
function looksLikeReply(item, rawXml, root) {
  if (typedExtra(rawXml, 'reply')) return true;
  return /^(?:[^:：]{1,80}[:：]\s*)?(?:↩️|Re\s+@?[A-Za-z0-9_]+)/i.test(plainText(item?.title))
    || /^(?:[^:：]{1,80}[:：]\s*)?(?:↩️|Re\s+@?[A-Za-z0-9_]+)/i.test(plainText(root?.textContent || ''));
}
function looksLikeRepost(item, rawXml, root) {
  if (typedExtra(rawXml, 'repost')) return true;
  return /^(?:[^:：]{1,80}[:：]\s*)?(?:🔁|RT(?:\s|:|@))/i.test(plainText(item?.title))
    || /^(?:[^:：]{1,80}[:：]\s*)?(?:🔁|RT(?:\s|:|@))/i.test(plainText(root?.textContent || ''));
}

function linksFor(parts, currentUrl, profileUrl, quoteUrl = '') {
  const excluded = new Set([xUrl(currentUrl), xUrl(profileUrl), xUrl(quoteUrl)].filter(Boolean));
  return [...new Set(parts.links.map(url => xUrl(url) || absoluteHttpUrl(url)).filter(Boolean))]
    .filter(url => !excluded.has(url))
    .filter(url => !normalizeTweetImageUrl(url) && !normalizeTweetVideoUrl(url) && !normalizeTweetVideoPosterUrl(url));
}

function quoteFrom(root, rawXml = '', currentUrl = '') {
  const quoteRoot = root?.querySelector('.rsshub-quote') || null;
  if (!quoteRoot) {
    if (!typedExtra(rawXml, 'quote')) return null;
    const urls = [...String(rawXml || '').matchAll(/https?:\/\/(?:x\.com|twitter\.com)\/[^\s<\"']+\/status(?:es)?\/\d{5,}/gi)].map(match => xUrl(match[0])).filter(Boolean);
    const quoteUrl = urls.find(url => url !== xUrl(currentUrl)) || '';
    if (!quoteUrl) return null;
    const handle = handleFromStatusUrl(quoteUrl);
    return { id: statusIdFrom(quoteUrl), url: quoteUrl, createdAt: '', author: { name: '', handle, avatar: '', profileUrl: profileUrlFromHandle(handle) }, text: '', media: [], links: [] };
  }

  const parts = mediaPartsFromRoot(quoteRoot);
  const statusLink = [...quoteRoot.querySelectorAll('a[href]')].map(anchor => xUrl(anchor.getAttribute('href') || anchor.href || '')).find(url => statusIdFrom(url)) || '';
  const profile = profileAnchor(quoteRoot, handleFromStatusUrl(statusLink));
  const handle = handleFromStatusUrl(statusLink) || handleFromProfileUrl(profile?.getAttribute('href') || profile?.href || '');
  const profileUrl = xUrl(profile?.getAttribute('href') || profile?.href || profileUrlFromHandle(handle));

  const quoteClone = quoteRoot.cloneNode(true);
  quoteClone.querySelectorAll('script, style, img, video, audio, picture, source, track, hr').forEach(node => node.remove());
  quoteClone.querySelectorAll('small').forEach(node => node.remove());
  quoteClone.querySelectorAll('a[href]').forEach(anchor => {
    const href = xUrl(anchor.getAttribute('href') || anchor.href || '');
    if (href === profileUrl || href === statusLink) anchor.remove();
  });
  let rawText = mediaFreeText(quoteClone.innerHTML || quoteClone.textContent || '');
  const structuredName = meaningfulName(quoteRoot.querySelector('strong')?.textContent || profile?.textContent || '');
  const inferredName = quoteNamePrefix(rawText);
  const name = structuredName || inferredName || '';
  const author = { name, handle, avatar: parts.avatars[0] || '', profileUrl };
  let text = stripAuthorPrefix(rawText, author);
  if (inferredName && !structuredName) text = stripNamedPrefix(rawText, inferredName);

  const images = chooseImages(parts.images), videos = chooseVideos(parts.videos), posters = choosePosters(parts.posters);
  const createdAtText = [...quoteRoot.querySelectorAll('small')].map(node => plainText(node.textContent || '')).find(value => value && !/^Link:/i.test(value)) || '';
  return { id: statusIdFrom(statusLink), url: statusLink, createdAt: dateIso(createdAtText), author, text, media: mediaObjects({ images, videos, posters }), links: linksFor(parts, statusLink, profileUrl) };
}

function normalizedItem(item, xmlNode) {
  const root = bestMarkupRoot(item?.rawDescription || item?.description || '');
  const rawXml = xmlNode?.outerHTML || '';
  if (looksLikeReply(item, rawXml, root) || looksLikeRepost(item, rawXml, root)) return null;
  const url = xUrl(item?.link || item?.guid || '') || String(item?.link || item?.guid || '');
  const author = authorFrom(item, root, xmlNode);
  const quote = quoteFrom(root, rawXml, url);
  const mainRoot = root?.cloneNode(true) || null;
  mainRoot?.querySelectorAll('.rsshub-quote').forEach(node => node.remove());
  const mainParts = mediaPartsFromRoot(mainRoot);
  const quoteImageIds = new Set((quote?.media || []).filter(media => media.type === 'image').map(media => tweetImageIdentity(media.url)).filter(Boolean));
  const quoteVideoIds = new Set((quote?.media || []).filter(media => media.type === 'video').map(media => tweetVideoIdentity(media.url)).filter(Boolean));
  const quotePosters = new Set((quote?.media || []).map(media => normalizeTweetVideoPosterUrl(media.poster)).filter(Boolean));
  const images = chooseImages([...mainParts.images, ...(Array.isArray(item?.images) ? item.images : []), item?.image], quoteImageIds);
  const videos = chooseVideos([...mainParts.videos, ...(Array.isArray(item?.videos) ? item.videos : []), item?.video], quoteVideoIds);
  const posters = choosePosters([...mainParts.posters, ...(Array.isArray(item?.videoPosters) ? item.videoPosters : [])], quotePosters);
  let text = textFromRoot(mainRoot, author);
  if (!text) {
    const fallback = item?.description && item.description !== item.title ? item.description : item?.title;
    text = stripAuthorPrefix(mediaFreeText(fallback || ''), author);
  }
  return { id: statusIdFrom(url) || statusIdFrom(item?.guid) || String(item?.id || ''), url, createdAt: item?.normalizedDate || dateIso(item?.pubDate || item?.originalDate), author, text, media: mediaObjects({ images, videos, posters }), quote, links: linksFor(mainParts, url, author.profileUrl, quote?.url || '') };
}

export function normalizeXFeed(xmlText, feedName = 'X') {
  const parsed = parseFeed(xmlText, feedName);
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const nodes = doc.querySelector('parsererror') ? [] : [...doc.querySelectorAll('item, entry')];
  return parsed.map((item, index) => normalizedItem(item, nodes[index])).filter(Boolean);
}
