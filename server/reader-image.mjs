import dns from 'node:dns/promises';
import net from 'node:net';
import { extractArticleImageFromHtml, resolveSourcePublishedTime } from '../lib/source-published-time.mjs';

const POSITIVE_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 90 * 1000;
const HOME_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_BYTES = 1500 * 1024;
const RSS_BYTES = 512 * 1024;
const PUBLISHER_FALLBACK_DEADLINE_MS = 1200;
const RESOLVER_POLICY = 'reader-image-fast-v3';
const imageCache = new Map();
const homeCache = new Map();

const PROFILES = [
  { re: /(?:スポーツ報知|報知新聞|hochi)/i, home: 'https://hochi.news/', pages: ['articles/', 'sports/', 'baseball/', 'mlb/', 'entertainment/'] },
  { re: /(?:産経ニュース|産経新聞|sankei)/i, home: 'https://www.sankei.com/', pages: ['politics/', 'affairs/', 'economy/', 'world/', 'sports/'] },
  { re: /(?:日テレ\s*news\s*nnn|日テレnews|日本テレビ|\bnnn\b|\bntv\b)/i, home: 'https://news.ntv.co.jp/', pages: ['category/society', 'category/politics', 'category/economy', 'category/international', 'category/sports'] },
  { re: /(?:毎日新聞|mainichi)/i, home: 'https://mainichi.jp/', pages: ['flash/', 'politics/', 'business/', 'sports/'] },
  { re: /(?:日本女子プロゴルフ協会|jlpga|lpga)/i, home: 'https://www.lpga.or.jp/', pages: ['news/', 'news/tournament/'] },
  { re: /(?:テレ朝\s*news|テレビ朝日|tv\s*asahi|ann(?:ニュース)?)/i, home: 'https://news.tv-asahi.co.jp/', pages: ['news_society/', 'news_politics/', 'news_economy/', 'news_international/', 'news_sports/', 'news_geinou/'] },
  { re: /(?:日本経済新聞|日経(?:新聞)?|nikkei)/i, home: 'https://www.nikkei.com/', pages: ['markets/kabu/', 'markets/', 'business/', 'economy/'] },
  { re: /(?:ウェザーニュース|weathernews)/i, home: 'https://weathernews.jp/', pages: ['news/', 's/topics/'] },
  { re: /(?:tbs\s*news\s*dig|tbsテレビ|jnn)/i, home: 'https://newsdig.tbs.co.jp/', pages: ['list/news/tbs/latest', 'list/genre/%E3%82%B9%E3%83%9D%E3%83%BC%E3%83%84', 'list/rura/latest'] },
  { re: /gizmodo/i, home: 'https://www.gizmodo.jp/', pages: [] },
  { re: /(?:yahoo!?(?:ニュース)?|ヤフーニュース)/i, home: 'https://news.yahoo.co.jp/', pages: [] }
];

const compact = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bareHost = value => String(value || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

function hostOf(value = '') {
  try { return new URL(String(value)).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return ''; }
}

function sameSite(a, b) {
  const aa = bareHost(a);
  const bb = bareHost(b);
  return Boolean(aa && bb && (aa === bb || aa.endsWith(`.${bb}`) || bb.endsWith(`.${aa}`)));
}

function safeUrl(value = '') {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (url.port && !['80', '443'].includes(url.port)) return '';
    return url.href;
  } catch { return ''; }
}

function bodyOf(req) {
  if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(req?.body || '{}'); }
  catch { return {}; }
}

function decode(value = '') {
  return String(value)
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 0))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0));
}

function text(value = '') {
  return decode(String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(raw = '', name = '') {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(raw).match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function norm(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function similarity(a = '', b = '') {
  const aa = norm(a);
  const bb = norm(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.length >= 10 && (aa.includes(bb) || bb.includes(aa))) {
    return Math.min(0.98, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + 0.22);
  }
  const grams = value => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const ga = grams(aa);
  const gb = grams(bb);
  if (!ga.size || !gb.size) return 0;
  let same = 0;
  for (const token of ga) if (gb.has(token)) same += 1;
  return 2 * same / (ga.size + gb.size);
}

function profileFor(value = '') {
  return PROFILES.find(profile => profile.re.test(String(value))) || null;
}

function publisherHint(title = '') {
  const match = String(title).match(/[（(]([^（）()]{2,90})[）)]\s*$/);
  const hint = compact(match?.[1] || '', 90);
  if (!hint) return '';
  if (hint.length <= 60 && !/[。！？!?]/.test(hint)) return hint;
  return '';
}

function baseTitle(title = '') {
  return compact(publisherHint(title)
    ? String(title).replace(/[（(][^（）()]{2,90}[）)]\s*$/, '')
    : title, 320);
}

function isAggregator(source = '') {
  return /(?:yahoo|google\s*news|googleニュース|smartnews|スマートニュース|グノシー|gunosy)/i.test(norm(source));
}

function isGoogleNewsUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return url.hostname.toLowerCase() === 'news.google.com'
      && /\/(?:rss\/articles|articles|read)\//.test(url.pathname);
  } catch { return false; }
}

function imageBlockedReason(image = '', imageKind = '') {
  const href = safeUrl(image);
  if (!href) return 'invalid-image-url';
  if (String(imageKind || '').toLowerCase() === 'site-brand') return 'site-brand';
  try {
    const url = new URL(href);
    const path = decodeURIComponent(`${url.pathname}${url.search}`).toLowerCase();
    if (url.hostname === 'www.google.com' && url.pathname.startsWith('/s2/favicons')) return 'site-brand';
    if (/(?:^|[\/_.-])(?:ogp[_-]?default|default[_-]?ogp|default[_-]?image|no[_-]?image|noimage|placeholder|site[_-]?brand)(?:[\/_.?&=-]|$)/i.test(path)) {
      return 'default-ogp';
    }
  } catch {}
  return '';
}

function logRejected(stage, image, reason, method = '') {
  console.info('[NEWS-IMAGE]', {
    diagnosticVersion: 2,
    phase: 'candidate-rejected',
    policy: RESOLVER_POLICY,
    stage,
    reason,
    imageHost: hostOf(image),
    method: compact(method, 140)
  });
}

function private4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) return true;
  const [a, b, c] = parts;
  return [0, 10, 127].includes(a)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function private6(ip) {
  const value = String(ip).toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || value.startsWith('2001:db8:') || value.startsWith('ff')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? private4(mapped[1]) : false;
}

function privateIp(ip) {
  const family = net.isIP(ip);
  return family === 4 ? private4(ip) : family === 6 ? private6(ip) : true;
}

async function publicUrl(raw) {
  const href = safeUrl(raw);
  if (!href) throw new Error('invalid-url');
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('private-host');
  }
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error('private-host');
    return url;
  }
  const rows = await dns.lookup(host, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => privateIp(row.address))) throw new Error('private-host');
  return url;
}

async function readLimited(response, max) {
  if (!response.body?.getReader) return String(await response.text()).slice(0, max);
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      const left = max - total;
      parts.push(bytes.length > left ? bytes.subarray(0, left) : bytes);
      total += Math.min(bytes.length, left);
      if (bytes.length >= left) break;
    }
    if (total >= max) {
      try { await reader.cancel(); } catch {}
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(parts).toString('utf8');
}

async function fetchText(raw, {
  timeout = 1300,
  max = PAGE_BYTES,
  accept = 'text/html,application/xhtml+xml;q=.9,*/*;q=.2'
} = {}) {
  let url = await publicUrl(raw);
  const deadline = Date.now() + timeout;
  for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(220, deadline - Date.now()));
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'Accept-Language': 'ja,en-US;q=.8,en;q=.6',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirectCount === 3) throw new Error('redirect-failed');
        try { await response.body?.cancel?.(); } catch {}
        url = await publicUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { text: await readLimited(response, max), finalUrl: url.href };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('redirect-failed');
}

function cacheKeys(link, articleId = '', title = '') {
  const keys = [safeUrl(link)];
  if (articleId) keys.push(`article:${compact(articleId, 700)}`);
  const titleKey = norm(baseTitle(title)).slice(0, 220);
  if (titleKey.length >= 12) keys.push(`title:${titleKey}`);
  return [...new Set(keys.filter(Boolean))];
}

function cacheGet(keys = []) {
  for (const key of keys) {
    const row = imageCache.get(key);
    if (!row) continue;
    const ttl = row.value?.image ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - row.at > ttl) {
      imageCache.delete(key);
      continue;
    }
    const blocked = row.value?.image ? imageBlockedReason(row.value.image, row.value.imageKind) : '';
    if (blocked) {
      imageCache.delete(key);
      console.info('[NEWS-IMAGE]', {
        diagnosticVersion: 2,
        phase: 'resolved-url-cache-invalidated',
        policy: RESOLVER_POLICY,
        cacheLayer: 'server-memory',
        reason: blocked,
        imageHost: hostOf(row.value.image)
      });
      continue;
    }
    return { key, value: row.value };
  }
  return null;
}

function cacheSet(keys = [], value) {
  if (!value) return;
  const blocked = value.image ? imageBlockedReason(value.image, value.imageKind) : '';
  if (blocked) return;
  for (const key of keys) {
    if (key) imageCache.set(key, { at: Date.now(), value });
  }
  while (imageCache.size > 240) imageCache.delete(imageCache.keys().next().value);
}

function cacheKeyType(key = '') {
  if (key.startsWith('article:')) return 'article-id';
  if (key.startsWith('title:')) return 'title';
  return 'link';
}

export function readerImageCacheLookup(body = {}) {
  const keys = cacheKeys(compact(body?.link, 2200), compact(body?.articleId, 700), compact(body?.title, 320));
  const cached = cacheGet(keys);
  return cached ? { payload: { ...cached.value, cached: true }, cacheKey: cacheKeyType(cached.key) } : null;
}

export function readerImageCacheRemember(body = {}, payload = {}) {
  const keys = cacheKeys(compact(body?.link, 2200), compact(body?.articleId, 700), compact(body?.title, 320));
  cacheSet(keys, payload);
}

function homeGet(key) {
  const normalized = norm(key).slice(0, 100);
  const row = homeCache.get(normalized);
  if (!row || Date.now() - row.at > HOME_TTL_MS) {
    if (row) homeCache.delete(normalized);
    return '';
  }
  return safeUrl(row.home);
}

function homeSet(key, home) {
  const normalized = norm(key).slice(0, 100);
  const href = safeUrl(home);
  if (!normalized || !href) return;
  homeCache.set(normalized, { at: Date.now(), home: href });
  while (homeCache.size > 120) homeCache.delete(homeCache.keys().next().value);
}

function pageTitle(html = '') {
  const source = String(html);
  const match = source.match(/<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || source.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i)
    || source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return text(match?.[1] || '');
}

function candidates(html, base, title) {
  const baseHost = hostOf(base);
  const source = decode(String(html).replace(/\\\//g, '/').replace(/\\u002F/gi, '/'));
  const out = [];
  const seen = new Set();
  const wanted = baseTitle(title);

  const add = (raw, label = '', bonus = 0) => {
    if (!raw || /^(?:#|javascript:|mailto:|tel:)/i.test(raw)) return;
    let url;
    try { url = new URL(raw, base); }
    catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)
      || !sameSite(baseHost, url.hostname)
      || url.pathname === '/'
      || /\.(?:jpg|jpeg|png|gif|webp|svg|css|js)(?:$|\?)/i.test(url.href)
      || seen.has(url.href)) return;

    const score = label ? similarity(wanted, baseTitle(label)) : 0;
    if (label && score < 0.4) return;
    seen.add(url.href);
    out.push({ url: url.href, sim: score, score: score + bonus });
  };

  let match;
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((match = anchor.exec(source))) {
    add(attr(match[1], 'href'), text(match[2]) || attr(match[1], 'aria-label') || attr(match[1], 'title'), 0.08);
  }

  for (const fragment of [wanted.slice(0, 28), wanted.slice(0, 18), wanted.slice(0, 12)].filter(value => value.length >= 10)) {
    let position = 0;
    let hits = 0;
    while (hits < 5) {
      const index = source.indexOf(fragment, position);
      if (index < 0) break;
      position = index + fragment.length;
      hits += 1;
      const window = source.slice(Math.max(0, index - 2200), Math.min(source.length, index + 2600));
      let urlMatch;
      const embedded = /(?:href|url|link|canonicalUrl|articleUrl)\s*[=:]\s*["']([^"']+)["']/gi;
      while ((urlMatch = embedded.exec(window))) add(urlMatch[1], wanted, 0.22);
      const absolute = /https?:\/\/[^\s"'<>]+/gi;
      while ((urlMatch = absolute.exec(window))) add(urlMatch[0], wanted, 0.12);
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function articleImage(url, title, expectedHost = '') {
  try {
    const page = await fetchText(url, { timeout: 1450, max: PAGE_BYTES });
    if (expectedHost && !sameSite(expectedHost, hostOf(page.finalUrl))) return null;
    const resolvedTitle = pageTitle(page.text);
    const titleScore = resolvedTitle ? similarity(baseTitle(title), baseTitle(resolvedTitle)) : 0;
    if (resolvedTitle && titleScore < 0.36) return null;

    const image = extractArticleImageFromHtml(page.text, { baseUrl: page.finalUrl || url });
    if (!image?.url) return null;
    const blocked = imageBlockedReason(image.url, 'article');
    if (blocked) {
      logRejected('publisher-article', image.url, blocked, image.method || 'image');
      return null;
    }
    return {
      image: image.url,
      method: image.method || 'image',
      articleUrl: page.finalUrl || url,
      similarity: titleScore
    };
  } catch {
    return null;
  }
}

async function crawlPublisher(title, source, home, extra = []) {
  const homepage = safeUrl(home);
  if (!homepage) return { image: '', error: 'publisher-homepage-not-found' };

  const expectedHost = hostOf(homepage);
  const urls = [homepage, ...extra].filter(Boolean).slice(0, 8);
  const pages = await Promise.all(urls.map(async url => {
    try {
      const page = await fetchText(url, { timeout: 1250, max: PAGE_BYTES });
      return sameSite(expectedHost, hostOf(page.finalUrl)) ? page : null;
    } catch { return null; }
  }));

  const found = [];
  const seen = new Set();
  for (const page of pages.filter(Boolean)) {
    for (const candidate of candidates(page.text, page.finalUrl, title)) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      found.push(candidate);
    }
  }

  const hits = await Promise.all(found
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(async candidate => {
      const result = await articleImage(candidate.url, title, expectedHost);
      return result ? { ...result, linkScore: candidate.score } : null;
    }));

  const best = hits
    .filter(Boolean)
    .sort((a, b) => (b.similarity + b.linkScore) - (a.similarity + a.linkScore))[0];

  return best
    ? { ...best, homepage, checked: urls.length }
    : { image: '', homepage, checked: urls.length, error: 'publisher-article-not-found' };
}

function bingArticle(raw = '') {
  const href = safeUrl(decode(raw));
  if (!href) return '';
  try {
    const url = new URL(href);
    return bareHost(url.hostname) === 'bing.com' && /\/news\/apiclick\.aspx$/i.test(url.pathname)
      ? safeUrl(url.searchParams.get('url') || '') || href
      : href;
  } catch { return href; }
}

function bingImage(raw = '') {
  const href = safeUrl(decode(raw));
  if (!href) return '';
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' && /(?:^|\.)bing(?:4)?\.com$|(?:^|\.)bing\.net$/i.test(url.hostname)) {
      url.protocol = 'https:';
    }
    return url.href;
  } catch { return href; }
}

async function bingNews(title, source) {
  const query = baseTitle(title);
  const hint = publisherHint(title);
  const wantedSource = hint || source;
  const aggregator = isAggregator(source);

  try {
    const page = await fetchText(
      `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&setmkt=ja-JP&format=RSS`,
      { timeout: 1050, max: RSS_BYTES, accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }
    );
    const blocks = page.text.match(/<item\b[\s\S]*?<\/item>/gi) || [];
    const rows = [];

    for (const block of blocks) {
      const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      const sourceMatch = block.match(/<(?:News:)?Source[^>]*>([\s\S]*?)<\/(?:News:)?Source>/i);
      const imageMatch = block.match(/<(?:News:)?Image[^>]*>([\s\S]*?)<\/(?:News:)?Image>/i);
      const rowTitle = text(titleMatch?.[1] || '');
      const rowSource = text(sourceMatch?.[1] || '');
      const titleScore = similarity(query, baseTitle(rowTitle));
      const sourceScore = wantedSource ? similarity(wantedSource, rowSource) : 0;

      if (!rowTitle || titleScore < 0.58) continue;
      if (!aggregator && wantedSource && sourceScore < 0.24 && titleScore < 0.9) continue;
      if (hint && sourceScore < 0.2 && titleScore < 0.9) continue;

      const rowImage = bingImage(text(imageMatch?.[1] || ''));
      const blocked = rowImage ? imageBlockedReason(rowImage, 'article') : '';
      if (blocked) logRejected('bing-thumbnail', rowImage, blocked, 'bing-news:thumbnail');

      rows.push({
        title: rowTitle,
        source: rowSource,
        sim: titleScore,
        sourceSim: sourceScore,
        url: bingArticle(text(linkMatch?.[1] || '')),
        image: blocked ? '' : rowImage,
        score: titleScore + sourceScore * 0.35 + (rowImage && !blocked ? 0.1 : 0)
      });
    }

    rows.sort((a, b) => b.score - a.score);
    const imageRow = rows.find(row => row.image && (row.sim >= 0.68 || row.sourceSim >= 0.42));
    if (imageRow) {
      return {
        image: imageRow.image,
        method: 'bing-news:thumbnail',
        articleUrl: imageRow.url,
        rowSource: imageRow.source,
        similarity: imageRow.sim,
        candidates: rows.length
      };
    }

    const linkRow = rows.find(row => row.url && (row.sim >= 0.76 || row.sourceSim >= 0.52));
    if (linkRow) {
      const image = await articleImage(linkRow.url, query);
      if (image) {
        return {
          ...image,
          method: `bing-news:${image.method}`,
          rowSource: linkRow.source,
          candidates: rows.length
        };
      }
    }

    return {
      image: '',
      error: rows.length ? 'bing-no-image' : 'bing-no-matching-story',
      candidates: rows.length
    };
  } catch (error) {
    return { image: '', error: `bing-${error?.message || error}`, candidates: 0 };
  }
}

async function googleRows(title) {
  const query = baseTitle(title);
  try {
    const page = await fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`,
      { timeout: 1150, max: RSS_BYTES, accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }
    );
    const blocks = page.text.match(/<item\b[\s\S]*?<\/item>/gi) || [];
    return blocks.map(block => {
      const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
      if (!sourceMatch) return null;
      const rowTitle = text(titleMatch?.[1] || '');
      const rowSource = text(sourceMatch?.[2] || '');
      const home = safeUrl(attr(sourceMatch[1], 'url'));
      const titleScore = similarity(query, baseTitle(rowTitle));
      return rowTitle && home && titleScore >= 0.58
        ? { title: rowTitle, source: rowSource, home, sim: titleScore }
        : null;
    }).filter(Boolean).sort((a, b) => b.sim - a.sim);
  } catch {
    return [];
  }
}

function fallbackType(row, source, hint) {
  return similarity(source, row.source) >= 0.5 || (hint && similarity(hint, row.source) >= 0.4)
    ? 'publisher-rss'
    : 'same-story';
}

function reusableGoogleRows(seedRows = []) {
  return (Array.isArray(seedRows) ? seedRows : [seedRows])
    .map(row => ({
      title: compact(row?.title, 320),
      source: compact(row?.source, 120),
      home: safeUrl(row?.home),
      sim: Number(row?.sim || 0)
    }))
    .filter(row => row.title && row.home && row.sim >= 0.58)
    .slice(0, 3);
}

async function publisherFallback(title, source, seedRows = []) {
  const query = baseTitle(title);
  const hint = publisherHint(title);
  const profile = profileFor(hint) || profileFor(source);
  const key = hint || source;
  const reusedRows = reusableGoogleRows(seedRows);
  const aggregatorPrimarySkipped = isAggregator(source) && reusedRows.length > 0;
  const sourceMatchedSeed = reusedRows.find(row => similarity(source, row.source) >= 0.46);
  const discoveredHome = !isAggregator(source) ? sourceMatchedSeed?.home || '' : '';
  const cachedHome = aggregatorPrimarySkipped ? '' : homeGet(key);
  const profileHome = aggregatorPrimarySkipped ? '' : (profile?.home || '');
  const home = cachedHome || discoveredHome || profileHome || '';

  const rowsPromise = reusedRows.length ? Promise.resolve(reusedRows) : googleRows(query);
  const primaryPromise = home
    ? crawlPublisher(query, key, home, (profile?.pages || []).map(path => new URL(path, home).href))
    : Promise.resolve(null);

  const [primary, rows] = await Promise.all([primaryPromise, rowsPromise]);
  if (primary?.image) {
    homeSet(key, primary.homepage);
    return {
      ...primary,
      fallback: reusedRows.length ? 'publisher-reused-google-row' : (hint ? 'publisher-hint' : 'publisher-direct'),
      rssCandidates: rows.length,
      googleNewsRowReused: Boolean(reusedRows.length),
      googleNewsSearchSkipped: Boolean(reusedRows.length),
      aggregatorPrimarySkipped
    };
  }

  const choices = [];
  for (const row of rows) {
    const sourceScore = similarity(source, row.source);
    const hintScore = hint ? similarity(hint, row.source) : 0;
    if (!(sourceScore >= 0.46 || hintScore >= 0.36 || row.sim >= 0.86 || (isAggregator(source) && row.sim >= 0.74))) {
      continue;
    }
    if (home && sameSite(hostOf(home), hostOf(row.home))) continue;
    if (choices.some(choice => choice.home === row.home)) continue;
    choices.push({ ...row, sourceScore, hintScore });
    if (choices.length >= 3) break;
  }

  const alternatives = await Promise.all(choices.map(async row => {
    const rowProfile = profileFor(row.source);
    const result = await crawlPublisher(
      query,
      row.source,
      row.home,
      (rowProfile?.pages || []).map(path => new URL(path, row.home).href)
    );
    return result?.image
      ? { ...result, rowSource: row.source, rowTitle: row.title, fallback: fallbackType(row, source, hint) }
      : null;
  }));

  const hit = alternatives.filter(Boolean).sort((a, b) => b.similarity - a.similarity)[0];
  if (hit) {
    return {
      ...hit,
      googleNewsRowReused: Boolean(reusedRows.length),
      googleNewsSearchSkipped: Boolean(reusedRows.length),
      aggregatorPrimarySkipped
    };
  }

  return {
    image: '',
    homepage: primary?.homepage || home,
    checked: primary?.checked || 0,
    rssCandidates: rows.length,
    publisherCandidates: choices.length,
    googleNewsRowReused: Boolean(reusedRows.length),
    googleNewsSearchSkipped: Boolean(reusedRows.length),
    aggregatorPrimarySkipped,
    error: primary?.error || (rows.length ? 'same-story-publisher-not-found' : 'google-news-no-candidates')
  };
}

async function publisherWithDeadline(title, source, seedRows = []) {
  let timer;
  const started = Date.now();
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      result: {
        image: '',
        error: 'publisher-deadline',
        googleNewsRowReused: Boolean(reusableGoogleRows(seedRows).length),
        googleNewsSearchSkipped: Boolean(reusableGoogleRows(seedRows).length),
        aggregatorPrimarySkipped: isAggregator(source) && reusableGoogleRows(seedRows).length > 0
      },
      timedOut: true,
      ms: Date.now() - started
    }), PUBLISHER_FALLBACK_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      publisherFallback(title, source, seedRows).then(result => ({
        result,
        timedOut: false,
        ms: Date.now() - started
      })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function raceImagePaths(entries = [], deadlineMs = PUBLISHER_FALLBACK_DEADLINE_MS) {
  const started = Date.now();
  const states = Object.fromEntries(entries.map(entry => [entry.name, {
    result: { image: '', error: `${entry.name}-pending` },
    timedOut: false,
    ms: 0
  }]));
  return new Promise(resolve => {
    let finished = false;
    let settled = 0;
    const finish = winner => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ winner, states, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      for (const entry of entries) {
        if (String(states[entry.name]?.result?.error || '').endsWith('-pending')) {
          states[entry.name] = {
            result: { image: '', error: `${entry.name}-deadline` },
            timedOut: true,
            ms: Date.now() - started
          };
        }
      }
      finish('');
    }, deadlineMs);

    for (const entry of entries) {
      Promise.resolve(entry.promise).then(run => {
        if (finished) return;
        states[entry.name] = run || { result: { image: '', error: `${entry.name}-empty` }, timedOut: false, ms: Date.now() - started };
        settled += 1;
        if (states[entry.name]?.result?.image) return finish(entry.name);
        if (settled >= entries.length) finish('');
      }).catch(error => {
        if (finished) return;
        states[entry.name] = {
          result: { image: '', error: `${entry.name}-${error?.message || error}` },
          timedOut: false,
          ms: Date.now() - started
        };
        settled += 1;
        if (settled >= entries.length) finish('');
      });
    }
  });
}

export function readerImageDiagnostic(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const body = bodyOf(req);
  const log = {
    phase: compact(body.phase, 80) || 'unknown',
    articleId: compact(body.articleId, 700),
    title: compact(body.title, 260),
    source: compact(body.source, 120),
    imageUrl: compact(body.imageUrl, 1100),
    imageHost: compact(body.imageHost, 180),
    summaryProvider: compact(body.summaryProvider, 80),
    viewport: compact(body.viewport, 80),
    online: body.online !== false
  };
  console.warn('[reader-image]', log);
  return res.status(204).end();
}

export async function readerImageResolve(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = bodyOf(req);
  const articleId = compact(body.articleId, 700);
  const title = compact(body.title, 320);
  const source = compact(body.source, 120);
  const link = compact(body.link, 2200);
  if (!/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'Invalid article link' });
  const seedRows = req?.__readerImageGoogleNewsRow ? [req.__readerImageGoogleNewsRow] : [];
  const sourceHomeHost = hostOf(seedRows[0]?.home);
  const parallelGoogleDecode = isGoogleNewsUrl(link) && req?.__readerImageGoogleDecodeMethod === 'rss-source-url-seed';

  console.info('[NEWS-IMAGE]', {
    diagnosticVersion: 2,
    phase: 'resolver-policy',
    policy: RESOLVER_POLICY,
    articleId,
    gdeltEnabled: false,
    siteBrandEnabled: false,
    publisherBingParallel: true,
    googleNewsDecodeFallback: true,
    googleNewsParallelDecode: parallelGoogleDecode,
    googleNewsRowReuse: true,
    duplicateGoogleSearchSuppression: true,
    publisherDeadlineMs: PUBLISHER_FALLBACK_DEADLINE_MS,
    resolvedUrlReuse: true,
    positiveCacheTtlMs: POSITIVE_TTL_MS
  });

  const keys = cacheKeys(link, articleId, title);
  const cached = cacheGet(keys);
  if (cached) {
    console.info('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'resolved-url-reuse',
      policy: RESOLVER_POLICY,
      articleId,
      cacheLayer: 'server-memory',
      cacheKey: cacheKeyType(cached.key),
      imageHost: hostOf(cached.value?.image),
      method: compact(cached.value?.method, 140)
    });
    console.info('[reader-image-resolve]', {
      ok: Boolean(cached.value?.image),
      cached: true,
      articleId,
      title,
      source,
      imageHost: hostOf(cached.value?.image),
      publisherHost: hostOf(cached.value?.publisherUrl),
      method: cached.value?.method || '',
      fallback: cached.value?.fallback || '',
      imageKind: cached.value?.imageKind || 'article',
      fallbackError: cached.value?.fallbackError || ''
    });
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ ...cached.value, cached: true });
  }

  const started = Date.now();
  let direct = {
    sourceImage: '',
    sourceImageMethod: '',
    publisherUrl: '',
    error: ''
  };

  if (isGoogleNewsUrl(link)) {
    direct.error = 'google-news-decode-fallback';
    console.info('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'google-news-decode-fallback',
      policy: RESOLVER_POLICY,
      articleId,
      reason: parallelGoogleDecode ? 'rss-source-url-seeded' : 'google-link-remained-after-preflight',
      strategy: parallelGoogleDecode
        ? 'publisher+google-decode+bing-race'
        : 'reuse-google-news-row+publisher-bing-parallel',
      publisherHint: compact(publisherHint(title), 90),
      googleNewsRowAvailable: Boolean(seedRows.length),
      sourceHomeHost
    });
  } else {
    direct = await resolveSourcePublishedTime(link, { stageTimeoutMs: 1200 });
  }

  const directImage = compact(direct?.sourceImage, 2200);
  const directBlocked = directImage ? imageBlockedReason(directImage, 'article') : '';
  if (directBlocked) logRejected('direct', directImage, directBlocked, direct?.sourceImageMethod || '');

  const payload = {
    image: directBlocked ? '' : directImage,
    backupImage: '',
    imageKind: directImage && !directBlocked ? 'article' : '',
    method: directBlocked ? '' : compact(direct?.sourceImageMethod, 120),
    publisherUrl: compact(direct?.publisherUrl || req?.__readerImageRecoveredPublisherUrl, 2200),
    error: compact(direct?.error, 240),
    fallback: '',
    fallbackError: ''
  };

  if (!payload.image) {
    console.info('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'fallback-parallel-start',
      policy: RESOLVER_POLICY,
      articleId,
      paths: parallelGoogleDecode ? ['publisher', 'google-decode', 'bing'] : ['publisher', 'bing'],
      googleNewsRowReused: Boolean(seedRows.length),
      sourceHomeHost,
      duplicateGoogleSearchSkipped: Boolean(seedRows.length),
      publisherDeadlineMs: PUBLISHER_FALLBACK_DEADLINE_MS,
      gdeltEnabled: false,
      siteBrandEnabled: false
    });

    const publisherPromise = publisherWithDeadline(title, source, seedRows);

    const bingStarted = Date.now();
    const bingPromise = bingNews(title, source)
      .then(result => ({ result, timedOut: false, ms: Date.now() - bingStarted }));

    const decodeStarted = Date.now();
    const decodePromise = parallelGoogleDecode
      ? resolveSourcePublishedTime(link, { stageTimeoutMs: 550 }).then(result => {
          const candidate = compact(result?.sourceImage, 2200);
          const blocked = candidate ? imageBlockedReason(candidate, 'article') : '';
          if (blocked) logRejected('google-parallel-decode', candidate, blocked, result?.sourceImageMethod || '');
          return {
            result: {
              image: blocked ? '' : candidate,
              method: compact(result?.sourceImageMethod, 140),
              articleUrl: compact(result?.publisherUrl, 2200),
              error: compact(result?.error || (candidate ? '' : 'google-decode-no-image'), 160)
            },
            timedOut: false,
            ms: Date.now() - decodeStarted
          };
        }).catch(error => ({
          result: { image: '', error: `google-decode-${error?.message || error}` },
          timedOut: false,
          ms: Date.now() - decodeStarted
        }))
      : Promise.resolve({ result: { image: '', error: 'google-decode-not-needed' }, timedOut: false, ms: 0 });

    const entries = [
      { name: 'publisher', promise: publisherPromise },
      ...(parallelGoogleDecode ? [{ name: 'google-decode', promise: decodePromise }] : []),
      { name: 'bing', promise: bingPromise }
    ];
    const race = await raceImagePaths(entries, PUBLISHER_FALLBACK_DEADLINE_MS);
    const publisherRun = race.states.publisher || { result: { image: '', error: 'publisher-empty' }, timedOut: false, ms: 0 };
    const decodeRun = race.states['google-decode'] || { result: { image: '', error: 'google-decode-not-needed' }, timedOut: false, ms: 0 };
    const bingRun = race.states.bing || { result: { image: '', error: 'bing-empty' }, timedOut: false, ms: 0 };
    const publisher = publisherRun.result || { image: '', error: 'publisher-empty' };
    const decoded = decodeRun.result || { image: '', error: 'google-decode-empty' };
    const bing = bingRun.result || { image: '', error: 'bing-empty' };

    console.info('[NEWS-IMAGE]', {
      diagnosticVersion: 2,
      phase: 'fallback-parallel-finish',
      policy: RESOLVER_POLICY,
      articleId,
      winner: race.winner || '',
      publisherMs: publisherRun.ms,
      publisherTimedOut: Boolean(publisherRun.timedOut),
      googleDecodeMs: decodeRun.ms,
      googleDecodeTimedOut: Boolean(decodeRun.timedOut),
      bingMs: bingRun.ms,
      bingTimedOut: Boolean(bingRun.timedOut),
      totalParallelMs: race.ms,
      publisherOk: Boolean(publisher.image),
      googleDecodeOk: Boolean(decoded.image),
      bingOk: Boolean(bing.image),
      googleNewsRowReused: Boolean(publisher.googleNewsRowReused) || Boolean(seedRows.length),
      duplicateGoogleSearchSkipped: Boolean(publisher.googleNewsSearchSkipped) || Boolean(seedRows.length),
      aggregatorPrimarySkipped: Boolean(publisher.aggregatorPrimarySkipped),
      sourceHomeHost,
      publisherReason: compact(publisher.error, 160),
      googleDecodeReason: compact(decoded.error, 160),
      bingReason: compact(bing.error, 160),
      gdeltUsed: false,
      siteBrandUsed: false
    });

    if (race.winner === 'publisher' && publisher.image) {
      payload.image = compact(publisher.image, 2200);
      payload.imageKind = 'article';
      payload.method = compact(publisher.method, 140);
      payload.publisherUrl = compact(publisher.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = publisher.fallback || 'publisher';
      console.info('[reader-image-resolve:publisher-discovery]', {
        ok: true,
        articleId,
        title,
        source,
        imageHost: hostOf(payload.image),
        publisherHost: hostOf(payload.publisherUrl),
        fallback: payload.fallback,
        rowSource: publisher.rowSource || '',
        checked: publisher.checked || 0,
        rssCandidates: publisher.rssCandidates || 0,
        googleNewsRowReused: Boolean(publisher.googleNewsRowReused) || Boolean(seedRows.length),
        duplicateGoogleSearchSkipped: Boolean(publisher.googleNewsSearchSkipped) || Boolean(seedRows.length),
        aggregatorPrimarySkipped: Boolean(publisher.aggregatorPrimarySkipped),
        publisherTimedOut: false,
        elapsedMs: Date.now() - started
      });
    } else if (race.winner === 'google-decode' && decoded.image) {
      payload.image = compact(decoded.image, 2200);
      payload.imageKind = 'article';
      payload.method = compact(decoded.method, 140);
      payload.publisherUrl = compact(decoded.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = 'google-news-parallel-decode';
      console.info('[reader-image-resolve:google-news-decode]', {
        ok: true,
        articleId,
        title,
        source,
        imageHost: hostOf(payload.image),
        publisherHost: hostOf(payload.publisherUrl),
        elapsedMs: Date.now() - started
      });
    } else if (race.winner === 'bing' && bing.image) {
      payload.image = compact(bing.image, 2200);
      payload.imageKind = 'article';
      payload.method = compact(bing.method, 140);
      payload.publisherUrl = compact(bing.articleUrl || payload.publisherUrl, 2200);
      payload.fallback = 'bing-news';
      console.info('[reader-image-resolve:bing-news]', {
        ok: true,
        articleId,
        title,
        source,
        imageHost: hostOf(payload.image),
        publisherHost: hostOf(payload.publisherUrl),
        rowSource: bing.rowSource || '',
        similarity: Number((bing.similarity || 0).toFixed(3)),
        candidates: bing.candidates || 0,
        elapsedMs: Date.now() - started
      });
    } else {
      const bingError = compact(bing.error || 'unknown', 120);
      const publisherError = compact(publisher.error || 'unknown', 160);
      const decodeError = compact(decoded.error || 'not-needed', 160);
      payload.fallbackError = compact(
        `bing:${bingError};publisher:${publisherError};decode:${decodeError};gdelt:disabled;site-brand:client-fallback`,
        500
      );
      console.warn('[reader-image-resolve:bing-news]', {
        ok: false,
        articleId,
        title,
        source,
        reason: bingError,
        candidates: bing.candidates || 0,
        elapsedMs: Date.now() - started
      });
      console.warn('[reader-image-resolve:publisher-discovery]', {
        ok: false,
        articleId,
        title,
        source,
        homepageHost: hostOf(publisher.homepage),
        checked: publisher.checked || 0,
        rssCandidates: publisher.rssCandidates || 0,
        publisherCandidates: publisher.publisherCandidates || 0,
        reason: publisherError,
        googleNewsRowReused: Boolean(publisher.googleNewsRowReused) || Boolean(seedRows.length),
        duplicateGoogleSearchSkipped: Boolean(publisher.googleNewsSearchSkipped) || Boolean(seedRows.length),
        aggregatorPrimarySkipped: Boolean(publisher.aggregatorPrimarySkipped),
        publisherTimedOut: Boolean(publisherRun.timedOut),
        publisherDeadlineMs: PUBLISHER_FALLBACK_DEADLINE_MS,
        elapsedMs: Date.now() - started
      });
    }
  }

  const finalBlocked = payload.image ? imageBlockedReason(payload.image, payload.imageKind) : '';
  if (finalBlocked) {
    logRejected('final', payload.image, finalBlocked, payload.method);
    payload.image = '';
    payload.backupImage = '';
    payload.imageKind = '';
    payload.method = '';
    payload.fallbackError = compact(
      `${payload.fallbackError ? `${payload.fallbackError};` : ''}final-image-rejected:${finalBlocked}`,
      500
    );
  }

  cacheSet(keys, payload);
  console.info('[NEWS-IMAGE]', {
    diagnosticVersion: 2,
    phase: 'resolved-url-cache-store',
    policy: RESOLVER_POLICY,
    articleId,
    cacheLayer: 'server-memory',
    cacheKeys: keys.map(cacheKeyType),
    stored: Boolean(payload.image),
    imageHost: hostOf(payload.image),
    ttlMs: payload.image ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
  });

  const log = {
    ok: Boolean(payload.image),
    cached: false,
    articleId,
    title,
    source,
    imageHost: hostOf(payload.image),
    publisherHost: hostOf(payload.publisherUrl),
    method: payload.method,
    fallback: payload.fallback,
    imageKind: payload.imageKind || 'article',
    elapsedMs: Date.now() - started,
    error: payload.error,
    fallbackError: payload.fallbackError
  };

  if (payload.image) console.info('[reader-image-resolve]', log);
  else console.warn('[reader-image-resolve]', log);

  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json(payload);
}
