import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';

const RSS_MAX_BYTES = 2 * 1024 * 1024;
const RSS_REDIRECTS = 5;
const VIDEO_REDIRECTS = 4;
const VIDEO_TIMEOUT_MS = 12_000;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function privateIp(address) {
  const family = net.isIP(address);
  if (!family) return true;

  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    return a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }

  const value = address.toLowerCase();
  return value === '::1' ||
    value === '::' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('ff') ||
    value.startsWith('2001:db8:');
}

async function safeRssUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URLが許可されていません');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('ポートが許可されていません');
  }

  const host = url.hostname.replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('ローカルURLは取得できません');
  }

  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error('非公開IPは取得できません');
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => privateIp(item.address))) {
      throw new Error('安全な公開アドレスではありません');
    }
  }

  return url;
}

async function readRss(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > RSS_MAX_BYTES) throw new Error('RSSが大きすぎます');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > RSS_MAX_BYTES) throw new Error('RSSが大きすぎます');
  return buffer;
}

async function handleRss(req, res) {
  try {
    const requested = Number(first(req.query?.timeout) || 12000);
    const timeoutMs = Math.max(
      3000,
      Math.min(12000, Number.isFinite(requested) ? requested : 12000)
    );

    let url = await safeRssUrl(String(first(req.query?.url) || ''));

    for (let index = 0; index <= RSS_REDIRECTS; index += 1) {
      const response = await fetch(url, {
        redirect: 'manual',
        headers: {
          Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=.2',
          'User-Agent': 'PersonalDashboardV2/2.14.14'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (index >= RSS_REDIRECTS) throw new Error('リダイレクトが多すぎます');
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch {}
        if (!location) throw new Error('リダイレクト先なし');
        url = await safeRssUrl(new URL(location, url).href);
        continue;
      }

      if (!response.ok) {
        try { await response.body?.cancel(); } catch {}
        throw new Error(`RSS取得エラー (${response.status})`);
      }

      const body = await readRss(response);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).send(body);
    }

    throw new Error('RSS取得失敗');
  } catch (error) {
    return res.status(502).send(error?.message || 'RSS取得エラー');
  }
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

function twitterVideoHeaders(req, { probe = false } = {}) {
  const range = probe ? 'bytes=0-2047' : String(req.headers?.range || '').trim();
  const headers = {
    'User-Agent': String(
      req.headers?.['user-agent'] ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
    ),
    Accept: String(req.headers?.accept || '*/*'),
    'Accept-Language': String(req.headers?.['accept-language'] || 'ja,en-US;q=0.8,en;q=0.6'),
    'Accept-Encoding': 'identity',
    Referer: 'https://x.com/',
    Origin: 'https://x.com'
  };
  if (range) headers.Range = range;
  return headers;
}

async function fetchTwitterVideo(inputUrl, init = {}) {
  let current = allowedTwitterVideoUrl(inputUrl);
  if (!current) throw new Error('Only video.twimg.com HTTPS URLs are allowed');

  for (let count = 0; count <= VIDEO_REDIRECTS; count += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);
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

function isHlsPlaylist(contentType, url) {
  return /mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '') ||
    /\.m3u8(?:$|\?)/i.test(url.href);
}

function twitterVideoProxyPath(url) {
  const params = new URLSearchParams({
    mode: 'twitter-video',
    url: url.href
  });
  return `/api/rss?${params}`;
}

function rewriteHlsPlaylist(text, baseUrl) {
  const rewriteUri = raw => {
    try {
      if (!raw || /^(?:data:|blob:)/i.test(raw)) return raw;
      const absolute = allowedTwitterVideoUrl(new URL(raw, baseUrl).href);
      return absolute ? twitterVideoProxyPath(absolute) : raw;
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

function setVideoProxyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
}

async function handleTwitterVideo(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Method Not Allowed');
  }

  setVideoProxyHeaders(res);

  const target = allowedTwitterVideoUrl(first(req.query?.url));
  if (!target) {
    return res.status(400).json({ ok: false, error: 'Invalid Twitter video URL' });
  }

  const probe = String(first(req.query?.probe) || '') === '1';

  try {
    const { response: upstream, finalUrl } = await fetchTwitterVideo(target, {
      method: 'GET',
      headers: twitterVideoHeaders(req, { probe })
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
      return res
        .status(upstream.status === 404 ? 404 : 502)
        .send(`Twitter video upstream error: ${upstream.status}`);
    }

    if (isHlsPlaylist(contentType, finalUrl)) {
      const playlist = rewriteHlsPlaylist(await upstream.text(), finalUrl);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(playlist));
      return res.end(req.method === 'HEAD' ? undefined : playlist);
    }

    res.statusCode = upstream.status;
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified'
    ]) {
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
    body.on('error', error => {
      console.error('[rss twitter-video stream]', error);
      if (!res.headersSent) res.status(502).end('Twitter video stream failed');
      else res.destroy?.(error);
    });
    return body.pipe(res);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Twitter video upstream timeout'
      : (error?.message || 'Twitter video proxy failed');
    console.error('[rss twitter-video]', message);
    if (!res.headersSent) return res.status(502).json({ ok: false, error: message });
    return res.end();
  }
}

export default async function handler(req, res) {
  const mode = String(first(req.query?.mode) || '').trim();
  if (mode === 'twitter-video') {
    return handleTwitterVideo(req, res);
  }
  return handleRss(req, res);
}
