const API='https://www.googleapis.com/youtube/v3';
const EXACT_CHANNEL_ID=/^UC[A-Za-z0-9_-]{22}$/;
const MAX_DISCOVERY_QUERIES=5;
const SEARCH_RESULTS_PER_QUERY=25;
const MAX_DISCOVERY_CANDIDATES=110;
const MAX_STRICT_PROBES=72;
const STRICT_PROBE_CONCURRENCY=8;
const CHANNEL_SHORTS_LIMIT=50;
const HTML_HEADERS={
  'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  'Accept':'text/html,application/xhtml+xml',
  'Accept-Language':'ja,en-US;q=0.7,en;q=0.5'
};
const STOP_WORDS=new Set([
  'shorts','short','youtube','official','video','動画','ショート','shortvideo','公式','チャンネル','channel',
  'これ','それ','あれ','この','その','から','まで','ため','など','です','ます','する','した','して','いる','ある','ない','こと','もの','よう','さん','ちゃん',
  'the','and','for','with','from','this','that','you','your','are','was','were','have','has','had','not','but','into','out','about','how','what','why','when','where'
]);

function apiKey(){return String(process.env.YOUTUBE_API_KEY||'').trim()}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function apiReason(data={}){return String(data?.error?.errors?.[0]?.reason||data?.error?.status||'youtubeApiError')}
function quotaLike(reason='',status=0){return Number(status)===429||/quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason))}
function transient(status=0,reason=''){return[408,425,429,500,502,503,504].includes(Number(status))||/backendError|internalError|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason))}

async function yt(path,params){
  const key=apiKey();
  if(!key)throw Object.assign(new Error('YOUTUBE_API_KEY がVercelに設定されていません'),{statusCode:500,code:'NO_API_KEY',reason:'keyMissing'});
  const url=new URL(`${API}/${path}`);
  Object.entries({...params,key}).forEach(([name,value])=>{if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(name,String(value))});
  let lastError;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(7000)});
      const data=await response.json().catch(()=>({}));
      if(response.ok)return data;
      const reason=apiReason(data);
      const error=Object.assign(new Error(data?.error?.message||`YouTube API ${response.status}`),{statusCode:response.status,code:quotaLike(reason,response.status)?'YOUTUBE_QUOTA':'YOUTUBE_API',reason,apiData:data});
      lastError=error;
      if(attempt===0&&transient(response.status,reason)&&!/quotaExceeded|dailyLimitExceeded/i.test(reason)){await sleep(220);continue}
      throw error;
    }catch(error){
      lastError=error;
      if(attempt===0&&(error?.name==='TimeoutError'||error?.name==='AbortError'||/fetch failed|network/i.test(String(error?.message||'')))){await sleep(160);continue}
      throw error;
    }
  }
  throw lastError||new Error('YouTube API error');
}

async function fetchHtml(url,{timeout=3500,max=1500000,withMeta=false}={}){
  const response=await fetch(url,{redirect:'follow',headers:HTML_HEADERS,signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw Object.assign(new Error(`YouTube HTML ${response.status}`),{status:response.status});
  const html=(await response.text()).slice(0,max);
  return withMeta?{html,finalUrl:response.url,status:response.status}:html;
}
function collectMatches(html,patterns){const ids=new Set();for(const pattern of patterns){pattern.lastIndex=0;let match;while((match=pattern.exec(String(html))))if(match[1])ids.add(match[1]);}return ids}
function extractShortIds(html=''){return collectMatches(html, [/"shortsLockupViewModel"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelItemRenderer"[\s\S]{0,1800}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"reelWatchEndpoint"[\s\S]{0,1200}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,/"url"\s*:\s*"\\?\/shorts\/([A-Za-z0-9_-]{11})(?:[?\\"/]|$)/g])}
function explicitShortSignal(html='',videoId=''){
  const text=String(html),id=String(videoId);if(!id)return false;
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:reelWatchEndpoint|shortsLockupViewModel)[\\s\\S]{0,2200}?"videoId"\\s*:\\s*"${escaped}"`).test(text)||new RegExp(`"url"\\s*:\\s*"\\\\?/shorts/${escaped}(?:[?\\\\"/]|$)`).test(text)||/WEB_PAGE_TYPE_SHORTS/.test(text);
}
async function probeShort(videoId){
  try{
    const page=await fetchHtml(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`,{withMeta:true});
    let finalIsShort=false;try{finalIsShort=new URL(page.finalUrl).pathname.startsWith('/shorts/')}catch{}
    return Boolean(finalIsShort&&explicitShortSignal(page.html,videoId));
  }catch{return false}
}
async function mapConcurrent(values,limit,worker){
  const result=new Array(values.length);let cursor=0;
  const workers=Array.from({length:Math.min(limit,Math.max(1,values.length))},async()=>{while(true){const index=cursor++;if(index>=values.length)return;try{result[index]=await worker(values[index],index)}catch{result[index]=null}}});
  await Promise.all(workers);return result;
}
function durationSeconds(iso=''){const match=String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);return match?Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0):0}
function cleanText(value=''){return String(value||'').replace(/https?:\/\/\S+/g,' ').replace(/[\u{1F300}-\u{1FAFF}]/gu,' ').replace(/[#＠@]/g,' ').toLowerCase()}
function tokenize(value=''){
  const text=cleanText(value);const out=[];
  try{
    if(Intl?.Segmenter){const seg=new Intl.Segmenter('ja',{granularity:'word'});for(const part of seg.segment(text)){const word=String(part.segment||'').trim();if(part.isWordLike&&word.length>=2)out.push(word)}}
  }catch{}
  if(!out.length)out.push(...text.match(/[a-z0-9][a-z0-9_-]{1,30}|[ぁ-んァ-ヶ一-龯]{2,18}/g)||[]);
  return out.map(x=>x.replace(/^[_-]+|[_-]+$/g,'')).filter(x=>x.length>=2&&x.length<=30&&!STOP_WORDS.has(x)&&!/^\d+$/.test(x));
}
function addWeight(map,word,weight){if(!word||STOP_WORDS.has(word))return;map.set(word,(map.get(word)||0)+weight)}
function ageMultiplier(at){const ageDays=Math.max(0,(Date.now()-Number(at||Date.now()))/86400000);return Math.max(.18,Math.exp(-ageDays/28))}
async function videoDetails(ids,parts='snippet,contentDetails,status'){
  const unique=[...new Set((ids||[]).filter(id=>/^[A-Za-z0-9_-]{11}$/.test(String(id))))];const items=[];
  for(let i=0;i<unique.length;i+=50){const data=await yt('videos',{part:parts,id:unique.slice(i,i+50).join(',')});items.push(...(data.items||[]))}
  return items;
}
function buildProfile(videos,history=[]){
  const historyMap=new Map(history.map(row=>[String(row?.videoId||''),row]));const terms=new Map(),categories=new Map();
  for(const video of videos){
    const event=historyMap.get(video.id);const behaviorWeight=event?Math.max(-4,Math.min(6,Number(event.score||1)))*ageMultiplier(event.at):1;
    if(behaviorWeight<=-2)continue;
    const w=Math.max(.25,behaviorWeight);
    for(const tag of video.snippet?.tags||[])for(const token of tokenize(tag))addWeight(terms,token,4.2*w);
    for(const token of tokenize(video.snippet?.title||''))addWeight(terms,token,2.8*w);
    for(const token of tokenize(String(video.snippet?.description||'').slice(0,700)))addWeight(terms,token,.55*w);
    const category=String(video.snippet?.categoryId||'');if(category)categories.set(category,(categories.get(category)||0)+2*w);
  }
  const topTerms=[...terms.entries()].sort((a,b)=>b[1]-a[1]).slice(0,24).map(([term,weight])=>({term,weight}));
  const topCategories=[...categories.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([id,weight])=>({id,weight}));
  return{terms,topTerms,topCategories};
}
function makeQueries(profile,count){
  const terms=profile.topTerms.map(x=>x.term);const queries=[];const add=q=>{q=q.filter(Boolean).join(' ').trim();if(q&&!queries.includes(q))queries.push(q)};
  add([terms[0],terms[1]]);add([terms[0],terms[2]]);add([terms[3],terms[4]]);add([terms[1],terms[5]]);add([terms[6],terms[7]]);
  for(const term of terms){if(queries.length>=count)break;add([term])}
  return queries.slice(0,count);
}
function itemFromVideo(video){
  return{videoId:video.id,title:video.snippet?.title||'無題',description:String(video.snippet?.description||'').slice(0,900),tags:(video.snippet?.tags||[]).slice(0,20),categoryId:String(video.snippet?.categoryId||''),channelId:video.snippet?.channelId||'',channelName:video.snippet?.channelTitle||'',publishedAt:video.snippet?.publishedAt||'',thumbnail:video.snippet?.thumbnails?.high?.url||video.snippet?.thumbnails?.medium?.url||video.snippet?.thumbnails?.default?.url||'',durationSeconds:durationSeconds(video.contentDetails?.duration),kind:'short',url:`https://www.youtube.com/shorts/${video.id}`};
}
function candidateScore(video,profile){
  let score=0;
  for(const token of tokenize(video.snippet?.title||''))score+=(profile.terms.get(token)||0)*1.2;
  for(const tag of video.snippet?.tags||[])for(const token of tokenize(tag))score+=(profile.terms.get(token)||0)*1.45;
  for(const token of tokenize(String(video.snippet?.description||'').slice(0,500)))score+=(profile.terms.get(token)||0)*.16;
  const cat=profile.topCategories.find(x=>x.id===String(video.snippet?.categoryId||''));if(cat)score+=8+Math.min(12,cat.weight);
  const ageDays=Math.max(0,(Date.now()-new Date(video.snippet?.publishedAt||0).getTime())/86400000);score+=Math.max(0,10-Math.log2(ageDays+1)*1.8);
  score+=Math.random()*8;
  return score;
}
async function channelSearch(query){
  const data=await yt('search',{part:'snippet',type:'channel',q:query,maxResults:8,regionCode:'JP',relevanceLanguage:'ja'});
  return(data.items||[]).map(item=>({channelId:item.id?.channelId||item.snippet?.channelId||'',name:item.snippet?.title||'YouTube',description:String(item.snippet?.description||'').slice(0,180),thumbnail:item.snippet?.thumbnails?.medium?.url||item.snippet?.thumbnails?.default?.url||''})).filter(x=>EXACT_CHANNEL_ID.test(x.channelId));
}
async function discover(body={}){
  const requested=Math.max(1,Math.min(MAX_DISCOVERY_QUERIES,Number(body.searchCount||5)));
  const seedIds=(Array.isArray(body.seedVideoIds)?body.seedVideoIds:[]).slice(0,50);
  const history=(Array.isArray(body.history)?body.history:[]).slice(0,80);
  const historyIds=history.sort((a,b)=>Number(b?.at||0)-Number(a?.at||0)).slice(0,35).map(x=>x?.videoId);
  const sourceVideos=await videoDetails([...seedIds,...historyIds]);
  const profile=buildProfile(sourceVideos,history);const queries=makeQueries(profile,requested);
  if(!queries.length)throw Object.assign(new Error('登録済み動画から発見テーマを作れませんでした'),{statusCode:422,reason:'profileEmpty'});
  const excludeChannels=new Set([...(body.registeredChannelIds||[]),...(body.hiddenChannelIds||[])].map(String));
  const excludeVideos=new Set((body.excludedVideoIds||[]).map(String));
  const ids=[];
  for(const q of queries){
    const data=await yt('search',{part:'snippet',type:'video',q,maxResults:SEARCH_RESULTS_PER_QUERY,videoDuration:'short',videoEmbeddable:'true',safeSearch:'moderate',regionCode:'JP',relevanceLanguage:'ja',order:'relevance'});
    for(const item of data.items||[]){const id=item.id?.videoId;if(id&&!excludeVideos.has(id)&&!ids.includes(id))ids.push(id);if(ids.length>=MAX_DISCOVERY_CANDIDATES)break}
    if(ids.length>=MAX_DISCOVERY_CANDIDATES)break;
  }
  const details=await videoDetails(ids);
  const ranked=details.filter(v=>v.status?.embeddable!==false&&!excludeChannels.has(String(v.snippet?.channelId||''))&&!excludeVideos.has(v.id)).map(video=>({video,score:candidateScore(video,profile)})).sort((a,b)=>b.score-a.score).slice(0,MAX_STRICT_PROBES);
  const strict=await mapConcurrent(ranked,STRICT_PROBE_CONCURRENCY,row=>probeShort(row.video.id));
  const perChannel=new Map(),pool=[];
  ranked.forEach((row,index)=>{if(!strict[index])return;const channelId=String(row.video.snippet?.channelId||''),count=perChannel.get(channelId)||0;if(count>=3)return;perChannel.set(channelId,count+1);pool.push({...itemFromVideo(row.video),discoveryScore:Number(row.score.toFixed(2))})});
  pool.sort((a,b)=>(b.discoveryScore+Math.random()*10)-(a.discoveryScore+Math.random()*10));
  return{items:pool.slice(0,40),queries,searchCalls:queries.length,profile:{terms:profile.topTerms.slice(0,12),categories:profile.topCategories}};
}
async function channelShorts(channelId){
  if(!EXACT_CHANNEL_ID.test(channelId))throw Object.assign(new Error('Channel ID が正しくありません'),{statusCode:400,reason:'invalidChannelId'});
  const channel=(await yt('channels',{part:'snippet,contentDetails',id:channelId})).items?.[0];
  if(!channel)throw Object.assign(new Error('チャンネルが見つかりません'),{statusCode:404,reason:'channelNotFound'});
  const uploads=channel.contentDetails?.relatedPlaylists?.uploads;if(!uploads)throw Object.assign(new Error('アップロード一覧が見つかりません'),{statusCode:404,reason:'uploadsMissing'});
  const playlist=await yt('playlistItems',{part:'contentDetails',playlistId:uploads,maxResults:CHANNEL_SHORTS_LIMIT});
  const ids=(playlist.items||[]).map(x=>x.contentDetails?.videoId).filter(Boolean);const details=await videoDetails(ids);
  let tabIds=new Set();try{tabIds=extractShortIds(await fetchHtml(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/shorts`,{timeout:4300,max:1800000}))}catch{}
  const candidates=details.filter(v=>durationSeconds(v.contentDetails?.duration)<=240);const unknown=candidates.filter(v=>!tabIds.has(v.id)).slice(0,30);
  const probes=await mapConcurrent(unknown,STRICT_PROBE_CONCURRENCY,v=>probeShort(v.id));const probed=new Set(unknown.filter((_,i)=>probes[i]).map(v=>v.id));
  const items=candidates.filter(v=>tabIds.has(v.id)||probed.has(v.id)).map(itemFromVideo).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
  return{channel:{id:channel.id,name:channel.snippet?.title||'',thumbnail:channel.snippet?.thumbnails?.medium?.url||channel.snippet?.thumbnails?.default?.url||''},items};
}

function sendError(res,error){
  const isQuota=error?.code==='YOUTUBE_QUOTA'||quotaLike(error?.reason,error?.statusCode);const status=isQuota?429:(error?.statusCode||500);
  return res.status(status).json({ok:false,error:isQuota?'YouTube検索APIの上限に達したため、新しい発見候補を取得できません。保存済み候補があればそちらを利用してください。':(error?.message||'YouTube情報を取得できませんでした'),reason:error?.reason||error?.code||'',detail:error?.apiData?.error?.message||'',retryable:!isQuota});
}

export default async function youtubeDiscovery(req,res){
  const action=String(req.query?.action||req.body?.action||'').trim();
  try{
    if(action==='channel-search'){
      const q=String(req.query?.q||'').trim();if(q.length<2)return res.status(400).json({ok:false,error:'検索文字を2文字以上入力してください'});
      const items=await channelSearch(q);res.setHeader('Cache-Control','s-maxage=86400, stale-while-revalidate=86400');return res.status(200).json({ok:true,items,searchCalls:1});
    }
    if(action==='discover'){
      if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
      const data=await discover(req.body||{});res.setHeader('Cache-Control','no-store');return res.status(200).json({ok:true,...data});
    }
    if(action==='channel-shorts'){
      const channelId=String(req.query?.channel||'').trim();const data=await channelShorts(channelId);res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=21600');return res.status(200).json({ok:true,...data,searchCalls:0});
    }
    return res.status(400).json({ok:false,error:'未知のYouTube actionです'});
  }catch(error){console.error('[youtube-discovery]',{action,name:error?.name,message:error?.message,reason:error?.reason});return sendError(res,error)}
}
