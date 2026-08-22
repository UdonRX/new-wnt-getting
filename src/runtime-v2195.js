import './runtime-v2192.js';

const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const lerp=(a,b,p)=>a+(b-a)*p;
const easeOut=p=>1-Math.pow(1-clamp(p),3);

// ---------------------------------------------------------------------------
// Reader list gesture: lock the swipe direction once and never re-evaluate it.
// The tab rail itself never auto-scrolls while a swipe is in progress.
// ---------------------------------------------------------------------------
let readerGesture=null;
let readerSuppressClickUntil=0;
let readerFab=null;
let readerFabSource=null;
let readerFabScreen=null;

function activeButton(container){return [...(container?.querySelectorAll?.('button')||[])].find(button=>button.classList.contains('active')||button.getAttribute('aria-selected')==='true')||null;}
function buttons(container){return [...(container?.querySelectorAll?.('button')||[])];}
function modeInfo(screen){const container=screen?.querySelector('.reader-mode-nav .segmented');const list=buttons(container);let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}
function sourceInfo(screen){const container=screen?.querySelector('.reader-feed-chips');const list=buttons(container).filter(button=>button.classList.contains('chip'));let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}
function trackInfo(screen){const container=screen?.querySelector('.paper-track-level .segmented');const list=buttons(container);let index=list.indexOf(activeButton(container));if(index<0)index=0;return{container,list,index};}

function selectReaderEdge(targetModeIndex,edge,attempt=0){
  if(attempt>24)return;
  const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
  if(!screen){setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),35);return;}
  const mode=modeInfo(screen);
  if(mode.index!==targetModeIndex){setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),35);return;}
  if(targetModeIndex===2){
    const track=trackInfo(screen);
    if(track.list.length){
      const desired=edge==='first'?0:track.list.length-1;
      if(track.index!==desired){track.list[desired]?.click();setTimeout(()=>selectReaderEdge(targetModeIndex,edge,attempt+1),45);return;}
      if(desired===track.list.length-1){const source=sourceInfo(screen);const button=edge==='first'?source.list[0]:source.list.at(-1);if(button&&!button.classList.contains('active'))button.click();}
    }
    return;
  }
  const source=sourceInfo(screen);const button=edge==='first'?source.list[0]:source.list.at(-1);if(button&&!button.classList.contains('active'))button.click();
}

function readerPlan(screen,direction){
  const mode=modeInfo(screen);if(!mode.list.length)return null;
  const source=sourceInfo(screen);
  if(mode.index<2){
    const next=source.index+direction;
    if(source.list.length&&next>=0&&next<source.list.length)return{container:source.container,from:source.list[source.index],to:source.list[next],commit:()=>source.list[next]?.click()};
    const nextMode=mode.index+direction;if(nextMode<0||nextMode>=mode.list.length)return null;
    return{container:mode.container,from:mode.list[mode.index],to:mode.list[nextMode],commit:()=>{mode.list[nextMode]?.click();setTimeout(()=>selectReaderEdge(nextMode,direction>0?'first':'last'),35);}};
  }
  const track=trackInfo(screen);
  if(track.list.length&&track.index===0){
    if(direction>0&&track.list[1])return{container:track.container,from:track.list[0],to:track.list[1],commit:()=>{track.list[1].click();setTimeout(()=>selectReaderEdge(2,'first'),35);}};
    if(direction<0&&mode.index>0)return{container:mode.container,from:mode.list[mode.index],to:mode.list[mode.index-1],commit:()=>{mode.list[mode.index-1].click();setTimeout(()=>selectReaderEdge(mode.index-1,'last'),35);}};
    return null;
  }
  if(track.list.length&&track.index>0){
    const next=source.index+direction;
    if(source.list.length&&next>=0&&next<source.list.length)return{container:source.container,from:source.list[source.index],to:source.list[next],commit:()=>source.list[next]?.click()};
    if(direction<0)return{container:track.container,from:track.list[track.index],to:track.list[0],commit:()=>track.list[0]?.click()};
  }
  return null;
}

function swipeIndicator(container){
  if(!container)return null;
  let indicator=container.querySelector(':scope > .reader-swipe-progress-indicator');
  if(indicator)return indicator;
  indicator=document.createElement('span');indicator.className='reader-swipe-progress-indicator';indicator.setAttribute('aria-hidden','true');container.append(indicator);return indicator;
}
function paintReaderPlan(plan,progress){
  if(!plan?.container||!plan.from||!plan.to)return;
  const p=clamp(progress);const indicator=swipeIndicator(plan.container);if(!indicator)return;
  plan.container.classList.add('reader-swipe-progress-active');
  const x=lerp(plan.from.offsetLeft,plan.to.offsetLeft,p);const width=lerp(plan.from.offsetWidth,plan.to.offsetWidth,p);
  indicator.style.width=`${Math.max(1,width)}px`;indicator.style.transform=`translate3d(${x}px,0,0)`;indicator.style.opacity='1';
}
function clearReaderPlan(plan){if(!plan?.container)return;const indicator=plan.container.querySelector(':scope > .reader-swipe-progress-indicator');if(indicator)indicator.style.opacity='0';plan.container.classList.remove('reader-swipe-progress-active');}
function readerIgnore(target){return Boolean(target?.closest?.('input,textarea,select,a,.reader-source-dock,.reader-mode-nav,.paper-track-level,.reader-bento-search,.reader-global-recommend-fab'));}
function readerTravel(width){return Math.max(92,Math.min(150,Math.max(1,width)*.36));}
function directionalDistance(g){if(!g?.direction)return 0;return g.direction>0?Math.max(0,-g.dx):Math.max(0,g.dx);}
function captureRailPositions(screen){return{
  mode:screen?.querySelector('.reader-mode-nav .segmented')?.scrollLeft||0,
  source:screen?.querySelector('.reader-feed-chips')?.scrollLeft||0,
  track:screen?.querySelector('.paper-track-level .segmented')?.scrollLeft||0
};}
function freezeReaderRails(positions,duration=320){
  const started=performance.now();
  const tick=()=>{
    const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
    if(!screen||performance.now()-started>duration)return;
    const rows=[['.reader-mode-nav .segmented',positions.mode],['.reader-feed-chips',positions.source],['.paper-track-level .segmented',positions.track]];
    for(const [selector,left] of rows){const node=screen.querySelector(selector);if(node&&Math.abs(node.scrollLeft-left)>.5)node.scrollLeft=left;}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

document.addEventListener('touchstart',event=>{
  if(event.touches?.length!==1)return;
  const target=event.target;const host=target?.closest?.('.reader-screen:not(.reader-focus-open) .reader-content-host');if(!host||readerIgnore(target))return;
  const touch=event.touches[0];readerGesture={host,screen:host.closest('.reader-screen'),startX:touch.clientX,startY:touch.clientY,startAt:performance.now(),dx:0,dy:0,horizontal:false,direction:0,planResolved:false,plan:null,visual:host.querySelector('.reader-bento-view')||host.firstElementChild,railPositions:captureRailPositions(host.closest('.reader-screen'))};
},{capture:true,passive:true});

document.addEventListener('touchmove',event=>{
  const g=readerGesture;if(!g||event.touches?.length!==1)return;
  const touch=event.touches[0];g.dx=touch.clientX-g.startX;g.dy=touch.clientY-g.startY;
  if(!g.horizontal){
    if(Math.abs(g.dy)>12&&Math.abs(g.dy)>Math.abs(g.dx)*1.08){readerGesture=null;return;}
    if(Math.abs(g.dx)<7||Math.abs(g.dx)<=Math.abs(g.dy)*1.08)return;
    g.horizontal=true;g.direction=g.dx<0?1:-1;g.plan=readerPlan(g.screen,g.direction);g.planResolved=true;g.visual?.classList.add('reader-horizontal-live');
  }
  if(event.cancelable)event.preventDefault();
  const distance=directionalDistance(g);const travel=readerTravel(g.host.clientWidth);const p=clamp(distance/travel);
  paintReaderPlan(g.plan,p);
  if(g.visual){const signed=g.direction>0?-distance:distance;g.visual.style.transform=`translate3d(${(signed*.18).toFixed(1)}px,0,0)`;}
},{capture:true,passive:false});

document.addEventListener('touchend',event=>{
  const g=readerGesture;readerGesture=null;if(!g?.horizontal)return;
  event.preventDefault();event.stopImmediatePropagation();readerSuppressClickUntil=Date.now()+360;
  const distance=directionalDistance(g);const elapsed=Math.max(16,performance.now()-g.startAt);const speed=distance/elapsed;const travel=readerTravel(g.host.clientWidth);const p=clamp(distance/travel);const quickFlick=distance>=36&&speed>=.46;const commit=Boolean(g.plan&&(p>=.5||quickFlick));
  if(g.visual){g.visual.style.transition='transform 150ms cubic-bezier(.2,.82,.2,1)';g.visual.style.transform=commit?`translate3d(${g.direction>0?'-38px':'38px'},0,0)`:'translate3d(0,0,0)';setTimeout(()=>{if(g.visual){g.visual.style.transition='';g.visual.style.transform='';g.visual.classList.remove('reader-horizontal-live');}},185);}
  if(g.plan){paintReaderPlan(g.plan,commit?1:0);setTimeout(()=>clearReaderPlan(g.plan),160);}
  if(commit){freezeReaderRails(g.railPositions,340);setTimeout(()=>g.plan?.commit?.(),95);}
},{capture:true,passive:false});

document.addEventListener('touchcancel',()=>{if(readerGesture?.plan)clearReaderPlan(readerGesture.plan);readerGesture=null;},{capture:true,passive:true});
document.addEventListener('click',event=>{if(Date.now()<readerSuppressClickUntil&&event.target?.closest?.('.reader-content-host')){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});

function ensureReaderFab(){
  const screen=document.querySelector('.reader-screen:not(.reader-focus-open)');
  if(!screen){readerFab?.remove();readerFab=null;readerFabSource=null;readerFabScreen=null;return false;}
  const source=screen.querySelector('.reader-recommend-overlay');if(!source)return false;source.classList.add('reader-recommend-source-hidden');
  if(readerFabScreen!==screen||readerFabSource!==source||!readerFab?.isConnected){
    readerFab?.remove();readerFabSource=source;readerFabScreen=screen;readerFab=document.createElement('button');readerFab.type='button';readerFab.className='reader-global-recommend-fab';readerFab.setAttribute('aria-label','おすすめへ');readerFab.title='おすすめへ';readerFab.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 13.8 8l5.2 1.8-5.2 1.8L12 17l-1.8-5.4L5 9.8 10.2 8 12 2.8Z"/><path d="m18.2 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>';
    readerFab.addEventListener('click',()=>{if(readerFabSource?.isConnected)readerFabSource.click();});document.body.append(readerFab);
  }
  return true;
}

let twitterCleanup=null;
function installTwitterHeader(){
  const host=document.querySelector('.twitter-feed-host');const screen=host?.closest('.screen');if(!screen)return false;if(screen.dataset.pdv2195Twitter==='1')return true;
  twitterCleanup?.();const topbar=screen.querySelector(':scope > .topbar');const chips=screen.querySelector(':scope > .twitter-list-chips');if(!topbar||!chips)return false;
  screen.dataset.pdv2195Twitter='1';const wrapper=document.createElement('div');wrapper.className='twitter-rich-sticky';screen.insertBefore(wrapper,topbar);wrapper.append(topbar,chips);
  const actions=topbar.querySelector('.topbar-actions');const copy=topbar.querySelector('.topbar-copy');let raf=0,destroyed=false,openHeight=0,actionsY=0,chipsY=0;
  const paint=()=>{raf=0;if(destroyed||!wrapper.isConnected)return;const raw=clamp((window.scrollY||document.scrollingElement?.scrollTop||0)/112);const p=easeOut(raw);wrapper.style.setProperty('--sns-progress',p.toFixed(4));wrapper.style.height=`${lerp(openHeight,52,p).toFixed(1)}px`;if(actions)actions.style.transform=`translate3d(0,${((8-actionsY)*p).toFixed(1)}px,0) scale(${(1-.14*p).toFixed(4)})`;chips.style.transform=`translate3d(0,${((8-chipsY)*p).toFixed(1)}px,0) scale(${(1-.08*p).toFixed(4)})`;chips.style.width=`calc(100% - ${(142*p).toFixed(1)}px)`;if(copy){copy.style.opacity=(1-p).toFixed(3);copy.style.transform=`translate3d(0,${(-12*p).toFixed(1)}px,0)`;}};
  const measure=()=>{const wr=wrapper.getBoundingClientRect();openHeight=Math.max(86,topbar.offsetHeight+chips.offsetHeight+8);wrapper.style.height=`${openHeight}px`;actionsY=(actions?.getBoundingClientRect().top||wr.top)-wr.top;chipsY=chips.getBoundingClientRect().top-wr.top;paint();};
  const onScroll=()=>{if(!raf)raf=requestAnimationFrame(paint);};window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',measure,{passive:true});requestAnimationFrame(measure);
  twitterCleanup=()=>{if(destroyed)return;destroyed=true;if(raf)cancelAnimationFrame(raf);window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',measure);};return true;
}

const YT_RESUME_KEY='pdv2:youtubeResume:v2193';
function readResume(){try{const value=JSON.parse(localStorage.getItem(YT_RESUME_KEY)||'{}');return value&&typeof value==='object'?value:{}}catch{return{}}}
function writeResume(map){try{const rows=Object.entries(map).sort((a,b)=>Number(b[1]?.at||0)-Number(a[1]?.at||0)).slice(0,120);localStorage.setItem(YT_RESUME_KEY,JSON.stringify(Object.fromEntries(rows)));}catch{}}
function resumeAt(videoId){const row=readResume()[String(videoId||'')];if(!row||Date.now()-Number(row.at||0)>90*24*3600*1000)return 0;return Math.max(0,Number(row.t||0));}
function clearResume(videoId){const key=String(videoId||'');if(!key)return;const map=readResume();if(key in map){delete map[key];writeResume(map);}}
function savePlayerProgress(instance,videoId){const key=String(videoId||'');if(!instance||!key)return;try{const data=instance.getVideoData?.()||{};if(data.isLive)return;const t=Number(instance.getCurrentTime?.()||0),duration=Number(instance.getDuration?.()||0);if(!Number.isFinite(t)||t<3)return;if(duration>0&&(duration-t<=12||t/duration>=.96)){clearResume(key);return;}const map=readResume();map[key]={t:Math.floor(t),duration:Math.floor(duration||0),at:Date.now()};writeResume(map);}catch{}}
function patchYouTubePlayer(){
  const YT=window.YT;if(!YT?.Player||YT.Player.__pdv2195Resume)return false;const Original=YT.Player;
  function WrappedPlayer(element,options={}){
    const elementId=typeof element==='string'?element:String(element?.id||'');if(!/^yt-v2170-player-/.test(elementId))return new Original(element,options);
    let currentId=String(options?.videoId||'');let timer=null;let instance=null;const events={...(options.events||{})};const originalReady=events.onReady,originalState=events.onStateChange;const start=resumeAt(currentId);const wrapped={...options,playerVars:{...(options.playerVars||{})},events};if(start>0&&wrapped.playerVars.start==null)wrapped.playerVars.start=Math.floor(start);
    events.onReady=event=>{instance=event.target;const t=resumeAt(currentId);if(t>0){try{event.target.seekTo(t,true);}catch{}}if(timer)clearInterval(timer);timer=setInterval(()=>savePlayerProgress(instance,currentId),4000);originalReady?.(event);};
    events.onStateChange=event=>{const state=Number(event.data);if(state===2)savePlayerProgress(event.target,currentId);if(state===0)clearResume(currentId);originalState?.(event);};
    const created=new Original(element,wrapped);instance=created;const load=created.loadVideoById?.bind(created);if(load)created.loadVideoById=(arg,startSeconds,...rest)=>{savePlayerProgress(created,currentId);if(arg&&typeof arg==='object'){const next={...arg};currentId=String(next.videoId||currentId);const saved=resumeAt(currentId);if(saved>0&&Number(next.startSeconds||0)<=0)next.startSeconds=saved;return load(next,...rest);}currentId=String(arg||currentId);const saved=resumeAt(currentId);return load(arg,saved>0?saved:startSeconds,...rest);};
    const destroy=created.destroy?.bind(created);if(destroy)created.destroy=(...args)=>{savePlayerProgress(created,currentId);if(timer)clearInterval(timer);timer=null;return destroy(...args);};return created;
  }
  WrappedPlayer.prototype=Original.prototype;Object.assign(WrappedPlayer,Original);WrappedPlayer.__pdv2195Resume=true;YT.Player=WrappedPlayer;return true;
}
(function installYouTubePatch(){if(patchYouTubePlayer())return;let stored=window.onYouTubeIframeAPIReady;try{Object.defineProperty(window,'onYouTubeIframeAPIReady',{configurable:true,get(){return stored;},set(fn){stored=function(...args){patchYouTubePlayer();return fn?.apply(this,args);};}});}catch{}const timer=setInterval(()=>{if(patchYouTubePlayer())clearInterval(timer);},250);setTimeout(()=>clearInterval(timer),20000);})();

const landscapeState=new WeakMap();
function showLandscapeUi(panel,state){if(!panel||!state)return;panel.classList.add('pdv2-landscape-ui-visible');if(state.timer)clearTimeout(state.timer);state.timer=setTimeout(()=>{state.timer=null;if(panel.isConnected)panel.classList.remove('pdv2-landscape-ui-visible');},3000);}
function enterLandscape(panel){
  if(!panel?.classList.contains('youtube-css-landscape'))return;
  let state=landscapeState.get(panel);if(state){showLandscapeUi(panel,state);return;}
  const viewport=panel.querySelector('.youtube-landscape-viewport');const controls=panel.querySelector('.youtube-landscape-controls');if(!viewport||!controls)return;
  const catcher=document.createElement('button');catcher.type='button';catcher.className='media-landscape-tap-catcher';catcher.setAttribute('aria-label','操作ボタンを表示');viewport.append(catcher);
  state={catcher,controls,timer:null};landscapeState.set(panel,state);
  catcher.addEventListener('click',()=>showLandscapeUi(panel,state));controls.addEventListener('pointerdown',()=>showLandscapeUi(panel,state),{passive:true});controls.addEventListener('click',()=>showLandscapeUi(panel,state));showLandscapeUi(panel,state);
}
function exitLandscape(panel){const state=landscapeState.get(panel);if(!state)return;if(state.timer)clearTimeout(state.timer);panel.classList.remove('pdv2-landscape-ui-visible');state.catcher.remove();landscapeState.delete(panel);}
function syncLandscape(panel){if(!panel?.isConnected)return;if(panel.classList.contains('youtube-css-landscape'))enterLandscape(panel);else exitLandscape(panel);}
document.addEventListener('click',event=>{const button=event.target?.closest?.('.youtube-orientation-btn');if(!button)return;const panel=button.closest('.twitch-inline-player');if(panel)setTimeout(()=>syncLandscape(panel),0);});

let enhancementRaf=0;
const enhancementObserver=new MutationObserver(()=>{if(!enhancementRaf)enhancementRaf=requestAnimationFrame(()=>{enhancementRaf=0;ensureReaderFab();if(!installTwitterHeader()&&twitterCleanup){twitterCleanup();twitterCleanup=null;}});});
enhancementObserver.observe(document.documentElement,{subtree:true,childList:true});
requestAnimationFrame(()=>{ensureReaderFab();installTwitterHeader();});
