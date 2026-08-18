const API='https://www.googleapis.com/youtube/v3';

function key(){ const k=String(process.env.YOUTUBE_API_KEY||'').trim(); if(!k){const e=new Error('YOUTUBE_API_KEY がVercelに設定されていません');e.statusCode=500;throw e;} return k; }
async function yt(path,params){ const u=new URL(`${API}/${path}`); Object.entries({...params,key:key()}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));}); const r=await fetch(u,{signal:AbortSignal.timeout(12000)}); const d=await r.json().catch(()=>({})); if(!r.ok){const e=new Error(d?.error?.message||`YouTube API ${r.status}`);e.statusCode=r.status;throw e;} return d; }
function norm(input){ let s=String(input||'').trim(); try{if(/^https?:\/\//i.test(s)){const u=new URL(s);const parts=u.pathname.split('/').filter(Boolean); if(parts[0]?.startsWith('@'))return parts[0]; if(parts[0]==='channel'&&parts[1])return parts[1]; return parts[0]||'';}}catch{} return s; }
async function resolveChannel(input){ const q=norm(input); if(/^UC[\w-]{20,}$/.test(q)){const d=await yt('channels',{part:'snippet,contentDetails',id:q});return d.items?.[0];}
  const handle=q.replace(/^@/,''); let d=await yt('channels',{part:'snippet,contentDetails',forHandle:handle}); if(d.items?.[0])return d.items[0];
  d=await yt('search',{part:'snippet',type:'channel',q, maxResults:1}); const id=d.items?.[0]?.snippet?.channelId||d.items?.[0]?.id?.channelId; if(!id)return null; return (await yt('channels',{part:'snippet,contentDetails',id})).items?.[0]||null; }
function durationSeconds(iso=''){const m=String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);return m?(Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0)):0;}
function classify(v){ const text=`${v.snippet?.title||''} ${v.snippet?.description||''} ${(v.snippet?.tags||[]).join(' ')}`.toLowerCase(); const premiere=/premiere|premiered|プレミア公開|プレミア配信/.test(text); const live=Boolean(v.liveStreamingDetails)&&!premiere; let liveType=''; if(live){if(v.liveStreamingDetails?.actualEndTime)liveType='archive'; else if(v.liveStreamingDetails?.actualStartTime)liveType='live'; else liveType='upcoming';}
  const sec=durationSeconds(v.contentDetails?.duration||''); const shortMarker=/#shorts?\b|\bshorts?\b|ショート動画|ショート/.test(text); const isShort=!live&&!premiere&&sec>0&&sec<=180&&shortMarker;
  return {kind:live?'live':isShort?'short':'long',liveType,premiere,durationSeconds:sec}; }
export default async function handler(req,res){
  try{
    const channel=String(req.query?.channel||'').trim(); if(!channel)return res.status(400).json({ok:false,error:'channel を指定してください'});
    const ch=await resolveChannel(channel); if(!ch)return res.status(404).json({ok:false,error:'YouTubeチャンネルが見つかりません'});
    const uploads=ch.contentDetails?.relatedPlaylists?.uploads; if(!uploads)throw new Error('アップロード一覧を取得できません');
    const p=await yt('playlistItems',{part:'contentDetails,snippet',playlistId:uploads,maxResults:50}); const ids=(p.items||[]).map(x=>x.contentDetails?.videoId||x.snippet?.resourceId?.videoId).filter(Boolean);
    const videos=[]; for(let i=0;i<ids.length;i+=50){const d=await yt('videos',{part:'snippet,contentDetails,liveStreamingDetails,status',id:ids.slice(i,i+50).join(',')});videos.push(...(d.items||[]));}
    const items=videos.map(v=>{const c=classify(v);return {videoId:v.id,title:v.snippet?.title||'',description:v.snippet?.description||'',publishedAt:v.snippet?.publishedAt||'',channelId:v.snippet?.channelId||ch.id,channelName:v.snippet?.channelTitle||ch.snippet?.title||'',thumbnail:v.snippet?.thumbnails?.high?.url||v.snippet?.thumbnails?.medium?.url||'',tags:v.snippet?.tags||[],duration:v.contentDetails?.duration||'',...c};}).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
    res.status(200).json({ok:true,channel:{id:ch.id,name:ch.snippet?.title||channel,thumbnail:ch.snippet?.thumbnails?.default?.url||''},items});
  }catch(err){console.error('[youtube-feed]',err);res.status(err.statusCode||500).json({ok:false,error:err.message||'YouTube取得エラー'});}
}
