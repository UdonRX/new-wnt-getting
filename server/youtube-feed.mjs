import { createCanvas, loadImage } from '@napi-rs/canvas';

const API = 'https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const DETAIL_LIMIT = 18;
const CLASSIFY_CONCURRENCY = 4;
const THUMB_CONCURRENCY = 5;
const CONFIRMED_CLASSIFY_TTL_MS = 12 * 60 * 60 * 1000;
const THUMB_CLASSIFY_TTL_MS = 45 * 60 * 1000;
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
async function fetchHtml(url,{timeout=4200,max=1800000,withMeta=false}={}){
  const response=await fetch(url,{redirect:'follow',headers:HTML_HEADERS,signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw Object.assign(new Error(`YouTube HTML ${response.status}`),{status:response.status});
  const html=(await response.text()).slice(0,max);return withMeta?{html,finalUrl:response.url,status:response.status}:html;
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
function cacheClassification(videoId,value,source='youtube'){if(!videoId||!['short','long'].includes(value?.kind))return;const ttlMs=source==='thumbnail'?THUMB_CLASSIFY_TTL_MS:CONFIRMED_CLASSIFY_TTL_MS;classificationCache.delete(videoId);classificationCache.set(videoId,{expiresAt:Date.now()+ttlMs,source,value});while(classificationCache.size>CLASSIFY_CACHE_MAX)classificationCache.delete(classificationCache.keys().next().value)}
function cachedClassification(videoId,source='youtube'){const cached=classificationCache.get(videoId);if(!cached)return null;if(Date.now()>=Number(cached.expiresAt||0)){classificationCache.delete(videoId);return null}return cached.source===source&&['short','long'].includes(cached.value?.kind)?cached.value:null}

function collectMatches(html,patterns){const ids=new Set();for(const pattern of patterns){pattern.lastIndex=0;let match;while((match=pattern.exec(html)))if(match[1])ids.add(match[1]);}return ids}
function extractShortIds(html=''){return collectMatches(String(html),[/"shortsLockupViewModel"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelItemRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelWatchEndpoint"[\s\S]{0,1200}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"url"\s*:\s*"\\?\/shorts\/([A-Za-z0-9_-]{11})(?:[?\\"/]|$)/g]);}
function extractLongIds(html=''){return collectMatches(String(html),[/"gridVideoRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"videoRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g]);}
function explicitShortSignal(html='',videoId=''){
  const text=String(html),id=String(videoId);if(!id)return false;const index=text.indexOf(`"videoId":"${id}"`);if(index>=0){const around=text.slice(Math.max(0,index-2200),Math.min(text.length,index+2600));if(/WEB_PAGE_TYPE_SHORTS|"isShorts"\s*:\s*true|shortsLockupViewModel|reelWatchEndpoint/.test(around))return true;}
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(?:reelWatchEndpoint|shortsLockupViewModel)[\\s\\S]{0,1800}?"videoId"\\s*:\\s*"${escaped}"`).test(text)||new RegExp(`"url"\\s*:\\s*"\\\\?/shorts/${escaped}(?:[?\\\\"/]|$)`).test(text);
}
function explicitLongSignal(html='',videoId='',finalUrl=''){
  const text=String(html),id=String(videoId);if(!id||explicitShortSignal(text,id))return false;
  try{const url=new URL(finalUrl);if(url.pathname==='/watch'&&url.searchParams.get('v')===id)return true}catch{}
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=new RegExp(`"videoId"\\s*:\\s*"${escaped}"`).exec(text);if(match){const around=text.slice(Math.max(0,match.index-2200),Math.min(text.length,match.index+2600));if(/WEB_PAGE_TYPE_WATCH|"isShorts"\s*:\s*false/.test(around))return true}return false;
}
function playabilityBlocked(html=''){return /"playabilityStatus"\s*:\s*\{[\s\S]{0,800}?"status"\s*:\s*"(?:ERROR|LOGIN_REQUIRED|UNPLAYABLE)"/.test(String(html))}
function htmlFailureReason(error){const status=Number(error?.status||0);if(status===429)return'youtube-rate-limit';if(error?.name==='TimeoutError'||error?.name==='AbortError'||/timeout/i.test(String(error?.message||'')))return'youtube-timeout';return'youtube-html-failed'}
async function channelTabEvidence(channelId){const base=`https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;const [shortsResult,videosResult]=await Promise.allSettled([fetchHtml(`${base}/shorts`,{timeout:4300}),fetchHtml(`${base}/videos`,{timeout:4300})]);return{shorts:shortsResult.status==='fulfilled'?extractShortIds(shortsResult.value):new Set(),videos:videosResult.status==='fulfilled'?extractLongIds(videosResult.value):new Set(),shortsOk:shortsResult.status==='fulfilled',videosOk:videosResult.status==='fulfilled',shortsReason:shortsResult.status==='rejected'?htmlFailureReason(shortsResult.reason):'',videosReason:videosResult.status==='rejected'?htmlFailureReason(videosResult.reason):''};}
function channelEvidenceReason(evidence){if(!evidence?.shortsOk)return evidence?.shortsReason||'youtube-html-failed';if(!evidence?.videosOk)return evidence?.videosReason||'youtube-html-failed';return'youtube-html-ambiguous'}
async function probeExplicitShort(videoId){try{const page=await fetchHtml(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`,{timeout:2600,max:1300000,withMeta:true}),html=page.html;if(playabilityBlocked(html))return{kind:'unknown',liveType:'',method:'shorts-html-blocked',status:200,reason:'youtube-html-ambiguous',error:'playability blocked'};if(explicitShortSignal(html,videoId))return{kind:'short',liveType:'',method:'shorts-html-explicit',status:200};if(explicitLongSignal(html,videoId,page.finalUrl))return{kind:'long',liveType:'',method:'shorts-html-explicit-long',status:200};return{kind:'unknown',liveType:'',method:'shorts-html-ambiguous',status:200,reason:'youtube-html-ambiguous',error:'explicit Shorts/long metadata not found'};}catch(error){return{kind:'unknown',liveType:'',method:'shorts-html-error',status:Number(error?.status||0),reason:htmlFailureReason(error),error:String(error?.message||error)}}}
async function mapConcurrent(values,limit,worker){const result=new Array(values.length);let cursor=0;const workers=Array.from({length:Math.min(limit,values.length)},async()=>{while(true){const index=cursor++;if(index>=values.length)return;try{result[index]=await worker(values[index],index)}catch(error){result[index]={kind:'unknown',liveType:'',method:'classification-error',status:0,reason:'classification-error',error:String(error?.message||error)}}}});await Promise.all(workers);return result}

function luma(data,index){return data[index]*.2126+data[index+1]*.7152+data[index+2]*.0722;}
function gradientEnergy(data,w,h,x0,x1){
  let sum=0,count=0;const left=Math.max(1,Math.floor(w*x0)),right=Math.min(w-2,Math.ceil(w*x1));
  for(let y=1;y<h-1;y+=2){for(let x=left;x<=right;x+=2){const i=(y*w+x)*4;const lx=(y*w+x+1)*4,ly=((y+1)*w+x)*4;sum+=Math.abs(luma(data,i)-luma(data,lx))+Math.abs(luma(data,i)-luma(data,ly));count+=2;}}
  return count?sum/count:0;
}
function boundaryEnergy(data,w,h,fraction){const x=Math.max(1,Math.min(w-2,Math.round(w*fraction)));let sum=0,count=0;for(let y=1;y<h-1;y++){const a=(y*w+x-1)*4,b=(y*w+x+1)*4;sum+=Math.abs(luma(data,a)-luma(data,b));count++;}return count?sum/count:0;}
function thumbnailDecision(center,left,right,boundary){
  const side=(left+right)/2,balance=Math.min(left,right)/Math.max(1,Math.max(left,right)),centerSide=center/Math.max(1,side),boundarySide=boundary/Math.max(1,side),texture=Math.max(center,side);
  const visual={center:Number(center.toFixed(1)),side:Number(side.toFixed(1)),boundary:Number(boundary.toFixed(1)),balance:Number(balance.toFixed(2)),centerSide:Number(centerSide.toFixed(2)),boundarySide:Number(boundarySide.toFixed(2))};
  const highShort=texture>=8&&centerSide>=1.70&&boundary>=14&&boundarySide>=1.45&&balance>=.62;
  if(highShort){const confidence=Math.min(.99,.91+Math.min(.08,Math.max(0,centerSide-1.70)*.08+Math.max(0,boundarySide-1.45)*.05+Math.max(0,balance-.62)*.10));return{kind:'short',confidence:Number(confidence.toFixed(2)),visual}}
  const highLong=texture>=8&&((centerSide<=1.08&&boundary<=8)||(centerSide<=1.15&&boundary<=6));
  if(highLong){const confidence=Math.min(.98,.91+Math.min(.07,Math.max(0,1.15-centerSide)*.18+Math.max(0,8-boundary)*.008));return{kind:'long',confidence:Number(confidence.toFixed(2)),visual}}
  return{kind:'unknown',confidence:0,visual};
}
async function thumbnailVisualProbe(video){
  const url=video?.snippet?.thumbnails?.high?.url||video?.snippet?.thumbnails?.medium?.url||video?.snippet?.thumbnails?.default?.url||'';
  if(!url)return{kind:'unknown',liveType:'',method:'thumbnail-fallback',confidence:0,status:0,reason:'thumbnail-fetch-error',error:'thumbnail missing'};
  try{
    const response=await fetch(url,{headers:{'User-Agent':HTML_HEADERS['User-Agent'],'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(2800)});if(!response.ok)return{kind:'unknown',liveType:'',method:'thumbnail-fallback',confidence:0,status:response.status,reason:'thumbnail-fetch-error',error:`thumbnail HTTP ${response.status}`};
    const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>5_000_000)return{kind:'unknown',liveType:'',method:'thumbnail-fallback',confidence:0,status:response.status,reason:'thumbnail-fetch-error',error:'thumbnail size invalid'};
    const image=await loadImage(bytes),w=96,h=54,canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,w,h);const pixels=ctx.getImageData(0,0,w,h).data;
    const center=gradientEnergy(pixels,w,h,.36,.64),left=gradientEnergy(pixels,w,h,.04,.30),right=gradientEnergy(pixels,w,h,.70,.96),boundary=(boundaryEnergy(pixels,w,h,.34)+boundaryEnergy(pixels,w,h,.66))/2,decision=thumbnailDecision(center,left,right,boundary);
    if(decision.kind==='unknown')return{...decision,liveType:'',method:'thumbnail-fallback',status:200,reason:'thumbnail-ambiguous'};
    return{...decision,liveType:'',method:'thumbnail-fallback',status:200};
  }catch(error){return{kind:'unknown',liveType:'',method:'thumbnail-fallback',confidence:0,status:0,reason:'thumbnail-fetch-error',error:String(error?.message||error)}}
}

async function classifyVideos(videos,channelId,hooks={}){
  const getTabEvidence=hooks.channelTabEvidence||channelTabEvidence,getHtmlProbe=hooks.probeExplicitShort||probeExplicitShort,getThumbnailProbe=hooks.thumbnailVisualProbe||thumbnailVisualProbe;
  const classifications=new Map(),pending=[];
  for(const video of videos){const live=liveClassification(video);if(live){classifications.set(video.id,live);continue}const cached=cachedClassification(video.id,'youtube');if(cached)classifications.set(video.id,cached);else pending.push(video)}
  if(!pending.length)return classifications;

  let evidence;try{evidence=await getTabEvidence(channelId)}catch(error){const reason=htmlFailureReason(error);evidence={shorts:new Set(),videos:new Set(),shortsOk:false,videosOk:false,shortsReason:reason,videosReason:reason}}
  const afterTabs=[];
  for(const video of pending){const inShorts=evidence.shorts?.has(video.id),inVideos=evidence.videos?.has(video.id),tabsReliable=evidence.shortsOk&&evidence.videosOk;if(tabsReliable&&inShorts&&!inVideos){const value={kind:'short',liveType:'',method:'channel-shorts-tab-json',status:200};cacheClassification(video.id,value,'youtube');classifications.set(video.id,value);continue}if(tabsReliable&&inVideos&&!inShorts){const value={kind:'long',liveType:'',method:'channel-videos-tab-json',status:200};cacheClassification(video.id,value,'youtube');classifications.set(video.id,value);continue}afterTabs.push({video,youtubeReason:channelEvidenceReason(evidence)})}

  const htmlProbed=await mapConcurrent(afterTabs,CLASSIFY_CONCURRENCY,row=>getHtmlProbe(row.video.id)),afterHtml=[];
  afterTabs.forEach((row,index)=>{const probe=htmlProbed[index];if(probe?.kind==='short'||probe?.kind==='long'){cacheClassification(row.video.id,probe,'youtube');classifications.set(row.video.id,probe);return}afterHtml.push({video:row.video,youtubeReason:probe?.reason||row.youtubeReason})});

  const needThumbnail=[];
  for(const row of afterHtml){const cached=cachedClassification(row.video.id,'thumbnail');if(cached){classifications.set(row.video.id,cached);continue}needThumbnail.push(row)}
  const visual=await mapConcurrent(needThumbnail,THUMB_CONCURRENCY,row=>getThumbnailProbe(row.video));
  needThumbnail.forEach((row,index)=>{const probe=visual[index];if((probe?.kind==='short'||probe?.kind==='long')&&Number(probe?.confidence||0)>=.90){const value={...probe,method:'thumbnail-fallback'};cacheClassification(row.video.id,value,'thumbnail');classifications.set(row.video.id,value);return}classifications.set(row.video.id,{kind:'unknown',liveType:'',method:probe?.method||'thumbnail-fallback',confidence:Number(probe?.confidence||0),status:Number(probe?.status||0),reason:probe?.reason||'thumbnail-ambiguous',youtubeReason:row.youtubeReason,error:probe?.error||''})});
  return classifications;
}

async function dataApiSnapshot(input){
  const startedAt=Date.now();const channel=await resolveChannel(input);if(!channel)throw Object.assign(new Error('YouTubeチャンネルを特定できませんでした'),{statusCode:404,reason:'channelNotFound'});const uploads=channel.contentDetails?.relatedPlaylists?.uploads;if(!uploads)throw Object.assign(new Error('アップロード一覧を取得できませんでした'),{statusCode:502,reason:'uploadsPlaylistMissing'});
  const playlist=await yt('playlistItems',{part:'snippet,contentDetails',playlistId:uploads,maxResults:DETAIL_LIMIT});const ids=(playlist.items||[]).map(item=>item.contentDetails?.videoId).filter(Boolean);if(!ids.length)return{channel:{id:channel.id,name:channel.snippet?.title||''},items:[],classificationWarnings:[],serverTimingMs:Date.now()-startedAt};
  const detailData=await yt('videos',{part:'snippet,contentDetails,liveStreamingDetails',id:ids.join(',')});const videos=detailData.items||[],byId=new Map(videos.map(video=>[video.id,video])),classifications=await classifyVideos(ids.map(id=>byId.get(id)).filter(Boolean),channel.id),warnings=[];
  const items=ids.map(id=>{const video=byId.get(id);if(!video){warnings.push(`${id}: 非公開または削除済みのため詳細を取得できませんでした`);return null;}const c=classifications.get(id)||{kind:'unknown',liveType:'',method:'missing-classification',reason:'classification-error'};if(c.kind==='unknown'){warnings.push(`${video.snippet?.title||id}: Shorts/通常動画の厳密分類を完了できませんでした (${c.reason||'unknown'})`);console.warn('[youtube-classification-unknown]',{videoId:id,method:c.method||'',reason:c.reason||'',youtubeReason:c.youtubeReason||'',status:c.status||0})}return{videoId:video.id,title:video.snippet?.title||'無題',channelName:video.snippet?.channelTitle||channel.snippet?.title||'',publishedAt:video.snippet?.publishedAt||'',thumbnail:video.snippet?.thumbnails?.medium?.url||video.snippet?.thumbnails?.high?.url||'',durationSeconds:durationSeconds(video.contentDetails?.duration),kind:c.kind,liveType:c.liveType,classificationMethod:c.method,classificationConfidence:Number(c.confidence||0),classificationReason:c.reason||'',classificationYouTubeReason:c.youtubeReason||'',classificationStatus:c.status||0,url:c.kind==='short'?`https://www.youtube.com/shorts/${video.id}`:`https://www.youtube.com/watch?v=${video.id}`}}).filter(Boolean);
  return{channel:{id:channel.id,name:channel.snippet?.title||''},items,classificationWarnings:warnings.slice(0,8),classificationComplete:warnings.length===0,classificationPolicy:'liveStreamingDetails > confirmed classification cache > channel Shorts/videos tabs > /shorts/{videoId} explicit metadata > high-confidence thumbnail fallback; unknown is preserved and duration is never used for Shorts classification',serverTimingMs:Date.now()-startedAt};
}

export default async function handler(req,res){
  const input=String(req.query?.channel||'').trim();if(!input)return res.status(400).json({ok:false,error:'channel を指定してください。'});
  try{const data=await dataApiSnapshot(input);res.setHeader('Cache-Control',data.classificationComplete?'s-maxage=180, stale-while-revalidate=900':'s-maxage=30, stale-while-revalidate=30');res.setHeader('Server-Timing',`youtube;dur=${Number(data.serverTimingMs||0)}`);return res.status(200).json({ok:true,source:'data-api-v2195',...data});}
  catch(error){console.error('[youtube-feed:v2195]',error);const isQuota=error?.code==='YOUTUBE_QUOTA'||quotaLike(error?.reason,error?.statusCode);return res.status(isQuota?429:(error?.statusCode||500)).json({ok:false,error:isQuota?'YouTube Data APIのクォータ上限のため更新できません。保存済み一覧があればそちらを表示します。':'YouTube情報を現在取得できません。保存済み一覧があればそちらを表示します。',reason:error?.reason||error?.code||'',detail:error?.apiData?.error?.message||error?.message||'',retryable:!isQuota});}
}
