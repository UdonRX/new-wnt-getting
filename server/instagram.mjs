const ALLOWED_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const RESERVED_PROFILE_PATHS = new Set([
  'accounts', 'about', 'developer', 'explore', 'directory', 'legal', 'privacy', 'terms',
  'p', 'reel', 'stories'
]);
const ALLOWED_VIDEO_KINDS = new Set(['auto', 'post', 'reel']);
const PROFILE_POST_LIMIT = 12;
const MAX_V1_PAGE_HOPS = 3;
const INSTAGRAM_WEB_APP_ID = '936619743392459';
const INSTAGRAM_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeProfile(raw) {
  const input = String(first(raw) || '').trim();
  if (!input) throw new Error('Instagramユーザー名が必要です。');

  let candidate = input;
  if (/^@[A-Za-z0-9._]+$/.test(candidate)) {
    candidate = `https://www.instagram.com/${candidate.slice(1)}/`;
  } else if (/^[A-Za-z0-9._]+$/.test(candidate)) {
    candidate = `https://www.instagram.com/${candidate}/`;
  } else if (/^(www\.)?instagram\.com\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const url = new URL(candidate);
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('instagram.com の公開プロフィールだけ指定できます。');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const username = parts[0] || '';
  if (parts.length !== 1 || RESERVED_PROFILE_PATHS.has(username.toLowerCase()) || !/^[A-Za-z0-9._]+$/.test(username)) {
    throw new Error('有効なInstagramプロフィールを指定してください。');
  }

  const normalized = username.toLowerCase();
  return {
    username: normalized,
    profileUrl: `https://www.instagram.com/${normalized}/`,
    iframeUrl: `https://www.instagram.com/${normalized}/embed/`
  };
}

function validateShortcode(raw) {
  const shortcode = String(first(raw) || '').trim();
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(shortcode)) {
    throw new Error('有効なInstagram shortcodeが必要です。');
  }
  return shortcode;
}

function requestedLimit(raw) {
  const value = Math.floor(Number(first(raw) || PROFILE_POST_LIMIT));
  if (!Number.isFinite(value)) return PROFILE_POST_LIMIT;
  return Math.max(1, Math.min(PROFILE_POST_LIMIT, value));
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function decodeEscapedLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function buildDecodedVariants(html, levels = 4) {
  const variants = [];
  let current = String(html || '');
  for (let level = 0; level < levels; level += 1) {
    if (!variants.includes(current)) variants.push(current);
    current = decodeEscapedLayer(current);
  }
  return variants;
}

function normalizeHttpsUrl(value) {
  let candidate = String(value || '').trim();
  for (let pass = 0; pass < 3; pass += 1) candidate = decodeEscapedLayer(candidate);
  candidate = candidate
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=');
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function extractBalanced(text, startIndex, open = '[', close = ']') {
  let depth = 0;
  let quote = '';
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { inString = false; quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quote = char; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function dedupeMediaObjects(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.shortcode || item.code || item.id || item.pk || JSON.stringify(item).slice(0, 120));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function parseGraphqlMediaFromHtml(html) {
  const variants = buildDecodedVariants(html, 4);
  let arrayOccurrences = 0;
  let bestItems = [];
  let parseMethod = null;
  let decodedLevel = null;
  const parseErrors = [];
  const collectedItems = [];

  for (let level = 0; level < variants.length; level += 1) {
    const input = variants[level];
    const marker = /["']graphql_media["']\s*:\s*\[/gi;
    let match;
    while ((match = marker.exec(input))) {
      arrayOccurrences += 1;
      const start = input.indexOf('[', match.index);
      if (start < 0) continue;
      const rawArray = extractBalanced(input, start, '[', ']');
      if (!rawArray) continue;
      try {
        const parsed = JSON.parse(rawArray);
        if (!Array.isArray(parsed)) continue;
        const objects = parsed
          .map((entry) => entry?.shortcode_media || entry?.node || entry)
          .filter((entry) => entry && typeof entry === 'object');
        if (objects.length) {
          collectedItems.push(...objects);
          if (decodedLevel == null) decodedLevel = level;
        }
      } catch (error) {
        if (parseErrors.length < 5) parseErrors.push(`array@level${level}: ${error.message}`);
      }
    }
  }

  const collected = dedupeMediaObjects(collectedItems);
  if (collected.length) {
    bestItems = collected;
    parseMethod = 'graphql_media_arrays';
  }

  if (!bestItems.length) {
    for (let level = 0; level < variants.length; level += 1) {
      const input = variants[level];
      const marker = /["']shortcode_media["']\s*:\s*\{/gi;
      const objects = [];
      let match;
      while ((match = marker.exec(input))) {
        const start = input.indexOf('{', match.index);
        if (start < 0) continue;
        const rawObject = extractBalanced(input, start, '{', '}');
        if (!rawObject) continue;
        try {
          objects.push(JSON.parse(rawObject));
        } catch (error) {
          if (parseErrors.length < 5) parseErrors.push(`object@level${level}: ${error.message}`);
        }
      }
      const deduped = dedupeMediaObjects(objects);
      if (deduped.length > bestItems.length) {
        bestItems = deduped;
        parseMethod = 'shortcode_media_objects';
        decodedLevel = level;
      }
    }
  }

  return {
    items: dedupeMediaObjects(bestItems),
    parseMethod,
    decodedLevel,
    arrayOccurrences,
    parseErrors
  };
}

function extractProfileAvatar(html, mediaItems = []) {
  for (const media of mediaItems || []) {
    const candidates = [
      media?.owner?.profile_pic_url_hd,
      media?.owner?.profile_pic_url,
      media?.owner?.profilePicUrl,
      media?.user?.profile_pic_url_hd,
      media?.user?.profile_pic_url,
      media?.user?.profilePicUrl
    ];
    for (const candidate of candidates) {
      const url = normalizeHttpsUrl(candidate);
      if (url) return url;
    }
  }

  for (const input of buildDecodedVariants(html, 5)) {
    const patterns = [
      /["']profile_pic_url_hd["']\s*:\s*["']([^"']+)["']/gi,
      /["']profile_pic_url["']\s*:\s*["']([^"']+)["']/gi,
      /["']profilePicUrl["']\s*:\s*["']([^"']+)["']/gi
    ];
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        const url = normalizeHttpsUrl(match[1]);
        if (url) return url;
      }
    }
  }
  return null;
}

function extractProfileUserId(html, mediaItems = []) {
  for (const media of mediaItems || []) {
    const candidates = [media?.owner?.id, media?.owner?.pk, media?.user?.id, media?.user?.pk];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (/^\d{3,30}$/.test(value)) return value;
    }
  }
  for (const input of buildDecodedVariants(html, 5)) {
    const patterns = [
      /["']profile_id["']\s*:\s*["']?(\d{3,30})["']?/i,
      /["']owner["']\s*:\s*\{[\s\S]{0,400}?["']id["']\s*:\s*["'](\d{3,30})["']/i,
      /["']user["']\s*:\s*\{[\s\S]{0,400}?["']id["']\s*:\s*["'](\d{3,30})["']/i
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

function firstCaption(media) {
  if (typeof media?.caption === 'string') return media.caption;
  const edgeText = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  return typeof edgeText === 'string' ? edgeText : '';
}

function timestampInfo(value) {
  if (value == null || value === '') return { seconds: null, iso: null };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { seconds: null, iso: null };
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return {
    seconds: Math.round(milliseconds / 1000),
    iso: Number.isNaN(date.getTime()) ? null : date.toISOString()
  };
}

function mediaKind(node = {}) {
  const type = String(node.__typename || '');
  return Boolean(node.is_video || node.isVideo || type === 'GraphVideo') ? 'video' : 'image';
}

function normalizeMediaNode(node = {}, fallbackShortcode = '') {
  const source = node?.node || node || {};
  const displayUrl = source.display_url || source.displayUrl || source.thumbnail_src || null;
  const shortcode = source.shortcode || fallbackShortcode || null;
  return {
    kind: mediaKind(source),
    url: displayUrl,
    posterUrl: displayUrl,
    shortcode
  };
}

function normalizeFeedItem(username, media, index, avatarUrl = null) {
  const type = String(media?.__typename || '');
  const isVideo = Boolean(media?.is_video || type === 'GraphVideo');
  const shortcode = media?.shortcode || null;
  const timestamp = timestampInfo(media?.taken_at_timestamp ?? media?.taken_at);
  const sidecar = Array.isArray(media?.edge_sidecar_to_children?.edges)
    ? media.edge_sidecar_to_children.edges
    : [];

  let mediaItems = [];
  let mediaType = 'image';
  if (type === 'GraphSidecar' && sidecar.length) {
    mediaType = 'carousel';
    mediaItems = sidecar
      .slice(0, 20)
      .map((entry) => normalizeMediaNode(entry, shortcode))
      .filter((entry) => entry.url);
  } else {
    mediaType = isVideo ? 'video' : 'image';
    const normalized = normalizeMediaNode(media, shortcode);
    if (normalized.url) mediaItems = [normalized];
  }

  const postPermalink = shortcode
    ? `https://www.instagram.com/p/${shortcode}/`
    : `https://www.instagram.com/${username}/`;
  const reelPermalink = shortcode && isVideo
    ? `https://www.instagram.com/reel/${shortcode}/`
    : null;

  return {
    contractVersion: 1,
    source: 'instagram',
    account: {
      username,
      profileUrl: `https://www.instagram.com/${username}/`,
      avatarUrl: avatarUrl || null
    },
    id: `instagram:${username}:${shortcode || media?.id || index + 1}`,
    externalId: media?.id || null,
    shortcode,
    text: firstCaption(media),
    timestamp: timestamp.seconds,
    timestampIso: timestamp.iso,
    mediaType,
    media: mediaItems,
    permalink: postPermalink,
    reelPermalink
  };
}

function v1ImageUrl(item = {}) {
  const candidates = item?.image_versions2?.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const url = normalizeHttpsUrl(candidate?.url);
      if (url) return url;
    }
  }
  return normalizeHttpsUrl(item?.thumbnail_url || item?.display_url || item?.image_url);
}

function v1Kind(item = {}) {
  return Number(item?.media_type) === 2 || Array.isArray(item?.video_versions) ? 'video' : 'image';
}

function normalizeV1MediaNode(item = {}, fallbackShortcode = '') {
  const url = v1ImageUrl(item);
  return {
    kind: v1Kind(item),
    url,
    posterUrl: url,
    shortcode: String(item?.code || item?.shortcode || fallbackShortcode || '') || null
  };
}

function normalizeV1FeedItem(username, media, index, fallbackAvatar = null) {
  const shortcode = String(media?.code || media?.shortcode || '').trim() || null;
  const timestamp = timestampInfo(media?.taken_at ?? media?.taken_at_timestamp);
  const avatarUrl = normalizeHttpsUrl(media?.user?.profile_pic_url || media?.user?.profile_pic_url_hd) || fallbackAvatar;
  const carousel = Array.isArray(media?.carousel_media) ? media.carousel_media : [];
  const isVideo = v1Kind(media) === 'video';
  let mediaType = 'image';
  let mediaItems = [];

  if (carousel.length) {
    mediaType = 'carousel';
    mediaItems = carousel
      .slice(0, 20)
      .map(entry => normalizeV1MediaNode(entry, shortcode))
      .filter(entry => entry.url);
  } else {
    mediaType = isVideo ? 'video' : 'image';
    const normalized = normalizeV1MediaNode(media, shortcode);
    if (normalized.url) mediaItems = [normalized];
  }

  const caption = typeof media?.caption?.text === 'string'
    ? media.caption.text
    : typeof media?.caption === 'string' ? media.caption : '';
  const postPermalink = shortcode
    ? `https://www.instagram.com/p/${shortcode}/`
    : `https://www.instagram.com/${username}/`;
  const reelPermalink = shortcode && (isVideo || media?.product_type === 'clips')
    ? `https://www.instagram.com/reel/${shortcode}/`
    : null;

  return {
    contractVersion: 1,
    source: 'instagram',
    account: {
      username,
      profileUrl: `https://www.instagram.com/${username}/`,
      avatarUrl: avatarUrl || null
    },
    id: `instagram:${username}:${shortcode || media?.id || media?.pk || index + 1}`,
    externalId: media?.id || String(media?.pk || '') || null,
    shortcode,
    text: caption,
    timestamp: timestamp.seconds,
    timestampIso: timestamp.iso,
    mediaType,
    media: mediaItems,
    permalink: postPermalink,
    reelPermalink
  };
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url');
}

function decodeCursor(raw, username) {
  const value = String(first(raw) || '').trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed?.username !== username || !['embed', 'v1'].includes(parsed?.mode)) {
      throw new Error('cursor mismatch');
    }
    if (parsed.mode === 'embed') {
      const offset = Math.max(0, Math.floor(Number(parsed.offset || 0)));
      return { mode: 'embed', username, offset, userId: /^\d{3,30}$/.test(String(parsed.userId || '')) ? String(parsed.userId) : null };
    }
    return {
      mode: 'v1',
      username,
      userId: /^\d{3,30}$/.test(String(parsed.userId || '')) ? String(parsed.userId) : null,
      maxId: String(parsed.maxId || '').slice(0, 500),
      skip: Array.isArray(parsed.skip) ? parsed.skip.map(value => String(value || '')).filter(Boolean).slice(0, 80) : []
    };
  } catch {
    throw new Error('Instagramページカーソルが無効です。');
  }
}

function itemShortcode(item) {
  return String(item?.shortcode || item?.code || '').trim();
}

async function fetchInstagramHtml(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
      'User-Agent': INSTAGRAM_UA
    },
    signal: AbortSignal.timeout(10000)
  });
  const html = await response.text();
  return { response, html };
}

async function fetchInstagramV1Page(target, userId, maxId = '') {
  const url = new URL(`https://www.instagram.com/api/v1/feed/user/${userId}/`);
  url.searchParams.set('count', String(PROFILE_POST_LIMIT));
  if (maxId) url.searchParams.set('max_id', maxId);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
      'User-Agent': INSTAGRAM_UA,
      'X-IG-App-ID': INSTAGRAM_WEB_APP_ID,
      'X-ASBD-ID': '198387',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: target.profileUrl
    },
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data || !Array.isArray(data.items)) {
    throw new Error(`Instagram追加ページ HTTP ${response.status}`);
  }
  return {
    items: data.items,
    moreAvailable: Boolean(data.more_available),
    nextMaxId: String(data.next_max_id || ''),
    status: response.status
  };
}

function sendProfilePage(res, {
  account,
  items,
  nextCursor = '',
  diagnostics = {}
}) {
  res.status(200).json({
    ok: true,
    source: 'instagram',
    account,
    count: items.length,
    items,
    hasMore: Boolean(nextCursor),
    nextCursor: nextCursor || null,
    diagnostics
  });
}

async function serveV1CursorPage(target, cursor, limit, res) {
  if (!cursor.userId) {
    sendProfilePage(res, {
      account: { username: target.username, profileUrl: target.profileUrl, avatarUrl: null },
      items: [],
      diagnostics: { paginationMode: 'v1', paginationAvailable: false, reason: 'user_id_missing' }
    });
    return;
  }

  let nextMaxId = cursor.maxId || '';
  const skip = new Set(cursor.skip || []);
  const output = [];
  let moreAvailable = true;
  let hops = 0;
  let avatarUrl = null;
  let lastError = null;

  while (moreAvailable && output.length < limit && hops < MAX_V1_PAGE_HOPS) {
    hops += 1;
    let page;
    try {
      page = await fetchInstagramV1Page(target, cursor.userId, nextMaxId);
    } catch (error) {
      lastError = error;
      break;
    }
    moreAvailable = page.moreAvailable;
    nextMaxId = page.nextMaxId;
    const normalized = page.items
      .map((item, index) => normalizeV1FeedItem(target.username, item, index, avatarUrl))
      .filter(item => item.shortcode || item.media.length || item.text);
    if (!avatarUrl) avatarUrl = normalized.find(item => item.account?.avatarUrl)?.account?.avatarUrl || null;
    for (const item of normalized) {
      const shortcode = itemShortcode(item);
      if (shortcode && skip.has(shortcode)) continue;
      if (shortcode) skip.add(shortcode);
      output.push(item);
      if (output.length >= limit) break;
    }
    if (!nextMaxId) moreAvailable = false;
  }

  const nextCursor = moreAvailable && nextMaxId
    ? encodeCursor({
      mode: 'v1',
      username: target.username,
      userId: cursor.userId,
      maxId: nextMaxId,
      skip: output.map(itemShortcode).filter(Boolean).slice(-24)
    })
    : '';

  sendProfilePage(res, {
    account: { username: target.username, profileUrl: target.profileUrl, avatarUrl },
    items: output,
    nextCursor,
    diagnostics: {
      paginationMode: 'v1',
      paginationAvailable: !lastError,
      hops,
      moreAvailable,
      paginationError: lastError?.message || null
    }
  });
}

export async function instagramProfile(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GETのみ対応しています。' });
    return;
  }

  let target;
  let cursor;
  const limit = requestedLimit(req.query?.limit);
  try {
    target = normalizeProfile(req.query?.username ?? req.query?.url);
    cursor = decodeCursor(req.query?.cursor, target.username);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (cursor?.mode === 'v1') {
    await serveV1CursorPage(target, cursor, limit, res);
    return;
  }

  try {
    const { response, html } = await fetchInstagramHtml(target.iframeUrl);
    if (!response.ok) {
      res.status(response.status).json({
        ok: false,
        error: `Instagramプロフィール取得 HTTP ${response.status}`,
        account: { username: target.username, profileUrl: target.profileUrl }
      });
      return;
    }

    const parsed = parseGraphqlMediaFromHtml(html);
    const avatarUrl = extractProfileAvatar(html, parsed.items);
    const userId = cursor?.userId || extractProfileUserId(html, parsed.items);
    const normalized = parsed.items
      .map((media, index) => normalizeFeedItem(target.username, media, index, avatarUrl))
      .filter((item) => item.shortcode || item.media.length || item.text)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

    if (!normalized.length) {
      res.status(502).json({
        ok: false,
        error: 'Profile Embed HTMLからgraphql_mediaを取得できませんでした。',
        account: { username: target.username, profileUrl: target.profileUrl, avatarUrl },
        diagnostics: {
          htmlLength: html.length,
          parseMethod: parsed.parseMethod,
          decodedLevel: parsed.decodedLevel,
          arrayOccurrences: parsed.arrayOccurrences,
          parseErrors: parsed.parseErrors
        }
      });
      return;
    }

    const offset = cursor?.mode === 'embed' ? cursor.offset : 0;
    const items = normalized.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    let nextCursor = '';

    if (nextOffset < normalized.length) {
      nextCursor = encodeCursor({
        mode: 'embed',
        username: target.username,
        offset: nextOffset,
        userId
      });
    } else if (userId) {
      nextCursor = encodeCursor({
        mode: 'v1',
        username: target.username,
        userId,
        maxId: '',
        skip: normalized.map(itemShortcode).filter(Boolean).slice(0, 80)
      });
    }

    sendProfilePage(res, {
      account: { username: target.username, profileUrl: target.profileUrl, avatarUrl },
      items,
      nextCursor,
      diagnostics: {
        htmlLength: html.length,
        parsedCount: parsed.items.length,
        normalizedCount: normalized.length,
        offset,
        returnedLimit: limit,
        avatarAvailable: Boolean(avatarUrl),
        userIdAvailable: Boolean(userId),
        parseMethod: parsed.parseMethod,
        decodedLevel: parsed.decodedLevel,
        arrayOccurrences: parsed.arrayOccurrences,
        parseErrors: parsed.parseErrors,
        paginationMode: cursor?.mode || 'initial'
      }
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      ok: false,
      error: timedOut
        ? 'Instagram Profile Embedへの接続が10秒でタイムアウトしました。'
        : `Instagramプロフィール取得に失敗しました: ${error.message}`,
      account: { username: target.username, profileUrl: target.profileUrl }
    });
  }
}

function cleanUrl(value) {
  return decodeEscapedLayer(String(value || ''))
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=');
}

function extractVideoUrls(html) {
  const urls = [];
  for (const input of buildDecodedVariants(html, 5)) {
    const patterns = [
      /["']video_url["']\s*:\s*["']([^"']+)["']/gi,
      /["']videoUrl["']\s*:\s*["']([^"']+)["']/gi,
      /<meta\b[^>]*(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]*>/gi
    ];
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        const url = cleanUrl(match[1]);
        if (/^https:\/\//i.test(url) && /(?:\.mp4(?:\?|$)|video|fbcdn|cdninstagram|scontent)/i.test(url)) {
          urls.push(url);
        }
      }
    }
  }
  return unique(urls).slice(0, 20);
}

function extractPoster(html) {
  for (const input of buildDecodedVariants(html, 5)) {
    const patterns = [
      /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /["']display_url["']\s*:\s*["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match?.[1]) return cleanUrl(match[1]);
    }
  }
  return null;
}

function videoCandidates(shortcode, kind) {
  const reel = `https://www.instagram.com/reel/${shortcode}/embed/`;
  const post = `https://www.instagram.com/p/${shortcode}/embed/`;
  if (kind === 'reel') return [reel, post];
  if (kind === 'post') return [post, reel];
  return [reel, post];
}

export async function instagramVideo(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GETのみ対応しています。' });
    return;
  }

  let shortcode;
  let kind;
  try {
    shortcode = validateShortcode(req.query?.shortcode);
    kind = String(first(req.query?.kind) || 'auto').toLowerCase();
    if (!ALLOWED_VIDEO_KINDS.has(kind)) {
      throw new Error('kindは auto / post / reel のいずれかです。');
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const attempts = [];
  for (const candidateUrl of videoCandidates(shortcode, kind)) {
    try {
      const { response, html } = await fetchInstagramHtml(candidateUrl);
      const videoUrls = extractVideoUrls(html);
      const posterUrl = extractPoster(html);
      attempts.push({
        url: candidateUrl,
        status: response.status,
        finalUrl: response.url,
        htmlLength: html.length,
        videoUrlCount: videoUrls.length,
        posterAvailable: Boolean(posterUrl)
      });

      if (response.ok && videoUrls.length) {
        res.status(200).json({
          ok: true,
          shortcode,
          kind,
          source: 'individual_embed_html',
          sourceUrl: candidateUrl,
          finalUrl: response.url,
          videoUrl: videoUrls[0],
          videoUrlCandidates: videoUrls,
          posterUrl,
          attempts
        });
        return;
      }
    } catch (error) {
      attempts.push({ url: candidateUrl, status: 'ERROR', error: error.message });
    }
  }

  res.status(404).json({
    ok: false,
    shortcode,
    kind,
    error: '個別投稿Embed HTMLからvideo_urlを取得できませんでした。',
    attempts
  });
}
