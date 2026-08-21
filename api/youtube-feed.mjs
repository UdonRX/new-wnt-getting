const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function apiKey() { return String(process.env.YOUTUBE_API_KEY || '').trim(); }

async function yt(path, params) {
  const key = apiKey();
  if (!key) {
    const error = new Error('YOUTUBE_API_KEY がVercelに設定されていません');
    error.statusCode = 500;
    error.code = 'NO_API_KEY';
    error.reason = 'keyMissing';
    throw error;
  }
  const url = new URL(`${API}/${path}`);
  Object.entries({ ...params, key }).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || 'youtubeApiError';
    const error = new Error(data?.error?.message || `YouTube API ${response.status}`);
    error.statusCode = response.status;
    error.code = 'YOUTUBE_API';
    error.reason = reason;
    error.apiData = data;
    throw error;
  }
  return data;
}

function norm(input) {
  const value = String(input || '').trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0]?.startsWith('@')) return parts[0];
      if (parts[0] === 'channel' && parts[1]) return parts[1];
      return parts[0] || '';
    }
  } catch {}
  return value;
}

async function resolveChannel(input) {
  const query = norm(input);
  if (EXACT_CHANNEL_ID.test(query)) {
    return (await yt('channels', { part: 'snippet,contentDetails', id: query })).items?.[0] || null;
  }
  const handle = query.replace(/^@/, '');
  let data = await yt('channels', { part: 'snippet,contentDetails', forHandle: handle });
  if (data.items?.[0]) return data.items[0];
  data = await yt('search', { part: 'snippet', type: 'channel', q: query, maxResults: 1 });
  const id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId;
  if (!id) return null;
  return (await yt('channels', { part: 'snippet,contentDetails', id })).items?.[0] || null;
}

function durationSeconds(iso = '') {
  const match = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
}

function classify(video) {
  const details = video?.liveStreamingDetails;
  const broadcast = video?.snippet?.liveBroadcastContent;

  // LIVE系はduration判定より必ず先に隔離する。
  if (details?.actualEndTime) return { kind: 'live', liveType: 'archive' };
  if (details?.actualStartTime || broadcast === 'live') return { kind: 'live', liveType: 'live' };
  if (details?.scheduledStartTime || broadcast === 'upcoming') return { kind: 'live', liveType: 'upcoming' };
  // liveStreamingDetails自体がある動画はShortsへ落とさない。
  if (details) return { kind: 'live', liveType: 'archive' };

  return {
    kind: durationSeconds(video?.contentDetails?.duration) <= 60 ? 'short' : 'long',
    liveType: ''
  };
}

async function dataApiSnapshot(input) {
  const channel = await resolveChannel(input);
  if (!channel) throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'), { statusCode: 404, reason: 'channelNotFound' });
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw Object.assign(new Error('アップロード一覧を取得できませんでした'), { statusCode: 502, reason: 'uploadsPlaylistMissing' });

  const playlist = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 40 });
  const ids = (playlist.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return { channel: { id: channel.id, name: channel.snippet?.title || '' }, items: [] };

  const details = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(',') });
  const byId = new Map((details.items || []).map(video => [video.id, video]));
  const items = ids.map(id => byId.get(id)).filter(Boolean).map(video => {
    const classification = classify(video);
    return {
      videoId: video.id,
      title: video.snippet?.title || '無題',
      channelName: video.snippet?.channelTitle || channel.snippet?.title || '',
      publishedAt: video.snippet?.publishedAt || '',
      thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.high?.url || '',
      durationSeconds: durationSeconds(video.contentDetails?.duration),
      kind: classification.kind,
      liveType: classification.liveType,
      url: `https://www.youtube.com/watch?v=${video.id}`
    };
  });
  return { channel: { id: channel.id, name: channel.snippet?.title || '' }, items };
}

async function atomFallback(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`YouTube Atom ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[1]);
  const channelName = (xml.match(/<title>([^<]+)<\/title>/)?.[1] || '').replace(/&amp;/g, '&');
  const items = entries.map(block => {
    const id = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || '';
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '無題';
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1] || '';
    return {
      videoId: id,
      title: title.replace(/&amp;/g, '&'),
      channelName,
      publishedAt,
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      durationSeconds: null,
      kind: 'long',
      liveType: '',
      url: `https://www.youtube.com/watch?v=${id}`
    };
  }).filter(item => item.videoId);
  return { channel: { id: channelId, name: channelName }, items, source: 'atom' };
}

export default async function handler(req, res) {
  const input = String(req.query?.channel || '').trim();
  if (!input) return res.status(400).json({ ok: false, error: 'channel を指定してください。' });
  try {
    const data = await dataApiSnapshot(input);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, source: 'data-api', ...data });
  } catch (err) {
    const normalized = norm(input);
    if (EXACT_CHANNEL_ID.test(normalized)) {
      try {
        const fallback = await atomFallback(normalized);
        return res.status(200).json({
          ok: true,
          ...fallback,
          warning: 'YouTube Data APIを利用できなかったため公開Atom feedで表示しています。',
          apiReason: err?.reason || err?.code || '',
          apiError: err?.message || ''
        });
      } catch {}
    }
    console.error('[youtube-feed]', err);
    return res.status(err?.statusCode || 500).json({
      ok: false,
      error: err?.message || 'YouTube情報の取得に失敗しました。',
      reason: err?.reason || err?.code || '',
      detail: err?.apiData?.error?.message || ''
    });
  }
}
