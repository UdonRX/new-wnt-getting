let tokenCache={token:'',expiresAt:0};
const snapshotCache=new Map();
const SNAPSHOT_FRESH_MS=30*1000;
const SNAPSHOT_STALE_MS=6*60*60*1000;
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function getCredentials(){
  const clientId=String(process.env.TWITCH_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.TWITCH_CLIENT_SECRET||'').trim();
  if(!clientId||!clientSecret){throw Object.assign(new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET がVercelに設定されていません。'),{statusCode:500,code:'TWITCH_CONFIG'});}
  return {clientId,clientSecret};
}

export function normalizeTwitchLogin(value){
  let raw=String(value||'').trim();if(!raw)return '';
  try{
    if(/^https?:\/\//i.test(raw)){const url=new URL(raw);if(!/(^|\.)twitch\.tv$/i.test(url.hostname))return '';raw=url.pathname.split('/').filter(Boolean)[0]||'';}
    else raw=raw.replace(/^@/,'').replace(/^www\.twitch\.tv\//i,'').replace(/^twitch\.tv\//i,'').split(/[/?#]/)[0];
  }catch{return '';}
  raw=raw.trim().toLowerCase();return /^[a-z0-9_]{2,25}$/i.test(raw)?raw:'';
}

function cachedSnapshot(login,{freshOnly=false}={}){
  const row=snapshotCache.get(login);if(!row?.snapshot)return null;
  const age=Date.now()-Number(row.at||0);if(age>(freshOnly?SNAPSHOT_FRESH_MS:SNAPSHOT_STALE_MS)){if(!freshOnly)snapshotCache.delete(login);return null;}
  return {...row.snapshot,_serverCache:freshOnly?'fresh':'stale'};
}
function putSnapshot(login,snapshot){snapshotCache.set(login,{at:Date.now(),snapshot});while(snapshotCache.size>80)snapshotCache.delete(snapshotCache.keys().next().value);return snapshot;}

async function getAppAccessToken({force=false}={}){
  const {clientId,clientSecret}=getCredentials();const now=Date.now();if(!force&&tokenCache.token&&tokenCache.expiresAt>now+60000)return {clientId,token:tokenCache.token};
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'});let lastError;
  for(let attempt=0;attempt<3;attempt+=1){
    try{
      const response=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body,signal:AbortSignal.timeout(8500)});
      const data=await response.json().catch(()=>({}));if(!response.ok||!data.access_token)throw Object.assign(new Error(data?.message||`Twitch App Access Tokenの取得に失敗しました (HTTP ${response.status})`),{statusCode:response.status||502});
      const expiresIn=Math.max(300,Number(data.expires_in)||3600);tokenCache={token:data.access_token,expiresAt:Date.now()+expiresIn*1000};return {clientId,token:data.access_token};
    }catch(error){lastError=error;if(attempt<2)await sleep(250*(attempt+1));}
  }
  throw lastError;
}

async function helix(path,params={}){
  let forceToken=false,lastError;
  for(let attempt=0;attempt<4;attempt+=1){
    let credentials;
    try{credentials=await getAppAccessToken({force:forceToken});}catch(error){lastError=error;if(attempt<3){await sleep(250*(attempt+1));forceToken=true;continue;}throw error;}
    const {clientId,token}=credentials;const url=new URL(`https://api.twitch.tv/helix/${path}`);Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));});
    try{
      const response=await fetch(url,{headers:{'Client-Id':clientId,'Authorization':`Bearer ${token}`,'Accept':'application/json'},signal:AbortSignal.timeout(8500)});const data=await response.json().catch(()=>({}));if(response.ok)return data;
      const error=Object.assign(new Error(data?.message||`Twitch APIエラー (HTTP ${response.status})`),{statusCode:response.status||502});lastError=error;
      if(response.status===401&&attempt<3){tokenCache={token:'',expiresAt:0};forceToken=true;await sleep(120);continue;}
      if([408,425,429,500,502,503,504].includes(response.status)&&attempt<3){const retryAfter=Math.min(1800,Math.max(180,Number(response.headers.get('retry-after')||0)*1000||0));await sleep(retryAfter||250*(attempt+1));continue;}
      throw error;
    }catch(error){lastError=error;if((error?.name==='TimeoutError'||error?.name==='AbortError'||error instanceof TypeError)&&attempt<3){await sleep(220*(attempt+1));continue;}throw error;}
  }
  throw lastError||new Error('Twitch API error');
}

function liveFromStream(stream,user,channelUrl){
  return stream?{
    isLive:true,title:stream.title||`${user.display_name||user.login} のライブ配信`,url:channelUrl,gameName:stream.game_name||'',startedAt:stream.started_at||'',viewerCount:Number(stream.viewer_count)||0,
    thumbnailUrl:String(stream.thumbnail_url||'').replace('{width}','640').replace('{height}','360'),checkedAt:new Date().toISOString(),statusUnknown:false
  }:{isLive:false,title:'',url:channelUrl,gameName:'',startedAt:'',viewerCount:0,thumbnailUrl:'',checkedAt:new Date().toISOString(),statusUnknown:false};
}
function archiveRows(raw=[]){return raw.map(video=>({
  id:video.id,title:video.title||'アーカイブ',url:video.url||`https://www.twitch.tv/videos/${video.id}`,
  createdAt:video.created_at||video.published_at||'',publishedAt:video.published_at||video.created_at||'',duration:video.duration||'',viewCount:Number(video.view_count)||0,
  thumbnailUrl:String(video.thumbnail_url||'').replace('%{width}','640').replace('%{height}','360').replace('{width}','640').replace('{height}','360')
}));}
function mergeArchives(fresh=[],stale=[],limit=50){
  const map=new Map();for(const row of [...fresh,...stale]){const id=String(row?.id||'');if(id&&!map.has(id))map.set(id,row);}
  return [...map.values()].sort((a,b)=>new Date(b.createdAt||b.publishedAt||0)-new Date(a.createdAt||a.publishedAt||0)).slice(0,Math.max(1,Math.min(Number(limit)||50,50)));
}

export async function getTwitchChannelSnapshot(input,{archiveLimit=50,force=false,allowStale=true}={}){
  const login=normalizeTwitchLogin(input);if(!login)throw Object.assign(new Error('Twitchの配信者名またはチャンネルURLが正しくありません。'),{statusCode:400});
  if(!force){const fresh=cachedSnapshot(login,{freshOnly:true});if(fresh)return fresh;}

  try{
    const userData=await helix('users',{login});const user=userData?.data?.[0];if(!user)throw Object.assign(new Error(`Twitch配信者「${login}」が見つかりません。`),{statusCode:404});
    const stale=allowStale?cachedSnapshot(login):null;
    const [streamResult,videoResult]=await Promise.allSettled([
      helix('streams',{user_id:user.id,first:1}),
      helix('videos',{user_id:user.id,type:'archive',sort:'time',first:Math.max(1,Math.min(Number(archiveLimit)||50,50))})
    ]);

    if(streamResult.status==='rejected'&&videoResult.status==='rejected'){
      if(stale)return {...stale,_stale:true,_staleReason:'Twitch API temporary failure'};
      throw streamResult.reason||videoResult.reason||new Error('Twitch API temporary failure');
    }

    const channelUrl=`https://www.twitch.tv/${user.login}`;
    const live=streamResult.status==='fulfilled'
      ? liveFromStream(streamResult.value?.data?.[0]||null,user,channelUrl)
      : stale?.live
        ? {...stale.live,statusUnknown:true,checkedAt:new Date().toISOString()}
        : {isLive:false,title:'',url:channelUrl,gameName:'',startedAt:'',viewerCount:0,thumbnailUrl:'',statusUnknown:true,checkedAt:new Date().toISOString()};

    const freshArchives=videoResult.status==='fulfilled'?archiveRows(videoResult.value?.data||[]):[];
    const archives=videoResult.status==='fulfilled'
      ? mergeArchives(freshArchives,stale?.archives||[],archiveLimit)
      : mergeArchives([],stale?.archives||[],archiveLimit);

    const snapshot={
      broadcaster:{id:user.id,login:user.login,displayName:user.display_name||user.login,profileImageUrl:user.profile_image_url||'',channelUrl},
      live,archives,
      partialErrors:{stream:streamResult.status==='rejected'?String(streamResult.reason?.message||''):'',archives:videoResult.status==='rejected'?String(videoResult.reason?.message||''):''}
    };

    if(streamResult.status==='fulfilled'&&videoResult.status==='fulfilled')return putSnapshot(login,snapshot);
    return {...snapshot,_partial:true};
  }catch(error){
    const stale=allowStale?cachedSnapshot(login):null;
    if(stale&&Number(error?.statusCode)!==400&&Number(error?.statusCode)!==404)return {...stale,_stale:true,_staleReason:String(error?.message||error||'')};
    throw error;
  }
}
