import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager } from '../../shared/components.js';
import { clearTwitchPlaybackRecovery, getRecentTwitchPlayback, mountTwitchPlayer } from './twitch-player.js';

const CACHE_KEY='pdv2:twitchCache:v2195';
const CACHE_FRESH_MS=30*1000;
const AUTO_REFRESH_MS=45*1000;
let selected=localStorage.getItem('pdv2:twitchSelected')||'all';
let cache=[];
let loadErrors=[];
let refreshTimer=null;
const views=new WeakMap();
function channelKey(channel){return String(channel.value||channel.url||channel.name||'').trim().toLowerCase();}
function stopAutoRefresh(){if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=null;}
function stayingInTwitch(event){const detail=event?.detail||{};return detail.screen==='media'&&detail.mediaMode==='twitch';}
window.addEventListener('pdv2:before-navigate',event=>{if(!stayingInTwitch(event))stopAutoRefresh();});

async function loadOne(channel,{force=false}={}){
  const value=channel.value||channel.url||channel.name;
  const params=new URLSearchParams({channel:String(value||''),format:'json'});
  if(force)params.set('force','1');
  const response=await fetch(`/api/twitch-feed?${params}`,{headers:{Accept:'application/json'},cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok===false)throw Object.assign(new Error(data.error||'Twitch取得エラー'),{sourceKey:channelKey(channel),code:data?.code||''});
  return {...data,_sourceKey:channelKey(channel),_configuredName:channel.name||''};
}
function readCache(){try{return JSON.parse(localStorage.getItem(CACHE_KEY)||'null');}catch{return null;}}

async function loadBatch(channels,{force=false}={}){
  const inputs=channels.map(channel=>String(channel.value||channel.url||channel.name||'').trim()).filter(Boolean);
  const params=new URLSearchParams({channels:JSON.stringify(inputs),format:'json'});if(force)params.set('force','1');
  const response=await fetch(`/api/twitch-feed?${params}`,{headers:{Accept:'application/json'},cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!Array.isArray(data?.results))throw new Error(data?.error||`Twitch一括取得エラー (${response.status})`);
  return data.results;
}
async function serialFallback(channels,{force=false}={}){
  const results=[];for(const channel of channels){try{results.push({channel,ok:true,snapshot:await loadOne(channel,{force})});}catch(error){results.push({channel,ok:false,error});}}return results;
}

async function loadAll(force=false){
  const previous=readCache();
  if(!force&&previous&&Date.now()-Number(previous.at||0)<CACHE_FRESH_MS){cache=previous.rows||[];loadErrors=[];return cache;}
  const staleByKey=new Map((previous?.rows||[]).map(row=>[String(row?._sourceKey||''),row]));
  const rows=[];const errors=[];let batchResults=[];
  try{
    batchResults=await loadBatch(state.twitchChannels,{force});
    const configuredByInput=new Map(state.twitchChannels.map(channel=>[String(channel.value||channel.url||channel.name||'').trim().toLowerCase(),channel]));
    for(const result of batchResults){
      const channel=configuredByInput.get(String(result?.input||'').trim().toLowerCase())||null;
      const key=channel?channelKey(channel):String(result?.login||result?.input||'').trim().toLowerCase();
      if(result?.ok&&result?.snapshot){rows.push({...result.snapshot,_sourceKey:key,_configuredName:channel?.name||'',_stale:Boolean(result.snapshot?._stale)});continue;}
      const stale=staleByKey.get(key);if(stale){rows.push({...stale,_stale:true});continue;}
      errors.push(`${channel?.name||result?.login||'Twitch'}: ${result?.error||'現在取得できません'}`);
    }
  }catch(batchError){
    console.warn('[twitch-v2195] batch failed, serial fallback',batchError);
    const serial=await serialFallback(state.twitchChannels,{force});
    serial.forEach(result=>{const key=channelKey(result.channel);if(result.ok){rows.push(result.snapshot);return;}const stale=staleByKey.get(key);if(stale){rows.push({...stale,_stale:true});return;}errors.push(`${result.channel?.name||'Twitch'}: ${result.error?.message||'現在取得できません'}`);});
  }
  const deduped=[];const seen=new Set();for(const row of rows){const key=String(row?._sourceKey||row?.broadcaster?.id||row?.broadcaster?.login||'');if(key&&seen.has(key))continue;if(key)seen.add(key);deduped.push(row);}
  cache=deduped;loadErrors=errors;try{localStorage.setItem(CACHE_KEY,JSON.stringify({at:Date.now(),rows:cache}));}catch{}
  if(!cache.length&&errors.length)throw new Error(errors.slice(0,2).join(' / ')||'Twitch一覧を取得できませんでした。');
  return cache;
}

function manage(onDone){
  let sheet;sheet=openSheet(collectionManager({items:state.twitchChannels,fields:[
    {key:'name',label:'表示名',placeholder:'任意'},
    {key:'value',label:'Twitch URL / 配信者名',placeholder:'https://www.twitch.tv/...'}
  ],onSave:draft=>{update('twitchChannels',draft);localStorage.removeItem(CACHE_KEY);sheet.close();onDone();}}),{title:'Twitch配信者編集'});
}
function picker(onChange,onEdit){
  const wrap=el('div');let sheet;
  wrap.append(el('button',{class:'list-item',type:'button',text:'すべての配信者',onclick:()=>{selected='all';localStorage.setItem('pdv2:twitchSelected',selected);sheet?.close();onChange();}}));
  cache.forEach(snapshot=>wrap.append(el('button',{class:'list-item',type:'button',text:snapshot.broadcaster.displayName,onclick:()=>{selected=snapshot.broadcaster.id;localStorage.setItem('pdv2:twitchSelected',selected);sheet?.close();onChange();}})));
  wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit();}}));
  sheet=openSheet(wrap,{title:'Twitch配信者'});
}
function makeQueue(rows){const queue=[];rows.filter(snapshot=>snapshot.live.isLive).forEach(snapshot=>queue.push({snapshot,videoId:''}));rows.flatMap(snapshot=>(snapshot.archives||[]).map(video=>({snapshot,videoId:video.id,createdAt:video.createdAt}))).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).forEach(entry=>queue.push(entry));return queue;}
function unusableThumbnail(url=''){const value=String(url||'').trim();return !value||/(?:404[_-](?:preview|processing)|processing[_-]?preview|placeholder|question|live_user_)/i.test(value);}
function channelPreview(snapshot){const login=String(snapshot?.broadcaster?.login||'').trim();return login?`https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-640x360.jpg`:'';}
function thumbnailElement(snapshot,video){
  const primary=String(video?.thumbnailUrl||'').trim();const preview=channelPreview(snapshot);const profile=String(snapshot?.broadcaster?.profileImageUrl||'').trim();
  const initial=unusableThumbnail(primary)?(profile||preview):primary;
  // v2.19.10: Safariで空のimg srcが現在ページ「/」へ解決されるため、URL候補が無い時は画像要素自体を作らない。
  if(!initial)return el('div',{class:'thumb twitch-archive-thumb thumb-missing'});
  const img=el('img',{class:'thumb twitch-archive-thumb',src:initial,alt:'',loading:'lazy',decoding:'async'});
  let step=0;const candidates=[profile,preview].filter(Boolean);
  img.addEventListener('error',()=>{while(step<candidates.length){const next=candidates[step++];if(next&&next!==img.src){img.src=next;return;}}img.removeAttribute('src');img.classList.add('thumb-missing');});
  return img;
}

function createView(host){
  const pickHost=el('div',{class:'twitch-picker-host'});
  const playerHost=el('div',{class:'twitch-inline-player-host'});
  const contentHost=el('div',{class:'twitch-list-host'});
  host.replaceChildren(pickHost,playerHost,contentHost);
  const view={host,pickHost,playerHost,contentHost};
  views.set(host,view);
  return view;
}

function maybeRestorePlayback(view,queue){
  if(view.playerHost.childElementCount)return;
  const recovery=getRecentTwitchPlayback();
  if(!recovery)return;
  const index=queue.findIndex(item=>String(item.snapshot?.broadcaster?.id||'')===String(recovery.broadcasterId||'')&&String(item.videoId||'')===String(recovery.videoId||''));
  if(index<0){clearTwitchPlaybackRecovery();return;}
  mountTwitchPlayer({host:view.playerHost,queue,index,settings:state.settings});
}

function draw(view){
  if(selected!=='all'&&!cache.some(snapshot=>snapshot.broadcaster.id===selected))selected='all';
  const rows=selected==='all'?cache:cache.filter(snapshot=>snapshot.broadcaster.id===selected);const queue=makeQueue(rows);
  const play=entry=>{const index=queue.findIndex(item=>item.snapshot.broadcaster.id===entry.snapshot.broadcaster.id&&String(item.videoId||'')===String(entry.videoId||''));mountTwitchPlayer({host:view.playerHost,queue,index:Math.max(0,index),settings:state.settings});};
  const pick=el('button',{class:'soft-button channel-picker',type:'button',onclick:()=>picker(()=>draw(view),()=>manage(()=>renderTwitch(view.host,{refresh:true})))},[el('span',{text:`配信者　${selected==='all'?'すべて':rows[0]?.broadcaster.displayName||'配信者'}`}),el('span',{text:'⌄'})]);
  view.pickHost.replaceChildren(pick);

  const content=el('div');if(loadErrors.length)content.append(el('div',{class:'media-warning',text:loadErrors.join(' / ')}));
  const unknownLive=rows.filter(snapshot=>snapshot.live?.statusUnknown&&!snapshot.live?.isLive);if(unknownLive.length)content.append(el('div',{class:'media-warning',text:'一部配信者のLIVE状態を再確認中です。45秒以内に自動更新します。'}));
  const lives=rows.filter(snapshot=>snapshot.live.isLive);
  if(lives.length){const fixed=el('div',{class:'twitch-live-zone'});lives.forEach(snapshot=>fixed.append(el('button',{class:'twitch-live-card',type:'button',onclick:()=>play({snapshot,videoId:''})},[el('div',{class:'live-badge',text:'● LIVE'}),el('div',{class:'media-title twitch-live-title',text:snapshot.live.title}),el('div',{class:'media-meta',text:`${snapshot.broadcaster.displayName} ・ ${Number(snapshot.live.viewerCount||0).toLocaleString()}人視聴`})])));content.append(fixed);}
  const archives=rows.flatMap(snapshot=>(snapshot.archives||[]).map(video=>({snapshot,video}))).sort((a,b)=>new Date(b.video.createdAt)-new Date(a.video.createdAt));
  if(archives.length){content.append(el('div',{class:'section-label',text:'アーカイブ'}));const list=el('div',{class:'media-list'});archives.forEach(({snapshot,video})=>list.append(el('button',{class:'media-row',type:'button',onclick:()=>play({snapshot,videoId:video.id})},[thumbnailElement(snapshot,video),el('div',{class:'media-row-copy'},[el('div',{class:'media-title',text:video.title||'アーカイブ'}),el('div',{class:'media-meta',text:snapshot.broadcaster.displayName})])])));content.append(list);}
  if(!lives.length&&!archives.length)content.append(el('div',{class:'empty',text:'配信・アーカイブがありません'}));
  view.contentHost.replaceChildren(content);
  maybeRestorePlayback(view,queue);
}

function scheduleAutoRefresh(view){
  stopAutoRefresh();
  if(!view?.host?.isConnected)return;
  refreshTimer=setTimeout(async()=>{
    refreshTimer=null;
    if(!view.host.isConnected)return;
    try{
      await loadAll(true);
      if(view.host.isConnected)draw(view);
    }catch(error){
      console.warn('[twitch-auto-refresh]',error?.message||error);
    }finally{
      if(view.host.isConnected)scheduleAutoRefresh(view);
    }
  },AUTO_REFRESH_MS);
}

export async function renderTwitch(host,{refresh=false}={}){
  stopAutoRefresh();
  let view=views.get(host);
  const reusable=Boolean(view?.host===host&&view.pickHost?.isConnected&&view.playerHost?.isConnected&&view.contentHost?.isConnected);
  if(!reusable)host.innerHTML='<div class="loading">Twitchを読み込み中...</div>';

  if(!state.twitchChannels.length){
    if(!reusable)view=createView(host);
    view.pickHost.replaceChildren();
    view.contentHost.replaceChildren(
      el('div',{class:'empty',text:'配信者を追加してください'}),
      el('button',{class:'primary-button full-button',type:'button',text:'Twitch配信者を追加',onclick:()=>manage(()=>renderTwitch(host,{refresh:true}))})
    );
    return;
  }

  try{await loadAll(refresh);}catch(error){
    if(!reusable)host.replaceChildren(el('div',{class:'error-box',text:error.message}));
    else view.contentHost.replaceChildren(el('div',{class:'error-box',text:error.message}));
    return;
  }
  if(!reusable)view=createView(host);
  draw(view);
  scheduleAutoRefresh(view);
}
