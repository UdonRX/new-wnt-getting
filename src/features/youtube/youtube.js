import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager, segmented, installShrinkingHeader } from '../../shared/components.js';
import { attachSwipe } from '../../shared/gestures.js';
import { cleanupYouTubePlayer, mountYouTubePlayer } from './youtube-player.js';

const TABS=['long','short','live'];
const CACHE_KEY='pdv2:youtubeCache:kind4-lockup';
const CACHE_TTL=10*60*1000;
const LOAD_CONCURRENCY=4;
const CHANNEL_TIMEOUT_MS=36_000;
let tab=localStorage.getItem('pdv2:youtubeTab')||'long';
if(!TABS.includes(tab))tab='long';
let selected=localStorage.getItem('pdv2:youtubeSelected')||'all';
let cache=[];
let loadWarnings=[];
let listSwipeDetach=null;
let compactDetach=null;
let renderGeneration=0;

function channelKey(ch){return String(ch?.value||ch?.url||ch?.name||'').trim().toLowerCase()}
function configuredChannels(){return (Array.isArray(state.youtubeChannels)?state.youtubeChannels:[]).filter(ch=>channelKey(ch))}
function rowKey(row){return String(row?._sourceKey||'').trim().toLowerCase()}
function configSignature(channels=configuredChannels()){return channels.map(channelKey).join('|')}
function rowMatchesSelection(row,value=selected){return value==='all'||rowKey(row)===String(value||'').toLowerCase()||String(row?.channel?.id||'')===String(value||'')}
function configuredMatchesSelection(ch,value=selected){const key=channelKey(ch);if(value==='all'||key===String(value||'').toLowerCase())return true;const row=cache.find(item=>rowKey(item)===key);return String(row?.channel?.id||'')===String(value||'')}
function configuredLabel(ch){const key=channelKey(ch);const row=cache.find(item=>rowKey(item)===key);return String(ch?.name||row?.channel?.name||ch?.value||ch?.url||'YouTube').trim()||'YouTube'}
function selectedLabel(){if(selected==='all')return'すべて';const ch=configuredChannels().find(item=>configuredMatchesSelection(item));if(ch)return configuredLabel(ch);const row=cache.find(item=>rowMatchesSelection(item));return row?.channel?.name||row?._configuredName||'YouTube'}

async function loadChannel(ch){
  const input=ch?.value||ch?.url||ch?.name;
  if(!String(input||'').trim())throw Object.assign(new Error('チャンネル指定が空です'),{reason:'channelMissing',status:400,sourceKey:channelKey(ch)});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),CHANNEL_TIMEOUT_MS);
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
function readCache(){try{return JSON.parse(localStorage.getItem(CACHE_KEY)||'null')}catch{return null}}
function saveCache({complete=true,at=Date.now()}={}){try{localStorage.setItem(CACHE_KEY,JSON.stringify({at,complete,configSignature:configSignature(),rows:cache,warnings:loadWarnings}))}catch{}}
function cacheIsFresh(value=readCache()){return Boolean(value)&&value.complete!==false&&String(value?.configSignature||'')===configSignature()&&Date.now()-Number(value?.at||0)<CACHE_TTL}
function warningRows(failures,byKey){return[...failures.entries()].map(([key,x])=>byKey.has(key)?`${x.name}: 更新できないため保存済み一覧を表示`:`${x.name}: 現在取得できません`)}

async function loadAll({force=false,onProgress}={}){
  const previous=readCache();
  const channels=configuredChannels();
  const previousRows=Array.isArray(previous?.rows)?previous.rows:[];
  const allowed=new Set(channels.map(channelKey));
  const staleByKey=new Map(previousRows.filter(row=>allowed.has(rowKey(row))).map(row=>[rowKey(row),row]));
  const byKey=new Map(staleByKey);
  cache=channels.map(ch=>byKey.get(channelKey(ch))).filter(Boolean);
  loadWarnings=Array.isArray(previous?.warnings)?previous.warnings:[];
  onProgress?.({done:0,total:channels.length});
  if(!force&&cacheIsFresh(previous))return cache;

  const failures=new Map();
  let done=0;
  const queue=channels.map((ch,index)=>({ch,index,missing:!byKey.has(channelKey(ch))}))
    .sort((a,b)=>Number(b.missing)-Number(a.missing)||a.index-b.index);
  const startedAt=Number(previous?.at||0);

  const worker=async()=>{
    while(queue.length){
      const job=queue.shift();if(!job)break;
      const {ch}=job,key=channelKey(ch);
      try{
        const row=await loadChannel(ch);
        byKey.set(key,row);failures.delete(key);
      }catch(error){
        const stale=staleByKey.get(key);
        if(stale)byKey.set(key,{...stale,_stale:true});
        failures.set(key,{name:ch.name||ch.value||ch.url||'YouTube',reason:error?.reason||'',status:error?.status||0});
      }
      done+=1;
      cache=channels.map(x=>byKey.get(channelKey(x))).filter(Boolean);
      loadWarnings=warningRows(failures,byKey);
      saveCache({complete:false,at:startedAt});
      onProgress?.({done,total:channels.length});
    }
  };
  await Promise.allSettled(Array.from({length:Math.min(LOAD_CONCURRENCY,Math.max(1,queue.length))},()=>worker()));
  cache=channels.map(x=>byKey.get(channelKey(x))).filter(Boolean);
  loadWarnings=warningRows(failures,byKey);
  saveCache({complete:true,at:Date.now()});
  if(!cache.length&&loadWarnings.length)throw new Error('YouTube一覧を取得できませんでした。登録チャンネルは残しているので、時間をおいて再更新してください。');
  return cache;
}

function channelSheet(onChange,onEdit){
  const wrap=el('div');let sheet;
  wrap.append(el('button',{class:`list-item ${selected==='all'?'selected':''}`,type:'button',text:'すべてのチャンネル',onclick:()=>{selected='all';localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange()}}));
  configuredChannels().forEach(ch=>{
    const key=channelKey(ch),row=cache.find(item=>rowKey(item)===key),active=configuredMatchesSelection(ch);
    const label=configuredLabel(ch)+(row?'':'（取得待ち）');
    wrap.append(el('button',{class:`list-item ${active?'selected':''}`,type:'button',text:label,onclick:()=>{selected=key;localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange()}}));
  });
  wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit()}}));
  sheet=openSheet(wrap,{title:'YouTubeチャンネル'});
}
function normalizeChannelValue(value=''){
  const raw=String(value||'').trim();
  if(!raw)return'';
  if(raw.startsWith('@'))return raw.split(/[/?#]/)[0];
  try{
    if(/^https?:\/\//i.test(raw)){
      const url=new URL(raw);
      const host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');
      if(host==='youtube.com'){
        const parts=url.pathname.split('/').filter(Boolean);
        if(parts[0]?.startsWith('@'))return `@${parts[0].slice(1)}`;
        if(parts[0]==='channel'&&parts[1])return parts[1];
      }
    }
  }catch{}
  return raw;
}
function normalizeChannels(draft=[]){
  const seen=new Set(),out=[];
  for(const raw of draft){
    const ch={...raw,name:String(raw?.name||'').trim(),value:normalizeChannelValue(raw?.value)};
    const key=channelKey(ch);if(!key||seen.has(key))continue;seen.add(key);out.push(ch);
  }
  return out;
}
function preserveCacheFor(channels){
  const previous=readCache();
  const allowed=new Set(channels.map(channelKey));
  cache=(Array.isArray(previous?.rows)?previous.rows:[]).filter(row=>allowed.has(rowKey(row)));
  loadWarnings=[];
  try{localStorage.setItem(CACHE_KEY,JSON.stringify({at:Number(previous?.at||0),complete:false,configSignature:configSignature(channels),rows:cache,warnings:[]}))}catch{}
}
function manage(onDone){let sheet;sheet=openSheet(collectionManager({items:state.youtubeChannels,fields:[{key:'name',label:'表示名',placeholder:'任意の名前'},{key:'value',label:'YouTube共有URL / @handle / Channel ID',placeholder:'例：https://youtube.com/@channel?si=...'}],onSave:draft=>{const channels=normalizeChannels(draft);update('youtubeChannels',channels);preserveCacheFor(channels);sheet.close();onDone?.()}}),{title:'YouTubeチャンネル編集'})}
export function openYouTubeChannelManager(onDone=()=>{}){manage(onDone)}
function normalizeKind(item){if(item?.liveType||item?.kind==='live')return'live';if(item?.kind==='videos')return'long';if(item?.kind==='shorts')return'short';return['long','short','live','unknown'].includes(item?.kind)?item.kind:'unknown'}
function liveBadge(item){if(item?.liveType==='archive')return el('span',{class:'archive-badge',text:'配信録画'});if(item?.liveType==='upcoming')return el('span',{class:'upcoming-badge',text:'配信予定'});return el('span',{class:'live-badge',text:'LIVE'})}

function thumbnailNode(item,currentTab,index){
  const url=String(item?.thumbnail||'').trim();
  const className=`thumb ${currentTab==='short'?'short-thumb':''}`;
  if(!url)return el('div',{class:`${className} thumb-missing`});
  return el('img',{class:className,src:url,alt:'',loading:index<4?'eager':'lazy',decoding:'async'});
}

export async function renderYouTube(host,{refresh=false}={}){
  const generation=++renderGeneration;
  cleanupYouTubePlayer();listSwipeDetach?.();listSwipeDetach=null;compactDetach?.();compactDetach=null;
  const screen=host.closest('.screen');screen?.classList.add('youtube-list-screen');
  const previous=readCache();
  const channels=configuredChannels();
  const allowed=new Set(channels.map(channelKey));
  if(previous?.rows?.length){cache=previous.rows.filter(row=>allowed.has(rowKey(row)));loadWarnings=Array.isArray(previous.warnings)?previous.warnings:[]}else{cache=[];loadWarnings=[]}
  if(!channels.length){host.replaceChildren(el('div',{class:'empty',text:'チャンネルを追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))}));return}

  let refreshing=false;
  let playerOpen=false;
  let pendingRefreshDraw=false;
  let playerObserver=null;

  function changeTab(next){if(!TABS.includes(next)||next===tab)return;cleanupYouTubePlayer();playerOpen=false;tab=next;localStorage.setItem('pdv2:youtubeTab',tab);draw()}
  function cycleTab(delta){const i=TABS.indexOf(tab),next=Math.max(0,Math.min(TABS.length-1,i+delta));if(next!==i)changeTab(TABS[next])}
  function draw(){
    if(generation!==renderGeneration||playerOpen)return;
    cleanupYouTubePlayer();compactDetach?.();compactDetach=null;playerObserver?.disconnect();playerObserver=null;
    if(selected!=='all'&&!channels.some(ch=>configuredMatchesSelection(ch)))selected='all';
    const selectedRows=selected==='all'?cache:cache.filter(row=>rowMatchesSelection(row));
    const picker=el('button',{class:'soft-button channel-picker youtube-channel-picker',type:'button',onclick:()=>channelSheet(draw,()=>manage(()=>renderYouTube(host,{refresh:true})))},[el('span',{text:`チャンネル　${selectedLabel()}`}),el('span',{text:'⌄'})]);
    const tabBar=el('div',{class:'media-sticky-tabs youtube-primary-tabs'});tabBar.append(segmented([{value:'long',label:'動画'},{value:'short',label:'Shorts'},{value:'live',label:'LIVE'}],tab,changeTab));
    const playerHost=el('div',{class:'youtube-inline-player-host twitch-inline-player-host'});
    const items=selectedRows.flatMap(row=>(row.items||[]).map(item=>({...item,kind:normalizeKind(item)}))).filter(item=>tab==='long'?(item.kind==='long'||item.kind==='unknown'):item.kind===tab).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const list=el('div',{class:'media-list media-swipe-list'});
    items.forEach((item,index)=>{const row=el('button',{class:'media-row',type:'button',onclick:()=>{playerOpen=true;mountYouTubePlayer({host:playerHost,queue:items,index,shorts:tab==='short'})}});row.append(thumbnailNode(item,tab,index));const copy=el('div',{class:'media-row-copy'}),titleLine=el('div',{class:'media-title-line'});if(tab==='live')titleLine.append(liveBadge(item),document.createTextNode(' '));titleLine.append(el('span',{class:'media-title',text:item.title||'無題'}));copy.append(titleLine,el('div',{class:'media-meta',text:[item.channelName||'',item.liveType==='archive'?'配信アーカイブ':''].filter(Boolean).join(' ・ ')}));row.append(copy);list.append(row)});
    if(!items.length){
      let message=refreshing?'YouTubeを更新しています…':'該当する動画が見つかりません';
      if(selected!=='all'&&!selectedRows.length&&!refreshing)message=`${selectedLabel()} は現在取得できません`;
      list.append(el('div',{class:'empty',text:message}));
    }
    const children=[picker,tabBar,playerHost];
    if(refreshing&&items.length)children.push(el('div',{class:'media-warning',text:'YouTubeをバックグラウンド更新中…'}));
    if(loadWarnings.length)children.push(el('div',{class:'media-warning',text:loadWarnings.slice(0,4).join(' / ')+(loadWarnings.length>4?` / 他${loadWarnings.length-4}件`: '')}));
    children.push(list);host.replaceChildren(...children);
    listSwipeDetach?.();listSwipeDetach=attachSwipe(list,{left:()=>cycleTab(1),right:()=>cycleTab(-1),threshold:68});if(screen)compactDetach=installShrinkingHeader(screen,{threshold:62,className:'youtube-scroll-compact'});
    playerObserver=new MutationObserver(()=>{
      if(generation!==renderGeneration)return;
      if(playerOpen&&playerHost.childElementCount===0){playerOpen=false;if(pendingRefreshDraw){pendingRefreshDraw=false;draw()}}
    });
    playerObserver.observe(playerHost,{childList:true});
  }
  function drawIfIdle(){if(generation!==renderGeneration)return;if(playerOpen){pendingRefreshDraw=true;return}draw()}

  draw();
  if(!refresh&&cacheIsFresh(previous))return;

  refreshing=true;drawIfIdle();
  try{
    await loadAll({force:refresh,onProgress:()=>drawIfIdle()});
  }catch(error){
    if(generation!==renderGeneration)return;
    if(!cache.length)loadWarnings=[error?.message||'YouTube一覧を取得できませんでした'];
  }finally{
    if(generation!==renderGeneration)return;
    refreshing=false;drawIfIdle();
  }
}
