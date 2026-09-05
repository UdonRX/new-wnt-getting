import './runtime-v2195.js';
import { setScreen, renderNav, applyTheme } from './app/router.js';
import { state, update } from './app/store.js';

const BUILD='2196twitch2';
const root=document.getElementById('app-main');
let renderSerial=0;
const modulePromises=new Map();
const importFailures=new Map();

const SCREEN={
  home:{path:'./features/home/home.js',exportName:'renderHome',label:'ホーム'},
  weather:{path:'./features/weather/weather.js',exportName:'renderWeather',label:'天気'},
  reader:{path:'./features/reader/reader.js',exportName:'renderReader',label:'読む'},
  media:{path:'./features/media/media.js',exportName:'renderMedia',label:'動画'},
  twitter:{path:'./features/twitter/twitter.js',exportName:'renderTwitter',label:'X'},
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
  const config=SCREEN[screen];
  if(!config)throw new Error(`Unknown screen: ${screen}`);
  const module=await loadModule(config.path,{force});
  const renderer=module?.[config.exportName];
  if(typeof renderer!=='function')throw new Error(`${config.path} に ${config.exportName} がありません`);
  return {renderer};
}
function loadingText(screen){if(screen==='reader')return '読むカードを準備しています…';if(screen==='twitter')return 'Xカードを準備しています…';return `${SCREEN[screen]?.label||'画面'}を準備しています…`;}
function renderLoading(screen){if(root)root.innerHTML=`<section class="screen pd-feature-loading"><div class="card pd-feature-loading-card" role="status"><div class="pd-feature-loading-spinner"></div><div class="pd-feature-loading-title">${loadingText(screen)}</div></div></section>`;}

async function clearDashboardRuntime(){
  try{
    if('serviceWorker'in navigator){const registrations=await navigator.serviceWorker.getRegistrations();await Promise.allSettled(registrations.map(r=>r.unregister()));}
    if('caches'in window){const keys=await caches.keys();await Promise.allSettled(keys.filter(key=>key.startsWith('personal-dashboard-')).map(key=>caches.delete(key)));}
  }catch(error){console.warn('[pdv2 clear runtime]',error);}
}

function renderScreenError(screen,error,options={}){
  if(!root)return;
  const label=SCREEN[screen]?.label||'画面';
  root.innerHTML=`<section class="screen pd-feature-error"><div class="error-box"><strong>${label}を表示できませんでした</strong><br><small>${safeMessage(error)}</small><div class="pd-feature-error-actions"><button type="button" class="soft-button" data-pdv2-feature-retry>もう一度試す</button><button type="button" class="soft-button" data-pdv2-feature-cache>キャッシュを更新</button></div></div></section>`;
  root.querySelector('[data-pdv2-feature-retry]')?.addEventListener('click',()=>{const path=SCREEN[screen]?.path;if(path)modulePromises.delete(path);navigate(screen,{...options,forceModuleReload:true});});
  root.querySelector('[data-pdv2-feature-cache]')?.addEventListener('click',async()=>{await clearDashboardRuntime();location.replace(`/?v=${BUILD}&feature-recovery=${encodeURIComponent(screen)}`);});
}
function renderBootError(error){console.error('[pdv2] boot failed:',error);if(!root)return;root.innerHTML=`<section class="screen pd-startup-error"><div class="error-box"><strong>アプリの起動に失敗しました</strong><br><small>${safeMessage(error)}</small><div class="pd-feature-error-actions"><button type="button" class="soft-button" onclick="location.reload()">再読み込み</button></div></div></section>`;}

export async function navigate(screen,options={}){
  if(!SCREEN[screen])screen='home';
  const destinationMediaMode=screen==='media'?(options.mediaMode||'youtube'):'';
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate',{detail:{screen,mediaMode:destinationMediaMode,source:options.source||''}}));
  if(options.readerMode)update('lastReaderMode',options.readerMode);
  if(screen==='media'&&!options.mediaMode)update('lastMediaMode','youtube');
  else if(options.mediaMode)update('lastMediaMode',options.mediaMode);
  if(options.paperTrack)update('paperTrack',options.paperTrack);
  setScreen(screen);
  renderNav(navigate);
  const serial=++renderSerial;
  renderLoading(screen);
  try{
    const {renderer}=await loadRenderer(screen,{force:Boolean(options.forceModuleReload)});
    if(serial!==renderSerial)return;
    await renderer(root,{navigate,refresh:Boolean(options.refresh),navigationSource:options.source||'',readerRecommendations:screen==='reader'&&options.source==='bottom-nav',...options});
    if(serial===renderSerial&&root&&!root.childElementCount)throw new Error(`${SCREEN[screen].label} の描画結果が空です`);
  }catch(error){console.error('[pdv2] render failed:',screen,error);if(serial===renderSerial)renderScreenError(screen,error,options);}
}

function idle(callback,delay=0){if('requestIdleCallback'in window)window.requestIdleCallback(callback,{timeout:Math.max(1000,delay+1500)});else setTimeout(callback,delay);}
function preloadFeature(screen,{warm=false}={}){
  const config=SCREEN[screen];if(!config)return;
  loadModule(config.path).then(module=>{
    if(screen==='reader'&&warm){
      window.__PDV2_READER_WARM_CACHE_ONLY=true;
      return Promise.resolve(module.warmReaderRecommendations?.()).finally(()=>{window.__PDV2_READER_WARM_CACHE_ONLY=false;});
    }
    if(screen==='twitter'&&warm)return module.warmTwitterFeeds?.({force:true});
  }).catch(error=>{window.__PDV2_READER_WARM_CACHE_ONLY=false;console.warn(`[${screen}-preload]`,error);});
}
function jstDay(){return new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);}
async function warmWikipediaDaily(){
  const key='pdv2:wikipediaDaily:v213';
  try{const cached=JSON.parse(localStorage.getItem(key)||'null');if(cached?.date===jstDay()&&Array.isArray(cached?.items)&&cached.items.length)return cached;}catch{}
  try{
    const response=await fetch('/api/wikipedia?mode=daily',{cache:'no-store',signal:AbortSignal.timeout(9000)});
    const data=await response.json().catch(()=>null);
    if(response.ok&&data?.date===jstDay()&&Array.isArray(data?.items)&&data.items.length){try{localStorage.setItem(key,JSON.stringify(data));}catch{}return data;}
  }catch(error){console.warn('[wikipedia-prewarm]',error?.message||error);}
  return null;
}
function startBackgroundJobs(){
  preloadFeature('reader',{warm:true});
  preloadFeature('twitter',{warm:true});
  idle(()=>warmWikipediaDaily(),20);
  idle(()=>preloadFeature('wikipedia'),320);
  idle(()=>preloadFeature('weather'),450);
  idle(()=>preloadFeature('media'),700);
}

async function resolveTwitchOAuthReturn(){
  try{
    const module=await loadModule('./features/twitch/twitch-chat.js');
    return await module.handleTwitchOAuthReturn?.();
  }catch(error){
    console.warn('[twitch-oauth]',error);
    return null;
  }
}

async function resolveTwitchPlaybackRecovery(){
  try{
    const module=await loadModule('./features/twitch/twitch-player.js');
    return module.getRecentTwitchPlayback?.()||null;
  }catch(error){
    console.warn('[twitch-recovery]',error);
    return null;
  }
}

async function boot(){
  if(!root)throw new Error('#app-main が見つかりません');
  applyTheme();
  const twitchOAuth=await resolveTwitchOAuthReturn();
  renderNav(navigate);
  if(twitchOAuth?.handled){
    update('lastMediaMode','twitch');
    await navigate('media',{mediaMode:'twitch',source:'twitch-oauth'});
  }else{
    const twitchRecovery=await resolveTwitchPlaybackRecovery();
    if(twitchRecovery){
      update('lastMediaMode','twitch');
      await navigate('media',{mediaMode:'twitch',source:'twitch-recovery'});
    }else{
      await navigate('home');
    }
  }
  startBackgroundJobs();
  if('serviceWorker'in navigator)navigator.serviceWorker.register(`/sw.js?v=${BUILD}`,{updateViaCache:'none'}).then(async registration=>{try{await registration.update();}catch{}registration.waiting?.postMessage({type:'SKIP_WAITING'});}).catch(error=>console.warn('[sw]',error));
  window.addEventListener('pdv2:settings-changed',()=>{try{applyTheme();}catch{}});
  window.addEventListener('pdv2:context-changed',()=>{try{applyTheme();renderNav(navigate);}catch{}});
  window.addEventListener('popstate',()=>navigate(state.screen||'home'));
  document.documentElement.dataset.pdv2Booted='1';
  window.dispatchEvent(new CustomEvent('pdv2:booted',{detail:{build:BUILD}}));
}
boot().catch(renderBootError);
