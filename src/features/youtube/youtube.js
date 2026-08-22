import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager, segmented, installShrinkingHeader } from '../../shared/components.js';
import { attachSwipe } from '../../shared/gestures.js';
import { cleanupYouTubePlayer, mountYouTubePlayer } from './youtube-player.js';

const TABS = ['long','short','live'];
const CACHE_KEY = 'pdv2:youtubeCache:v2160';
const SOFT_FRESH_MS = 3 * 60 * 1000;
let tab = localStorage.getItem('pdv2:youtubeTab') || 'long';
if(!TABS.includes(tab)) tab='long';
let selected = localStorage.getItem('pdv2:youtubeSelected') || 'all';
let cache=[];
let loadWarnings=[];
let listSwipeDetach=null;
let compactDetach=null;
let refreshGeneration=0;

function channelKey(ch) { return String(ch.value || ch.url || ch.name || '').trim().toLowerCase(); }

async function loadChannel(ch) {
  const input=ch.value||ch.url||ch.name;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10_500);
  try {
    const response=await fetch(`/api/youtube-feed?channel=${encodeURIComponent(input)}`,{cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw Object.assign(new Error(data.error||`YouTube取得エラー (${response.status})`),{reason:data.reason||'',detail:data.detail||'',sourceKey:channelKey(ch)});
    return {...data,_sourceKey:channelKey(ch),_configuredName:ch.name||''};
  } finally {
    clearTimeout(timer);
  }
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); }
  catch { return null; }
}

function saveCache() {
  try { localStorage.setItem(CACHE_KEY,JSON.stringify({at:Date.now(),rows:cache,warnings:loadWarnings})); } catch {}
}

function orderedRows(byKey) {
  return state.youtubeChannels.map(ch=>byKey.get(channelKey(ch))).filter(Boolean);
}

async function refreshAll({onProgress=null}={}) {
  const generation=++refreshGeneration;
  const previous=readCache();
  const staleByKey=new Map((previous?.rows||[]).map(row=>[String(row?._sourceKey||'').toLowerCase(),row]));
  const byKey=new Map(cache.map(row=>[String(row?._sourceKey||'').toLowerCase(),row]));
  const warningByKey=new Map();

  const publish=()=>{
    if(generation!==refreshGeneration)return;
    cache=orderedRows(byKey);
    loadWarnings=[...warningByKey.values()];
    saveCache();
    onProgress?.();
  };

  const tasks=state.youtubeChannels.map(async ch=>{
    const key=channelKey(ch);
    try {
      const row=await loadChannel(ch);
      if(generation!==refreshGeneration)return;
      byKey.set(key,{...row,_stale:false});
      warningByKey.delete(key);
      publish();
    } catch(error) {
      if(generation!==refreshGeneration)return;
      const stale=staleByKey.get(key)||byKey.get(key);
      if(stale) {
        byKey.set(key,{...stale,_stale:true});
        warningByKey.set(key,`${ch.name||ch.value||'YouTube'}: 前回取得分を表示中`);
      } else {
        warningByKey.set(key,`${ch.name||ch.value||'YouTube'}: 現在取得できません`);
      }
      publish();
    }
  });

  await Promise.allSettled(tasks);
  publish();
  if(!cache.length&&loadWarnings.length) throw new Error('YouTube一覧を取得できませんでした。少し後で更新してください。');
  return cache;
}

function channelSheet(onChange,onEdit) {
  const wrap=el('div'); let sheet;
  wrap.append(el('button',{class:`list-item ${selected==='all'?'selected':''}`,type:'button',text:'すべてのチャンネル',onclick:()=>{selected='all';localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange();}}));
  cache.forEach(row=>wrap.append(el('button',{class:'list-item',type:'button',text:row.channel?.name||row._configuredName||'YouTube',onclick:()=>{selected=row.channel?.id||'all';localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange();}})));
  wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit();}}));
  sheet=openSheet(wrap,{title:'YouTubeチャンネル'});
}

function manage(onDone) {
  let sheet;
  sheet=openSheet(collectionManager({
    items:state.youtubeChannels,
    fields:[
      {key:'name',label:'表示名',placeholder:'任意の名前'},
      {key:'value',label:'チャンネルURL / @handle / Channel ID',placeholder:'例：UCDn8Lqf-x0zD8hmFUg08f6w'}
    ],
    onSave:draft=>{
      update('youtubeChannels',draft);
      localStorage.removeItem(CACHE_KEY);
      sheet.close();
      onDone();
    }
  }),{title:'YouTubeチャンネル編集'});
}

function normalizeKind(item) {
  if(item?.liveType||item?.kind==='live') return 'live';
  if(item?.kind==='videos') return 'long';
  if(item?.kind==='shorts') return 'short';
  return item?.kind||'unknown';
}

function liveBadge(item) {
  if(item?.liveType==='archive') return el('span',{class:'archive-badge',text:'配信録画'});
  if(item?.liveType==='upcoming') return el('span',{class:'upcoming-badge',text:'配信予定'});
  return el('span',{class:'live-badge',text:'LIVE'});
}

export async function renderYouTube(host,{refresh=false}={}) {
  cleanupYouTubePlayer();
  listSwipeDetach?.(); listSwipeDetach=null;
  compactDetach?.(); compactDetach=null;
  const screen=host.closest('.screen');
  screen?.classList.add('youtube-list-screen');
  host.innerHTML='<div class="loading">YouTubeを読み込み中...</div>';

  if(!state.youtubeChannels.length) {
    host.replaceChildren(
      el('div',{class:'empty',text:'チャンネルを追加してください'}),
      el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))})
    );
    return;
  }

  function changeTab(next) {
    if(!TABS.includes(next)||next===tab) return;
    cleanupYouTubePlayer();
    tab=next;
    localStorage.setItem('pdv2:youtubeTab',tab);
    draw();
  }
  function cycleTab(delta) {
    const index=TABS.indexOf(tab);
    const next=Math.max(0,Math.min(TABS.length-1,index+delta));
    if(next!==index) changeTab(TABS[next]);
  }

  function draw() {
    if(!host.isConnected)return;
    cleanupYouTubePlayer();
    listSwipeDetach?.(); listSwipeDetach=null;
    compactDetach?.(); compactDetach=null;
    if(selected!=='all'&&!cache.some(row=>row.channel?.id===selected)) selected='all';
    const selectedRows=selected==='all'?cache:cache.filter(row=>row.channel?.id===selected);
    const picker=el('button',{class:'soft-button channel-picker youtube-channel-picker',type:'button',onclick:()=>channelSheet(draw,()=>manage(()=>renderYouTube(host,{refresh:true})))},[
      el('span',{text:`チャンネル　${selected==='all'?'すべて':selectedRows[0]?.channel?.name||'YouTube'}`}),el('span',{text:'⌄'})
    ]);
    const tabBar=el('div',{class:'media-sticky-tabs youtube-primary-tabs'});
    tabBar.append(segmented([
      {value:'long',label:'動画'},{value:'short',label:'Shorts'},{value:'live',label:'LIVE'}
    ],tab,changeTab));
    const playerHost=el('div',{class:'youtube-inline-player-host twitch-inline-player-host'});
    const items=selectedRows.flatMap(row=>(row.items||[]).map(item=>({...item,kind:normalizeKind(item)})))
      .filter(item=>item.kind===tab)
      .sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const list=el('div',{class:'media-list media-swipe-list'});

    items.forEach((item,index)=>{
      const row=el('button',{class:'media-row',type:'button',onclick:()=>mountYouTubePlayer({host:playerHost,queue:items,index,shorts:tab==='short'})});
      row.append(el('img',{class:`thumb ${tab==='short'?'short-thumb':''}`,src:item.thumbnail||'',alt:'',loading:index<4?'eager':'lazy',decoding:'async'}));
      const copy=el('div',{class:'media-row-copy'});
      const titleLine=el('div',{class:'media-title-line'});
      if(tab==='live') titleLine.append(liveBadge(item),document.createTextNode(' '));
      titleLine.append(el('span',{class:'media-title',text:item.title||'無題'}));
      const meta=[item.channelName||''];
      if(item.liveType==='archive') meta.push('配信アーカイブ');
      if(item._stale) meta.push('前回取得');
      copy.append(titleLine,el('div',{class:'media-meta',text:meta.filter(Boolean).join(' ・ ')}));
      row.append(copy);
      list.append(row);
    });
    if(!items.length) list.append(el('div',{class:'empty',text:`${tab==='short'?'Shorts':tab==='live'?'LIVE / 配信録画':'動画'}が見つかりません`}));

    const children=[picker,tabBar,playerHost];
    if(loadWarnings.length) children.push(el('div',{class:'media-warning',text:loadWarnings.join(' / ')}));
    children.push(list);
    host.replaceChildren(...children);
    listSwipeDetach=attachSwipe(list,{left:()=>cycleTab(1),right:()=>cycleTab(-1),threshold:68});
    if(screen) compactDetach=installShrinkingHeader(screen,{threshold:62,className:'youtube-scroll-compact'});
  }

  const previous=readCache();
  const previousRows=Array.isArray(previous?.rows)?previous.rows:[];
  const previousAge=Date.now()-Number(previous?.at||0);

  if(!refresh&&previousRows.length) {
    cache=previousRows;
    loadWarnings=previous?.warnings||[];
    draw();
    if(previousAge<SOFT_FRESH_MS)return;
    refreshAll({onProgress:draw}).catch(()=>{});
    return;
  }

  try {
    await refreshAll({onProgress:()=>{
      if(cache.length)draw();
    }});
    if(cache.length)draw();
  } catch(error) {
    if(cache.length)draw();
    else host.replaceChildren(el('div',{class:'error-box',text:error.message}));
  }
}
