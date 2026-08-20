import { Readable } from 'node:stream';

const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 12_000;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function allowedTwitterVideoUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.port) return null;

    const host = url.hostname.toLowerCase();
    if (host !== 'video.twimg.com' && !host.endsWith('.video.twimg.com')) return null;
    return url;
  } catch {
    return null;
  }
}

function requestHeaders(req, { probe = false } = {}) {
  const range = probe ? 'bytes=0-2047' : String(req.headers?.range || '').trim();
  const headers = {
    'User-Agent': String(req.headers?.['user-agent'] || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'),
    'Accept': String(req.headers?.accept || '*/*'),
    'Accept-Language': String(req.headers?.['accept-language'] || 'ja,en-US;q=0.8,en;q=0.6'),
    'Accept-Encoding': 'identity',
    // ブラウザー直読みでは付けられない「X側からの取得」に近い形にする。
    'Referer': 'https://x.com/',
    'Origin': 'https://x.com'
  };
  if (range) headers.Range = range;
  return headers;
}

async function fetchAllowed(inputUrl, init = {}) {
  let current = allowedTwitterVideoUrl(inputUrl);
  if (!current) throw new Error('Only video.twimg.com HTTPS URLs are allowed');

  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch {}
    if (!location) throw new Error(`Twitter CDN redirect ${response.status} had no location`);

    const next = allowedTwitterVideoUrl(new URL(location, current).href);
    if (!next) throw new Error('Twitter CDN redirected outside the allowed video host');
    current = next;
  }

  throw new Error('Too many Twitter CDN redirects');
}

function isPlaylist(contentType, url) {
  return /mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '') || /\.m3u8(?:$|\?)/i.test(url.href);
}

function proxyPath(url) {
  return `/api/twitter-video-proxy?url=${encodeURIComponent(url.href)}`;
}

function rewritePlaylist(text, baseUrl) {
  const rewriteUri = raw => {
    try {
      if (!raw || /^(?:data:|blob:)/i.test(raw)) return raw;
      const absolute = allowedTwitterVideoUrl(new URL(raw, baseUrl).href);
      return absolute ? proxyPath(absolute) : raw;
    } catch {
      return raw;
    }
  };

  return String(text || '')
    .split(/\r?\n/)
    .map(line => {
      if (!line) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, raw) => `URI="${rewriteUri(raw)}"`);
      }
      return rewriteUri(line.trim());
    })
    .join('\n');
}

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Method Not Allowed');
  }

  setCommonHeaders(res);

  const target = allowedTwitterVideoUrl(first(req.query?.url));
  if (!target) return res.status(400).json({ ok: false, error: 'Invalid Twitter video URL' });

  const probe = String(first(req.query?.probe) || '') === '1';

  try {
    const { response: upstream, finalUrl } = await fetchAllowed(target, {
      method: 'GET',
      headers: requestHeaders(req, { probe })
    });

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const ok = upstream.status >= 200 && upstream.status < 400;

    if (probe) {
      try { await upstream.body?.cancel(); } catch {}
      return res.status(ok ? 200 : 502).json({
        ok,
        upstreamStatus: upstream.status,
        contentType,
        range: upstream.headers.get('accept-ranges') || '',
        finalHost: finalUrl.hostname
      });
    }

    if (!ok) {
      try { await upstream.body?.cancel(); } catch {}
      return res.status(upstream.status === 404 ? 404 : 502).send(`Twitter video upstream error: ${upstream.status}`);
    }

    if (isPlaylist(contentType, finalUrl)) {
      const playlist = rewritePlaylist(await upstream.text(), finalUrl);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(playlist));
      return res.end(playlist);
    }

    res.statusCode = upstream.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Content-Disposition', 'inline');

    if (req.method === 'HEAD' || !upstream.body) {
      try { await upstream.body?.cancel(); } catch {}
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);
    req.on?.('aborted', () => body.destroy());
    res.on?.('close', () => {
      if (!res.writableEnded) body.destroy();
    });
    body.on('error', err => {
      console.error('[twitter-video-proxy stream]', err);
      if (!res.headersSent) res.status(502).end('Twitter video stream failed');
      else res.destroy?.(err);
    });
    return body.pipe(res);
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Twitter video upstream timeout' : (error?.message || 'Twitter video proxy failed');
    console.error('[twitter-video-proxy]', message);
    if (!res.headersSent) return res.status(502).json({ ok: false, error: message });
    return res.end();
  }
}
