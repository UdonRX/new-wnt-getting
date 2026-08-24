import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager, segmented, installShrinkingHeader } from '../../shared/components.js';
import { attachSwipe } from '../../shared/gestures.js';
import { cleanupYouTubePlayer, mountYouTubePlayer } from './youtube-player.js';

const TABS=['long','short','live'];
const CACHE_KEY='pdv2:youtubeCache:v2185';
const LOAD_CONCURRENCY=3;
const CACHE_TTL=10*60*1000;
let tab=localStorage.getItem('pdv2:youtubeTab')||'long';
if(!TABS.includes(tab))tab='long';
let selected=localStorage.getItem('pdv2:youtubeSelected')||'all';
let cache=[];
let loadWarnings=[];
let listSwipeDetach=null;
let compactDetach=null;
let renderGeneration=0;

function channelKey(ch){return String(ch.value||ch.url||ch.name||'').trim().toLowerCase()}
async function loadChannel(ch,{force=false}={}){
  const input=ch.value||ch.url||ch.name;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(`/api/youtube-feed?channel=${encodeURIComponent(input)}`,{cache:force?'no-store':'default',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error||`YouTube取得エラー (${response.status})`),{reason:data.reason||'',detail:data.detail||'',status:response.status,sourceKey:channelKey(ch)});
    return{...data,_sourceKey:channelKey(ch),_configuredName:ch.name||'',_stale:false};
  }finally{clearTimeout(timer)}
}
function readCache(){try{return JSON.parse(localStorage.getItem(CACHE_KEY)||'null')}catch{return null}}
function saveCache(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({at:Date.now(),rows:cache,warnings:loadWarnings}))}catch{}}
function cacheFresh(value=readCache()){return Boolean(value?.rows?.length)&&Date.now()-Number(value?.at||0)<CACHE_TTL}

async function loadAll({force=false,onProgress}={}){
  const previous=readCache();
  if(previous?.rows?.length){cache=previous.rows;loadWarnings=[]}
  if(!force&&cacheFresh(previous))return cache;

  const staleByKey=new Map((previous?.rows||[]).map(row=>[String(row?._sourceKey||'').toLowerCase(),row]));
  const byKey=new Map(cache.map(row=>[String(row?._sourceKey||'').toLowerCase(),row]));
  const failures=new Map();
  const queue=state.youtubeChannels.map((ch,index)=>({ch,index}));
  const total=queue.length;
  let completed=0;
  onProgress?.({completed,total,percent:total?8:100,label:'チャンネルをまとめて確認中'});

  const worker=async()=>{
    while(queue.length){
      const job=queue.shift();if(!job)break;
      const {ch}=job,key=channelKey(ch);
      try{
        const row=await loadChannel(ch,{force});
        byKey.set(key,row);failures.delete(key);
      }catch(error){
        const stale=staleByKey.get(key);
        if(stale)byKey.set(key,{...stale,_stale:true});
        failures.set(key,{name:ch.name||ch.value||'YouTube',reason:error?.reason||'',status:error?.status||0});
      }
      completed+=1;
      cache=state.youtubeChannels.map(x=>byKey.get(channelKey(x))).filter(Boolean);
      loadWarnings=[...failures.entries()].filter(([failedKey])=>!byKey.has(failedKey)).map(([,x])=>`${x.name}: 現在取得できません`);
      saveCache();
      const percent=total?Math.min(96,8+Math.round((completed/total)*88)):100;
      onProgress?.({completed,total,percent,label:`${completed}/${total} チャンネルを確認済み`});
    }
  };
  await Promise.allSettled(Array.from({length:Math.min(LOAD_CONCURRENCY,Math.max(1,queue.length))},()=>worker()));
  cache=state.youtubeChannels.map(x=>byKey.get(channelKey(x))).filter(Boolean);
  loadWarnings=[...failures.entries()].filter(([key])=>!byKey.has(key)).map(([,x])=>`${x.name}: 現在取得できません`);
  saveCache();
  onProgress?.({completed:total,total,percent:100,label:'一覧を更新しました'});
  if(!cache.length&&loadWarnings.length)throw new Error('YouTube一覧を取得できませんでした。更新処理を絞って再試行してください。');
  return cache;
}

function channelSheet(onChange,onEdit){const wrap=el('div');let sheet;wrap.append(el('button',{class:`list-item ${selected==='all'?'selected':''}`,type:'button',text:'すべてのチャンネル',onclick:()=>{selected='all';localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange()}}));cache.forEach(row=>wrap.append(el('button',{class:'list-item',type:'button',text:row.channel?.name||row._configuredName||'YouTube',onclick:()=>{selected=row.channel?.id||'all';localStorage.setItem('pdv2:youtubeSelected',selected);sheet?.close();onChange()}})));wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit()}}));sheet=openSheet(wrap,{title:'YouTubeチャンネル'})}
function manage(onDone){let sheet;sheet=openSheet(collectionManager({items:state.youtubeChannels,fields:[{key:'name',label:'表示名',placeholder:'任意の名前'},{key:'value',label:'チャンネルURL / @handle / Channel ID',placeholder:'例：UCDn8Lqf-x0zD8hmFUg08f6w'}],onSave:draft=>{update('youtubeChannels',draft);localStorage.removeItem(CACHE_KEY);sheet.close();onDone()}}),{title:'YouTubeチャンネル編集'})}
function normalizeKind(item){if(item?.liveType||item?.kind==='live')return'live';if(item?.kind==='videos')return'long';if(item?.kind==='shorts')return'short';return item?.kind||'long'}
function liveBadge(item){if(item?.liveType==='archive')return el('span',{class:'archive-badge',text:'配信録画'});if(item?.liveType==='upcoming')return el('span',{class:'upcoming-badge',text:'配信予定'});return el('span',{class:'live-badge',text:'LIVE'})}
function loadProgressMarkup(state){
  const wrap=el('div',{class:'youtube-load-progress','data-youtube-load-progress':'1'});
  const label=el('span',{class:'youtube-load-progress-label','data-youtube-load-label':'1',text:state?.label||'動画一覧を準備中'});
  const value=el('span',{class:'youtube-load-progress-value','data-youtube-load-value':'1',text:`${Math.round(state?.percent||8)}%`});
  const fill=el('span',{class:'youtube-load-progress-fill','data-youtube-load-fill':'1'});fill.style.width=`${Math.round(state?.percent||8)}%`;
  wrap.append(el('div',{class:'youtube-load-progress-top'},[label,value]),el('div',{class:'youtube-load-progress-track'},[fill]));
  return wrap;
}
function paintLoadProgress(node,state){
  if(!node?.isConnected||!state)return;
  const percent=Math.max(0,Math.min(100,Number(state.percent)||0));
  const label=node.querySelector('[data-youtube-load-label]');const value=node.querySelector('[data-youtube-load-value]');const fill=node.querySelector('[data-youtube-load-fill]');
  if(label)label.textContent=state.label||'動画一覧を準備中';if(value)value.textContent=`${Math.round(percent)}%`;if(fill)fill.style.width=`${percent}%`;
}

export async function renderYouTube(host,{refresh=false}={}){
  const generation=++renderGeneration;
  cleanupYouTubePlayer();listSwipeDetach?.();listSwipeDetach=null;compactDetach?.();compactDetach=null;
  const screen=host.closest('.screen');screen?.classList.add('youtube-list-screen');
  const previous=readCache();if(previous?.rows?.length){cache=previous.rows;loadWarnings=[]}else{cache=[];loadWarnings=[]}
  if(!state.youtubeChannels.length){host.replaceChildren(el('div',{class:'empty',text:'チャンネルを追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))}));return}

  let loadState=(refresh||!cacheFresh(previous))?{percent:8,label:'動画一覧を準備中'}:null;
  let loadProgressNode=null;
  let currentPlayerHost=null;
  const playerOpen=()=>Boolean(currentPlayerHost?.firstElementChild)||document.documentElement.classList.contains('youtube-shorts-open');

  function changeTab(next){if(!TABS.includes(next)||next===tab)return;cleanupYouTubePlayer();tab=next;localStorage.setItem('pdv2:youtubeTab',tab);draw()}
  function cycleTab(delta){const i=TABS.indexOf(tab),next=Math.max(0,Math.min(TABS.length-1,i+delta));if(next!==i)changeTab(TABS[next])}
  function draw(){
    if(generation!==renderGeneration)return;
    cleanupYouTubePlayer();compactDetach?.();compactDetach=null;
    if(selected!=='all'&&!cache.some(row=>row.channel?.id===selected))selected='all';
    const selectedRows=selected==='all'?cache:cache.filter(row=>row.channel?.id===selected);
    const picker=el('button',{class:'soft-button channel-picker youtube-channel-picker',type:'button',onclick:()=>channelSheet(draw,()=>manage(()=>renderYouTube(host,{refresh:true})))},[el('span',{text:`チャンネル　${selected==='all'?'すべて':selectedRows[0]?.channel?.name||'YouTube'}`}),el('span',{text:'⌄'})]);
    const tabBar=el('div',{class:'media-sticky-tabs youtube-primary-tabs'});tabBar.append(segmented([{value:'long',label:'動画'},{value:'short',label:'Shorts'},{value:'live',label:'LIVE'}],tab,changeTab));
    const playerHost=el('div',{class:'youtube-inline-player-host twitch-inline-player-host'});currentPlayerHost=playerHost;
    const items=selectedRows.flatMap(row=>(row.items||[]).map(item=>({...item,kind:normalizeKind(item)}))).filter(item=>item.kind===tab).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const list=el('div',{class:'media-list media-swipe-list'});
    items.forEach((item,index)=>{const row=el('button',{class:'media-row',type:'button',onclick:()=>mountYouTubePlayer({host:playerHost,queue:items,index,shorts:tab==='short'})});row.append(el('img',{class:`thumb ${tab==='short'?'short-thumb':''}`,src:item.thumbnail||'',alt:'',loading:index<4?'eager':'lazy',decoding:'async'}));const copy=el('div',{class:'media-row-copy'}),titleLine=el('div',{class:'media-title-line'});if(tab==='live')titleLine.append(liveBadge(item),document.createTextNode(' '));titleLine.append(el('span',{class:'media-title',text:item.title||'無題'}));copy.append(titleLine,el('div',{class:'media-meta',text:[item.channelName||'',item.liveType==='archive'?'配信アーカイブ':''].filter(Boolean).join(' ・ ')}));row.append(copy);list.append(row)});
    if(!items.length)list.append(el('div',{class:'empty',text:cache.length?'該当する動画が見つかりません':'YouTubeを取得中…'}));
    const children=[picker,tabBar,playerHost];
    loadProgressNode=null;if(loadState){loadProgressNode=loadProgressMarkup(loadState);children.push(loadProgressNode)}
    if(loadWarnings.length)children.push(el('div',{class:'media-warning',text:loadWarnings.slice(0,4).join(' / ')+(loadWarnings.length>4?` / 他${loadWarnings.length-4}件`: '')}));children.push(list);host.replaceChildren(...children);listSwipeDetach=attachSwipe(list,{left:()=>cycleTab(1),right:()=>cycleTab(-1),threshold:68});if(screen)compactDetach=installShrinkingHeader(screen,{threshold:62,className:'youtube-scroll-compact'});
  }

  draw();
  if(!loadState)return;
  try{
    await loadAll({force:refresh,onProgress:state=>{loadState=state;paintLoadProgress(loadProgressNode,state)}});
    if(generation!==renderGeneration)return;
    loadState=null;loadProgressNode?.remove();loadProgressNode=null;
    // 取得途中に動画を開いても、一覧の進捗更新でplayer DOMを破棄しない。
    // 全チャンネルの取得が終わった時だけ一度だけ一覧を更新する。
    if(!playerOpen())draw();
  }catch(error){
    if(generation!==renderGeneration)return;
    loadState=null;loadProgressNode?.remove();loadProgressNode=null;
    if(cache.length){if(!playerOpen())draw()}else host.replaceChildren(el('div',{class:'error-box',text:error.message}))
  }
}
