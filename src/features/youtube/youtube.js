import { state, update } from '../../app/store.js';
import { el, openSheet, showToast } from '../../shared/dom.js';
import { collectionManager } from '../../shared/components.js';
import { openYouTubePlayer } from './youtube-player.js';

let tab=localStorage.getItem('pdv2:youtubeTab')||'long';
let selected=localStorage.getItem('pdv2:youtubeSelected')||'all';
let cache=[];

async function loadChannel(ch){const r=await fetch(`/api/youtube-feed?channel=${encodeURIComponent(ch.value||ch.url||ch.name)}`,{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'YouTube取得エラー');return d;}
async function loadAll(force=false){
  const key='pdv2:youtubeCache'; if(!force){try{const c=JSON.parse(localStorage.getItem(key)||'null');if(c&&Date.now()-c.at<10*60*1000){cache=c.rows;return cache;}}catch{}}
  const settled=await Promise.allSettled(state.youtubeChannels.map(loadChannel));
  cache=settled.filter(x=>x.status==='fulfilled').map(x=>x.value); localStorage.setItem(key,JSON.stringify({at:Date.now(),rows:cache}));return cache;
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

function manage(onDone){let sheet;sheet=openSheet(collectionManager({items:state.youtubeChannels,fields:[{key:'name',label:'表示名',placeholder:'任意の名前'},{key:'value',label:'チャンネルURL / @handle / Channel ID',placeholder:'https://youtube.com/@...'}],onSave:d=>{update('youtubeChannels',d);sheet.close();onDone();}}),{title:'YouTubeチャンネル編集'});}

export async function renderYouTube(host,{refresh=false}={}){
  host.innerHTML='<div class="loading">YouTubeを読み込み中...</div>';
  if(!state.youtubeChannels.length){host.replaceChildren(el('div',{class:'empty',text:'チャンネルを追加してください'}),el('button',{class:'primary-button full-button',type:'button',text:'YouTubeチャンネルを追加',onclick:()=>manage(()=>renderYouTube(host,{refresh:true}))}));return;}
  try{await loadAll(refresh);draw();}catch(err){host.innerHTML=`<div class="error-box">${err.message}</div>`;}
  function draw(){
    const selectedRow=selected==='all'?null:cache.find(r=>r.channel.id===selected);
    const picker=el('button',{class:'soft-button channel-picker',type:'button',html:`<span>👤 ${selectedRow?.channel.name||'すべてのチャンネル'}</span><span>⌄</span>`,onclick:()=>channelSheet(()=>draw(),()=>manage(()=>renderYouTube(host,{refresh:true})))});
    const seg=el('div',{class:'segmented'});[['long','動画'],['short','Shorts'],['live','LIVE']].forEach(([v,l])=>seg.append(el('button',{class:tab===v?'active':'',type:'button',text:l,onclick:()=>{tab=v;localStorage.setItem('pdv2:youtubeTab',v);draw();}})));
    let items=(selectedRow?[selectedRow]:cache).flatMap(r=>r.items||[]).filter(x=>x.kind===tab).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
    const list=el('div',{class:'media-list'});
    items.forEach((item,i)=>{
      const row=el('button',{class:'media-row',type:'button',onclick:()=>openYouTubePlayer(items,i,{shorts:tab==='short'})});
      const liveLabel = tab==='live'
        ? item.liveType==='archive' ? '<span class="archive-badge">配信録画</span> '
          : item.liveType==='upcoming' ? '<span class="upcoming-badge">配信予定</span> '
          : '<span class="live-badge">LIVE</span> '
        : '';
      row.innerHTML=`<img class="thumb ${tab==='short'?'short-thumb':''}" src="${item.thumbnail||''}" alt=""><div><div>${liveLabel}<span class="media-title">${item.title}</span></div><div class="media-meta">${item.channelName||''}${item.premiere?' ・ プレミア公開':''}${item.liveType==='archive'?' ・ 配信アーカイブ':''}</div></div>`;list.append(row);
    });
    if(!items.length)list.append(el('div',{class:'empty',text:tab==='short'?'Shortsが見つかりません':'動画が見つかりません'}));
    host.replaceChildren(picker,seg,list);
  }
}
