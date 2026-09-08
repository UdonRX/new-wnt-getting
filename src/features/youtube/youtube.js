import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { segmented, installShrinkingHeader } from '../../shared/components.js';
import { relativeTime } from '../../shared/time.js';
import { cleanupYouTubePlayer, mountYouTubePlayer } from './youtube-player.js';
import { createDiscoveryButton, openYouTubeDiscovery, recordYouTubeOpen, searchYouTubeChannels, warmYouTubeDiscovery } from './youtube-discovery.js';

const TABS=['long','short','live'];
const CACHE_KEY='pdv2:youtubeCache:kind4-lockup';
const CACHE_TTL=10*60*1000;
const LOAD_CONCURRENCY=4;
const CHANNEL_TIMEOUT_MS=36_000;
const META_KEY='pdv2:youtubeChannelMeta:v1';
const META_TTL=7*24*60*60*1000;
const USAGE_KEY='pdv2:youtubeChannelUsage:v1';
const STYLE_ID='pdv2-youtube-nav-v1';
let tab=localStorage.getItem('pdv2:youtubeTab')||'long';
if(!TABS.includes(tab))tab='long';
let selected='all';
let activeHost=null;
let cache=[];
let loadWarnings=[];
let listSwipeDetach=null;
let compactDetach=null;
let renderGeneration=0;
let discoveryWarmTimer=0;
let channelMetaJob=null;

function channelKey(ch){return String(ch?.value||ch?.url||ch?.name||'').trim().toLowerCase()}
function configuredChannels(){return(Array.isArray(state.youtubeChannels)?state.youtubeChannels:[]).filter(ch=>channelKey(ch))}
function rowKey(row){return String(row?._sourceKey||'').trim().toLowerCase()}
function configSignature(channels=configuredChannels()){return channels.map(channelKey).join('|')}
function rowMatchesSelection(row,value=selected){return value==='all'||rowKey(row)===String(value||'').toLowerCase()||String(row?.channel?.id||'')===String(value||'')}
function configuredMatchesSelection(ch,value=selected){const key=channelKey(ch);if(value==='all'||key===String(value||'').toLowerCase())return true;const row=cache.find(item=>rowKey(item)===key);return String(row?.channel?.id||'')===String(value||'')}
function configuredLabel(ch){const key=channelKey(ch),row=cache.find(item=>rowKey(item)===key),meta=channelMetaForId(row?.channel?.id);return String(ch?.name||meta?.name||row?.channel?.name||ch?.value||ch?.url||'YouTube').trim()||'YouTube'}
function selectedLabel(){if(selected==='all')return'ALL';const ch=configuredChannels().find(item=>configuredMatchesSelection(item));if(ch)return configuredLabel(ch);const row=cache.find(item=>rowMatchesSelection(item));return row?.channel?.name||row?._configuredName||'YouTube'}
function readJson(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}
function readMeta(){const value=readJson(META_KEY,{at:0,items:{}});return value&&typeof value==='object'?value:{at:0,items:{}}}
function channelMetaForId(id=''){const value=readMeta();return value?.items?.[String(id||'')]||null}
function channelRow(ch){const key=channelKey(ch);return cache.find(row=>rowKey(row)===key)||null}
function channelAvatar(ch,row=channelRow(ch)){const meta=channelMetaForId(row?.channel?.id);return String(meta?.avatar||row?.channel?.avatar||'').trim()}
function usageData(){const value=readJson(USAGE_KEY,{});return value&&typeof value==='object'?value:{}}
function recordChannelUse(key,type='select'){
  const id=String(key||'').toLowerCase();if(!id||id==='all')return;
  const usage=usageData(),current=usage[id]||{selects:0,opens:0,lastAt:0};
  if(type==='open')current.opens=Number(current.opens||0)+1;else current.selects=Number(current.selects||0)+1;
  current.lastAt=Date.now();usage[id]=current;
  try{localStorage.setItem(USAGE_KEY,JSON.stringify(usage))}catch{}
}
function frequentChannels(limit=5){
  const channels=configuredChannels(),usage=usageData();
  const sorted=channels.map((ch,index)=>{const u=usage[channelKey(ch)]||{};return{ch,index,score:Number(u.opens||0)*3+Number(u.selects||0)*2,lastAt:Number(u.lastAt||0)}})
    .sort((a,b)=>b.score-a.score||b.lastAt-a.lastAt||a.index-b.index).map(value=>value.ch);
  if(selected!=='all'){
    const current=channels.find(ch=>configuredMatchesSelection(ch));
    if(current){const rest=sorted.filter(ch=>channelKey(ch)!==channelKey(current));return[current,...rest].slice(0,limit)}
  }
  return sorted.slice(0,limit);
}
function scheduleDiscoveryWarmup(seedItems,registeredChannelIds){
  clearTimeout(discoveryWarmTimer);
  discoveryWarmTimer=setTimeout(()=>{
    discoveryWarmTimer=0;
    const run=()=>warmYouTubeDiscovery({seedItems,registeredChannelIds}).catch(error=>console.warn('[youtube discovery warmup]',error?.message||error));
    if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(run,{timeout:900});else run();
  },90);
}

async function loadChannel(ch){
  const input=ch?.value||ch?.url||ch?.name;
  if(!String(input||'').trim())throw Object.assign(new Error('チャンネル指定が空です'),{reason:'channelMissing',status:400,sourceKey:channelKey(ch)});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),CHANNEL_TIMEOUT_MS);
  try{
    const response=await fetch(`/api/youtube-feed?channel=${encodeURIComponent(input)}`,{cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error||`YouTube取得エラー (${response.status})`),{reason:data.reason||'',detail:data.detail||'',status:response.status,sourceKey:channelKey(ch)});
    return{...data,_sourceKey:channelKey(ch),_configuredName:ch.name||'',_stale:false};
  }catch(error){
    if(error?.name==='AbortError')throw Object.assign(new Error('YouTubeチャンネル取得がタイムアウトしました'),{reason:'clientTimeout',status:408,sourceKey:channelKey(ch)});
    throw error;
  }finally{clearTimeout(timer)}
}
function readCache(){return readJson(CACHE_KEY,null)}
function saveCache({complete=true,at=Date.now()}={}){try{localStorage.setItem(CACHE_KEY,JSON.stringify({at,complete,configSignature:configSignature(),rows:cache,warnings:loadWarnings}))}catch{}}
function cacheIsFresh(value=readCache()){return Boolean(value)&&value.complete!==false&&String(value?.configSignature||'')===configSignature()&&Date.now()-Number(value?.at||0)<CACHE_TTL}
function warningRows(failures,byKey){return[...failures.entries()].map(([key,x])=>byKey.has(key)?`${x.name}: 更新できないため保存済み一覧を表示`:`${x.name}: 現在取得できません`)}

async function loadAll({force=false,onProgress}={}){
  const previous=readCache(),channels=configuredChannels(),previousRows=Array.isArray(previous?.rows)?previous.rows:[],allowed=new Set(channels.map(channelKey));
  const staleByKey=new Map(previousRows.filter(row=>allowed.has(rowKey(row))).map(row=>[rowKey(row),row])),byKey=new Map(staleByKey);
  cache=channels.map(ch=>byKey.get(channelKey(ch))).filter(Boolean);loadWarnings=Array.isArray(previous?.warnings)?previous.warnings:[];onProgress?.({done:0,total:channels.length});
  if(!force&&cacheIsFresh(previous))return cache;
  const failures=new Map();let done=0;
  const queue=channels.map((ch,index)=>({ch,index,missing:!byKey.has(channelKey(ch))})).sort((a,b)=>Number(b.missing)-Number(a.missing)||a.index-b.index),startedAt=Number(previous?.at||0);
  const worker=async()=>{while(queue.length){const job=queue.shift();if(!job)break;const{ch}=job,key=channelKey(ch);try{const row=await loadChannel(ch);byKey.set(key,row);failures.delete(key)}catch(error){const stale=staleByKey.get(key);if(stale)byKey.set(key,{...stale,_stale:true});failures.set(key,{name:ch.name||ch.value||ch.url||'YouTube',reason:error?.reason||'',status:error?.status||0})}done+=1;cache=channels.map(x=>byKey.get(channelKey(x))).filter(Boolean);loadWarnings=warningRows(failures,byKey);saveCache({complete:false,at:startedAt});onProgress?.({done,total:channels.length})}};
  await Promise.allSettled(Array.from({length:Math.min(LOAD_CONCURRENCY,Math.max(1,queue.length))},()=>worker()));
  cache=channels.map(x=>byKey.get(channelKey(x))).filter(Boolean);loadWarnings=warningRows(failures,byKey);saveCache({complete:true,at:Date.now()});
  if(!cache.length&&loadWarnings.length)throw new Error('YouTube一覧を取得できませんでした。登録チャンネルは残しているので、時間をおいて再更新してください。');
  return cache;
}

async function ensureChannelMeta({onReady}={}){
  if(channelMetaJob)return channelMetaJob;
  const ids=[...new Set(cache.map(row=>String(row?.channel?.id||'')).filter(id=>/^UC[A-Za-z0-9_-]{22}$/.test(id)))];
  if(!ids.length)return null;
  const stored=readMeta(),items=stored?.items||{},fresh=Date.now()-Number(stored?.at||0)<META_TTL&&ids.every(id=>items[id]?.avatar);
  if(fresh)return stored;
  channelMetaJob=(async()=>{
    try{
      const query=new URLSearchParams({action:'channel-meta',ids:ids.join(',')});
      const response=await fetch(`/api/youtube?${query}`,{cache:'force-cache',signal:AbortSignal.timeout(8000)}),data=await response.json().catch(()=>({}));
      if(!response.ok||!data.ok)throw new Error(data.error||`YouTubeチャンネル画像取得エラー (${response.status})`);
      const merged={...items};for(const item of data.items||[]){if(item?.id)merged[item.id]={name:item.name||'',avatar:item.avatar||''}};
      const next={at:Date.now(),items:merged};try{localStorage.setItem(META_KEY,JSON.stringify(next))}catch{};onReady?.();return next;
    }catch(error){console.warn('[youtube-channel-meta]',error?.message||error);return stored}
    finally{channelMetaJob=null}
  })();
  return channelMetaJob;
}

function avatarNode({src='',label='YouTube',className='youtube-channel-avatar',eager=false}={}){
  const wrap=el('span',{class:className});
  if(src){const image=el('img',{src,alt:'',loading:eager?'eager':'lazy',decoding:'async',referrerpolicy:'no-referrer'});image.addEventListener('error',()=>{image.remove();wrap.textContent=String(label||'Y').trim().slice(0,1).toUpperCase()||'Y'},{once:true});wrap.append(image)}else wrap.textContent=String(label||'Y').trim().slice(0,1).toUpperCase()||'Y';
  return wrap;
}
function chooseChannel(value,onChange){selected=value||'all';if(selected!=='all')recordChannelUse(selected,'select');onChange()}
function channelSheet(onChange,onEdit){
  const wrap=el('div',{class:'youtube-channel-sheet'}),head=el('div',{class:'youtube-channel-sheet-head'}),list=el('div',{class:'youtube-channel-sheet-list'});let sheet;
  head.append(el('strong',{text:'登録チャンネル'}),el('button',{class:'youtube-sheet-close',type:'button','aria-label':'閉じる',text:'×',onclick:()=>sheet?.close()}));
  const all=el('button',{class:`youtube-channel-sheet-row ${selected==='all'?'selected':''}`,type:'button',onclick:()=>{chooseChannel('all',onChange);sheet?.close()}},[avatarNode({label:'ALL',className:'youtube-channel-avatar youtube-all-avatar'}),el('span',{text:'ALL・全チャンネル'})]);list.append(all);
  configuredChannels().forEach(ch=>{const key=channelKey(ch),row=channelRow(ch),label=configuredLabel(ch),active=configuredMatchesSelection(ch);list.append(el('button',{class:`youtube-channel-sheet-row ${active?'selected':''}`,type:'button',onclick:()=>{chooseChannel(key,onChange);sheet?.close()}},[avatarNode({src:channelAvatar(ch,row),label}),el('span',{text:label})]))});
  const edit=el('button',{class:'soft-button full-button',type:'button',text:'＋ チャンネルを追加 / 編集',onclick:()=>{sheet?.close();onEdit()}});
  wrap.append(head,list,edit);sheet=openSheet(wrap,{title:''});
}
function normalizeChannelValue(value=''){
  const raw=String(value||'').trim();if(!raw)return'';if(raw.startsWith('@'))return raw.split(/[/?#]/)[0];
  try{if(/^https?:\/\//i.test(raw)){const url=new URL(raw),host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');if(host==='youtube.com'){const parts=url.pathname.split('/').filter(Boolean);if(parts[0]?.startsWith('@'))return`@${parts[0].slice(1)}`;if(parts[0]==='channel'&&parts[1])return parts[1]}}}catch{}return raw;
}
function normalizeChannels(draft=[]){const seen=new Set(),out=[];for(const raw of draft){const ch={...raw,name:String(raw?.name||'').trim(),value:normalizeChannelValue(raw?.value)},key=channelKey(ch);if(!key||seen.has(key))continue;seen.add(key);out.push(ch)}return out}
function preserveCacheFor(channels){const previous=readCache(),allowed=new Set(channels.map(channelKey));cache=(Array.isArray(previous?.rows)?previous.rows:[]).filter(row=>allowed.has(rowKey(row)));loadWarnings=[];try{localStorage.setItem(CACHE_KEY,JSON.stringify({at:Number(previous?.at||0),complete:false,configSignature:configSignature(channels),rows:cache,warnings:[]}))}catch{}}
function saveManagedChannels(channels){const normalized=normalizeChannels(channels);update('youtubeChannels',normalized);preserveCacheFor(normalized);return normalized}
function candidateRegistered(candidate){const id=String(candidate?.channelId||'').toLowerCase();if(!id)return false;return configuredChannels().some(ch=>channelKey(ch)===id)||cache.some(row=>String(row?.channel?.id||'').toLowerCase()===id)}
function manage(onDone){
  let sheet,searchTimer=0,searchGeneration=0,lastResults=[];
  const wrap=el('div',{class:'youtube-channel-manager'}),searchInput=el('input',{class:'youtube-channel-search-input',type:'search',placeholder:'チャンネル名を検索',autocomplete:'off',autocapitalize:'off'}),searchStatus=el('div',{class:'youtube-channel-search-status',text:'チャンネル名を入力すると候補を表示します'}),results=el('div',{class:'youtube-channel-search-results'}),registered=el('div',{class:'youtube-channel-registered'});
  const renderRegistered=()=>{registered.replaceChildren();for(const ch of configuredChannels()){const key=channelKey(ch),row=channelRow(ch),label=configuredLabel(ch),copy=el('div',{class:'youtube-channel-result-copy'},[el('strong',{text:label}),el('small',{text:row?.channel?.id||ch.value||''})]),remove=el('button',{class:'youtube-channel-remove',type:'button','aria-label':`${label}を削除`,text:'−',onclick:()=>{saveManagedChannels(configuredChannels().filter(x=>channelKey(x)!==key));renderRegistered();renderSearchResults(lastResults)}});registered.append(el('div',{class:'youtube-channel-registered-row'},[avatarNode({src:channelAvatar(ch,row),label}),copy,remove]))}if(!registered.childElementCount)registered.append(el('div',{class:'youtube-channel-search-status',text:'まだ登録されていません'}))};
  const renderSearchResults=items=>{lastResults=Array.isArray(items)?items:[];results.replaceChildren();for(const candidate of lastResults){const added=candidateRegistered(candidate),img=avatarNode({src:candidate.thumbnail||'',label:candidate.name||'Y'}),copy=el('div',{class:'youtube-channel-result-copy'},[el('strong',{text:candidate.name||'YouTube'}),el('small',{text:candidate.description||candidate.channelId})]),add=el('button',{class:`youtube-channel-add ${added?'is-added':''}`,type:'button','aria-label':added?'登録済み':'このチャンネルを登録',text:added?'✓':'＋',onclick:()=>{if(candidateRegistered(candidate))return;saveManagedChannels([...configuredChannels(),{name:candidate.name||'',value:candidate.channelId}]);renderRegistered();renderSearchResults(lastResults)}});results.append(el('div',{class:'youtube-channel-result'},[img,copy,add]))}if(!results.childElementCount&&String(searchInput.value||'').trim())results.append(el('div',{class:'youtube-channel-search-status',text:'候補が見つかりませんでした'}))};
  const runSearch=async()=>{const q=String(searchInput.value||'').trim(),min=/[^\x00-\x7F]/.test(q)?2:3;if(q.length<min){searchStatus.textContent=`${min}文字以上入力してください`;results.replaceChildren();return}const my=++searchGeneration;searchStatus.textContent='検索中…';try{const items=await searchYouTubeChannels(q);if(my!==searchGeneration)return;searchStatus.textContent=`${items.length}件の候補`;renderSearchResults(items)}catch(error){if(my!==searchGeneration)return;searchStatus.textContent=error?.message||'検索できませんでした';results.replaceChildren()}};
  searchInput.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,900)});
  const manualInput=el('input',{type:'text',placeholder:'共有URL / @handle / Channel ID'}),manualAdd=el('button',{class:'soft-button',type:'button',text:'追加',onclick:()=>{const value=normalizeChannelValue(manualInput.value);if(!value)return;saveManagedChannels([...configuredChannels(),{name:'',value}]);manualInput.value='';renderRegistered();renderSearchResults(lastResults)}}),manual=el('details',{class:'youtube-channel-manual'},[el('summary',{text:'URL / @handle / Channel ID から追加'}),el('div',{class:'youtube-channel-manual-row'},[manualInput,manualAdd])]),done=el('button',{class:'primary-button full-button',type:'button',text:'完了',onclick:()=>{clearTimeout(searchTimer);sheet?.close();onDone?.()}});
  wrap.append(el('div',{class:'youtube-channel-search-box'},[searchInput]),searchStatus,results,el('strong',{text:'登録中'}),registered,manual,done);renderRegistered();sheet=openSheet(wrap,{title:'YouTubeチャンネル追加'});setTimeout(()=>searchInput.focus(),180);
}
export function openYouTubeChannelManager(onDone=()=>{}){manage(onDone)}
function normalizeKind(item){if(item?.liveType||item?.kind==='live')return'live';if(item?.kind==='videos')return'long';if(item?.kind==='shorts')return'short';return['long','short','live','unknown'].includes(item?.kind)?item.kind:'unknown'}
function liveBadge(item){if(item?.liveType==='archive')return el('span',{class:'archive-badge',text:'配信録画'});if(item?.liveType==='upcoming')return el('span',{class:'upcoming-badge',text:'配信予定'});return el('span',{class:'live-badge',text:'LIVE'})}
function thumbnailNode(item,currentTab,index){const url=String(item?.thumbnail||'').trim(),className=`thumb ${currentTab==='short'?'short-thumb':''}`;if(!url)return el('div',{class:`${className} thumb-missing`});return el('img',{class:className,src:url,alt:'',loading:index<4?'eager':'lazy',decoding:'async'})}

function ensureStyles(){if(document.getElementById(STYLE_ID))return;const style=document.createElement('style');style.id=STYLE_ID;style.textContent=`
.youtube-primary-tabs{position:sticky!important;top:max(3px,calc(env(safe-area-inset-top) + 3px))!important;z-index:88!important;margin:0 -2px 8px!important;padding:6px 2px!important;background:color-mix(in srgb,var(--bg) 90%,transparent)!important;-webkit-backdrop-filter:blur(18px) saturate(1.14);backdrop-filter:blur(18px) saturate(1.14);border-radius:16px}.youtube-primary-tabs .segmented{width:100%;box-shadow:0 7px 20px rgba(0,0,0,.08)}
.youtube-channel-rail{display:flex;align-items:flex-start;gap:8px;width:100%;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:2px 2px 10px;touch-action:pan-x}.youtube-channel-rail::-webkit-scrollbar{display:none}.youtube-channel-filter{flex:0 0 58px;width:58px;min-width:58px;padding:0;border:0;background:transparent;color:var(--muted);display:grid;justify-items:center;gap:5px;font:inherit;font-size:9px;line-height:1.15;text-align:center}.youtube-channel-filter-label{width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.youtube-channel-filter.selected{color:var(--text);font-weight:800}.youtube-channel-avatar{width:42px;height:42px;min-width:42px;display:grid;place-items:center;overflow:hidden;border-radius:50%;border:1.5px solid var(--line);background:var(--surface-2);color:var(--text);font-size:12px;font-weight:850;box-sizing:border-box}.youtube-channel-avatar img{display:block;width:100%;height:100%;object-fit:cover}.youtube-channel-filter.selected .youtube-channel-avatar{border:2.5px solid var(--feature-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--feature-color) 16%,transparent)}.youtube-all-avatar{font-size:9px;letter-spacing:-.02em}.youtube-channel-more .youtube-channel-avatar{font-size:25px;font-weight:400}.media-swipe-list{touch-action:pan-y;will-change:transform,opacity}.youtube-video-byline{margin-top:6px;display:flex;align-items:center;gap:5px;min-width:0;color:var(--muted);font-size:11px}.youtube-video-byline .youtube-channel-avatar{width:22px;height:22px;min-width:22px;border-width:1px;font-size:8px}.youtube-video-channel{min-width:0;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.youtube-video-time{white-space:nowrap}.youtube-channel-sheet{display:grid;gap:10px;min-height:0}.youtube-channel-sheet-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 0 8px;background:var(--surface-solid)}.youtube-sheet-close{width:38px;height:38px;border:1px solid var(--line);border-radius:50%;background:var(--surface-2);color:var(--text);font-size:23px;line-height:1}.youtube-channel-sheet-list{max-height:min(60dvh,520px);overflow-y:auto;-webkit-overflow-scrolling:touch;display:grid;gap:5px;padding-right:2px}.youtube-channel-sheet-row{width:100%;min-height:56px;display:grid;grid-template-columns:42px minmax(0,1fr);gap:10px;align-items:center;padding:7px 9px;border:1px solid transparent;border-radius:14px;background:transparent;color:var(--text);font:inherit;text-align:left}.youtube-channel-sheet-row.selected{border-color:color-mix(in srgb,var(--feature-color) 45%,var(--line));background:color-mix(in srgb,var(--feature-color) 9%,var(--surface-2));font-weight:800}.youtube-channel-registered-row>.youtube-channel-avatar,.youtube-channel-result>.youtube-channel-avatar{width:42px;height:42px;min-width:42px}.youtube-channel-result>.youtube-channel-avatar img{border-radius:50%}
@media(max-width:430px){.youtube-channel-rail{gap:6px}.youtube-channel-filter{flex-basis:56px;width:56px;min-width:56px}.youtube-channel-filter-label{width:56px}}
@media(prefers-reduced-motion:reduce){.media-swipe-list{transition-duration:.001ms!important}}
`;document.head.append(style)}
function channelRail(onChange,onEdit){
  const rail=el('div',{class:'youtube-channel-rail','aria-label':'YouTubeチャンネルフィルター'});
  const buttonFor=(ch,index)=>{const key=channelKey(ch),row=channelRow(ch),label=configuredLabel(ch),active=configuredMatchesSelection(ch);return el('button',{class:`youtube-channel-filter ${active?'selected':''}`,type:'button','aria-label':`${label}で絞り込む`,'aria-pressed':String(active),onclick:()=>chooseChannel(key,onChange)},[avatarNode({src:channelAvatar(ch,row),label,eager:index<5}),el('span',{class:'youtube-channel-filter-label',text:label})])};
  rail.append(el('button',{class:`youtube-channel-filter ${selected==='all'?'selected':''}`,type:'button','aria-label':'すべての登録チャンネル','aria-pressed':String(selected==='all'),onclick:()=>chooseChannel('all',onChange)},[avatarNode({label:'ALL',className:'youtube-channel-avatar youtube-all-avatar',eager:true}),el('span',{class:'youtube-channel-filter-label',text:'ALL'})]));
  frequentChannels(5).forEach((ch,index)=>rail.append(buttonFor(ch,index)));
  rail.append(el('button',{class:'youtube-channel-filter youtube-channel-more',type:'button','aria-label':'登録チャンネル一覧',onclick:()=>channelSheet(onChange,onEdit)},[avatarNode({label:'＋',className:'youtube-channel-avatar'}),el('span',{class:'youtube-channel-filter-label',text:'一覧'})]));
  return rail;
}
function attachTabSwipe(list,cycle){
  let sx=0,sy=0,dx=0,dy=0,started=0,mode='';
  const reset=animate=>{if(animate){list.style.transition='transform 150ms cubic-bezier(.2,.8,.2,1),opacity 150ms ease';list.style.transform='translate3d(0,0,0)';list.style.opacity='1';setTimeout(()=>{if(list.isConnected)list.style.transition=''},170)}else{list.style.transform='';list.style.opacity='';list.style.transition=''}};
  const start=event=>{if(event.touches.length!==1)return;const t=event.touches[0];sx=t.clientX;sy=t.clientY;dx=dy=0;started=performance.now();mode='';list.style.transition='none'};
  const move=event=>{if(!started||event.touches.length!==1)return;const t=event.touches[0];dx=t.clientX-sx;dy=t.clientY-sy;const ax=Math.abs(dx),ay=Math.abs(dy);if(!mode&&Math.max(ax,ay)>9){if(ay>ax*1.08){mode='vertical';reset(false);return}if(ax>ay*1.2)mode='horizontal'}if(mode!=='horizontal')return;if(event.cancelable)event.preventDefault();const x=Math.max(-92,Math.min(92,dx*.58));list.style.transform=`translate3d(${x}px,0,0)`;list.style.opacity=String(Math.max(.78,1-Math.abs(x)/460))};
  const end=()=>{if(!started)return;const elapsed=Math.max(1,performance.now()-started),velocity=dx/elapsed,horizontal=mode==='horizontal',trigger=horizontal&&(Math.abs(dx)>52||Math.abs(velocity)>.48),delta=dx<0?1:-1;started=0;if(trigger&&cycle(delta)){list.style.transition='transform 90ms ease-out,opacity 90ms ease-out';list.style.transform=`translate3d(${delta>0?-28:28}px,0,0)`;list.style.opacity='.84';setTimeout(()=>cycle(0),92)}else reset(true)};
  list.addEventListener('touchstart',start,{passive:true});list.addEventListener('touchmove',move,{passive:false});list.addEventListener('touchend',end,{passive:true});list.addEventListener('touchcancel',()=>{started=0;reset(true)},{passive:true});
  return()=>{list.removeEventListener('touchstart',start);list.removeEventListener('touchmove',move);list.removeEventListener('touchend',end);reset(false)};
}

export async function renderYouTube(host,{refresh=false}={}){
  ensureStyles();
  const generation=++renderGeneration;
  if(host!==activeHost){activeHost=host;selected='all'}
  cleanupYouTubePlayer();listSwipeDetach?.();listSwipeDetach=null;compactDetach?.();compactDetach=null;
  const screen=host.closest('.screen');screen?.classList.add('youtube-list-screen');
  const previous=readCache(),channels=configuredChannels(),allowed=new Set(channels.map(channelKey));
  if(previous?.rows?.length){cache=previous.rows.filter(row=>allowed.has(rowKey(row)));loadWarnings=Array.isArray(previous.warnings)?previous.warnings:[]}else{cache=[];loadWarnings=[]}
  if(!channels.length){host.replaceChildren(el('div',{class:'empty',text:'チャンネルを追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))}));return}

  let refreshing=false,playerOpen=false,pendingRefreshDraw=false,playerObserver=null;
  function changeTab(next){if(!TABS.includes(next)||next===tab)return false;cleanupYouTubePlayer();playerOpen=false;tab=next;localStorage.setItem('pdv2:youtubeTab',tab);draw();return true}
  function cycleTab(delta){if(delta===0)return true;const i=TABS.indexOf(tab),next=Math.max(0,Math.min(TABS.length-1,i+delta));if(next===i)return false;return changeTab(TABS[next])}
  function draw(){
    if(generation!==renderGeneration||playerOpen)return;
    cleanupYouTubePlayer();compactDetach?.();compactDetach=null;playerObserver?.disconnect();playerObserver=null;
    if(selected!=='all'&&!channels.some(ch=>configuredMatchesSelection(ch)))selected='all';
    const selectedRows=selected==='all'?cache:cache.filter(row=>rowMatchesSelection(row));
    const tabBar=el('div',{class:'media-sticky-tabs youtube-primary-tabs'});tabBar.append(segmented([{value:'long',label:'動画'},{value:'short',label:'Shorts'},{value:'live',label:'LIVE'}],tab,changeTab));
    const rail=channelRail(draw,()=>manage(()=>renderYouTube(host,{refresh:true})));
    const playerHost=el('div',{class:'youtube-inline-player-host twitch-inline-player-host'});
    const enrich=row=>(row.items||[]).map(item=>({...item,_sourceKey:rowKey(row),channelId:item.channelId||row?.channel?.id||'',channelName:item.channelName||row?.channel?.name||row?._configuredName||'',channelAvatar:channelAvatar(configuredChannels().find(ch=>channelKey(ch)===rowKey(row))||{},row),kind:normalizeKind(item)}));
    const items=selectedRows.flatMap(enrich).filter(item=>tab==='long'?(item.kind==='long'||item.kind==='unknown'):item.kind===tab).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const allSeedItems=cache.flatMap(enrich);
    const list=el('div',{class:'media-list media-swipe-list'});
    items.forEach((item,index)=>{
      const row=el('button',{class:'media-row',type:'button',onclick:()=>{recordYouTubeOpen(item);recordChannelUse(item._sourceKey,'open');playerOpen=true;mountYouTubePlayer({host:playerHost,queue:items,index,shorts:tab==='short'})}});
      row.append(thumbnailNode(item,tab,index));
      const copy=el('div',{class:'media-row-copy'}),titleLine=el('div',{class:'media-title-line'});if(tab==='live')titleLine.append(liveBadge(item),document.createTextNode(' '));titleLine.append(el('span',{class:'media-title',text:item.title||'無題'}));copy.append(titleLine);
      const byline=el('div',{class:'youtube-video-byline'});byline.append(avatarNode({src:item.channelAvatar,label:item.channelName,className:'youtube-channel-avatar',eager:index<4}),el('span',{class:'youtube-video-channel',text:item.channelName||'YouTube'}));const when=relativeTime(item.publishedAt);if(when)byline.append(el('span',{text:'・'}),el('span',{class:'youtube-video-time',text:when}));if(item.liveType==='archive')byline.append(el('span',{text:'・配信アーカイブ'}));copy.append(byline);row.append(copy);list.append(row);
    });
    if(!items.length){let message=refreshing?'YouTubeを更新しています…':'該当する動画が見つかりません';if(selected!=='all'&&!selectedRows.length&&!refreshing)message=`${selectedLabel()} は現在取得できません`;list.append(el('div',{class:'empty',text:message}))}
    const children=[tabBar,rail,playerHost];if(refreshing&&items.length)children.push(el('div',{class:'media-warning',text:'YouTubeをバックグラウンド更新中…'}));if(loadWarnings.length)children.push(el('div',{class:'media-warning',text:loadWarnings.slice(0,4).join(' / ')+(loadWarnings.length>4?` / 他${loadWarnings.length-4}件`:'')}));children.push(list);host.replaceChildren(...children);
    if(tab==='short'){
      const registeredChannelIds=[...new Set(cache.map(row=>String(row?.channel?.id||'')).filter(Boolean))];scheduleDiscoveryWarmup(allSeedItems,registeredChannelIds);
      host.append(createDiscoveryButton(()=>{playerOpen=true;openYouTubeDiscovery({seedItems:allSeedItems,registeredChannelIds,onRegister:item=>{if(!item?.channelId)return false;if(candidateRegistered({channelId:item.channelId}))return true;saveManagedChannels([...configuredChannels(),{name:item.channelName||'',value:item.channelId}]);return true},onClose:()=>{playerOpen=false;renderYouTube(host,{refresh:false})}}).catch(()=>{playerOpen=false})}));
    }
    listSwipeDetach?.();listSwipeDetach=attachTabSwipe(list,cycleTab);if(screen)compactDetach=installShrinkingHeader(screen,{threshold:62,className:'youtube-scroll-compact'});
    playerObserver=new MutationObserver(()=>{if(generation!==renderGeneration)return;if(playerOpen&&playerHost.childElementCount===0){playerOpen=false;if(pendingRefreshDraw){pendingRefreshDraw=false;draw()}}});playerObserver.observe(playerHost,{childList:true});
  }
  function drawIfIdle(){if(generation!==renderGeneration)return;if(playerOpen){pendingRefreshDraw=true;return}draw()}
  draw();
  ensureChannelMeta({onReady:drawIfIdle}).catch(()=>{});
  if(!refresh&&cacheIsFresh(previous))return;
  refreshing=true;drawIfIdle();
  try{await loadAll({force:refresh,onProgress:()=>drawIfIdle()});await ensureChannelMeta({onReady:drawIfIdle})}
  catch(error){if(generation!==renderGeneration)return;if(!cache.length)loadWarnings=[error?.message||'YouTube一覧を取得できませんでした']}
  finally{if(generation!==renderGeneration)return;refreshing=false;drawIfIdle()}
}
