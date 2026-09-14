import './runtime.js';
import { setScreen, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';
import { installFinalTheme } from './app/final-theme.js';

const BUILD='2210pwa1';
const PWA_STATUS_URL='https://api.github.com/repos/UdonRX/new-wnt-getting/commits/main/status';
const PWA_BASELINE_KEY='pdv2:pwaDeployedSha:v1';
const PWA_PENDING_KEY='pdv2:pwaPendingSha:v1';
const PWA_CHECK_INTERVAL_MS=5*60*1000;
const PWA_RESUME_MIN_MS=60*1000;
const root=document.getElementById('app-main');
let renderSerial=0;
const modulePromises=new Map();
const importFailures=new Map();
let heroNavigator=null;
let themeController=null;
let finalUiPromise=null;
let quickController=null;
let serviceController=null;
let swRegistrationPromise=null;
let pwaCheckPromise=null;
let pwaLastCheckAt=0;
let pwaHiddenAt=0;
let pwaReloading=false;

const SCREEN={
  home:{path:'./features/home/home.js',exportName:'renderHome',label:'ホーム'},
  weather:{path:'./features/weather/weather.js',exportName:'renderWeather',label:'天気'},
  weatherDetail:{path:'./features/weather/weather-detail.js',exportName:'renderWeatherDetail',label:'天気'},
  newsToday:{path:'./features/reader/news-today.js',exportName:'renderNewsToday',label:'ニュース'},
  reader:{path:'./features/reader/reader.js',exportName:'renderReader',label:'読む'},
  media:{path:'./features/media/media.js',exportName:'renderMedia',label:'動画'},
  twitter:{path:'./features/twitter/sns.js',exportName:'renderSNS',label:'SNS'},
  wikipedia:{path:'./features/wikipedia/wikipedia.js',exportName:'renderWikipedia',label:'Wikipedia'},
  settings:{path:'./features/settings/settings.js',exportName:'renderSettings',label:'設定'}
};

function versioned(path){return `${path}?v=${BUILD}`;}
function safeMessage(error){return String(error?.message||error||'不明なエラー').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function timeoutPromise(promise,timeoutMs,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} の読み込みがタイムアウトしました`)),timeoutMs);})]).finally(()=>clearTimeout(timer));}
async function importAttempt(path,url,timeoutMs){return timeoutPromise(import(url),timeoutMs,path);}
async function importResilient(path){
  try{return await importAttempt(path,versioned(path),6500);}catch(firstError){console.warn('[pdv2 module retry: versioned]',path,firstError);importFailures.set(path,firstError);}
  try{return await importAttempt(path,path,4500);}catch(secondError){const error=new Error(`${path} を読み込めませんでした。${secondError?.message||importFailures.get(path)?.message||''}`.trim());error.cause=secondError;throw error;}
}
function loadModule(path,{force=false}={}){
  if(force)modulePromises.delete(path);
  if(!modulePromises.has(path)){
    const promise=importResilient(path).catch(error=>{modulePromises.delete(path);throw error;});
    modulePromises.set(path,promise);
  }
  return modulePromises.get(path);
}
async function loadRenderer(screen,{force=false}={}){
  const config=SCREEN[screen];if(!config)throw new Error(`Unknown screen: ${screen}`);
  const module=await loadModule(config.path,{force}),renderer=module?.[config.exportName];
  if(typeof renderer!=='function')throw new Error(`${config.path} に ${config.exportName} がありません`);
  return{renderer};
}
function loadingText(screen){if(screen==='reader')return'読むカードを準備しています…';if(screen==='twitter')return'SNSカードを準備しています…';return`${SCREEN[screen]?.label||'画面'}を準備しています…`;}
function renderLoading(screen){if(root)root.innerHTML=`<section class="screen pd-feature-loading"><div class="card pd-feature-loading-card" role="status"><div class="pd-feature-loading-spinner"></div><div class="pd-feature-loading-title">${loadingText(screen)}</div></div></section>`;}

async function clearDashboardRuntime(){
  try{
    if('serviceWorker'in navigator){const registrations=await navigator.serviceWorker.getRegistrations();await Promise.allSettled(registrations.map(r=>r.unregister()));}
    if('caches'in window){const keys=await caches.keys();await Promise.allSettled(keys.filter(key=>key.startsWith('personal-dashboard-')).map(key=>caches.delete(key)));}
  }catch(error){console.warn('[pdv2 clear runtime]',error);}
}
function renderScreenError(screen,error,options={}){
  if(!root)return;const label=SCREEN[screen]?.label||'画面';
  root.innerHTML=`<section class="screen pd-feature-error"><div class="error-box"><strong>${label}を表示できませんでした</strong><br><small>${safeMessage(error)}</small><div class="pd-feature-error-actions"><button type="button" class="soft-button" data-pdv2-feature-retry>もう一度試す</button><button type="button" class="soft-button" data-pdv2-feature-cache>キャッシュを更新</button></div></div></section>`;
  root.querySelector('[data-pdv2-feature-retry]')?.addEventListener('click',()=>{const path=SCREEN[screen]?.path;if(path)modulePromises.delete(path);navigate(screen,{...options,forceModuleReload:true});});
  root.querySelector('[data-pdv2-feature-cache]')?.addEventListener('click',async()=>{await clearDashboardRuntime();location.replace(`/?v=${BUILD}&feature-recovery=${encodeURIComponent(screen)}`);});
}
function renderBootError(error){console.error('[pdv2] boot failed:',error);if(!root)return;root.innerHTML=`<section class="screen pd-startup-error"><div class="error-box"><strong>アプリの起動に失敗しました</strong><br><small>${safeMessage(error)}</small><div class="pd-feature-error-actions"><button type="button" class="soft-button" onclick="location.reload()">再読み込み</button></div></div></section>`;}

async function navigateCore(screen,options={}){
  if(!SCREEN[screen])screen='home';
  // Plain Read navigation bypasses the retired generic Reader landing completely.
  // Knowledge/Papers still enter Reader via their explicit readerMode from Home.
  if(screen==='reader'&&!options.readerMode&&!options.readerRecommendations)screen='newsToday';
  const destinationMediaMode=screen==='media'?(options.mediaMode||'youtube'):'';
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate',{detail:{screen,mediaMode:destinationMediaMode,source:options.source||''}}));
  if(options.readerMode)update('lastReaderMode',options.readerMode);
  if(screen==='media'&&!options.mediaMode)update('lastMediaMode','youtube');else if(options.mediaMode)update('lastMediaMode',options.mediaMode);
  if(options.paperTrack)update('paperTrack',options.paperTrack);
  setScreen(screen);themeController?.sync?.();
  const serial=++renderSerial;renderLoading(screen);
  try{
    const {renderer}=await loadRenderer(screen,{force:Boolean(options.forceModuleReload)});if(serial!==renderSerial)return;
    await renderer(root,{navigate,refresh:Boolean(options.refresh),navigationSource:options.source||'',...options});
    if(serial===renderSerial&&root&&!root.childElementCount)throw new Error(`${SCREEN[screen].label} の描画結果が空です`);
    if(serial===renderSerial)window.dispatchEvent(new CustomEvent('pdv2:navigation-complete',{detail:{screen,options}}));
  }catch(error){console.error('[pdv2] render failed:',screen,error);if(serial===renderSerial)renderScreenError(screen,error,options);}
}
async function installFinalUiModules(){
  if(finalUiPromise)return finalUiPromise;
  finalUiPromise=Promise.all([
    import('./app/hero-transition.js'),
    import('./app/quick-launcher.js'),
    import('./app/home-service-state.js')
  ]).then(([hero,quick,service])=>{
    if(!heroNavigator)heroNavigator=hero.createHeroNavigator({root});
    if(!quickController)quickController=quick.installQuickLauncher({navigate,getScreen:()=>state.screen});
    if(!serviceController)serviceController=service.installHomeServiceState({root});
    return heroNavigator;
  }).catch(error=>{finalUiPromise=null;console.warn('[final-ui-lazy]',error?.message||error);return null;});
  return finalUiPromise;
}
export async function navigate(screen,options={}){
  if(!SCREEN[screen])screen='home';
  // Normalize plain Read before Hero transition/preload so the retired Reader shell is never a destination.
  if(screen==='reader'&&!options.readerMode&&!options.readerRecommendations)screen='newsToday';
  if(options?.source==='home-hero'&&!heroNavigator)await installFinalUiModules();
  if(heroNavigator)return heroNavigator.go(screen,options,navigateCore,()=>loadRenderer(screen,{force:Boolean(options.forceModuleReload)}));
  return navigateCore(screen,options);
}

function idle(callback,delay=0){if('requestIdleCallback'in window)window.requestIdleCallback(callback,{timeout:Math.max(1000,delay+1500)});else setTimeout(callback,delay);}
function preloadFeature(screen,{warm=false}={}){
  const config=SCREEN[screen];if(!config)return;
  loadModule(config.path).then(module=>{
    if(screen==='reader'&&warm){window.__PDV2_READER_WARM_CACHE_ONLY=true;return Promise.resolve(module.warmReaderRecommendations?.()).finally(()=>{window.__PDV2_READER_WARM_CACHE_ONLY=false;});}
    if(screen==='twitter'&&warm)return module.warmTwitterFeeds?.({force:true});
  }).catch(error=>{window.__PDV2_READER_WARM_CACHE_ONLY=false;console.warn(`[${screen}-preload]`,error);});
}
function jstDay(){return new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);}
async function warmWikipediaDaily(){
  const key='pdv2:wikipediaDaily:v213';
  try{const cached=JSON.parse(localStorage.getItem(key)||'null');if(cached?.date===jstDay()&&Array.isArray(cached?.items)&&cached.items.length)return cached;}catch{}
  try{const response=await fetch('/api/wikipedia?mode=daily',{cache:'no-store',signal:AbortSignal.timeout(9000)}),data=await response.json().catch(()=>null);if(response.ok&&data?.date===jstDay()&&Array.isArray(data?.items)&&data.items.length){try{localStorage.setItem(key,JSON.stringify(data));}catch{}return data;}}catch(error){console.warn('[wikipedia-prewarm]',error?.message||error);}
  return null;
}
function startBackgroundJobs(){
  preloadFeature('reader',{warm:true});idle(()=>preloadFeature('media'),80);idle(()=>warmWikipediaDaily(),160);idle(()=>preloadFeature('wikipedia'),360);idle(()=>preloadFeature('weather'),520);idle(()=>preloadFeature('twitter'),1800);
}
function scheduleFinalUiAfterPaint(){requestAnimationFrame(()=>requestAnimationFrame(()=>installFinalUiModules()));}

function isStandalonePwa(){return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches||window.navigator.standalone===true);}
function pwaRecoveryQuery(){const params=new URL(location.href).searchParams;return params.has('pdv2_app_update')||params.has('pdv2_sw_update');}
function cleanPwaRecoveryQuery(){try{const url=new URL(location.href);url.searchParams.delete('pdv2_app_update');url.searchParams.delete('pdv2_sw_update');url.searchParams.delete('_pdv2');history.replaceState(history.state,'',`${url.pathname}${url.search}${url.hash}`);}catch{}}
async function ensureServiceWorker(){
  if(!('serviceWorker'in navigator))return null;
  if(!swRegistrationPromise)swRegistrationPromise=navigator.serviceWorker.register(`/sw.js?v=${BUILD}`,{updateViaCache:'none'}).then(async registration=>{try{await registration.update();}catch{}registration.waiting?.postMessage({type:'SKIP_WAITING'});return registration;}).catch(error=>{swRegistrationPromise=null;console.warn('[sw]',error);return null;});
  return swRegistrationPromise;
}
async function fetchPwaDeploymentStatus(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4200);
  try{
    const response=await fetch(`${PWA_STATUS_URL}?_=${Date.now()}`,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/vnd.github+json'}});
    if(!response.ok)throw new Error(`GitHub status ${response.status}`);
    const data=await response.json();
    const statuses=(Array.isArray(data?.statuses)?data.statuses:[]).filter(row=>String(row?.context||'').toLowerCase()==='vercel').sort((a,b)=>Date.parse(b?.updated_at||0)-Date.parse(a?.updated_at||0));
    const vercel=statuses[0]||null;
    return{sha:String(data?.sha||''),ready:vercel?.state==='success',vercelState:String(vercel?.state||'missing')};
  }finally{clearTimeout(timer);}
}
async function reloadForPwaUpdate(sha,reason){
  if(pwaReloading||!sha)return;
  pwaReloading=true;
  try{sessionStorage.setItem(PWA_PENDING_KEY,sha);}catch{}
  console.info('[pwa-recovery]',{phase:'reload',reason,currentBuild:BUILD,targetSha:sha,screen:state.screen});
  try{const registration=await ensureServiceWorker();await registration?.update?.();registration?.waiting?.postMessage({type:'SKIP_WAITING'});}catch(error){console.warn('[pwa-recovery] sw update before reload',error?.message||error);}
  const url=new URL(location.href);url.searchParams.set('pdv2_app_update',sha);url.searchParams.set('_pdv2',String(Date.now()));location.replace(url.href);
}
async function checkPwaDeployment({reason='periodic',force=false}={}){
  if(!isStandalonePwa()||pwaReloading)return null;
  const now=Date.now();
  if(!force&&now-pwaLastCheckAt<PWA_CHECK_INTERVAL_MS)return null;
  if(pwaCheckPromise)return pwaCheckPromise;
  pwaLastCheckAt=now;
  pwaCheckPromise=(async()=>{
    try{const registration=await ensureServiceWorker();try{await registration?.update?.();}catch{}
      const status=await fetchPwaDeploymentStatus();
      const baseline=String(localStorage.getItem(PWA_BASELINE_KEY)||'');
      const pending=String(sessionStorage.getItem(PWA_PENDING_KEY)||'');
      globalThis.__PDV2_PWA_RECOVERY={at:Date.now(),reason,baseline,pending,...status};
      console.info('[pwa-recovery]',{phase:'check',reason,baseline:baseline.slice(0,12),pending:pending.slice(0,12),remote:status.sha.slice(0,12),vercelState:status.vercelState});
      if(!status.ready||!status.sha)return status;
      if(pending===status.sha){localStorage.setItem(PWA_BASELINE_KEY,status.sha);sessionStorage.removeItem(PWA_PENDING_KEY);cleanPwaRecoveryQuery();return status;}
      if(!baseline){localStorage.setItem(PWA_BASELINE_KEY,status.sha);cleanPwaRecoveryQuery();return status;}
      if(baseline!==status.sha){await reloadForPwaUpdate(status.sha,reason);return status;}
      cleanPwaRecoveryQuery();return status;
    }catch(error){console.warn('[pwa-recovery]',{phase:'check-failed',reason,error:error?.message||String(error)});return null;}
  })().finally(()=>{pwaCheckPromise=null;});
  return pwaCheckPromise;
}
function installPwaAutoRecovery(){
  if(!isStandalonePwa())return;
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pwaHiddenAt=Date.now();return;}const awayMs=pwaHiddenAt?Date.now()-pwaHiddenAt:0;pwaHiddenAt=0;if(awayMs>=PWA_RESUME_MIN_MS)checkPwaDeployment({reason:'resume',force:true});},{passive:true});
  window.addEventListener('pageshow',event=>{if(event.persisted)checkPwaDeployment({reason:'pageshow-restored',force:true});else checkPwaDeployment({reason:'pageshow'});},{passive:true});
  window.addEventListener('online',()=>checkPwaDeployment({reason:'online',force:true}),{passive:true});
  setTimeout(()=>checkPwaDeployment({reason:'boot',force:true}),900);
}
async function restoreAfterPwaUpdate(){
  if(!pwaRecoveryQuery())return false;
  const screen=SCREEN[state.screen]?state.screen:'home';
  const options={source:'pwa-auto-update',refresh:true,forceModuleReload:true};
  if(screen==='media')options.mediaMode=state.mediaMode||'youtube';
  if(screen==='reader'){options.readerMode=state.readerMode||'news';options.paperTrack=state.paperTrack||'core';}
  await navigate(screen,options);cleanPwaRecoveryQuery();return true;
}

async function resolveTwitchOAuthReturn(){try{const module=await loadModule('./features/twitch/twitch-chat.js');return await module.handleTwitchOAuthReturn?.();}catch(error){console.warn('[twitch-oauth]',error);return null;}}
async function resolveTwitchPlaybackRecovery(){try{const module=await loadModule('./features/twitch/twitch-player.js');return module.getRecentTwitchPlayback?.()||null;}catch(error){console.warn('[twitch-recovery]',error);return null;}}

async function boot(){
  if(!root)throw new Error('#app-main が見つかりません');
  applyTheme();themeController=installFinalTheme({state});
  const twitchOAuth=await resolveTwitchOAuthReturn();
  if(twitchOAuth?.handled){update('lastMediaMode','twitch');await navigate('media',{mediaMode:'twitch',source:'twitch-oauth'});}else{const twitchRecovery=await resolveTwitchPlaybackRecovery();if(twitchRecovery){update('lastMediaMode','twitch');await navigate('media',{mediaMode:'twitch',source:'twitch-recovery'});}else if(!(await restoreAfterPwaUpdate()))await navigate('home');}
  scheduleFinalUiAfterPaint();startBackgroundJobs();
  ensureServiceWorker();installPwaAutoRecovery();
  window.addEventListener('pdv2:settings-changed',()=>{try{applyTheme();themeController?.sync?.();}catch{}});window.addEventListener('pdv2:context-changed',()=>{try{applyTheme();themeController?.sync?.();}catch{}});window.addEventListener('popstate',()=>navigate(state.screen||'home'));
  document.documentElement.dataset.pdv2Booted='1';window.dispatchEvent(new CustomEvent('pdv2:booted',{detail:{build:BUILD}}));
}
boot().catch(renderBootError);
