import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { collectionManager } from '../../shared/components.js';
import { openYouTubePlayer } from './youtube-player.js';

let tab=localStorage.getItem('pdv2:youtubeTab')||'long';
let selected=localStorage.getItem('pdv2:youtubeSelected')||'all';
let cache=[];
let loadWarnings=[];

async function loadChannel(ch){
  const input=ch.value||ch.url||ch.name;
  const r=await fetch(`/api/youtube-feed?channel=${encodeURIComponent(input)}`,{cache:'no-store'});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`${ch.name||input}: ${d.error||`YouTube取得エラー (${r.status})`}`);
  return d;
}

async function loadAll(force=false){
  const key='pdv2:youtubeCache';
  if(!force){
    try{
      const c=JSON.parse(localStorage.getItem(key)||'null');
      if(c&&Date.now()-c.at<10*60*1000){cache=c.rows||[];loadWarnings=c.warnings||[];return cache;}
    }catch{}
  }
  const settled=await Promise.allSettled(state.youtubeChannels.map(loadChannel));
  cache=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const failures=settled.filter(x=>x.status==='rejected').map(x=>String(x.reason?.message||x.reason));
  loadWarnings=[...failures,...cache.map(x=>x.warning).filter(Boolean)];
  localStorage.setItem(key,JSON.stringify({at:Date.now(),rows:cache,warnings:loadWarnings}));
  if(!cache.length&&failures.length)throw new Error(failures.join(' / '));
  return cache;
}

function channelSheet(onChange,onEdit){
  const wrap=el('div'); let sheet;
  wrap.append(el('button',{class:`list-item ${selected==='all'?'selected':''}`,type:'button',text:'すべてのチャンネル',onclick:()=>{
    selected='all'; localStorage.setItem('pdv2:youtubeSelected',selected); sheet?.close(); onChange();
  }}));
  cache.forEach(row=>wrap.append(el('button',{class:'list-item',type:'button',text:row.channel.name,onclick:()=>{
    selected=row.channel.id; localStorage.setItem('pdv2:youtubeSelected',selected); sheet?.close(); onChange();
  }})));
  wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'＋追加 / 編集',onclick:()=>{sheet?.close();onEdit();}}));
  sheet=openSheet(wrap,{title:'YouTubeチャンネル'});
}

function manage(onDone){
  let sheet;
  sheet=openSheet(collectionManager({
    items:state.youtubeChannels,
    fields:[{key:'name',label:'表示名',placeholder:'任意の名前'},{key:'value',label:'チャンネルURL / @handle / Channel ID',placeholder:'例：UCDn8Lqf-x0zD8hmFUg08f6w'}],
    onSave:d=>{update('youtubeChannels',d);localStorage.removeItem('pdv2:youtubeCache');sheet.close();onDone();}
  }),{title:'YouTubeチャンネル編集'});
}

export async function renderYouTube(host,{refresh=false}={}){
  host.innerHTML='<div class="loading">YouTubeを読み込み中...</div>';
  if(!state.youtubeChannels.length){
    host.replaceChildren(el('div',{class:'empty',text:'チャンネルを追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))}));
    return;
  }
  try{await loadAll(refresh);draw();}catch(err){host.replaceChildren(el('div',{class:'error-box',text:err.message}),el('button',{class:'soft-button full-button',type:'button',text:'もう一度取得',onclick:()=>renderYouTube(host,{refresh:true})}));}

  function draw(){
    if(selected!=='all'&&!cache.some(r=>r.channel.id===selected))selected='all';
    const selectedRow=selected==='all'?null:cache.find(r=>r.channel.id===selected);
    const picker=el('button',{class:'soft-button channel-picker',type:'button',html:`<span>チャンネル　${selectedRow?.channel.name||'すべて'}</span><span>⌄</span>`,onclick:()=>channelSheet(()=>draw(),()=>manage(()=>renderYouTube(host,{refresh:true})))});
    const seg=el('div',{class:'segmented'});
    [['long','動画'],['short','Shorts'],['live','LIVE']].forEach(([v,l])=>seg.append(el('button',{class:tab===v?'active':'',type:'button',text:l,onclick:()=>{tab=v;localStorage.setItem('pdv2:youtubeTab',v);draw();}})));
    const items=(selectedRow?[selectedRow]:cache).flatMap(r=>r.items||[]).filter(x=>x.kind===tab).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const list=el('div',{class:'media-list'});
    items.forEach((item,i)=>{
      const row=el('button',{class:'media-row',type:'button',onclick:()=>openYouTubePlayer(items,i,{shorts:tab==='short'})});
      const liveLabel = tab==='live'
        ? item.liveType==='archive' ? '<span class="archive-badge">配信録画</span> '
          : item.liveType==='upcoming' ? '<span class="upcoming-badge">配信予定</span> '
          : '<span class="live-badge">LIVE</span> '
        : '';
      row.innerHTML=`<img class="thumb ${tab==='short'?'short-thumb':''}" src="${item.thumbnail||''}" alt=""><div><div>${liveLabel}<span class="media-title">${item.title}</span></div><div class="media-meta">${item.channelName||''}${item.premiere?' ・ プレミア公開':''}${item.liveType==='archive'?' ・ 配信アーカイブ':''}</div></div>`;
      list.append(row);
    });
    if(!items.length){
      const label=tab==='short'?'Shorts':tab==='live'?'LIVE / 配信録画':'動画';
      list.append(el('div',{class:'empty',text:`${label}が見つかりません`}));
    }
    const children=[picker,seg];
    if(loadWarnings.length)children.push(el('div',{class:'media-warning',text:loadWarnings.join(' / ')}));
    children.push(list);
    host.replaceChildren(...children);
  }
}
