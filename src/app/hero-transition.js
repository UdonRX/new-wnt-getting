const STYLE_ID='pdv2-hero-style';
function reducedMotion(){return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;}
function ensureStyles(){
  if(document.getElementById(STYLE_ID))return;
  const style=document.createElement('style');style.id=STYLE_ID;style.textContent=`
  body.pdv2-hero-detail #bottom-nav{display:none!important}body.pdv2-hero-detail #app-main{padding-bottom:calc(env(safe-area-inset-bottom) + 22px)}
  body.pdv2-hero-detail #app-main>.screen{animation:none!important}.pdv2-hero-close{position:fixed;z-index:390;top:calc(env(safe-area-inset-top) + 10px);right:max(12px,calc(env(safe-area-inset-right) + 10px));width:44px;height:44px;border-radius:50%;border:1px solid color-mix(in srgb,var(--line) 72%,transparent);background:color-mix(in srgb,var(--surface-solid) 88%,transparent);color:var(--text);display:grid;place-items:center;font-size:27px;line-height:1;box-shadow:0 8px 24px rgba(0,0,0,.2);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);touch-action:manipulation}
  body.pdv2-hero-detail .weather-detail-screen .wd-header>button:first-child{visibility:hidden}body.pdv2-hero-detail .weather-detail-screen .wd-mode-switch{bottom:calc(env(safe-area-inset-bottom) + 88px)!important}body.pdv2-hero-detail .news-today-screen .nt-header>button:first-child{visibility:hidden}body.pdv2-hero-detail .media-screen>.topbar,body.pdv2-hero-detail .twitter-screen>.topbar,body.pdv2-hero-detail .instagram-screen>.topbar{padding-right:54px}
  ::view-transition-group(pdv2-hero-card){animation-duration:380ms;animation-timing-function:cubic-bezier(.22,.78,.18,1)}::view-transition-old(pdv2-hero-card),::view-transition-new(pdv2-hero-card){mix-blend-mode:normal;overflow:clip}
  .pdv2-hero-fallback-clone{position:fixed!important;z-index:389!important;margin:0!important;pointer-events:none!important;transform-origin:0 0!important;will-change:transform,opacity!important;overflow:hidden!important}.pdv2-hero-fallback-target{animation:pdv2HeroFadeIn 210ms ease-out both}@keyframes pdv2HeroFadeIn{from{opacity:.18}to{opacity:1}}
  @media(prefers-reduced-motion:reduce){::view-transition-group(pdv2-hero-card){animation-duration:.001ms!important}}
  `;document.head.append(style);
}
function homeTarget(root,key){return[...root.querySelectorAll('[data-home-hero-key]')].find(node=>node.dataset.homeHeroKey===key)||null;}
function clearName(node){if(node?.style?.viewTransitionName)node.style.viewTransitionName='';}
export function createHeroNavigator({root}={}){
  ensureStyles();let active=null,closeButton=null,busy=false;
  const installClose=()=>{if(closeButton?.isConnected)return;closeButton=document.createElement('button');closeButton.type='button';closeButton.className='pdv2-hero-close';closeButton.setAttribute('aria-label','閉じてホームへ戻る');closeButton.textContent='×';closeButton.onclick=()=>close();document.body.append(closeButton);};
  const removeClose=()=>{closeButton?.remove();closeButton=null;};
  async function fallbackOpen(source,run){
    const rect=source?.getBoundingClientRect?.();let clone=null;
    if(rect?.width&&rect?.height&&!reducedMotion()){clone=source.cloneNode(true);clone.removeAttribute('data-home-hero-key');clone.classList.add('pdv2-hero-fallback-clone');Object.assign(clone.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});document.body.append(clone);}
    await run();root?.firstElementChild?.classList.add('pdv2-hero-fallback-target');
    if(clone){const vw=window.innerWidth||rect.width,vh=window.visualViewport?.height||window.innerHeight||rect.height;await clone.animate([{transform:'translate3d(0,0,0) scale(1)',opacity:1},{transform:`translate3d(${-rect.left}px,${-rect.top}px,0) scale(${vw/rect.width},${vh/rect.height})`,opacity:.08}],{duration:330,easing:'cubic-bezier(.22,.78,.18,1)',fill:'forwards'}).finished.catch(()=>{});clone.remove();}
  }
  async function open(screen,options,navigateCore,prepare){
    if(busy)return;busy=true;
    const key=String(options.heroKey||''),source=options.heroElement?.isConnected?options.heroElement:homeTarget(root,key),scrollY=window.scrollY;
    if(!key||!source){busy=false;return navigateCore(screen,options);}
    try{await prepare?.();}catch{}
    active={key,scrollY};document.body.classList.add('pdv2-hero-detail');
    const run=async()=>{await navigateCore(screen,{...options,__heroBypass:true});const target=root?.firstElementChild;if(target)target.style.viewTransitionName='pdv2-hero-card';};
    if(typeof document.startViewTransition==='function'&&!reducedMotion()){
      source.style.viewTransitionName='pdv2-hero-card';const transition=document.startViewTransition(run);await transition.finished.catch(()=>{});clearName(source);clearName(root?.firstElementChild);
    }else await fallbackOpen(source,run);
    installClose();busy=false;
  }
  async function close(){
    if(!active||busy)return;busy=true;removeClose();const current=active;const oldTarget=root?.firstElementChild;document.body.classList.remove('pdv2-hero-detail');
    const run=async()=>{await window.__PDV2_NAVIGATE_CORE?.('home',{source:'hero-close',heroReturnKey:current.key,__heroBypass:true});window.scrollTo({top:current.scrollY,behavior:'auto'});await new Promise(resolve=>requestAnimationFrame(resolve));const destination=homeTarget(root,current.key);if(destination)destination.style.viewTransitionName='pdv2-hero-card';};
    if(typeof document.startViewTransition==='function'&&!reducedMotion()){
      if(oldTarget)oldTarget.style.viewTransitionName='pdv2-hero-card';const transition=document.startViewTransition(run);await transition.finished.catch(()=>{});clearName(oldTarget);clearName(homeTarget(root,current.key));
    }else{if(oldTarget&&!reducedMotion())await oldTarget.animate([{opacity:1,transform:'scale(1)'},{opacity:.18,transform:'scale(.985)'}],{duration:150,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{});await run();}
    active=null;window.dispatchEvent(new CustomEvent('pdv2:hero-return-finished'));busy=false;
  }
  return{async go(screen,options,navigateCore,prepare){window.__PDV2_NAVIGATE_CORE=navigateCore;if(options?.__heroBypass||options?.source!=='home-hero')return navigateCore(screen,options);return open(screen,options,navigateCore,prepare);},close,isActive:()=>Boolean(active)};
}
