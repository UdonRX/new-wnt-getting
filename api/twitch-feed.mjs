import { getTwitchChannelSnapshot, normalizeTwitchLogin } from '../lib/twitch.mjs';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRss(snapshot, origin) {
  const name = snapshot.broadcaster.displayName;
  const items = [];
  if (snapshot.live.isLive) {
    items.push(`
      <item>
        <title>${esc(`[LIVE] ${snapshot.live.title}`)}</title>
        <link>${esc(snapshot.live.url)}</link>
        <guid isPermaLink="false">${esc(`live:${snapshot.broadcaster.id}:${snapshot.live.startedAt}`)}</guid>
        <pubDate>${esc(new Date(snapshot.live.startedAt || Date.now()).toUTCString())}</pubDate>
        <description>${esc(`${name} は配信中です${snapshot.live.gameName ? ` / ${snapshot.live.gameName}` : ''}`)}</description>
        <category>LIVE</category>
        <twitch:streamer>${esc(name)}</twitch:streamer>
        <twitch:login>${esc(snapshot.broadcaster.login)}</twitch:login>
        <twitch:status>live</twitch:status>
      </item>`);
  }
  snapshot.archives.forEach(video => {
    items.push(`
      <item>
        <title>${esc(video.title)}</title>
        <link>${esc(video.url)}</link>
        <guid isPermaLink="false">${esc(`archive:${video.id}`)}</guid>
        <pubDate>${esc(new Date(video.createdAt || Date.now()).toUTCString())}</pubDate>
        <description>${esc(`${name} / Twitchアーカイブ${video.duration ? ` / ${video.duration}` : ''}`)}</description>
        <category>ARCHIVE</category>
        <twitch:streamer>${esc(name)}</twitch:streamer>
        <twitch:login>${esc(snapshot.broadcaster.login)}</twitch:login>
        <twitch:status>archive</twitch:status>
      </item>`);
  });
  const selfUrl = `${origin}/api/twitch-feed?channel=${encodeURIComponent(snapshot.broadcaster.login)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:twitch="https://www.twitch.tv/">
  <channel>
    <title>${esc(`Twitch - ${name}`)}</title>
    <link>${esc(snapshot.broadcaster.channelUrl)}</link>
    <description>${esc(`${name} の配信状況とアーカイブ`)}</description>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />
    ${items.join('\n')}
  </channel>
</rss>`;
}

function parseChannels(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed; } catch {}
  return raw.split(',').map(row => row.trim()).filter(Boolean);
}

async function batchSnapshots(inputs, { force = false } = {}) {
  const unique = [];
  const seen = new Set();
  for (const input of inputs) {
    const raw = typeof input === 'object' ? String(input?.value || input?.url || input?.name || '') : String(input || '');
    const login = normalizeTwitchLogin(raw);
    const key = login || raw.toLowerCase();
    if (!raw || seen.has(key)) continue;
    seen.add(key);
    unique.push({ input: raw, login });
    if (unique.length >= 24) break;
  }

  const results = [];
  for (const row of unique) {
    try {
      const snapshot = await getTwitchChannelSnapshot(row.input, { archiveLimit: 50, force, allowStale: true });
      results.push({ input: row.input, login: row.login || snapshot?.broadcaster?.login || '', ok: true, snapshot });
    } catch (error) {
      results.push({
        input: row.input, login: row.login || '', ok: false,
        status: Number(error?.statusCode) || 500,
        code: String(error?.code || ''),
        error: String(error?.message || 'Twitch情報の取得に失敗しました。')
      });
    }
  }
  return results;
}

export default async function handler(req, res) {
  try {
    if (String(req.query?.mode || '') === 'config') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        twitchClientId: String(process.env.TWITCH_CLIENT_ID || ''),
        twitchConfigured: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
        youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
      });
    }

    const format = String(req.query?.format || '').toLowerCase();
    const force = String(req.query?.force || '') === '1';
    const channels = parseChannels(req.query?.channels);
    if (channels.length) {
      const results = await batchSnapshots(channels, { force });
      const okCount = results.filter(row => row.ok).length;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: okCount > 0, okCount, total: results.length, results });
    }

    const channel = String(req.query?.channel || '').trim();
    if (!channel) return res.status(400).json({ ok: false, error: 'channel または channels を指定してください。' });
    const snapshot = await getTwitchChannelSnapshot(channel, { archiveLimit: 50, force, allowStale: true });

    if (format === 'json' || String(req.headers.accept || '').includes('application/json')) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...snapshot });
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || 'localhost';
    const origin = `${proto}://${host}`;
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).send(toRss(snapshot, origin));
  } catch (err) {
    console.error('[twitch-feed-v2195]', err);
    return res.status(err?.statusCode || 500).json({ ok: false, code: String(err?.code || ''), error: err?.message || 'Twitch情報の取得に失敗しました。' });
  }
}
