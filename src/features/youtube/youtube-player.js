import { el, showToast } from '../../shared/dom.js';
import { attachSwipe } from '../../shared/gestures.js';

let apiPromise=null, player=null, modal=null, list=[], index=0, endedTimer=null;
const autoNext=()=>localStorage.getItem('pdv2:youtubeAutoNext')!=='0';

function ensureApi(){
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(apiPromise)return apiPromise;
  apiPromise=new Promise((resolve,reject)=>{
    const prev=window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady=()=>{prev?.();resolve(window.YT)};
    if(!document.querySelector('script[src*="youtube.com/iframe_api"]')){const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.onerror=reject;document.head.append(s);}
    setTimeout(()=>window.YT?.Player&&resolve(window.YT),4000);
  });return apiPromise;
}
function close(){if(endedTimer)clearTimeout(endedTimer);try{player?.pauseVideo?.()}catch{};modal?.remove();modal=null;player?.destroy?.();player=null;}
function setLandscape(on){if(!modal)return;modal.classList.toggle('css-landscape',Boolean(on));modal.dataset.landscape=on?'1':'0';}
function toggleLandscape(){if(!modal||modal.classList.contains('shorts'))return;setLandscape(modal.dataset.landscape!=='1');}
function updateMeta(item){
  if(!modal)return; modal.querySelector('.player-title').textContent=item.title; modal.querySelector('.player-channel').textContent=item.channelName||'';
  const btn=modal.querySelector('.auto-next-btn');if(btn)btn.textContent=`連続再生 ${autoNext()?'ON':'OFF'}`;
  const external=modal.querySelector('.youtube-external');if(external)external.href=`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
}
async function loadCurrent(){
  const item=list[index]; if(!item||!modal)return;
  updateMeta(item);
  if(player?.loadVideoById){player.loadVideoById({videoId:item.videoId,startSeconds:0});return;}
  const YT=await ensureApi();
  player=new YT.Player('yt-v2-player',{videoId:item.videoId,playerVars:{autoplay:1,playsinline:1,rel:0},events:{onReady:e=>{try{e.target.playVideo()}catch{}},onStateChange:e=>{if(e.data===YT.PlayerState.ENDED&&autoNext()){endedTimer=setTimeout(()=>move(1),250);}}}});
}
function move(delta){const next=index+delta;if(next<0||next>=list.length){showToast(next<0?'最初の動画です':'最後の動画です');return;}index=next;loadCurrent();}

export function openYouTubePlayer(items,startIndex=0,{shorts=false}={}){
  list=items; index=Math.max(0,Math.min(startIndex,list.length-1));
  modal=el('section',{class:`player-modal ${shorts?'shorts':''}`});
  const top=el('div',{class:'player-topbar'});
  top.append(el('button',{class:'player-icon',type:'button',text:'✕',onclick:close}),el('strong',{text:shorts?'Shorts':'YouTube'}));
  if(!shorts)top.append(el('button',{class:'player-icon orientation-btn',type:'button',text:'↔ 横画面',onclick:toggleLandscape})); else top.append(el('span'));
  const stage=el('div',{class:'player-stage'});stage.append(el('div',{id:'yt-v2-player',style:'width:100%;height:100%'}));
  const body=el('div',{class:'player-body'});body.append(el('div',{class:'player-title'}),el('div',{class:'player-channel'}));
  const actions=el('div',{class:'player-actions'});
  actions.append(el('button',{class:'player-soft',type:'button',text:'◀ 前',onclick:()=>move(-1)}),el('button',{class:'player-soft',type:'button',text:'次 ▶',onclick:()=>move(1)}));
  if(!shorts){actions.append(el('button',{class:'player-soft auto-next-btn',type:'button',onclick:e=>{localStorage.setItem('pdv2:youtubeAutoNext',autoNext()?'0':'1');e.currentTarget.textContent=`連続再生 ${autoNext()?'ON':'OFF'}`;}}));}
  actions.append(el('a',{class:'player-soft youtube-external',target:'_blank',rel:'noopener noreferrer',href:'#',text:'YouTubeで開く ↗'}));
  body.append(actions); modal.append(top,stage,body);document.getElementById('overlay-root').append(modal);
  if(shorts)attachSwipe(modal,{up:()=>move(1),down:()=>move(-1),threshold:70});
  loadCurrent();
  return {close};
}
