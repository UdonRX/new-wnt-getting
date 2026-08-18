import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager } from '../../shared/components.js';
import { cleanupTwitchPlayer, mountTwitchPlayer } from './twitch-player.js';

let selected=localStorage.getItem('pdv2:twitchSelected')||'all';
let cache=[];
let loadErrors=[];

async function loadOne(ch){
  const value=ch.value||ch.url||ch.name;
  const r=await fetch(`/api/twitch-feed?channel=${encodeURIComponent(value)}&format=json`,{headers:{Accept:'application/json'},cache:'no-store'});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`${ch.name||value}: ${d.error||'Twitch取得エラー'}`);
  return d;
}

async function loadAll(force=false){
  const key='pdv2:twitchCache';
  if(!force){
    try{const c=JSON.parse(localStorage.getItem(key)||'null');if(c&&Date.now()-c.at<60*1000){cache=c.rows||[];loadErrors=c.errors||[];return cache;}}catch{}
  }
  const s=await Promise.allSettled(state.twitchChannels.map(loadOne));
  cache=s.filter(x=>x.status==='fulfilled').map(x=>x.value);
  loadErrors=s.filter(x=>x.status==='rejected').map(x=>String(x.reason?.message||x.reason));
  localStorage.setItem(key,JSON.stringify({at:Date.now(),rows:cache,errors:loadErrors}));
  if(!cache.length&&loadErrors.length)throw new Error(loadErrors.join(' / '));
  return cache;
}

function manage(onDone){
  let sheet;
  sheet=openSheet(collectionManager({
    items:state.twitchChannels,
    fields:[{key:'name',label:'表示名',placeholder:'任意'},{key:'value',label:'Twitch URL / 配信者名',placeholder:'https://www.twitch.tv/...'}],
    onSave:d=>{update('twitchChannels',d);localStorage.removeItem('pdv2:twitchCache');sheet.close();onDone();}
  }),{title:'Twitch配信者編集'});
}

function picker(onChange,onEdit){
  const w=el('div'); let sheet;
  w.append(el('button',{class:'list-item',type:'button',text:'すべての配信者',onclick:()=>{
    selected='all';localStorage.setItem('pdv2:twitchSelected',selected);sheet?.close();onChange();
  }}));
  cache.forEach(s=>w.append(el('button',{class:'list-item',type:'button',text:s.broadcaster.displayName,onclick:()=>{
    selected=s.broadcaster.id;localStorage.setItem('pdv2:twitchSelected',selected);sheet?.close();onChange();
  }})));
  w.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit();}}));
  sheet=openSheet(w,{title:'Twitch配信者'});
}

function makeQueue(rows){
  const queue=[];
  rows.filter(s=>s.live.isLive).forEach(snapshot=>queue.push({snapshot,videoId:''}));
  rows.flatMap(snapshot=>snapshot.archives.map(v=>({snapshot,videoId:v.id,createdAt:v.createdAt})))
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .forEach(x=>queue.push(x));
  return queue;
}

export async function renderTwitch(host,{refresh=false}={}){
  cleanupTwitchPlayer();
  host.innerHTML='<div class="loading">Twitchを読み込み中...</div>';
  if(!state.twitchChannels.length){
    host.replaceChildren(el('div',{class:'empty',text:'配信者を追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'Twitch配信者を追加',onclick:()=>manage(()=>renderTwitch(host,{refresh:true}))}));
    return;
  }
  try{await loadAll(refresh);draw();}catch(err){host.replaceChildren(el('div',{class:'error-box',text:err.message}));}

  function draw(){
    if(selected!=='all'&&!cache.some(s=>s.broadcaster.id===selected))selected='all';
    const rows=selected==='all'?cache:cache.filter(s=>s.broadcaster.id===selected);
    const queue=makeQueue(rows);
    const playerHost=el('div',{class:'twitch-inline-player-host'});
    const play=(entry)=>{
      const idx=queue.findIndex(x=>x.snapshot.broadcaster.id===entry.snapshot.broadcaster.id&&String(x.videoId||'')===String(entry.videoId||''));
      mountTwitchPlayer({host:playerHost,queue,index:Math.max(0,idx),settings:state.settings});
    };

    const pick=el('button',{class:'soft-button channel-picker',type:'button',html:`<span>配信者　${selected==='all'?'すべて':rows[0]?.broadcaster.displayName||'配信者'}</span><span>⌄</span>`,onclick:()=>picker(draw,()=>manage(()=>renderTwitch(host,{refresh:true})))});
    const content=el('div');

    if(loadErrors.length)content.append(el('div',{class:'media-warning',text:loadErrors.join(' / ')}));

    const lives=rows.filter(s=>s.live.isLive);
    if(lives.length){
      const fixed=el('div',{class:'twitch-live-zone'});
      lives.forEach(s=>{
        const c=el('button',{class:'twitch-live-card',type:'button',onclick:()=>play({snapshot:s,videoId:''})});
        c.innerHTML=`<div class="live-badge">● LIVE</div><div class="media-title" style="margin-top:7px">${s.live.title}</div><div class="media-meta">${s.broadcaster.displayName} ・ ${Number(s.live.viewerCount||0).toLocaleString()}人視聴</div>`;
        fixed.append(c);
      });
      content.append(fixed);
    }

    const archives=rows.flatMap(s=>s.archives.map(v=>({s,v}))).sort((a,b)=>new Date(b.v.createdAt)-new Date(a.v.createdAt));
    const list=el('div',{class:'media-list'});
    archives.forEach(({s,v})=>{
      const r=el('button',{class:'media-row',type:'button',onclick:()=>play({snapshot:s,videoId:v.id})});
      r.innerHTML=`<img class="thumb" src="${v.thumbnailUrl||''}" alt=""><div><div class="media-title">${v.title}</div><div class="media-meta">${s.broadcaster.displayName} ・ ${v.duration||''}</div></div>`;
      list.append(r);
    });
    if(!list.children.length)list.append(el('div',{class:'empty',text:'アーカイブがありません'}));
    content.append(el('div',{class:'section-title'},[el('h2',{text:'アーカイブ'}),el('small',{text:'タイトルをタップで上に再生'})]),list);

    host.replaceChildren(pick,playerHost,content);
  }
}
