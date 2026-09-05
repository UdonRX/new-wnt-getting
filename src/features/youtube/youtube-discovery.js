import { showToast } from '../../shared/dom.js';
import { mountYouTubePlayer, cleanupYouTubePlayer } from './youtube-player.js';

const HISTORY_KEY='pdv2:youtubeDiscoveryHistory:v1';
const LIKES_KEY='pdv2:youtubeDiscoveryLikes:v1';
const DISLIKES_KEY='pdv2:youtubeDiscoveryDislikes:v1';
const HIDDEN_CHANNELS_KEY='pdv2:youtubeDiscoveryHiddenChannels:v1';
const POOL_KEY='pdv2:youtubeDiscoveryPool:v1';
const SEARCH_USAGE_KEY='pdv2:youtubeSearchUsage:v1';
const CHANNEL_SEARCH_CACHE_KEY='pdv2:youtubeChannelSearchCache:v1';
const POOL_TTL=6*60*60*1000;
const CHANNEL_SEARCH_TTL=24*60*60*1000;
const DISCOVERY_DAILY_SOFT_LIMIT=85;
const SEARCH_TOTAL_SOFT_LIMIT=94;
const HISTORY_MAX=200;
const CHANNEL_ID_RE=/^UC[A-Za-z0-9_-]{22}$/;
let discoverySession=null;
let discoveryLoading=null;

function readJson(key,fallback){try{const value=JSON.parse(localStorage.getItem(key)||'null');return value??fallback}catch{return fallback}}
function writeJson(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
function todayKey(){try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(new Date())}catch{return new Date().toISOString().slice(0,10)}}
function usage(){const current=readJson(SEARCH_USAGE_KEY,{});if(current.date!==todayKey())return{date:todayKey(),discover:0,channel:0};return{date:current.date,discover:Number(current.discover||0),channel:Number(current.channel||0)}}
function addUsage(kind,count){const current=usage();current[kind]=Number(current[kind]||0)+Math.max(0,Number(count||0));writeJson(SEARCH_USAGE_KEY,current);return current}
function allowedDiscoverySearchCount(requested){const current=usage();const byDiscover=Math.max(0,DISCOVERY_DAILY_SOFT_LIMIT-current.discover);const byTotal=Math.max(0,SEARCH_TOTAL_SOFT_LIMIT-current.discover-current.channel);return Math.max(0,Math.min(Number(requested||0),byDiscover,byTotal))}
function setValues(key){return new Set(readJson(key,[]).map(String))}
function saveSet(key,set,max=300){writeJson(key,[...set].slice(-max))}
function historyRows(){const value=readJson(HISTORY_KEY,[]);return Array.isArray(value)?value:[]}
function upsertHistory(item,{delta=1,reason='open'}={}){
  const videoId=String(item?.videoId||'');if(!videoId)return;
  const rows=historyRows();const index=rows.findIndex(x=>x.videoId===videoId);const old=index>=0?rows[index]:{};
  const next={videoId,channelId:String(item?.channelId||old.channelId||''),kind:String(item?.kind||old.kind||''),at:Date.now(),views:Number(old.views||0)+(reason==='open'?1:0),score:Math.max(-6,Math.min(8,Number(old.score||0)+Number(delta||0)))};
  if(index>=0)rows.splice(index,1);rows.unshift(next);writeJson(HISTORY_KEY,rows.slice(0,HISTORY_MAX));
}
export function recordYouTubeOpen(item){if(!item?.videoId||item?.kind==='live')return;upsertHistory(item,{delta:.8,reason:'open'})}
function historyPayload(){return historyRows().slice(0,80).map(({videoId,at,score})=>({videoId,at,score}))}
function recentlySeenIds(){return historyRows().slice(0,120).map(x=>x.videoId)}
function normalizedName(value=''){return String(value||'').trim().toLocaleLowerCase('ja-JP')}
function hiddenTokens(item={}){const tokens=[];const id=String(item.channelId||'').trim();const name=normalizedName(item.channelName);if(id)tokens.push(id);if(name)tokens.push(`name:${name}`);return tokens}
function isHidden(item,hidden=setValues(HIDDEN_CHANNELS_KEY)){return hiddenTokens(item).some(token=>hidden.has(token))}
function isAllowed(item,registeredIds=[]){
  if(!item?.videoId)return false;
  if(setValues(DISLIKES_KEY).has(String(item.videoId)))return false;
  if(isHidden(item))return false;
  const id=String(item.channelId||'');if(id&&new Set(registeredIds.map(String)).has(id))return false;
  return true;
}

function ensureStyles(){
  if(document.getElementById('pdv2-youtube-discovery-styles'))return;
  const style=document.createElement('style');style.id='pdv2-youtube-discovery-styles';style.textContent=`
.youtube-discovery-fab{position:fixed;z-index:118;right:max(18px,calc(env(safe-area-inset-right) + 14px));bottom:calc(var(--nav-total) + 18px);width:58px;height:58px;min-width:58px;min-height:58px;padding:0;border-radius:50%;border:1px solid color-mix(in srgb,var(--feature-color) 55%,rgba(255,255,255,.12));background:color-mix(in srgb,var(--feature-color) 84%,#11161d);color:#fff;display:grid;place-items:center;box-shadow:0 10px 28px rgba(0,0,0,.34),0 4px 14px color-mix(in srgb,var(--feature-color) 26%,transparent);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);touch-action:manipulation}.youtube-discovery-fab svg{width:27px;height:27px}.youtube-discovery-fab:active{transform:scale(.94)}
.youtube-channel-manager{display:grid;gap:12px}.youtube-channel-search-box{display:flex;gap:8px}.youtube-channel-search-input{flex:1;min-width:0;min-height:46px;padding:0 13px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--text);font:inherit;outline:none}.youtube-channel-search-input:focus{border-color:var(--feature-color)}.youtube-channel-search-status{min-height:18px;color:var(--muted);font-size:11px}.youtube-channel-search-results,.youtube-channel-registered{display:grid;gap:8px}.youtube-channel-result,.youtube-channel-registered-row{width:100%;display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--text);text-align:left}.youtube-channel-result img{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#111}.youtube-channel-result-copy{min-width:0}.youtube-channel-result-copy strong,.youtube-channel-result-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.youtube-channel-result-copy small{margin-top:3px;color:var(--muted);font-size:10px}.youtube-channel-add,.youtube-channel-remove{min-width:38px;min-height:38px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--text);font-weight:800}.youtube-channel-add.is-added{color:var(--success)}.youtube-channel-manual{padding-top:4px}.youtube-channel-manual summary{color:var(--muted);font-size:11px;cursor:pointer}.youtube-channel-manual-row{display:flex;gap:8px;margin-top:8px}.youtube-channel-manual-row input{flex:1;min-width:0;min-height:42px;padding:0 11px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);color:var(--text)}
.youtube-discovery-loading-shell{position:fixed;z-index:430;inset:0;display:grid;place-content:center;gap:12px;padding:24px;text-align:center;background:#000;color:#fff}.youtube-discovery-loading-shell .youtube-discovery-spinner{width:30px;height:30px;margin:auto;border:2px solid rgba(255,255,255,.22);border-top-color:#fff;border-radius:50%;animation:youtubeDiscoverySpin .75s linear infinite}@keyframes youtubeDiscoverySpin{to{transform:rotate(360deg)}}.youtube-discovery-loading-close{position:absolute;left:max(12px,env(safe-area-inset-left));top:max(12px,env(safe-area-inset-top));width:42px;height:42px;border:0;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;font-size:19px}
.youtube-shorts-player .youtube-discovery-rail{position:absolute;z-index:30;right:max(12px,calc(env(safe-area-inset-right) + 6px));bottom:max(118px,calc(env(safe-area-inset-bottom) + 104px));display:grid;gap:13px}.youtube-shorts-player .youtube-discovery-action{width:50px;min-height:50px;padding:5px 2px;border:0;background:transparent;color:#fff;display:grid;place-items:center;gap:2px;text-shadow:0 1px 4px #000}.youtube-shorts-player .youtube-discovery-action span:first-child{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:rgba(0,0,0,.48);font-size:22px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}.youtube-shorts-player .youtube-discovery-action small{font-size:9px}.youtube-shorts-player .youtube-discovery-action.is-on span:first-child{background:rgba(255,45,85,.78)}.youtube-shorts-player .youtube-discovery-action.is-added span:first-child{background:rgba(48,209,88,.72)}
`;
  document.head.append(style);
}

export async function searchYouTubeChannels(query){
  ensureStyles();const q=String(query||'').trim();if(q.length<2)return[];
  const cache=readJson(CHANNEL_SEARCH_CACHE_KEY,{});const key=q.toLowerCase();const hit=cache[key];if(hit&&Date.now()-Number(hit.at||0)<CHANNEL_SEARCH_TTL)return Array.isArray(hit.items)?hit.items:[];
  const response=await fetch(`/api/youtube-feed?action=channel-search&q=${encodeURIComponent(q)}`,{cache:'no-store'});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'チャンネルを検索できませんでした');
  addUsage('channel',Number(data.searchCalls||1));cache[key]={at:Date.now(),items:data.items||[]};const entries=Object.entries(cache).sort((a,b)=>Number(b[1]?.at||0)-Number(a[1]?.at||0)).slice(0,40);writeJson(CHANNEL_SEARCH_CACHE_KEY,Object.fromEntries(entries));return data.items||[];
}

function validPool(){const value=readJson(POOL_KEY,null);if(!value||Date.now()-Number(value.at||0)>POOL_TTL||!Array.isArray(value.items))return null;const items=value.items.filter(item=>isAllowed(item));return items.length?{...value,items}:null}
function savePool(items){writeJson(POOL_KEY,{at:Date.now(),items:(items||[]).filter(item=>isAllowed(item)).slice(0,55)})}
async function requestPool({seedItems=[],registeredChannelIds=[],existingItems=[],refill=false}={}){
  const requested=allowedDiscoverySearchCount(refill?3:5);if(requested<1)throw new Error('今日のYouTube検索の安全上限に近いため、新しい発見候補の検索を停止しています。');
  const seedVideoIds=seedItems.filter(x=>String(x?.kind||'')==='short').map(x=>x.videoId).filter(Boolean).slice(0,50);
  const hidden=[...setValues(HIDDEN_CHANNELS_KEY)].filter(x=>CHANNEL_ID_RE.test(x));const disliked=[...setValues(DISLIKES_KEY)];const excluded=[...new Set([...recentlySeenIds(),...disliked,...existingItems.map(x=>x.videoId)])].slice(0,180);
  const response=await fetch('/api/youtube-feed?action=discover',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({action:'discover',searchCount:requested,seedVideoIds,history:historyPayload(),registeredChannelIds,hiddenChannelIds:hidden,excludedVideoIds:excluded})});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'発見Shortsを取得できませんでした');addUsage('discover',Number(data.searchCalls||requested));return(data.items||[]).filter(item=>isAllowed(item,registeredChannelIds));
}

function removeLoading(){discoveryLoading?.remove();discoveryLoading=null}
function finishDiscovery({closePlayer=false,notify=true}={}){
  const session=discoverySession;discoverySession=null;removeLoading();
  try{session?.observer?.disconnect?.()}catch{}
  try{session?.rootObserver?.disconnect?.()}catch{}
  session?.rail?.remove?.();
  if(closePlayer&&session)cleanupYouTubePlayer();
  if(notify&&session&&!session.closedNotified){session.closedNotified=true;session.onClose?.()}
}
export function cleanupYouTubeDiscovery(){finishDiscovery({closePlayer:true,notify:false})}
window.addEventListener('pdv2:before-navigate',()=>finishDiscovery({closePlayer:false,notify:false}));

export function createDiscoveryButton(onClick){
  ensureStyles();const button=document.createElement('button');button.type='button';button.className='youtube-discovery-fab';button.setAttribute('aria-label','似ているShortsを発見');button.title='発見';button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m15.8 8.2-2.3 5.3-5.3 2.3 2.3-5.3 5.3-2.3Z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>';button.onclick=onClick;return button;
}

function showLoading(onClose){
  removeLoading();const root=document.getElementById('overlay-root')||document.body;const shell=document.createElement('section');shell.className='youtube-discovery-loading-shell';shell.innerHTML='<div class="youtube-discovery-spinner"></div><strong>好みに近いShortsを探しています…</strong><small>登録済みShortsと視聴傾向から選定中</small>';const close=document.createElement('button');close.type='button';close.className='youtube-discovery-loading-close';close.textContent='✕';close.onclick=()=>{removeLoading();onClose?.()};shell.append(close);root.append(shell);discoveryLoading=shell;return shell;
}
function currentVideoId(overlay){const href=overlay?.querySelector('.youtube-shorts-external')?.getAttribute('href')||'';const match=String(href).match(/\/shorts\/([A-Za-z0-9_-]{11})/);return match?.[1]||''}
function currentIndex(overlay,pool){const id=currentVideoId(overlay);return id?pool.findIndex(x=>String(x.videoId)===id):-1}
function currentItem(overlay,pool){const index=currentIndex(overlay,pool);return index>=0?pool[index]:null}
function nextButton(overlay){return[...overlay.querySelectorAll('button.youtube-shorts-action')].find(button=>String(button.textContent||'').includes('次'))||null}

export async function openYouTubeDiscovery({seedItems=[],registeredChannelIds=[],onRegister,onClose}={}){
  ensureStyles();finishDiscovery({closePlayer:true,notify:false});showLoading(onClose);
  const registeredSet=new Set(registeredChannelIds.map(String));const seenSet=new Set(recentlySeenIds());
  let pool=(validPool()?.items||[]).filter(item=>isAllowed(item,registeredChannelIds)&&!registeredSet.has(String(item.channelId||''))&&!seenSet.has(String(item.videoId||'')));
  if(pool.length<3){
    try{pool=await requestPool({seedItems,registeredChannelIds});savePool(pool)}
    catch(error){if(discoveryLoading){discoveryLoading.innerHTML=`<strong>発見Shortsを開始できませんでした</strong><small>${String(error?.message||error)}</small>`;const close=document.createElement('button');close.type='button';close.className='youtube-discovery-loading-close';close.textContent='✕';close.onclick=()=>{removeLoading();onClose?.()};discoveryLoading.append(close)}return null}
  }
  pool=pool.filter(item=>isAllowed(item,registeredChannelIds));
  if(!pool.length){if(discoveryLoading)discoveryLoading.innerHTML='<strong>似ているShortsが見つかりませんでした</strong>';return null}
  removeLoading();

  const controller=mountYouTubePlayer({queue:pool,index:0,shorts:true});
  const overlay=document.querySelector('.youtube-shorts-player');
  if(!controller||!overlay){onClose?.();return null}

  const rail=document.createElement('div');rail.className='youtube-discovery-rail';
  const like=document.createElement('button'),add=document.createElement('button'),uninterested=document.createElement('button'),hide=document.createElement('button');
  for(const [button,icon,label,aria] of [[like,'♡','興味あり','興味あり'],[add,'＋','登録','このチャンネルを登録'],[uninterested,'×','興味なし','興味なし'],[hide,'⊘','除外','このチャンネルを発見に出さない']]){button.type='button';button.className='youtube-discovery-action';button.innerHTML=`<span>${icon}</span><small>${label}</small>`;button.setAttribute('aria-label',aria);rail.append(button)}
  overlay.append(rail);

  const session={overlay,rail,observer:null,rootObserver:null,onClose,closedNotified:false,refilling:false,lastVideoId:'',actionBusy:false};
  discoverySession=session;
  const registered=()=>new Set(registeredChannelIds.map(String));
  const syncButtons=()=>{
    if(discoverySession!==session||!overlay.isConnected)return;const item=currentItem(overlay,pool);if(!item)return;
    like.classList.toggle('is-on',setValues(LIKES_KEY).has(String(item.videoId)));
    const added=registered().has(String(item.channelId||''));add.classList.toggle('is-added',added);add.querySelector('span').textContent=added?'✓':'＋';
  };
  const persist=()=>savePool(pool);
  const purgeFuture=fromIndex=>{
    for(let i=pool.length-1;i>fromIndex;i--)if(!isAllowed(pool[i],registeredChannelIds))pool.splice(i,1);
    persist();
  };
  const maybeRefill=async(force=false)=>{
    if(session.refilling||discoverySession!==session)return;
    const index=currentIndex(overlay,pool);const remaining=index>=0?pool.slice(index+1).filter(item=>isAllowed(item,registeredChannelIds)).length:pool.length;
    if(!force&&remaining>10)return;session.refilling=true;
    try{
      const extra=await requestPool({seedItems,registeredChannelIds,existingItems:pool,refill:true});const seen=new Set(pool.map(x=>String(x.videoId)));
      for(const item of extra)if(isAllowed(item,registeredChannelIds)&&!seen.has(String(item.videoId))){seen.add(String(item.videoId));pool.push(item)}
      persist();const next=nextButton(overlay);if(next&&pool.length>(Math.max(0,currentIndex(overlay,pool))+1))next.disabled=false;
    }catch(error){console.warn('[youtube discovery refill]',error?.message||error)}finally{session.refilling=false}
  };
  const goNext=async()=>{
    let index=currentIndex(overlay,pool);if(index<0)return false;purgeFuture(index);
    if(index>=pool.length-1){await maybeRefill(true);index=currentIndex(overlay,pool);purgeFuture(index)}
    const next=nextButton(overlay);if(!next||index<0||index>=pool.length-1)return false;next.disabled=false;next.click();return true;
  };
  const onItemChanged=()=>{
    if(discoverySession!==session||!overlay.isConnected)return;const item=currentItem(overlay,pool);if(!item)return;
    if(!isAllowed(item,registeredChannelIds)&&!session.actionBusy){queueMicrotask(()=>goNext());return}
    if(session.lastVideoId!==String(item.videoId)){session.lastVideoId=String(item.videoId);upsertHistory(item,{delta:.8,reason:'open'});maybeRefill()}
    syncButtons();
  };

  like.onclick=()=>{const item=currentItem(overlay,pool);if(!item)return;const likes=setValues(LIKES_KEY),id=String(item.videoId);if(likes.has(id)){likes.delete(id);upsertHistory(item,{delta:-2,reason:'unlike'})}else{likes.add(id);upsertHistory(item,{delta:5,reason:'like'});showToast('興味ありに追加しました')}saveSet(LIKES_KEY,likes);syncButtons()};
  add.onclick=()=>{const item=currentItem(overlay,pool);if(!item?.channelId)return;if(registered().has(String(item.channelId))){showToast('登録済みです');return}const ok=onRegister?.(item);if(ok!==false){registeredChannelIds.push(String(item.channelId));const index=currentIndex(overlay,pool);purgeFuture(index);syncButtons();showToast(`${item.channelName||'チャンネル'}を登録しました`)}};
  uninterested.onclick=async()=>{if(session.actionBusy)return;const item=currentItem(overlay,pool);if(!item)return;session.actionBusy=true;try{const dislikes=setValues(DISLIKES_KEY);dislikes.add(String(item.videoId));saveSet(DISLIKES_KEY,dislikes);upsertHistory(item,{delta:-5,reason:'dislike'});const index=currentIndex(overlay,pool);purgeFuture(index);showToast('興味なしを反映しました');await goNext()}finally{session.actionBusy=false}};
  hide.onclick=async()=>{if(session.actionBusy)return;const item=currentItem(overlay,pool);if(!item)return;session.actionBusy=true;try{const hidden=setValues(HIDDEN_CHANNELS_KEY);for(const token of hiddenTokens(item))hidden.add(token);saveSet(HIDDEN_CHANNELS_KEY,hidden);upsertHistory(item,{delta:-5,reason:'hide-channel'});const index=currentIndex(overlay,pool);purgeFuture(index);showToast('このチャンネルを発見から除外しました');await goNext()}finally{session.actionBusy=false}};

  const external=overlay.querySelector('.youtube-shorts-external');
  session.observer=new MutationObserver(onItemChanged);if(external)session.observer.observe(external,{attributes:true,attributeFilter:['href']});
  const close=overlay.querySelector('.youtube-shorts-close');close?.addEventListener('click',()=>finishDiscovery({closePlayer:false,notify:true}),{once:true});
  const parent=overlay.parentNode;session.rootObserver=new MutationObserver(()=>{if(discoverySession===session&&!overlay.isConnected)finishDiscovery({closePlayer:false,notify:true})});if(parent)session.rootObserver.observe(parent,{childList:true});
  onItemChanged();
  return{close:()=>{controller.close?.();finishDiscovery({closePlayer:false,notify:true})}};
}
