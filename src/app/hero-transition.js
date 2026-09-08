const STYLE_ID='pdv2-return-gesture-style';
const TRANSITION_MS=190;
const EDGE_START_PX=28;
const EDGE_DISTANCE_RATIO=.31;
const EDGE_VELOCITY=.5;
const SHELL_WAIT_MS=240;

function ensureStyles(){
  if(document.getElementById(STYLE_ID))return;
  const style=document.createElement('style');style.id=STYLE_ID;style.textContent=`
  body.pdv2-hero-detail #app-main{padding-bottom:calc(env(safe-area-inset-bottom) + 22px)}
  body.pdv2-hero-detail #app-main>.screen{animation:none!important}.pdv2-hero-close{position:fixed;z-index:390;top:calc(env(safe-area-inset-top) + 10px);right:max(12px,calc(env(safe-area-inset-right) + 10px));width:44px;height:44px;border-radius:50%;border:1px solid color-mix(in srgb,var(--line) 72%,transparent);background:color-mix(in srgb,var(--surface-solid) 88%,transparent);color:var(--text);display:grid;place-items:center;font-size:27px;line-height:1;box-shadow:0 8px 24px rgba(0,0,0,.2);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);touch-action:manipulation;transition:opacity 120ms ease-out}
  body.pdv2-hero-detail .weather-detail-screen .wd-header>button:first-child{visibility:hidden}body.pdv2-hero-detail .news-today-screen .nt-header>button:first-child{visibility:hidden}body.pdv2-hero-detail .media-screen>.topbar,body.pdv2-hero-detail .twitter-screen>.topbar,body.pdv2-hero-detail .instagram-screen>.topbar{padding-right:54px}
  ::view-transition-group(root){animation-duration:${TRANSITION_MS}ms!important;animation-timing-function:cubic-bezier(.2,.72,.25,1)!important}
  ::view-transition-old(root){mix-blend-mode:normal;animation:pdv2ReduceMotionOld ${TRANSITION_MS}ms cubic-bezier(.2,.72,.25,1) both!important}
  ::view-transition-new(root){mix-blend-mode:normal;animation:pdv2ReduceMotionNew ${TRANSITION_MS}ms cubic-bezier(.2,.72,.25,1) both!important}
  @keyframes pdv2ReduceMotionOld{from{opacity:1;transform:translate3d(0,0,0)}to{opacity:0;transform:translate3d(-2px,0,0)}}
  @keyframes pdv2ReduceMotionNew{from{opacity:0;transform:translate3d(2px,0,0)}to{opacity:1;transform:translate3d(0,0,0)}}
  .pdv2-motion-fallback-old{position:fixed!important;z-index:382!important;inset:0!important;overflow:hidden!important;pointer-events:none!important;background:var(--bg);contain:paint}.pdv2-motion-fallback-old>.pdv2-motion-fallback-main{position:absolute!important;left:0!important;width:100%!important;pointer-events:none!important}
  .pdv2-edge-home-underlay{position:fixed;z-index:368;inset:0;overflow:hidden;pointer-events:none;background:var(--bg);contain:strict}.pdv2-edge-home-underlay>.pdv2-edge-home-main{position:absolute;left:0;width:100%;pointer-events:none}
  .pdv2-edge-hitbox{position:fixed;z-index:389;left:0;top:0;bottom:0;width:${EDGE_START_PX}px;padding:0;margin:0;border:0;background:transparent;opacity:.001;pointer-events:auto;touch-action:pan-y pinch-zoom;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}.pdv2-edge-hitbox[hidden]{display:none!important}
  html.media-player-open .pdv2-edge-hitbox,body.ig-story-opened .pdv2-edge-hitbox,body:has(.youtube-shorts-player) .pdv2-edge-hitbox,body:has(.player-modal) .pdv2-edge-hitbox{pointer-events:none!important}
  body.pdv2-edge-active{overflow:hidden!important;overscroll-behavior-x:none!important}body.pdv2-edge-active .pdv2-quick,body.pdv2-edge-active .pdv2-hero-close{opacity:0!important;pointer-events:none!important}
  `;document.head.append(style);
}
function removeIds(node){node?.removeAttribute?.('id');node?.querySelectorAll?.('[id]').forEach(child=>child.removeAttribute('id'));}
function quietMedia(node){node?.querySelectorAll?.('video,audio,iframe').forEach(media=>{const placeholder=document.createElement('div');placeholder.className=media.className;placeholder.style.cssText='width:100%;height:100%;background:#000';media.replaceWith(placeholder);});}
function rootSnapshot(root){
  if(!root?.childElementCount)return null;
  const clone=root.cloneNode(true);removeIds(clone);quietMedia(clone);clone.classList.add('pdv2-motion-fallback-main');return clone;
}
function fallbackLayer(root){
  const clone=rootSnapshot(root);if(!clone)return null;
  const rect=root.getBoundingClientRect();const layer=document.createElement('div');layer.className='pdv2-motion-fallback-old';clone.style.top=`${rect.top}px`;layer.append(clone);document.body.append(layer);return layer;
}
async function fallbackTransition(root,run){
  const oldLayer=fallbackLayer(root);const oldOpacity=root.style.opacity;const oldPointer=root.style.pointerEvents;
  root.style.opacity='0';root.style.pointerEvents='none';
  await run();
  const enter=root.animate([{opacity:0,transform:'translate3d(2px,0,0)'},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:TRANSITION_MS,easing:'cubic-bezier(.2,.72,.25,1)',fill:'both'});
  const leave=oldLayer?.animate([{opacity:1,transform:'translate3d(0,0,0)'},{opacity:0,transform:'translate3d(-2px,0,0)'}],{duration:TRANSITION_MS,easing:'cubic-bezier(.2,.72,.25,1)',fill:'both'});
  root.style.opacity=oldOpacity;root.style.pointerEvents=oldPointer;
  await Promise.allSettled([enter.finished,leave?.finished]);oldLayer?.remove();
}
async function crossFade(root,run){
  document.body.classList.add('pdv2-motion-transitioning');
  try{
    if(typeof document.startViewTransition==='function'){
      const transition=document.startViewTransition(run);await transition.finished.catch(()=>{});
    }else await fallbackTransition(root,run);
  }finally{document.body.classList.remove('pdv2-motion-transitioning');}
}
function homeSnapshot(root){
  const clone=rootSnapshot(root);if(!clone)return null;
  const rect=root.getBoundingClientRect();return{clone,top:rect.top,scrollY:window.scrollY};
}
function makeHomeUnderlay(snapshot){
  if(!snapshot?.clone)return null;
  const layer=document.createElement('div');layer.className='pdv2-edge-home-underlay';const clone=snapshot.clone.cloneNode(true);clone.className='pdv2-edge-home-main';clone.style.top=`${snapshot.top}px`;layer.append(clone);document.body.append(layer);return layer;
}
function inferScreen(root){
  const first=root?.firstElementChild;if(first?.classList.contains('home-screen'))return'home';if(first?.classList.contains('weather-detail-screen'))return'weatherDetail';if(first?.classList.contains('news-today-screen'))return'newsToday';if(first?.classList.contains('media-screen'))return'media';if(first?.classList.contains('twitter-screen')||first?.classList.contains('instagram-screen'))return'twitter';if(first?.classList.contains('wikipedia-screen'))return'wikipedia';return'';
}
function shellReady(root){const first=root?.firstElementChild;return Boolean(first&&!first.classList.contains('pd-feature-loading'));}
function waitForScreenShell(root,timeoutMs=SHELL_WAIT_MS){
  if(shellReady(root))return Promise.resolve();
  return new Promise(resolve=>{
    let done=false,timer=0;const finish=()=>{if(done)return;done=true;observer?.disconnect?.();if(timer)clearTimeout(timer);resolve();};
    const observer=new MutationObserver(()=>{if(shellReady(root))finish();});
    try{observer.observe(root,{childList:true});}catch{return finish();}
    timer=setTimeout(finish,timeoutMs);requestAnimationFrame(()=>{if(shellReady(root))finish();});
  });
}
function blockedEdgeSurface(){
  if(document.documentElement.classList.contains('media-player-open')||document.body.classList.contains('ig-story-opened'))return true;
  return Boolean(document.querySelector('.youtube-shorts-player,.player-modal'));
}

export function createHeroNavigator({root}={}){
  ensureStyles();let active=null,closeButton=null,busy=false,currentScreen=inferScreen(root)||'home';let edge=null,edgeHitbox=null;
  const installClose=()=>{if(closeButton?.isConnected)return;closeButton=document.createElement('button');closeButton.type='button';closeButton.className='pdv2-hero-close';closeButton.setAttribute('aria-label','閉じてホームへ戻る');closeButton.textContent='×';closeButton.onclick=()=>close();document.body.append(closeButton);};
  const removeClose=()=>{closeButton?.remove();closeButton=null;};
  const edgeEligible=()=>Boolean(active&&currentScreen!=='home'&&root?.firstElementChild&&!busy&&!blockedEdgeSurface());
  const syncEdgeHitbox=()=>{if(!edgeHitbox)return;edgeHitbox.hidden=!Boolean(active&&currentScreen!=='home');};
  async function runNavigation(screen,options,navigateCore,{enterHero=false,leaveHero=false}={}){
    const run=async()=>{
      if(enterHero)document.body.classList.add('pdv2-hero-detail');
      if(leaveHero)document.body.classList.remove('pdv2-hero-detail');
      Promise.resolve(navigateCore(screen,{...options,__heroBypass:true})).catch(error=>console.warn('[pdv2 navigation background]',error));
      await waitForScreenShell(root);
    };
    await crossFade(root,run);currentScreen=screen;syncEdgeHitbox();
  }
  async function close(){
    if(!active||busy)return;busy=true;const current=active;removeClose();
    try{
      await runNavigation('home',{source:'hero-close',heroReturnKey:current.key},window.__PDV2_NAVIGATE_CORE,{leaveHero:true});
      window.scrollTo({top:current.scrollY,behavior:'auto'});active=null;currentScreen='home';syncEdgeHitbox();window.dispatchEvent(new CustomEvent('pdv2:hero-return-finished'));
    }finally{busy=false;}
  }
  function resetEdgeStyles(){
    if(!edge)return;const style=edge.savedStyle||{};root.style.position=style.position;root.style.zIndex=style.zIndex;root.style.transform=style.transform;root.style.transition=style.transition;root.style.willChange=style.willChange;root.style.boxShadow=style.boxShadow;root.style.opacity=style.opacity;edge.underlay?.remove();document.body.classList.remove('pdv2-edge-active');edge=null;
  }
  async function completeEdge(){
    if(!edge||busy)return;busy=true;const current=active;const vw=Math.max(1,window.innerWidth||390),dx=edge.dx;const duration=Math.max(90,Math.min(180,Math.round((vw-dx)/vw*180)));
    root.style.transition=`transform ${duration}ms cubic-bezier(.2,.72,.25,1)`;root.style.transform=`translate3d(${vw}px,0,0)`;
    await new Promise(resolve=>setTimeout(resolve,duration+12));
    root.style.opacity='0';root.style.transition='none';root.style.transform='none';document.body.classList.remove('pdv2-hero-detail');removeClose();
    try{
      await window.__PDV2_NAVIGATE_CORE?.('home',{source:'edge-swipe-back',heroReturnKey:current?.key||'',__heroBypass:true});currentScreen='home';if(current?.scrollY!=null)window.scrollTo({top:current.scrollY,behavior:'auto'});active=null;
    }finally{root.style.opacity='1';resetEdgeStyles();syncEdgeHitbox();window.dispatchEvent(new CustomEvent('pdv2:hero-return-finished'));busy=false;}
  }
  function cancelEdge(){
    if(!edge)return;const duration=Math.max(90,Math.min(150,Math.round((edge.dx/Math.max(1,window.innerWidth||390))*90+90)));root.style.transition=`transform ${duration}ms cubic-bezier(.2,.72,.25,1)`;root.style.transform='translate3d(0,0,0)';setTimeout(resetEdgeStyles,duration+12);
  }
  const onTouchStart=event=>{
    if(!edgeEligible()||event.touches?.length!==1)return;const t=event.touches[0];if(t.clientX>EDGE_START_PX)return;
    edge={startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastAt:performance.now(),velocity:0,dx:0,locked:false,underlay:null,savedStyle:{position:root.style.position,zIndex:root.style.zIndex,transform:root.style.transform,transition:root.style.transition,willChange:root.style.willChange,boxShadow:root.style.boxShadow,opacity:root.style.opacity}};
  };
  const onTouchMove=event=>{
    if(!edge||event.touches?.length!==1)return;const t=event.touches[0],rawDx=t.clientX-edge.startX,dy=t.clientY-edge.startY;
    if(!edge.locked){const distance=Math.max(Math.abs(rawDx),Math.abs(dy));if(distance<6)return;if(rawDx<=0||Math.abs(dy)>Math.abs(rawDx)*1.08){edge=null;return;}edge.locked=true;edge.underlay=makeHomeUnderlay(active?.home);document.body.classList.add('pdv2-edge-active');root.style.position='relative';root.style.zIndex='370';root.style.transition='none';root.style.willChange='transform';root.style.boxShadow='-14px 0 30px rgba(0,0,0,.16)';}
    if(!edge.locked)return;if(event.cancelable)event.preventDefault();event.stopPropagation();const now=performance.now(),dx=Math.max(0,Math.min(window.innerWidth||390,rawDx)),dt=Math.max(1,now-edge.lastAt),sample=(t.clientX-edge.lastX)/dt;edge.velocity=edge.velocity*.55+sample*.45;edge.lastX=t.clientX;edge.lastAt=now;edge.dx=dx;root.style.transition='none';root.style.transform=`translate3d(${dx}px,0,0)`;
  };
  const onTouchEnd=event=>{
    if(!edge)return;if(!edge.locked){edge=null;return;}if(event.cancelable)event.preventDefault();event.stopPropagation();const vw=Math.max(1,window.innerWidth||390),freshVelocity=performance.now()-edge.lastAt<=100?edge.velocity:0,commit=edge.dx>=vw*EDGE_DISTANCE_RATIO||(edge.dx>44&&freshVelocity>=EDGE_VELOCITY);if(commit)completeEdge();else cancelEdge();
  };
  const onTouchCancel=()=>{if(edge?.locked)cancelEdge();else edge=null;};
  edgeHitbox=document.createElement('div');edgeHitbox.className='pdv2-edge-hitbox';edgeHitbox.hidden=true;edgeHitbox.setAttribute('aria-hidden','true');document.body.append(edgeHitbox);
  edgeHitbox.addEventListener('touchstart',onTouchStart,{passive:true});edgeHitbox.addEventListener('touchmove',onTouchMove,{passive:false});edgeHitbox.addEventListener('touchend',onTouchEnd,{passive:false});edgeHitbox.addEventListener('touchcancel',onTouchCancel,{passive:true});
  return{async go(screen,options={},navigateCore,prepare){
    window.__PDV2_NAVIGATE_CORE=navigateCore;if(options?.__heroBypass)return navigateCore(screen,options);if(busy)return;busy=true;
    const source=String(options?.source||'');const fromHomeEntry=source==='home-hero'||source==='quick-launcher'||screen==='weatherDetail'||screen==='newsToday';const openingFromHome=!active&&currentScreen==='home'&&screen!=='home'&&fromHomeEntry;const visualHero=source==='home-hero'||screen==='weatherDetail'||screen==='newsToday';
    if(openingFromHome){try{await prepare?.();}catch{}active={key:String(options.heroKey||screen),scrollY:window.scrollY,home:homeSnapshot(root),screen,showClose:visualHero};}
    const leavingHero=screen==='home'&&Boolean(active);const enteringHero=openingFromHome&&visualHero;
    try{await runNavigation(screen,options,navigateCore,{enterHero:enteringHero,leaveHero:leavingHero});if(openingFromHome){if(active?.showClose)installClose();else removeClose();syncEdgeHitbox();}if(leavingHero){active=null;removeClose();currentScreen='home';syncEdgeHitbox();window.dispatchEvent(new CustomEvent('pdv2:hero-return-finished'));}}
    finally{busy=false;syncEdgeHitbox();}
  },close,isActive:()=>Boolean(active)};
}
