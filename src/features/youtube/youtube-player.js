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

// v2.19.7: YouTubeはiOS Safari/PWAでも埋め込み元を識別できるよう、
// Player APIとiframe fallbackの両方へorigin/referrer policyを明示する。
function youtubeErrorMessage(error, fallback='YouTubeプレイヤーの読み込みに失敗しました') {
  const code=Number(error?.data ?? error?.code ?? 0);
  if(code===2) return '動画IDが正しくありません。';
  if(code===5) return 'YouTubeプレイヤーを初期化できませんでした。';
  if(code===100) return 'この動画は削除済み、または非公開です。';
  if(code===101||code===150) return 'この動画は埋め込み再生が許可されていません。';
  if(code===153) return 'YouTubeが埋め込み元を確認できませんでした。';
  const message=String(error?.message || (typeof error==='string'?error:'')).trim();
  return message || fallback;
}

function youtubeEmbedUrl(videoId,{shorts=false,autoplay=true}={}) {
  const url=new URL(`https://www.youtube.com/embed/${encodeURIComponent(String(videoId||''))}`);
  url.searchParams.set('playsinline','1');
  url.searchParams.set('rel','0');
  url.searchParams.set('controls','1');
  url.searchParams.set('autoplay',autoplay?'1':'0');
  url.searchParams.set('origin',location.origin);
  if(shorts) url.searchParams.set('loop','0');
  return url.toString();
}

function mountIframeFallback(stage,item,{shorts=false}={}) {
  if(!stage?.isConnected||!item?.videoId) return null;
  const iframe=el('iframe',{
    src:youtubeEmbedUrl(item.videoId,{shorts,autoplay:true}),
    title:item.title||'YouTube',
    allow:'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen:'true',
    referrerpolicy:'strict-origin-when-cross-origin'
  });
  iframe.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000;';
  stage.replaceChildren(iframe);
  return iframe;
}

function clearPlaybackNotice(stage) {
  stage?.querySelectorAll?.('[data-youtube-playback-notice]').forEach(node=>node.remove());
}

function renderPlaybackError(stage,message,className='youtube-shorts-error') {
  if(!stage?.isConnected) return;
  clearPlaybackNotice(stage);
  const errorNode=el('div',{class:className,'data-youtube-playback-notice':'1',text:message});
  errorNode.style.cssText='position:absolute;inset:0;z-index:4;display:grid;place-content:center;padding:28px;text-align:center;background:#000;color:#fff;';
  stage.append(errorNode);
}

function renderExternalPlaybackFallback(stage,item,{shorts=false}={}) {
  if(!stage?.isConnected||!item?.videoId) return;
  clearPlaybackNotice(stage);
  const href=shorts
    ? `https://www.youtube.com/shorts/${encodeURIComponent(item.videoId)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  const message=el('div',{text:'この動画は投稿者の設定で埋め込み再生できません。'});
  const link=el('a',{
    href,
    target:'_blank',
    rel:'noopener noreferrer',
    text:'YouTubeで再生 ↗'
  });
  link.style.cssText='display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 20px;border:1px solid rgba(255,255,255,.34);border-radius:14px;background:#202020;color:#fff;text-decoration:none;font-weight:800;';
  const notice=el('div',{'data-youtube-playback-notice':'1'},[message,link]);
  notice.style.cssText='position:absolute;inset:0;z-index:4;display:grid;place-content:center;gap:16px;padding:28px;text-align:center;background:#000;color:#fff;';
  stage.append(notice);
}

function ensureApi() {
  if(window.YT?.Player) return Promise.resolve(window.YT);
  if(apiPromise) return apiPromise;

  const pending=new Promise((resolve,reject)=>{
    let timer=null;
    let script=null;
    let settled=false;
    const finishResolve=()=>{
      if(settled||!window.YT?.Player) return;
      settled=true;
      if(timer) clearInterval(timer);
      resolve(window.YT);
    };
    const finishReject=error=>{
      if(settled) return;
      settled=true;
      if(timer) clearInterval(timer);
      script?.remove?.();
      reject(error instanceof Error?error:new Error(youtubeErrorMessage(error,'YouTube Player APIを読み込めませんでした')));
    };

    const previous=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{
      try{previous?.();}catch(error){console.warn('[youtube] previous iframe ready callback failed',youtubeErrorMessage(error));}
      finishResolve();
    };

    if(!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      script=document.createElement('script');
      script.src='https://www.youtube.com/iframe_api';
      script.referrerPolicy='strict-origin-when-cross-origin';
      script.onerror=event=>finishReject(new Error(`YouTube Player APIの取得に失敗しました${event?.type?` (${event.type})`:''}`));
      document.head.append(script);
    }

    const startedAt=Date.now();
    timer=setInterval(()=>{
      if(window.YT?.Player) finishResolve();
      else if(Date.now()-startedAt>10000) finishReject(new Error('YouTube Player APIの読み込みがタイムアウトしました'));
    },120);
  });

  apiPromise=pending.catch(error=>{
    // 一度のscript失敗をページ存続中ずっと使い回さない。
    apiPromise=null;
    throw error;
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

function syncLandscapeViewport(panel) {
  if(!panel) return;
  const viewport=window.visualViewport;
  const width=Math.max(1,Number(viewport?.width||window.innerWidth||document.documentElement.clientWidth||1));
  const height=Math.max(1,Number(viewport?.height||window.innerHeight||document.documentElement.clientHeight||1));
  const left=Number(viewport?.offsetLeft||0);
  const top=Number(viewport?.offsetTop||0);
  panel.style.setProperty('--pdv2-media-vw',`${width}px`);
  panel.style.setProperty('--pdv2-media-vh',`${height}px`);
  panel.style.setProperty('--pdv2-media-left',`${left}px`);
  panel.style.setProperty('--pdv2-media-top',`${top}px`);
  panel.style.setProperty('--pdv2-media-cx',`${left+width/2}px`);
  panel.style.setProperty('--pdv2-media-cy',`${top+height/2}px`);
}

function clearLandscapeViewport(panel) {
  if(!panel) return;
  for(const name of ['--pdv2-media-vw','--pdv2-media-vh','--pdv2-media-left','--pdv2-media-top','--pdv2-media-cx','--pdv2-media-cy']) panel.style.removeProperty(name);
}

function setLandscape(panel,on) {
  if(!panel) return;
  const enabled=Boolean(on);
  panel.classList.toggle('youtube-css-landscape',enabled);
  document.documentElement.classList.toggle('media-player-open',enabled);
  document.documentElement.classList.toggle('youtube-landscape-open',enabled);
  document.body.classList.toggle('youtube-landscape-open',enabled);
  if(enabled) syncLandscapeViewport(panel); else clearLandscapeViewport(panel);
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
window.addEventListener('resize',()=>{if(activePanel?.classList.contains('youtube-css-landscape'))syncLandscapeViewport(activePanel);},{passive:true});
window.visualViewport?.addEventListener('resize',()=>{if(activePanel?.classList.contains('youtube-css-landscape'))syncLandscapeViewport(activePanel);},{passive:true});
window.visualViewport?.addEventListener('scroll',()=>{if(activePanel?.classList.contains('youtube-css-landscape'))syncLandscapeViewport(activePanel);},{passive:true});

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
  let fallbackMode=false;
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
  const useFallback=reason=>{
    if(myGeneration!==generation||!overlay.isConnected) return;
    console.warn('[youtube shorts] iframe fallback',youtubeErrorMessage(reason));
    clearPlaybackNotice(stage);
    try{player?.destroy?.();}catch{}
    player=null;
    fallbackMode=true;
    mountIframeFallback(stage,queue[current],{shorts:true});
  };
  const loadIndex=nextIndex=>{
    if(nextIndex<0||nextIndex>=queue.length) return false;
    current=nextIndex; advancing=false; updateUi();
    clearPlaybackNotice(stage);
    const item=queue[current];
    if(!fallbackMode&&player?.loadVideoById){try{player.loadVideoById({videoId:item.videoId,startSeconds:0});player.playVideo?.();}catch(error){useFallback(error);}}
    else if(fallbackMode) mountIframeFallback(stage,item,{shorts:true});
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
    try{
      player=new YT.Player(holderId,{videoId:queue[current].videoId,playerVars:{autoplay:1,playsinline:1,rel:0,cc_load_policy:0,controls:1,modestbranding:1,origin:location.origin},events:{
        onReady:event=>{try{event.target.getIframe?.().setAttribute('referrerpolicy','strict-origin-when-cross-origin');event.target.playVideo();}catch{} endedMonitor=setInterval(()=>{if(myGeneration!==generation||!overlay.isConnected)return;try{if(player?.getPlayerState?.()===YT.PlayerState.ENDED)advance();}catch{}},650);},
        onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING)advancing=false;if(event.data===YT.PlayerState.ENDED)advance();},
        onError:event=>{const code=Number(event?.data||0);if(code===5||code===153)useFallback(event);else if(code===101||code===150)renderExternalPlaybackFallback(stage,queue[current],{shorts:true});else renderPlaybackError(stage,youtubeErrorMessage(event));}
      }});
    }catch(error){useFallback(error);}
  }).catch(error=>useFallback(error));
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
  let fallbackMode=false;

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
  const useFallback=reason=>{
    if(myGeneration!==generation||!panel.isConnected) return;
    console.warn('[youtube] iframe fallback',youtubeErrorMessage(reason));
    try{player?.destroy?.();}catch{}
    player=null;
    ready=false;
    fallbackMode=true;
    mountIframeFallback(stage,queue[current]);
  };

  const loadIndex=(nextIndex,{autoplay=true}={})=>{
    if(nextIndex<0||nextIndex>=queue.length) return false;
    current=nextIndex;
    advancing=false;
    updateUi();
    const item=queue[current];
    if(!fallbackMode&&ready&&player?.loadVideoById){
      try{
        player.loadVideoById({videoId:item.videoId,startSeconds:0});
        if(autoplay) player.playVideo?.();
      }catch(error){useFallback(error);}
    }else if(fallbackMode){
      mountIframeFallback(stage,item);
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
    try{
      player=new YT.Player(holderId,{
        videoId:queue[current].videoId,
        playerVars:{autoplay:1,playsinline:1,rel:0,cc_load_policy:0,origin:location.origin},
        events:{
          onReady:event=>{
            ready=true;
            try{event.target.getIframe?.().setAttribute('referrerpolicy','strict-origin-when-cross-origin');event.target.playVideo();}catch{}
            endedMonitor=setInterval(()=>{
              if(myGeneration!==generation||!panel.isConnected||!autoNext())return;
              try{if(player?.getPlayerState?.()===YT.PlayerState.ENDED)advanceFromEnd();}catch{}
            },650);
          },
          onStateChange:event=>{
            if(event.data===YT.PlayerState.PLAYING)advancing=false;
            if(event.data===YT.PlayerState.ENDED)advanceFromEnd();
          },
          onError:event=>{const code=Number(event?.data||0);if(code===5||code===153)useFallback(event);else if(panel.isConnected)info.append(el('div',{class:'error-box',text:youtubeErrorMessage(event)}));}
        }
      });
    }catch(error){useFallback(error);}
  }).catch(error=>useFallback(error));
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
