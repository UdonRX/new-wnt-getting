let tokenCache={token:'',expiresAt:0};
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function getCredentials(){
  const clientId=String(process.env.TWITCH_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.TWITCH_CLIENT_SECRET||'').trim();
  if(!clientId||!clientSecret) throw Object.assign(new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET がVercelに設定されていません。'),{statusCode:500});
  return {clientId,clientSecret};
}

export function normalizeTwitchLogin(value){
  let raw=String(value||'').trim();
  if(!raw)return '';
  try{
    if(/^https?:\/\//i.test(raw)){
      const url=new URL(raw);
      if(!/(^|\.)twitch\.tv$/i.test(url.hostname))return '';
      raw=url.pathname.split('/').filter(Boolean)[0]||'';
    }else{
      raw=raw.replace(/^@/,'').replace(/^www\.twitch\.tv\//i,'').replace(/^twitch\.tv\//i,'').split(/[/?#]/)[0];
    }
  }catch{return '';}
  raw=raw.trim().toLowerCase();
  return /^[a-z0-9_]{2,25}$/i.test(raw)?raw:'';
}

async function getAppAccessToken({force=false}={}){
  const {clientId,clientSecret}=getCredentials();
  const now=Date.now();
  if(!force&&tokenCache.token&&tokenCache.expiresAt>now+60000)return {clientId,token:tokenCache.token};
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'});
  let lastError;
  for(let attempt=0;attempt<2;attempt+=1){
    try{
      const response=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(9000)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.access_token)throw Object.assign(new Error(data?.message||'Twitch App Access Tokenの取得に失敗しました。'),{statusCode:response.status||502});
      const expiresIn=Math.max(300,Number(data.expires_in)||3600);
      tokenCache={token:data.access_token,expiresAt:Date.now()+expiresIn*1000};
      return {clientId,token:data.access_token};
    }catch(error){lastError=error;if(attempt===0)await sleep(300);}
  }
  throw lastError;
}

async function helix(path,params={}){
  let forceToken=false;
  let lastError;
  for(let attempt=0;attempt<3;attempt+=1){
    const {clientId,token}=await getAppAccessToken({force:forceToken});
    const url=new URL(`https://api.twitch.tv/helix/${path}`);
    Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));});
    try{
      const response=await fetch(url,{headers:{'Client-Id':clientId,'Authorization':`Bearer ${token}`,'Accept':'application/json'},signal:AbortSignal.timeout(9000)});
      const data=await response.json().catch(()=>({}));
      if(response.ok)return data;
      const error=Object.assign(new Error(data?.message||`Twitch APIエラー (HTTP ${response.status})`),{statusCode:response.status||502});
      lastError=error;
      if(response.status===401&&attempt<2){tokenCache={token:'',expiresAt:0};forceToken=true;await sleep(120);continue;}
      if([429,500,502,503,504].includes(response.status)&&attempt<2){await sleep(attempt?700:250);continue;}
      throw error;
    }catch(error){
      lastError=error;
      if((error?.name==='TimeoutError'||error?.name==='AbortError')&&attempt<2){await sleep(attempt?600:200);continue;}
      throw error;
    }
  }
  throw lastError||new Error('Twitch API error');
}

export async function getTwitchChannelSnapshot(input,{archiveLimit=20}={}){
  const login=normalizeTwitchLogin(input);
  if(!login)throw Object.assign(new Error('Twitchの配信者名またはチャンネルURLが正しくありません。'),{statusCode:400});
  const userData=await helix('users',{login});
  const user=userData?.data?.[0];
  if(!user)throw Object.assign(new Error(`Twitch配信者「${login}」が見つかりません。`),{statusCode:404});

  const [streamResult,videoResult]=await Promise.allSettled([
    helix('streams',{user_id:user.id,first:1}),
    helix('videos',{user_id:user.id,type:'archive',sort:'time',first:Math.max(1,Math.min(Number(archiveLimit)||20,50))})
  ]);
  const stream=streamResult.status==='fulfilled'?streamResult.value?.data?.[0]||null:null;
  const archivesRaw=videoResult.status==='fulfilled'?videoResult.value?.data||[]:[];
  const channelUrl=`https://www.twitch.tv/${user.login}`;
  return {
    broadcaster:{id:user.id,login:user.login,displayName:user.display_name||user.login,profileImageUrl:user.profile_image_url||'',channelUrl},
    live:stream?{
      isLive:true,title:stream.title||`${user.display_name||user.login} のライブ配信`,url:channelUrl,gameName:stream.game_name||'',startedAt:stream.started_at||'',viewerCount:Number(stream.viewer_count)||0,
      thumbnailUrl:String(stream.thumbnail_url||'').replace('{width}','640').replace('{height}','360')
    }:{isLive:false,title:'',url:channelUrl,gameName:'',startedAt:'',viewerCount:0,thumbnailUrl:''},
    archives:archivesRaw.map(video=>({
      id:video.id,title:video.title||'アーカイブ',url:video.url||`https://www.twitch.tv/videos/${video.id}`,
      createdAt:video.created_at||video.published_at||'',publishedAt:video.published_at||video.created_at||'',duration:video.duration||'',viewCount:Number(video.view_count)||0,
      thumbnailUrl:String(video.thumbnail_url||'').replace('%{width}','640').replace('%{height}','360').replace('{width}','640').replace('{height}','360')
    })),
    partialErrors:{
      stream:streamResult.status==='rejected'?String(streamResult.reason?.message||''):'',
      archives:videoResult.status==='rejected'?String(videoResult.reason?.message||''):''
    }
  };
}
