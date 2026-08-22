const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const DETAIL_LIMIT = 18;
const STRICT_PROBE_LIMIT = 18;
const SHORTS_PROBE_CONCURRENCY = 6;
const SHORTS_PROBE_TTL_MS = 12 * 60 * 60 * 1000;
const SHORTS_PROBE_CACHE_MAX = 500;
const shortsProbeCache = new Map();

function apiKey() { return String(process.env.YOUTUBE_API_KEY || '').trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function apiReason(data = {}) { return String(data?.error?.errors?.[0]?.reason || data?.error?.status || 'youtubeApiError'); }
function quotaLike(reason = '', status = 0) {
  return Number(status) === 429 || /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason));
}
function transient(status = 0, reason = '') {
  return [408,425,429,500,502,503,504].includes(Number(status)) || /backendError|internalError|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason));
}

async function yt(path, params) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('YOUTUBE_API_KEY がVercelに設定されていません'), { statusCode: 500, code: 'NO_API_KEY', reason: 'keyMissing' });
  const url = new URL(`${API}/${path}`);
  Object.entries({ ...params, key }).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  });

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      const reason = apiReason(data);
      const error = Object.assign(new Error(data?.error?.message || `YouTube API ${response.status}`), {
        statusCode: response.status,
        code: quotaLike(reason, response.status) ? 'YOUTUBE_QUOTA' : 'YOUTUBE_API',
        reason,
        apiData: data
      });
      lastError = error;
      if (attempt === 0 && transient(response.status, reason) && !/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
        await sleep(250);
        continue;
      }
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /fetch failed|network/i.test(String(error?.message || '')))) {
        await sleep(180);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('YouTube API error');
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

  // search.list has a much larger quota cost; only use it when a saved value is not a handle/channel id.
  data = await yt('search', { part: 'snippet', type: 'channel', q: query, maxResults: 1 });
  const id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId;
  if (!id) return null;
  return (await yt('channels', { part: 'snippet,contentDetails', id })).items?.[0] || null;
}

function durationSeconds(iso = '') {
  const match = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
}

function liveClassification(video) {
  const details = video?.liveStreamingDetails;
  if (!details) return null;
  if (details.actualEndTime) return { kind: 'live', liveType: 'archive', method: 'liveStreamingDetails' };
  if (details.actualStartTime) return { kind: 'live', liveType: 'live', method: 'liveStreamingDetails' };
  if (details.scheduledStartTime) return { kind: 'live', liveType: 'upcoming', method: 'liveStreamingDetails' };
  return { kind: 'live', liveType: 'archive', method: 'liveStreamingDetails' };
}

function cacheProbe(videoId, value) {
  shortsProbeCache.delete(videoId);
  shortsProbeCache.set(videoId, { at: Date.now(), value });
  while (shortsProbeCache.size > SHORTS_PROBE_CACHE_MAX) shortsProbeCache.delete(shortsProbeCache.keys().next().value);
}

async function shortsRequest(videoId, method = 'HEAD') {
  const response = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`, {
    method,
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
      'Accept': method === 'HEAD' ? '*/*' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en-US;q=0.7,en;q=0.5'
    },
    signal: AbortSignal.timeout(method === 'HEAD' ? 1_200 : 1_700)
  });
  try { await response.body?.cancel?.(); } catch {}
  return response.status;
}

async function probeShorts(videoId) {
  const cached = shortsProbeCache.get(videoId);
  if (cached && Date.now() - cached.at < SHORTS_PROBE_TTL_MS) return cached.value;

  let status = 0;
  let errorMessage = '';
  try {
    status = await shortsRequest(videoId, 'HEAD');
    if ([403,405,501].includes(status)) status = await shortsRequest(videoId, 'GET');
  } catch (error) {
    errorMessage = String(error?.message || error);
  }

  if (status === 200) {
    const value = { kind: 'short', liveType: '', method: 'shorts-url-200', status };
    cacheProbe(videoId, value);
    return value;
  }
  if (status >= 300 && status < 400) {
    const value = { kind: 'long', liveType: '', method: 'shorts-url-redirect', status };
    cacheProbe(videoId, value);
    return value;
  }
  return { kind: 'unknown', liveType: '', method: 'shorts-url-unresolved', status, error: errorMessage || `HTTP ${status || 'error'}` };
}

async function mapConcurrent(values, limit, worker) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      try { result[index] = await worker(values[index], index); }
      catch (error) { result[index] = { kind: 'unknown', liveType: '', method: 'probe-error', status: 0, error: String(error?.message || error) }; }
    }
  });
  await Promise.all(workers);
  return result;
}

async function classifyVideos(videos) {
  const classifications = new Map();
  const nonLive = [];
  for (const video of videos) {
    const live = liveClassification(video);
    if (live) classifications.set(video.id, live);
    else if (nonLive.length < STRICT_PROBE_LIMIT) nonLive.push(video);
    else classifications.set(video.id, { kind: 'unknown', liveType: '', method: 'probe-budget' });
  }
  const results = await mapConcurrent(nonLive, SHORTS_PROBE_CONCURRENCY, video => probeShorts(video.id));
  nonLive.forEach((video, index) => classifications.set(video.id, results[index]));
  return classifications;
}

async function dataApiSnapshot(input) {
  const startedAt = Date.now();
  const channel = await resolveChannel(input);
  if (!channel) throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'), { statusCode: 404, reason: 'channelNotFound' });
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw Object.assign(new Error('アップロード一覧を取得できませんでした'), { statusCode: 502, reason: 'uploadsPlaylistMissing' });

  const playlist = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: DETAIL_LIMIT });
  const ids = (playlist.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return { channel: { id: channel.id, name: channel.snippet?.title || '' }, items: [], classificationWarnings: [], serverTimingMs: Date.now() - startedAt };

  // Required classification source: videos.list with snippet,contentDetails,liveStreamingDetails.
  const detailData = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(',') });
  const videos = detailData.items || [];
  const byId = new Map(videos.map(video => [video.id, video]));
  const classifications = await classifyVideos(ids.map(id => byId.get(id)).filter(Boolean));
  const warnings = [];

  const items = ids.map(id => {
    const video = byId.get(id);
    if (!video) return null;
    const c = classifications.get(id) || { kind: 'unknown', liveType: '', method: 'missing-classification' };
    if (c.kind === 'unknown') warnings.push(`${video.snippet?.title || id}: 厳密分類を完了できませんでした`);
    return {
      videoId: video.id,
      title: video.snippet?.title || '無題',
      channelName: video.snippet?.channelTitle || channel.snippet?.title || '',
      publishedAt: video.snippet?.publishedAt || '',
      thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.high?.url || '',
      durationSeconds: durationSeconds(video.contentDetails?.duration),
      kind: c.kind,
      liveType: c.liveType,
      classificationMethod: c.method,
      classificationStatus: c.status || 0,
      url: c.kind === 'short' ? `https://www.youtube.com/shorts/${video.id}` : `https://www.youtube.com/watch?v=${video.id}`
    };
  }).filter(Boolean);

  return {
    channel: { id: channel.id, name: channel.snippet?.title || '' },
    items,
    classificationWarnings: warnings.slice(0, 8),
    classificationComplete: warnings.length === 0,
    serverTimingMs: Date.now() - startedAt
  };
}

export default async function handler(req, res) {
  const input = String(req.query?.channel || '').trim();
  if (!input) return res.status(400).json({ ok: false, error: 'channel を指定してください。' });
  try {
    const data = await dataApiSnapshot(input);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    res.setHeader('Server-Timing', `youtube;dur=${Number(data.serverTimingMs || 0)}`);
    return res.status(200).json({ ok: true, source: 'data-api-v2184', ...data });
  } catch (error) {
    console.error('[youtube-feed:v2184]', error);
    const isQuota = error?.code === 'YOUTUBE_QUOTA' || quotaLike(error?.reason, error?.statusCode);
    return res.status(isQuota ? 429 : (error?.statusCode || 500)).json({
      ok: false,
      error: isQuota
        ? 'YouTube Data APIのクォータ上限のため更新できません。保存済み一覧があればそちらを表示します。'
        : 'YouTube情報を現在取得できません。保存済み一覧があればそちらを表示します。',
      reason: error?.reason || error?.code || '',
      detail: error?.apiData?.error?.message || error?.message || '',
      retryable: !isQuota
    });
  }
}
