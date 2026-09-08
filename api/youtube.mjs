import youtubeFeed from '../server/youtube-feed.mjs';
import youtubeDiscovery from '../server/youtube-discovery.mjs';

const CHANNEL_ID=/^UC[A-Za-z0-9_-]{22}$/;

async function channelMeta(req,res){
  const ids=[...new Set(String(req.query?.ids||'').split(',').map(value=>value.trim()).filter(value=>CHANNEL_ID.test(value)))].slice(0,50);
  if(!ids.length)return res.status(200).json({ok:true,items:[]});
  const key=String(process.env.YOUTUBE_API_KEY||'').trim();
  if(!key)return res.status(500).json({ok:false,error:'YOUTUBE_API_KEY がVercelに設定されていません'});
  const url=new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part','snippet');
  url.searchParams.set('id',ids.join(','));
  url.searchParams.set('key',key);
  const response=await fetch(url,{signal:AbortSignal.timeout(6500)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return res.status(response.status).json({ok:false,error:data?.error?.message||`YouTube API ${response.status}`});
  const items=(data.items||[]).map(channel=>({
    id:channel.id,
    name:channel.snippet?.title||'',
    avatar:channel.snippet?.thumbnails?.high?.url||channel.snippet?.thumbnails?.medium?.url||channel.snippet?.thumbnails?.default?.url||''
  }));
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ok:true,items});
}

export default async function handler(req, res) {
  try {
    const action=String(req.query?.action||req.body?.action||'').trim();
    if(action==='channel-meta')return await channelMeta(req,res);
    if(action) return await youtubeDiscovery(req,res);
    return await youtubeFeed(req, res);
  } catch (error) {
    console.error('[api-youtube-router]', { name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
