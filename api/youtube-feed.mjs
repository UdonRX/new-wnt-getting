const API='https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID=/^UC[A-Za-z0-9_-]{22}$/;

function apiKey(){ return String(process.env.YOUTUBE_API_KEY||'').trim(); }

async function yt(path,params){
  const k=apiKey();
  if(!k){const e=new Error('YOUTUBE_API_KEY がVercelに設定されていません');e.statusCode=500;e.code='NO_API_KEY';throw e;}
  const u=new URL(`${API}/${path}`);
  Object.entries({...params,key:k}).forEach(([name,value])=>{if(value!==undefined&&value!==null&&value!=='')u.searchParams.set(name,String(value));});
  const r=await fetch(u,{signal:AbortSignal.timeout(12000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d?.error?.message||`YouTube API ${r.status}`);e.statusCode=r.status;e.code='YOUTUBE_API';throw e;}
  return d;
}

function norm(input){
  let s=String(input||'').trim();
  try{
    if(/^https?:\/\//i.test(s)){
      const u=new URL(s);
      const parts=u.pathname.split('/').filter(Boolean);
      if(parts[0]?.startsWith('@'))return parts[0];
      if(parts[0]==='channel'&&parts[1])return parts[1];
      return parts[0]||'';
    }
  }catch{}
  return s;
}

async function resolveChannel(input){
  const q=norm(input);
  if(EXACT_CHANNEL_ID.test(q)){
    const d=await yt('channels',{part:'snippet,contentDetails',id:q});
    return d.items?.[0];
  }
  const handle=q.replace(/^@/,'');
  let d=await yt('channels',{part:'snippet,contentDetails',forHandle:handle});
  if(d.items?.[0])return d.items[0];
  d=await yt('search',{part:'snippet',type:'channel',q,maxResults:1});
  const id=d.items?.[0]?.snippet?.channelId||d.items?.[0]?.id?.channelId;
  if(!id)return null;
  return (await yt('channels',{part:'snippet,contentDetails',id})).items?.[0]||null;
}

function durationSeconds(iso=''){
  const m=String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m?(Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0)):0;
}

function classify(v){
  const text=`${v.snippet?.title||''} ${v.snippet?.description||''} ${(v.snippet?.tags||[]).join(' ')}`.toLowerCase();
  const premiere=/premiere|premiered|プレミア公開|プレミア配信/.test(text);
  const live=Boolean(v.liveStreamingDetails)&&!premiere;
  let liveType='';
  if(live){
    if(v.liveStreamingDetails?.actualEndTime)liveType='archive';
    else if(v.liveStreamingDetails?.actualStartTime)liveType='live';
    else liveType='upcoming';
  }
  const sec=durationSeconds(v.contentDetails?.duration||'');
  // Shortsは現在最大3分。APIで時間が取れる場合は #shorts の有無に依存しない。
  const isShort=!live&&!premiere&&sec>0&&sec<=180;
  return {kind:live?'live':isShort?'short':'long',liveType,premiere,durationSeconds:sec};
}

function decodeXml(value=''){
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'");
}
function tag(block,name){
  const escaped=name.replace(':','\\:');
  const m=block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,'i'));
  return decodeXml(m?.[1]||'').trim();
}
function attr(block,tagName,attrName){
  const re=new RegExp(`<${tagName.replace(':','\\:')}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`,'i');
  return decodeXml(block.match(re)?.[1]||'').trim();
}

async function fetchPublicAtom(channelId){
  const u=`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const r=await fetch(u,{headers:{Accept:'application/atom+xml,application/xml,text/xml,*/*;q=.2','User-Agent':'Mozilla/5.0 PersonalDashboardV2/2.3'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error(`YouTube公開フィード ${r.status}`);
  const xml=await r.text();
  const channelName=tag(xml,'title')||channelId;
  const entries=[...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(x=>x[0]);
  const items=entries.map(entry=>{
    const videoId=tag(entry,'yt:videoId');
    const title=tag(entry,'title')||tag(entry,'media:title');
    const publishedAt=tag(entry,'published')||tag(entry,'updated');
    const thumbnail=attr(entry,'media:thumbnail','url')||`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const markedShort=/#shorts?\b|ショート/i.test(title);
    return {
      videoId,title,description:'',publishedAt,channelId,channelName,thumbnail,tags:[],duration:'',
      kind:markedShort?'short':'long',liveType:'',premiere:false,durationSeconds:0
    };
  }).filter(x=>x.videoId&&x.title);
  if(!items.length)throw new Error('YouTube公開フィードから動画を取得できませんでした');
  return {ok:true,source:'rss-fallback',warning:'YouTube Data APIを利用できなかったため公開フィードから表示しています。LIVE判定・一部Shorts判定は制限されます。',channel:{id:channelId,name:channelName,thumbnail:''},items};
}

async function fetchByApi(channel){
  const ch=await resolveChannel(channel);
  if(!ch)return null;
  const uploads=ch.contentDetails?.relatedPlaylists?.uploads;
  if(!uploads)throw new Error('アップロード一覧を取得できません');
  const p=await yt('playlistItems',{part:'contentDetails,snippet',playlistId:uploads,maxResults:50});
  const ids=(p.items||[]).map(x=>x.contentDetails?.videoId||x.snippet?.resourceId?.videoId).filter(Boolean);
  const videos=[];
  for(let i=0;i<ids.length;i+=50){
    const d=await yt('videos',{part:'snippet,contentDetails,liveStreamingDetails,status',id:ids.slice(i,i+50).join(',')});
    videos.push(...(d.items||[]));
  }
  const items=videos.map(v=>{
    const c=classify(v);
    return {
      videoId:v.id,title:v.snippet?.title||'',description:v.snippet?.description||'',publishedAt:v.snippet?.publishedAt||'',
      channelId:v.snippet?.channelId||ch.id,channelName:v.snippet?.channelTitle||ch.snippet?.title||'',
      thumbnail:v.snippet?.thumbnails?.high?.url||v.snippet?.thumbnails?.medium?.url||'',tags:v.snippet?.tags||[],duration:v.contentDetails?.duration||'',...c
    };
  }).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
  return {ok:true,source:'api',channel:{id:ch.id,name:ch.snippet?.title||channel,thumbnail:ch.snippet?.thumbnails?.default?.url||''},items};
}

export default async function handler(req,res){
  try{
    const channel=String(req.query?.channel||'').trim();
    if(!channel)return res.status(400).json({ok:false,error:'channel を指定してください'});
    const normalized=norm(channel);
    try{
      const result=await fetchByApi(channel);
      if(!result)return res.status(404).json({ok:false,error:'YouTubeチャンネルが見つかりません'});
      res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
      return res.status(200).json(result);
    }catch(apiErr){
      // Channel IDが分かっている場合はAPIキー・割当・制限エラーでも公開Atomへフォールバック。
      if(EXACT_CHANNEL_ID.test(normalized)){
        try{
          const fallback=await fetchPublicAtom(normalized);
          fallback.apiError=apiErr.message||'YouTube Data API error';
          res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
          return res.status(200).json(fallback);
        }catch(feedErr){
          const e=new Error(`${apiErr.message||'YouTube API取得失敗'} / 公開フィード: ${feedErr.message}`);
          e.statusCode=apiErr.statusCode||502;
          throw e;
        }
      }
      throw apiErr;
    }
  }catch(err){
    console.error('[youtube-feed]',err);
    res.status(err.statusCode||500).json({ok:false,error:err.message||'YouTube取得エラー'});
  }
}
