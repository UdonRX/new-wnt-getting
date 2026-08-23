import { createCanvas, loadImage } from '@napi-rs/canvas';

const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const DETAIL_LIMIT = 18;
const CLASSIFY_CONCURRENCY = 4;
const THUMB_CONCURRENCY = 5;
const CLASSIFY_TTL_MS = 12 * 60 * 60 * 1000;
const CLASSIFY_CACHE_MAX = 500;
const CHANNEL_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const classificationCache = new Map();
const channelResolveCache = new Map();

function apiKey(){return String(process.env.YOUTUBE_API_KEY||'').trim()}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function apiReason(data={}){return String(data?.error?.errors?.[0]?.reason||data?.error?.status||'youtubeApiError')}
function quotaLike(reason='',status=0){return Number(status)===429||/quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason))}
function transient(status=0,reason=''){return[408,425,429,500,502,503,504].includes(Number(status))||/backendError|internalError|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason))}

async function yt(path,params){
  const key=apiKey();if(!key)throw Object.assign(new Error('YOUTUBE_API_KEY がVercelに設定されていません'),{statusCode:500,code:'NO_API_KEY',reason:'keyMissing'});
  const url=new URL(`${API}/${path}`);Object.entries({...params,key}).forEach(([name,value])=>{if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(name,String(value))});
  let lastError;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(6000)});const data=await response.json().catch(()=>({}));if(response.ok)return data;
      const reason=apiReason(data);const error=Object.assign(new Error(data?.error?.message||`YouTube API ${response.status}`),{statusCode:response.status,code:quotaLike(reason,response.status)?'YOUTUBE_QUOTA':'YOUTUBE_API',reason,apiData:data});lastError=error;
      if(attempt===0&&transient(response.status,reason)&&!/quotaExceeded|dailyLimitExceeded/i.test(reason)){await sleep(250);continue}throw error;
    }catch(error){lastError=error;if(attempt===0&&(error?.name==='TimeoutError'||error?.name==='AbortError'||/fetch failed|network/i.test(String(error?.message||'')))){await sleep(180);continue}throw error}
  }
  throw lastError||new Error('YouTube API error');
}

function parseInput(input){
  const raw=String(input||'').trim();
  if(EXACT_CHANNEL_ID.test(raw))return{kind:'id',value:raw,raw};
  if(raw.startsWith('@'))return{kind:'handle',value:raw.slice(1),raw};
  try{
    if(/^https?:\/\//i.test(raw)){
      const url=new URL(raw);const parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]?.startsWith('@'))return{kind:'handle',value:parts[0].slice(1),raw,url:raw};
      if(parts[0]==='channel'&&EXACT_CHANNEL_ID.test(parts[1]||''))return{kind:'id',value:parts[1],raw,url:raw};
      if(parts[0]==='user'&&parts[1])return{kind:'username',value:parts[1],raw,url:raw};
      if(parts[0]==='c'&&parts[1])return{kind:'page',value:parts[1],raw,url:raw};
      if(parts[0])return{kind:'page',value:parts[0],raw,url:raw};
    }
  }catch{}
  return{kind:'text',value:raw.replace(/^@/,''),raw};
}

const HTML_HEADERS={
  'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  'Accept':'text/html,application/xhtml+xml',
  'Accept-Language':'ja,en-US;q=0.7,en;q=0.5'
};
async function fetchHtml(url,{timeout=4200,max=1800000}={}){
  const response=await fetch(url,{redirect:'follow',headers:HTML_HEADERS,signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw Object.assign(new Error(`YouTube HTML ${response.status}`),{status:response.status});
  const text=await response.text();return text.slice(0,max);
}
async function fetchChannelIdFromPage(rawUrl){
  let url;try{url=new URL(rawUrl)}catch{return''}
  const html=await fetchHtml(url,{timeout:4200,max:1500000});
  return html.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/)?.[1]||html.match(/"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/)?.[1]||html.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1]||'';
}
async function channelById(id){return(await yt('channels',{part:'snippet,contentDetails',id})).items?.[0]||null}
async function resolveChannel(input){
  const parsed=parseInput(input);const cacheKey=parsed.raw.toLowerCase();const cached=channelResolveCache.get(cacheKey);if(cached&&Date.now()-cached.at<CHANNEL_RESOLVE_TTL_MS)return cached.channel;
  let channel=null;
  if(parsed.kind==='id')channel=await channelById(parsed.value);
  else if(parsed.kind==='handle')channel=(await yt('channels',{part:'snippet,contentDetails',forHandle:parsed.value})).items?.[0]||null;
  else if(parsed.kind==='username')channel=(await yt('channels',{part:'snippet,contentDetails',forUsername:parsed.value})).items?.[0]||null;
  else if(parsed.kind==='page'){const id=await fetchChannelIdFromPage(parsed.url).catch(()=>'' );if(id)channel=await channelById(id);}
  else{channel=(await yt('channels',{part:'snippet,contentDetails',forHandle:parsed.value})).items?.[0]||null;if(!channel){const data=await yt('search',{part:'snippet',type:'channel',q:parsed.value,maxResults:1});const id=data.items?.[0]?.snippet?.channelId||data.items?.[0]?.id?.channelId;if(id)channel=await channelById(id);}}
  if(channel){channelResolveCache.set(cacheKey,{at:Date.now(),channel});while(channelResolveCache.size>300)channelResolveCache.delete(channelResolveCache.keys().next().value)}
  return channel;
}

function durationSeconds(iso=''){const match=String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);return match?Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0):0}
function liveClassification(video){const details=video?.liveStreamingDetails;if(!details)return null;if(details.actualEndTime)return{kind:'live',liveType:'archive',method:'liveStreamingDetails'};if(details.actualStartTime)return{kind:'live',liveType:'live',method:'liveStreamingDetails'};if(details.scheduledStartTime)return{kind:'live',liveType:'upcoming',method:'liveStreamingDetails'};return{kind:'live',liveType:'archive',method:'liveStreamingDetails'}}
function cacheClassification(videoId,value){classificationCache.delete(videoId);classificationCache.set(videoId,{at:Date.now(),value});while(classificationCache.size>CLASSIFY_CACHE_MAX)classificationCache.delete(classificationCache.keys().next().value)}
function cachedClassification(videoId){const cached=classificationCache.get(videoId);return cached&&Date.now()-cached.at<CLASSIFY_TTL_MS?cached.value:null}

function collectMatches(html,patterns){const ids=new Set();for(const pattern of patterns){pattern.lastIndex=0;let match;while((match=pattern.exec(html)))if(match[1])ids.add(match[1]);}return ids}
function extractShortIds(html=''){return collectMatches(String(html),[/"shortsLockupViewModel"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelItemRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelWatchEndpoint"[\s\S]{0,1200}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"url"\s*:\s*"\\?\/shorts\/([A-Za-z0-9_-]{11})(?:[?\\"/]|$)/g]);}
function extractLongIds(html=''){return collectMatches(String(html),[/"gridVideoRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"videoRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g]);}
function explicitShortSignal(html='',videoId=''){
  const text=String(html),id=String(videoId);if(!id)return false;const index=text.indexOf(`"videoId":"${id}"`);if(index>=0){const around=text.slice(Math.max(0,index-2200),Math.min(text.length,index+2600));if(/WEB_PAGE_TYPE_SHORTS|"isShorts"\s*:\s*true|shortsLockupViewModel|reelWatchEndpoint/.test(around))return true;}
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(?:reelWatchEndpoint|shortsLockupViewModel)[\\s\\S]{0,1800}?"videoId"\\s*:\\s*"${escaped}"`).test(text)||new RegExp(`"url"\\s*:\\s*"\\\\?/shorts/${escaped}(?:[?\\\\"/]|$)`).test(text);
}
function playabilityBlocked(html=''){return /"playabilityStatus"\s*:\s*\{[\s\S]{0,800}?"status"\s*:\s*"(?:ERROR|LOGIN_REQUIRED|UNPLAYABLE)"/.test(String(html))}
async function channelTabEvidence(channelId){const base=`https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;const [shortsResult,videosResult]=await Promise.allSettled([fetchHtml(`${base}/shorts`,{timeout:4300}),fetchHtml(`${base}/videos`,{timeout:4300})]);return{shorts:shortsResult.status==='fulfilled'?extractShortIds(shortsResult.value):new Set(),videos:videosResult.status==='fulfilled'?extractLongIds(videosResult.value):new Set(),shortsOk:shortsResult.status==='fulfilled',videosOk:videosResult.status==='fulfilled'};}
async function probeExplicitShort(videoId){try{const html=await fetchHtml(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`,{timeout:2600,max:1300000});if(playabilityBlocked(html))return{kind:'unknown',liveType:'',method:'shorts-html-blocked',status:200,error:'playability blocked'};if(explicitShortSignal(html,videoId))return{kind:'short',liveType:'',method:'shorts-html-json',status:200};return{kind:'unknown',liveType:'',method:'shorts-html-no-explicit-signal',status:200,error:'explicit Shorts metadata not found'};}catch(error){return{kind:'unknown',liveType:'',method:'shorts-html-error',status:Number(error?.status||0),error:String(error?.message||error)}}}
async function mapConcurrent(values,limit,worker){const result=new Array(values.length);let cursor=0;const workers=Array.from({length:Math.min(limit,values.length)},async()=>{while(true){const index=cursor++;if(index>=values.length)return;try{result[index]=await worker(values[index],index)}catch(error){result[index]={kind:'unknown',liveType:'',method:'classification-error',status:0,error:String(error?.message||error)}}}});await Promise.all(workers);return result}

function luma(data,index){return data[index]*.2126+data[index+1]*.7152+data[index+2]*.0722;}
function gradientEnergy(data,w,h,x0,x1){
  let sum=0,count=0;const left=Math.max(1,Math.floor(w*x0)),right=Math.min(w-2,Math.ceil(w*x1));
  for(let y=1;y<h-1;y+=2){for(let x=left;x<=right;x+=2){const i=(y*w+x)*4;const lx=(y*w+x+1)*4,ly=((y+1)*w+x)*4;sum+=Math.abs(luma(data,i)-luma(data,lx))+Math.abs(luma(data,i)-luma(data,ly));count+=2;}}
  return count?sum/count:0;
}
function boundaryEnergy(data,w,h,fraction){const x=Math.max(1,Math.min(w-2,Math.round(w*fraction)));let sum=0,count=0;for(let y=1;y<h-1;y++){const a=(y*w+x-1)*4,b=(y*w+x+1)*4;sum+=Math.abs(luma(data,a)-luma(data,b));count++;}return count?sum/count:0;}
async function thumbnailVisualProbe(video){
  const url=video?.snippet?.thumbnails?.high?.url||video?.snippet?.thumbnails?.medium?.url||video?.snippet?.thumbnails?.default?.url||'';
  if(!url)return{kind:'unknown',liveType:'',method:'thumbnail-none',status:0,error:'thumbnail missing'};
  try{
    const response=await fetch(url,{headers:{'User-Agent':HTML_HEADERS['User-Agent'],'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(2800)});if(!response.ok)return{kind:'unknown',liveType:'',method:'thumbnail-http',status:response.status,error:`thumbnail HTTP ${response.status}`};
    const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>5_000_000)return{kind:'unknown',liveType:'',method:'thumbnail-size',status:response.status,error:'thumbnail size invalid'};
    const image=await loadImage(bytes);const w=96,h=54,canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,w,h);const pixels=ctx.getImageData(0,0,w,h).data;
    const center=gradientEnergy(pixels,w,h,.36,.64),left=gradientEnergy(pixels,w,h,.04,.30),right=gradientEnergy(pixels,w,h,.70,.96),side=(left+right)/2;
    const boundary=(boundaryEnergy(pixels,w,h,.34)+boundaryEnergy(pixels,w,h,.66))/2;
    const balance=Math.min(left,right)/Math.max(1,Math.max(left,right));
    const verticalBlur=center>side*1.55&&boundary>Math.max(12,side*1.35)&&balance>.52;
    if(verticalBlur)return{kind:'short',liveType:'',method:'thumbnail-vertical-blur',status:200,visual:{center:Number(center.toFixed(1)),side:Number(side.toFixed(1)),boundary:Number(boundary.toFixed(1))}};
    const clearlyLandscape=center<side*1.22||boundary<9;
    if(clearlyLandscape)return{kind:'long',liveType:'',method:'thumbnail-landscape',status:200,visual:{center:Number(center.toFixed(1)),side:Number(side.toFixed(1)),boundary:Number(boundary.toFixed(1))}};
    return{kind:'unknown',liveType:'',method:'thumbnail-ambiguous',status:200,visual:{center:Number(center.toFixed(1)),side:Number(side.toFixed(1)),boundary:Number(boundary.toFixed(1))}};
  }catch(error){return{kind:'unknown',liveType:'',method:'thumbnail-error',status:0,error:String(error?.message||error)}}
}

async function classifyVideos(videos,channelId){
  const classifications=new Map(),nonLive=[];for(const video of videos){const live=liveClassification(video);if(live)classifications.set(video.id,live);else nonLive.push(video)}
  if(!nonLive.length)return classifications;
  const evidence=await channelTabEvidence(channelId).catch(()=>({shorts:new Set(),videos:new Set(),shortsOk:false,videosOk:false}));
  const remaining=[];
  for(const video of nonLive){const cached=cachedClassification(video.id);if(cached){classifications.set(video.id,cached);continue;}const inShorts=evidence.shorts.has(video.id),inVideos=evidence.videos.has(video.id);if(inShorts&&!inVideos){const value={kind:'short',liveType:'',method:'channel-shorts-tab-json',status:200};cacheClassification(video.id,value);classifications.set(video.id,value);continue;}remaining.push({video,inVideos,inShorts});}
  const visual=await mapConcurrent(remaining,THUMB_CONCURRENCY,row=>thumbnailVisualProbe(row.video));
  const unresolved=[];
  remaining.forEach((row,index)=>{
    const probe=visual[index];
    if(probe?.kind==='short'){cacheClassification(row.video.id,probe);classifications.set(row.video.id,probe);return;}
    if(row.inVideos&&!row.inShorts){const value=probe?.kind==='long'?probe:{kind:'long',liveType:'',method:'channel-videos-tab-json',status:200};cacheClassification(row.video.id,value);classifications.set(row.video.id,value);return;}
    if(probe?.kind==='long'){cacheClassification(row.video.id,probe);classifications.set(row.video.id,probe);return;}
    unresolved.push(row.video);
  });
  const htmlProbed=await mapConcurrent(unresolved,CLASSIFY_CONCURRENCY,video=>probeExplicitShort(video.id));
  unresolved.forEach((video,index)=>{const value=htmlProbed[index];classifications.set(video.id,value);if(value.kind!=='unknown')cacheClassification(video.id,value);});
  return classifications;
}

async function dataApiSnapshot(input){
  const startedAt=Date.now();const channel=await resolveChannel(input);if(!channel)throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'),{statusCode:404,reason:'channelNotFound'});const uploads=channel.contentDetails?.relatedPlaylists?.uploads;if(!uploads)throw Object.assign(new Error('アップロード一覧を取得できませんでした'),{statusCode:502,reason:'uploadsPlaylistMissing'});
  const playlist=await yt('playlistItems',{part:'snippet,contentDetails',playlistId:uploads,maxResults:DETAIL_LIMIT});const ids=(playlist.items||[]).map(item=>item.contentDetails?.videoId).filter(Boolean);if(!ids.length)return{channel:{id:channel.id,name:channel.snippet?.title||''},items:[],classificationWarnings:[],serverTimingMs:Date.now()-startedAt};
  const detailData=await yt('videos',{part:'snippet,contentDetails,liveStreamingDetails',id:ids.join(',')});const videos=detailData.items||[],byId=new Map(videos.map(video=>[video.id,video])),classifications=await classifyVideos(ids.map(id=>byId.get(id)).filter(Boolean),channel.id),warnings=[];
  const items=ids.map(id=>{const video=byId.get(id);if(!video){warnings.push(`${id}: 非公開または削除済みのため詳細を取得できませんでした`);return null;}const c=classifications.get(id)||{kind:'unknown',liveType:'',method:'missing-classification'};if(c.kind==='unknown')warnings.push(`${video.snippet?.title||id}: Shorts/通常動画の厳密分類を完了できませんでした`);return{videoId:video.id,title:video.snippet?.title||'無題',channelName:video.snippet?.channelTitle||channel.snippet?.title||'',publishedAt:video.snippet?.publishedAt||'',thumbnail:video.snippet?.thumbnails?.medium?.url||video.snippet?.thumbnails?.high?.url||'',durationSeconds:durationSeconds(video.contentDetails?.duration),kind:c.kind,liveType:c.liveType,classificationMethod:c.method,classificationStatus:c.status||0,url:c.kind==='short'?`https://www.youtube.com/shorts/${video.id}`:`https://www.youtube.com/watch?v=${video.id}`}}).filter(Boolean);
  return{channel:{id:channel.id,name:channel.snippet?.title||''},items,classificationWarnings:warnings.slice(0,8),classificationComplete:warnings.length===0,classificationPolicy:'liveStreamingDetails + YouTube HTML metadata + high-confidence thumbnail vertical/blur composition; duration is never used for Shorts classification',serverTimingMs:Date.now()-startedAt};
}

export default async function handler(req,res){
  const input=String(req.query?.channel||'').trim();if(!input)return res.status(400).json({ok:false,error:'channel を指定してください。'});
  try{const data=await dataApiSnapshot(input);res.setHeader('Cache-Control','s-maxage=180, stale-while-revalidate=900');res.setHeader('Server-Timing',`youtube;dur=${Number(data.serverTimingMs||0)}`);return res.status(200).json({ok:true,source:'data-api-v2195',...data});}
  catch(error){console.error('[youtube-feed:v2195]',error);const isQuota=error?.code==='YOUTUBE_QUOTA'||quotaLike(error?.reason,error?.statusCode);return res.status(isQuota?429:(error?.statusCode||500)).json({ok:false,error:isQuota?'YouTube Data APIのクォータ上限のため更新できません。保存済み一覧があればそちらを表示します。':'YouTube情報を現在取得できません。保存済み一覧があればそちらを表示します。',reason:error?.reason||error?.code||'',detail:error?.apiData?.error?.message||error?.message||'',retryable:!isQuota});}
}
