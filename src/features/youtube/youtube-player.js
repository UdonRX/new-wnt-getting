import { el, showToast } from '../../shared/dom.js';
import { watchPlayingTitle, clearPlayingTitle } from '../../shared/playing-title.js';

let apiPromise=null;
let player=null;
let activeHost=null;
let activePanel=null;
let shortsOverlay=null;
let endedTimer=null;
let endedMonitor=null;
let generation=0;
const autoNext=()=>localStorage.getItem('pdv2:youtubeAutoNext')!=='0';

function ensureApi() {
  if(window.YT?.Player) return Promise.resolve(window.YT);
  if(apiPromise) return apiPromise;
  apiPromise=new Promise((resolve,reject)=>{
    const previous=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{previous?.();resolve(window.YT);};
    if(!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script=document.createElement('script');
      script.src='https://www.youtube.com/iframe_api';
      script.onerror=reject;
      document.head.append(script);
    }
    const startedAt=Date.now();
    const timer=setInterval(()=>{
      if(window.YT?.Player){clearInterval(timer);resolve(window.YT);}
      else if(Date.now()-startedAt>10000){clearInterval(timer);reject(new Error('YouTube Player APIの読み込みがタイムアウトしました'));}
    },120);
  });
  return apiPromise;
}

function orientationButtonHtml(landscape) {
  const label=landscape?'縦表示':'横表示';
  const icon=landscape
    ? '<rect x="8.3" y="3.5" width="7.4" height="17" rx="2"/><path d="M5.5 8.2 3.2 10.5l2.3 2.3M18.5 15.8l2.3-2.3-2.3-2.3"/>'
    : '<rect x="3.5" y="7.2" width="17" height="9.6" rx="2"/><path d="m9 4.5 2.2-2.2 2.2 2.2M15 19.5l-2.2 2.2-2.2-2.2"/>';
  return `<svg class="youtube-orientation-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${label}</span>`;
}

function autoNextIconHtml() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 6.5H8.8a5.3 5.3 0 0 0-5.3 5.3v.4a5.3 5.3 0 0 0 5.3 5.3h7.7"/><path d="m14.5 3.5 3 3-3 3"/><path d="m9.5 20.5-3-3 3-3"/></svg>';
}

function syncAutoNextButtons(panel) {
  if (!panel) return;
  const enabled = autoNext();
  panel.querySelectorAll('[data-youtube-auto-next]').forEach(button => {
    button.classList.toggle('is-on', enabled);
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.setAttribute('aria-label', `連続再生 ${enabled ? 'ON' : 'OFF'}`);
    button.title = `連続再生 ${enabled ? 'ON' : 'OFF'}`;
    if (button.classList.contains('youtube-auto-next-btn')) button.textContent = `連続再生 ${enabled ? 'ON' : 'OFF'}`;
  });
}

function toggleAutoNext(panel) {
  localStorage.setItem('pdv2:youtubeAutoNext', autoNext() ? '0' : '1');
  syncAutoNextButtons(panel);
  showToast(`連続再生 ${autoNext() ? 'ON' : 'OFF'}`);
}

function setLandscape(panel,on) {
  if(!panel) return;
  const enabled=Boolean(on);
  panel.classList.toggle('youtube-css-landscape',enabled);
  document.documentElement.classList.toggle('media-player-open',enabled);
  document.documentElement.classList.toggle('youtube-landscape-open',enabled);
  document.body.classList.toggle('youtube-landscape-open',enabled);
  panel.querySelectorAll('.youtube-orientation-btn').forEach(button=>{
    button.innerHTML=orientationButtonHtml(enabled);
    button.setAttribute('aria-label',enabled?'縦表示に戻す':'横表示にする');
    button.title=enabled?'縦表示に戻す':'横表示にする';
  });
  if(enabled) window.scrollTo({top:0,behavior:'auto'});
}

function stopEndWatch() {
  if(endedTimer) clearTimeout(endedTimer);
  if(endedMonitor) clearInterval(endedMonitor);
  endedTimer=null; endedMonitor=null;
}

export function cleanupYouTubePlayer() {
  generation+=1;
  clearPlayingTitle();
  stopEndWatch();
  try{player?.pauseVideo?.();}catch{}
  try{player?.destroy?.();}catch{}
  player=null;
  if(activePanel) setLandscape(activePanel,false);
  activePanel=null;
  if(activeHost?.isConnected) activeHost.replaceChildren();
  activeHost=null;
  shortsOverlay?.remove(); shortsOverlay=null;
  document.documentElement.classList.remove('media-player-open','youtube-shorts-open','youtube-landscape-open');
  document.body.classList.remove('youtube-landscape-open');
}
window.addEventListener('pdv2:before-navigate',cleanupYouTubePlayer);

function toggleLandscape(panel) {
  const on=!panel.classList.contains('youtube-css-landscape');
  setLandscape(panel,on);
  showToast(on?'横表示に切り替えました':'縦表示に戻しました');
}
function clampIndex(index,queue){return Math.max(0,Math.min(Number(index)||0,queue.length-1));}

function mountShortsPlayer({queue,index=0}={}) {
  cleanupYouTubePlayer();
  if(!Array.isArray(queue)||!queue.length) return null;
  const myGeneration=generation;
  let current=clampIndex(index,queue);
  let advancing=false;
  const overlayRoot=document.getElementById('overlay-root')||document.body;
  const overlay=el('section',{class:'youtube-shorts-player',role:'dialog','aria-modal':'true','aria-label':'YouTube Shortsプレーヤー'});
  shortsOverlay=overlay;
  document.documentElement.classList.add('youtube-shorts-open','media-player-open');
  const close=el('button',{class:'youtube-shorts-close',type:'button','aria-label':'Shortsを閉じる',text:'✕',onclick:cleanupYouTubePlayer});
  const title=el('strong',{class:'youtube-shorts-title'});
  const channel=el('span',{class:'youtube-shorts-channel'});
  const top=el('header',{class:'youtube-shorts-top'},[close,el('div',{class:'youtube-shorts-meta'},[title,channel]),el('span',{class:'youtube-shorts-top-spacer','aria-hidden':'true'})]);
  const stage=el('div',{class:'youtube-shorts-stage'});
  const holderId=`yt-v2160-shorts-${Date.now()}`;
  stage.append(el('div',{id:holderId,class:'youtube-shorts-embed'}));
  const prev=el('button',{class:'youtube-shorts-action',type:'button',text:'‹ 前'});
  const next=el('button',{class:'youtube-shorts-action',type:'button',text:'次 ›'});
  const external=el('a',{class:'youtube-shorts-action youtube-shorts-external',target:'_blank',rel:'noopener noreferrer',text:'YouTubeで開く ↗'});
  overlay.append(top,stage,el('footer',{class:'youtube-shorts-bottom'},[prev,next,external]));
  overlayRoot.append(overlay);

  const updateUi=()=>{
    const item=queue[current]||{};
    title.textContent=item.title||'Shorts'; channel.textContent=item.channelName||'YouTube';
    external.href=`https://www.youtube.com/shorts/${encodeURIComponent(item.videoId||'')}`;
    prev.disabled=current<=0; next.disabled=current>=queue.length-1;
  };
  const loadIndex=nextIndex=>{
    if(nextIndex<0||nextIndex>=queue.length) return false;
    current=nextIndex; advancing=false; updateUi();
    const item=queue[current];
    if(player?.loadVideoById){try{player.loadVideoById({videoId:item.videoId,startSeconds:0});player.playVideo?.();}catch{}}
    return true;
  };
  const advance=()=>{
    if(advancing||current>=queue.length-1) return;
    advancing=true;
    endedTimer=setTimeout(()=>{endedTimer=null;if(!loadIndex(current+1))advancing=false;},120);
  };
  prev.onclick=()=>loadIndex(current-1); next.onclick=()=>loadIndex(current+1); updateUi();
  ensureApi().then(YT=>{
    if(myGeneration!==generation||!overlay.isConnected) return;
    player=new YT.Player(holderId,{videoId:queue[current].videoId,playerVars:{autoplay:1,playsinline:1,rel:0,cc_load_policy:0,controls:1,modestbranding:1},events:{
      onReady:event=>{try{event.target.playVideo();}catch{} endedMonitor=setInterval(()=>{if(myGeneration!==generation||!overlay.isConnected)return;try{if(player?.getPlayerState?.()===YT.PlayerState.ENDED)advance();}catch{}},650);},
      onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING)advancing=false;if(event.data===YT.PlayerState.ENDED)advance();}
    }});
  }).catch(error=>{if(overlay.isConnected)stage.append(el('div',{class:'youtube-shorts-error',text:`Shortsを再生できませんでした: ${error.message}`}));});
  return {close:cleanupYouTubePlayer};
}

function mountInlinePlayer({host,queue,index=0}={}) {
  cleanupYouTubePlayer();
  if(!host||!Array.isArray(queue)||!queue.length) return null;
  activeHost=host;
  const myGeneration=generation;
  let current=clampIndex(index,queue);
  let advancing=false;
  let ready=false;

  const panel=el('section',{class:'twitch-inline-player youtube-inline-player'});
  activePanel=panel;
  const kicker=el('div',{class:'twitch-inline-kicker'});
  const channel=el('strong',{class:'youtube-player-channel'});
  const close=el('button',{class:'icon-button twitch-close',type:'button','aria-label':'プレイヤーを閉じる',text:'✕',onclick:cleanupYouTubePlayer});
  const head=el('div',{class:'twitch-inline-head youtube-player-head'},[
    el('div',{class:'youtube-player-channel-copy'},[kicker,channel]),close
  ]);

  const stage=el('div',{class:'twitch-inline-stage youtube-inline-stage'});
  const holderId=`yt-v2170-player-${Date.now()}`;
  stage.append(el('div',{id:holderId,class:'youtube-inline-embed'}));
  const titleNode=el('div',{class:'player-title'});

  const prev=el('button',{class:'player-soft',type:'button',text:'‹ 前へ'});
  const next=el('button',{class:'player-soft',type:'button',text:'次へ ›'});
  const landscape=el('button',{
    class:'player-soft youtube-orientation-btn',type:'button',html:orientationButtonHtml(false),
    'aria-label':'横表示にする',title:'横表示にする',onclick:()=>toggleLandscape(panel)
  });
  const external=el('a',{class:'player-soft',target:'_blank',rel:'noopener noreferrer',text:'YouTubeで開く ↗'});
  const auto=el('button',{
    class:'player-soft youtube-auto-next-btn',type:'button','data-youtube-auto-next':'1',
    onclick:()=>toggleAutoNext(panel)
  });
  const controls=el('div',{class:'twitch-inline-controls youtube-inline-controls'},[prev,next,landscape,external,auto]);
  const info=el('div',{class:'twitch-inline-info youtube-inline-info'},[titleNode,controls]);

  const landscapePrev=el('button',{class:'youtube-landscape-action',type:'button',text:'‹ 前','aria-label':'前の動画'});
  const portrait=el('button',{
    class:'youtube-landscape-action youtube-orientation-btn',type:'button',html:orientationButtonHtml(true),
    'aria-label':'縦表示に戻す',title:'縦表示に戻す',onclick:()=>setLandscape(panel,false)
  });
  const landscapeNext=el('button',{class:'youtube-landscape-action',type:'button',text:'次 ›','aria-label':'次の動画'});
  const landscapeAuto=el('button',{
    class:'youtube-landscape-action youtube-landscape-auto',type:'button',html:autoNextIconHtml(),
    'data-youtube-auto-next':'1','aria-label':'連続再生','aria-pressed':'false',onclick:()=>toggleAutoNext(panel)
  });
  const landscapeControls=el('footer',{class:'youtube-landscape-controls'},[
    landscapePrev,portrait,landscapeNext,landscapeAuto
  ]);
  const landscapeViewport=el('div',{class:'youtube-landscape-viewport'},[stage,landscapeControls]);

  panel.append(head,landscapeViewport,info);
  activeHost.replaceChildren(panel);

  const updateUi=()=>{
    const item=queue[current]||{};
    kicker.textContent=item.kind==='live'?'LIVE':'動画';
    channel.textContent=item.channelName||'YouTube';
    titleNode.textContent=item.title||'YouTube';
    external.href=`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId||'')}`;
    prev.disabled=landscapePrev.disabled=current<=0;
    next.disabled=landscapeNext.disabled=current>=queue.length-1;
    syncAutoNextButtons(panel);
    clearPlayingTitle();
    watchPlayingTitle(stage,item.title||'YouTube');
  };

  const loadIndex=(nextIndex,{autoplay=true}={})=>{
    if(nextIndex<0||nextIndex>=queue.length) return false;
    current=nextIndex;
    advancing=false;
    updateUi();
    const item=queue[current];
    if(ready&&player?.loadVideoById){
      try{
        player.loadVideoById({videoId:item.videoId,startSeconds:0});
        if(autoplay) player.playVideo?.();
      }catch{}
    }
    return true;
  };

  const advanceFromEnd=()=>{
    if(!autoNext()||advancing||current>=queue.length-1)return;
    advancing=true;
    endedTimer=setTimeout(()=>{
      endedTimer=null;
      if(!loadIndex(current+1,{autoplay:true}))advancing=false;
    },100);
  };

  prev.onclick=landscapePrev.onclick=()=>loadIndex(current-1,{autoplay:true});
  next.onclick=landscapeNext.onclick=()=>loadIndex(current+1,{autoplay:true});

  const preventLandscapeScroll=event=>{
    if(panel.classList.contains('youtube-css-landscape')&&event.cancelable) event.preventDefault();
  };
  panel.addEventListener('touchmove',preventLandscapeScroll,{passive:false});
  panel.addEventListener('wheel',preventLandscapeScroll,{passive:false});

  updateUi();
  requestAnimationFrame(()=>activeHost?.scrollIntoView({behavior:'smooth',block:'start'}));

  ensureApi().then(YT=>{
    if(myGeneration!==generation||!panel.isConnected)return;
    player=new YT.Player(holderId,{
      videoId:queue[current].videoId,
      playerVars:{autoplay:1,playsinline:1,rel:0,cc_load_policy:0},
      events:{
        onReady:event=>{
          ready=true;
          try{event.target.playVideo();}catch{}
          endedMonitor=setInterval(()=>{
            if(myGeneration!==generation||!panel.isConnected||!autoNext())return;
            try{if(player?.getPlayerState?.()===YT.PlayerState.ENDED)advanceFromEnd();}catch{}
          },650);
        },
        onStateChange:event=>{
          if(event.data===YT.PlayerState.PLAYING)advancing=false;
          if(event.data===YT.PlayerState.ENDED)advanceFromEnd();
        }
      }
    });
  }).catch(error=>{
    if(panel.isConnected)info.append(el('div',{class:'error-box',text:`YouTubeプレイヤーを読み込めませんでした: ${error.message}`}));
  });
  return {close:cleanupYouTubePlayer};
}

export function mountYouTubePlayer({host,queue,index=0,shorts=false}={}) {
  return shorts?mountShortsPlayer({queue,index}):mountInlinePlayer({host,queue,index});
}
export function openYouTubePlayer(items,startIndex=0,{shorts=false,host}={}) {
  if(shorts) return mountShortsPlayer({queue:items,index:startIndex});
  if(!host) return null;
  return mountInlinePlayer({host,queue:items,index:startIndex});
}
