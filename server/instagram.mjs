const ALLOWED_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const RESERVED_PROFILE_PATHS = new Set([
  'accounts', 'about', 'developer', 'explore', 'directory', 'legal', 'privacy', 'terms',
  'p', 'reel', 'stories'
]);
const ALLOWED_VIDEO_KINDS = new Set(['auto', 'post', 'reel']);
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
    const key = String(item.shortcode || item.id || JSON.stringify(item).slice(0, 120));
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
        if (objects.length > bestItems.length) {
          bestItems = objects;
          parseMethod = 'graphql_media_array';
          decodedLevel = level;
        }
      } catch (error) {
        if (parseErrors.length < 5) parseErrors.push(`array@level${level}: ${error.message}`);
      }
    }
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

function normalizeFeedItem(username, media, index) {
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
      profileUrl: `https://www.instagram.com/${username}/`
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

export async function instagramProfile(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GETのみ対応しています。' });
    return;
  }

  let target;
  try {
    target = normalizeProfile(req.query?.username ?? req.query?.url);
  } catch (error) {
    res.status(400).json({ error: error.message });
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
    const items = parsed.items
      .map((media, index) => normalizeFeedItem(target.username, media, index))
      .filter((item) => item.shortcode || item.media.length || item.text)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 6);

    if (!items.length) {
      res.status(502).json({
        ok: false,
        error: 'Profile Embed HTMLからgraphql_mediaを取得できませんでした。',
        account: { username: target.username, profileUrl: target.profileUrl },
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

    res.status(200).json({
      ok: true,
      source: 'instagram',
      account: { username: target.username, profileUrl: target.profileUrl },
      count: items.length,
      items,
      diagnostics: {
        htmlLength: html.length,
        parsedCount: parsed.items.length,
        parseMethod: parsed.parseMethod,
        decodedLevel: parsed.decodedLevel,
        arrayOccurrences: parsed.arrayOccurrences,
        parseErrors: parsed.parseErrors
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
