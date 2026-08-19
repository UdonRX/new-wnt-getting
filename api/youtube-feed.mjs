const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function apiKey() { return String(process.env.YOUTUBE_API_KEY || '').trim(); }

async function yt(path, params) {
  const key = apiKey();
  if (!key) {
    const e = new Error('YOUTUBE_API_KEY がVercelに設定されていません');
    e.statusCode = 500; e.code = 'NO_API_KEY'; e.reason = 'keyMissing';
    throw e;
  }
  const url = new URL(`${API}/${path}`);
  Object.entries({ ...params, key }).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || 'youtubeApiError';
    const e = new Error(data?.error?.message || `YouTube API ${response.status}`);
    e.statusCode = response.status; e.code = 'YOUTUBE_API'; e.reason = reason; e.apiData = data;
    throw e;
  }
  return data;
}

function norm(input) {
  let s = String(input || '').trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0]?.startsWith('@')) return parts[0];
      if (parts[0] === 'channel' && parts[1]) return parts[1];
      return parts[0] || '';
    }
  } catch {}
  return s;
}

async function resolveChannel(input) {
  const q = norm(input);
  if (EXACT_CHANNEL_ID.test(q)) {
    return (await yt('channels', { part: 'snippet,contentDetails', id: q })).items?.[0] || null;
  }
  const handle = q.replace(/^@/, '');
  let d = await yt('channels', { part: 'snippet,contentDetails', forHandle: handle });
  if (d.items?.[0]) return d.items[0];
  d = await yt('search', { part: 'snippet', type: 'channel', q, maxResults: 1 });
  const id = d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId;
  if (!id) return null;
  return (await yt('channels', { part: 'snippet,contentDetails', id })).items?.[0] || null;
}

function durationSeconds(iso = '') {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

function classify(video) {
  const live = video?.snippet?.liveBroadcastContent === 'live' || video?.liveStreamingDetails?.actualStartTime;
  if (live) return 'live';
  return durationSeconds(video?.contentDetails?.duration) <= 60 ? 'short' : 'long';
}

async function dataApiSnapshot(input) {
  const channel = await resolveChannel(input);
  if (!channel) throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'), { statusCode: 404, reason: 'channelNotFound' });
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw Object.assign(new Error('アップロード一覧を取得できませんでした'), { statusCode: 502, reason: 'uploadsPlaylistMissing' });
  const playlist = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 40 });
  const ids = (playlist.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return { channel: { id: channel.id, name: channel.snippet?.title || '' }, items: [] };
  const details = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(',') });
  const byId = new Map((details.items || []).map(v => [v.id, v]));
  const items = ids.map(id => byId.get(id)).filter(Boolean).map(v => ({
    videoId: v.id,
    title: v.snippet?.title || '無題',
    channelName: v.snippet?.channelTitle || channel.snippet?.title || '',
    publishedAt: v.snippet?.publishedAt || '',
    thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.high?.url || '',
    durationSeconds: durationSeconds(v.contentDetails?.duration),
    kind: classify(v),
    url: `https://www.youtube.com/watch?v=${v.id}`
  }));
  return { channel: { id: channel.id, name: channel.snippet?.title || '' }, items };
}

function xmlText(node, name) { return node.getElementsByTagName(name)?.[0]?.textContent?.trim() || ''; }

async function atomFallback(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`YouTube Atom ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const channelName = (xml.match(/<title>([^<]+)<\/title>/)?.[1] || '').replace(/&amp;/g, '&');
  const items = entries.map(block => {
    const id = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || '';
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '無題';
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1] || '';
    return { videoId:id, title:title.replace(/&amp;/g,'&'), channelName, publishedAt, thumbnail:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, durationSeconds:null, kind:'long', url:`https://www.youtube.com/watch?v=${id}` };
  }).filter(i => i.videoId);
  return { channel: { id: channelId, name: channelName }, items, source:'atom' };
}

export default async function handler(req, res) {
  const input = String(req.query?.channel || '').trim();
  if (!input) return res.status(400).json({ ok:false, error:'channel を指定してください。' });
  try {
    const data = await dataApiSnapshot(input);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ ok:true, source:'data-api', ...data });
  } catch (err) {
    const normalized = norm(input);
    if (EXACT_CHANNEL_ID.test(normalized)) {
      try {
        const fallback = await atomFallback(normalized);
        return res.status(200).json({ ok:true, ...fallback, warning:'YouTube Data APIを利用できなかったため公開Atom feedで表示しています。', apiReason:err?.reason || err?.code || '', apiError:err?.message || '' });
      } catch {}
    }
    console.error('[youtube-feed]', err);
    return res.status(err?.statusCode || 500).json({ ok:false, error:err?.message || 'YouTube情報の取得に失敗しました。', reason:err?.reason || err?.code || '', detail:err?.apiData?.error?.message || '' });
  }
}
