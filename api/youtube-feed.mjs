const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function apiKey() { return String(process.env.YOUTUBE_API_KEY || '').trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function yt(path, params) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('YOUTUBE_API_KEY がVercelに設定されていません'), { statusCode:500, code:'NO_API_KEY', reason:'keyMissing' });
  const url = new URL(`${API}/${path}`);
  Object.entries({ ...params, key }).forEach(([name,value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name,String(value));
  });

  let lastError;
  for (let attempt=0; attempt<2; attempt+=1) {
    try {
      const response = await fetch(url,{signal:AbortSignal.timeout(10000)});
      const data = await response.json().catch(()=>({}));
      if (response.ok) return data;
      const reason=data?.error?.errors?.[0]?.reason||data?.error?.status||'youtubeApiError';
      const error=Object.assign(new Error(data?.error?.message||`YouTube API ${response.status}`),{
        statusCode:response.status,code:'YOUTUBE_API',reason,apiData:data
      });
      lastError=error;
      if (attempt===0 && [403,429,500,502,503,504].includes(response.status)) { await sleep(350); continue; }
      throw error;
    } catch(error) {
      lastError=error;
      if (attempt===0 && (error?.name==='TimeoutError'||error?.name==='AbortError')) { await sleep(250); continue; }
      throw error;
    }
  }
  throw lastError || new Error('YouTube API error');
}

function norm(input) {
  const value=String(input||'').trim();
  try {
    if(/^https?:\/\//i.test(value)) {
      const url=new URL(value);
      const parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]?.startsWith('@')) return parts[0];
      if(parts[0]==='channel'&&parts[1]) return parts[1];
      return parts[0]||'';
    }
  } catch {}
  return value;
}

async function resolveChannel(input) {
  const query=norm(input);
  if(EXACT_CHANNEL_ID.test(query)) return (await yt('channels',{part:'snippet,contentDetails',id:query})).items?.[0]||null;
  const handle=query.replace(/^@/,'');
  let data=await yt('channels',{part:'snippet,contentDetails',forHandle:handle});
  if(data.items?.[0]) return data.items[0];
  data=await yt('search',{part:'snippet',type:'channel',q:query,maxResults:1});
  const id=data.items?.[0]?.snippet?.channelId||data.items?.[0]?.id?.channelId;
  if(!id) return null;
  return (await yt('channels',{part:'snippet,contentDetails',id})).items?.[0]||null;
}

async function publicChannelId(input) {
  const normalized=norm(input);
  if(EXACT_CHANNEL_ID.test(normalized)) return normalized;
  const handle=normalized.startsWith('@')?normalized:`@${normalized.replace(/^@/,'')}`;
  const response=await fetch(`https://www.youtube.com/${encodeURI(handle)}`,{
    headers:{
      'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
      'Accept':'text/html,application/xhtml+xml',
      'Accept-Language':'ja,en-US;q=0.7,en;q=0.5'
    },
    signal:AbortSignal.timeout(6500)
  });
  if(!response.ok) throw new Error(`YouTube page ${response.status}`);
  const html=await response.text();
  const patterns=[
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /itemprop="channelId"\s+content="(UC[A-Za-z0-9_-]{22})"/,
    /\/channel\/(UC[A-Za-z0-9_-]{22})/
  ];
  for(const pattern of patterns) {
    const id=html.match(pattern)?.[1];
    if(id) return id;
  }
  return '';
}

function durationSeconds(iso='') {
  const match=String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return match?Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0):0;
}

function classify(video) {
  const details=video?.liveStreamingDetails;
  const broadcast=video?.snippet?.liveBroadcastContent;
  if(details?.actualEndTime) return {kind:'live',liveType:'archive'};
  if(details?.actualStartTime||broadcast==='live') return {kind:'live',liveType:'live'};
  if(details?.scheduledStartTime||broadcast==='upcoming') return {kind:'live',liveType:'upcoming'};
  if(details) return {kind:'live',liveType:'archive'};
  return {kind:durationSeconds(video?.contentDetails?.duration)<=60?'short':'long',liveType:''};
}

async function dataApiSnapshot(input) {
  const channel=await resolveChannel(input);
  if(!channel) throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'),{statusCode:404,reason:'channelNotFound'});
  const uploads=channel.contentDetails?.relatedPlaylists?.uploads;
  if(!uploads) throw Object.assign(new Error('アップロード一覧を取得できませんでした'),{statusCode:502,reason:'uploadsPlaylistMissing'});
  const playlist=await yt('playlistItems',{part:'snippet,contentDetails',playlistId:uploads,maxResults:40});
  const ids=(playlist.items||[]).map(item=>item.contentDetails?.videoId).filter(Boolean);
  if(!ids.length) return {channel:{id:channel.id,name:channel.snippet?.title||''},items:[]};
  const details=await yt('videos',{part:'snippet,contentDetails,liveStreamingDetails',id:ids.join(',')});
  const byId=new Map((details.items||[]).map(video=>[video.id,video]));
  const items=ids.map(id=>byId.get(id)).filter(Boolean).map(video=>{
    const c=classify(video);
    return {
      videoId:video.id,title:video.snippet?.title||'無題',channelName:video.snippet?.channelTitle||channel.snippet?.title||'',
      publishedAt:video.snippet?.publishedAt||'',thumbnail:video.snippet?.thumbnails?.medium?.url||video.snippet?.thumbnails?.high?.url||'',
      durationSeconds:durationSeconds(video.contentDetails?.duration),kind:c.kind,liveType:c.liveType,
      url:`https://www.youtube.com/watch?v=${video.id}`
    };
  });
  return {channel:{id:channel.id,name:channel.snippet?.title||''},items};
}

async function atomFallback(channelId) {
  const url=`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 AppleWebKit/605.1.15 Safari/604.1','Accept':'application/atom+xml,application/xml,text/xml,*/*;q=.2'},signal:AbortSignal.timeout(8500)});
  if(!response.ok) throw new Error(`YouTube Atom ${response.status}`);
  const xml=await response.text();
  const entries=[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match=>match[1]);
  const channelName=(xml.match(/<title>([^<]+)<\/title>/)?.[1]||'').replace(/&amp;/g,'&');
  const items=entries.map(block=>{
    const id=block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]||'';
    const title=block.match(/<title>([\s\S]*?)<\/title>/)?.[1]||'無題';
    const publishedAt=block.match(/<published>([^<]+)<\/published>/)?.[1]||'';
    return {videoId:id,title:title.replace(/&amp;/g,'&'),channelName,publishedAt,thumbnail:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`,durationSeconds:null,kind:'long',liveType:'',url:`https://www.youtube.com/watch?v=${id}`};
  }).filter(item=>item.videoId);
  return {channel:{id:channelId,name:channelName},items,source:'atom'};
}

export default async function handler(req,res) {
  const input=String(req.query?.channel||'').trim();
  if(!input) return res.status(400).json({ok:false,error:'channel を指定してください。'});
  try {
    const data=await dataApiSnapshot(input);
    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({ok:true,source:'data-api',...data});
  } catch(err) {
    let fallbackId='';
    try { fallbackId=await publicChannelId(input); } catch {}
    if(fallbackId) {
      try {
        const fallback=await atomFallback(fallbackId);
        return res.status(200).json({
          ok:true,...fallback,
          warning:'YouTube Data APIが一時利用できないため公開フィードで表示しています。',
          apiReason:err?.reason||err?.code||'',apiError:err?.message||''
        });
      } catch {}
    }
    console.error('[youtube-feed:v2160]',err);
    return res.status(err?.statusCode||500).json({
      ok:false,error:'YouTube情報を現在取得できません。保存済み一覧があればそちらを表示します。',
      reason:err?.reason||err?.code||'',detail:err?.apiData?.error?.message||err?.message||''
    });
  }
}
