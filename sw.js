const CACHE_NAME='personal-dashboard-v2-19-5-flow1';
const STATIC_FETCH_TIMEOUT_MS=5500;
const APP_SHELL=[
  '/','/index.html','/manifest.webmanifest',
  '/src/styles/tokens.css','/src/styles/base.css','/src/styles/navigation.css','/src/styles/screens.css','/src/styles/app.css','/src/styles/motion.css','/src/styles/v2181.css','/src/styles/v2182.css','/src/styles/v2189.css','/src/styles/v2194.css','/src/styles/v2195.css',
  '/src/main.js','/src/runtime-v2182.js','/src/runtime-v2184.js','/src/runtime-v2185.js','/src/runtime-v2192.js','/src/runtime-v2195.js','/src/app/router.js','/src/app/store.js',
  '/src/shared/components.js','/src/shared/dom.js','/src/shared/gestures.js','/src/shared/icons.js','/src/shared/playing-title.js','/src/shared/reader-debug.js','/src/shared/rss.js','/src/shared/storage.js','/src/shared/time.js',
  '/src/features/home/home.js','/src/features/weather/weather.js','/src/features/weather/weather-api.js','/src/features/weather/weather-icons.js',
  '/src/features/reader/reader.js','/src/features/reader/reader-data.js','/src/features/reader/reader-flow.js','/src/features/reader/reader-focus.js','/src/features/reader/reader-rank.js',
  '/src/features/media/media.js','/src/features/youtube/youtube.js','/src/features/youtube/youtube-player.js',
  '/src/features/twitch/twitch.js','/src/features/twitch/twitch-player.js','/src/features/twitch/twitch-chat.js',
  '/src/features/twitter/twitter.js','/src/features/twitter/image-viewer.js','/src/features/wikipedia/wikipedia.js','/src/features/settings/settings.js',
  '/shared/paper-creative-keywords.js','/icons/icon-192.png','/icons/icon-512.png'
];
function canonicalRequest(request){try{const url=new URL(request.url);return new Request(new URL(url.pathname,self.location.origin).href,{method:'GET',headers:request.headers,credentials:request.credentials,mode:request.mode==='navigate'?'same-origin':request.mode});}catch{return null;}}
async function cacheStatic(cache,request,response){if(!response?.ok)return;try{await cache.put(request,response.clone());}catch{}const canonical=canonicalRequest(request);if(canonical){try{await cache.put(canonical,response.clone());}catch{}}}
async function precacheIndividually(){const cache=await caches.open(CACHE_NAME);await Promise.allSettled(APP_SHELL.map(async path=>{try{const request=new Request(new URL(path,self.location.origin).href,{cache:'reload'});const response=await fetch(request);if(response?.ok)await cacheStatic(cache,request,response);}catch(error){console.warn('[sw precache skip]',path,error?.message||error);}}));}
self.addEventListener('install',event=>event.waitUntil(precacheIndividually().finally(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.allSettled(keys.filter(key=>key.startsWith('personal-dashboard-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
async function cachedFallback(request){const direct=await caches.match(request,{ignoreSearch:true});if(direct)return direct;const canonical=canonicalRequest(request);if(canonical){const hit=await caches.match(canonical,{ignoreSearch:true});if(hit)return hit;}return null;}
async function fetchFreshWithTimeout(request,timeoutMs=STATIC_FETCH_TIMEOUT_MS){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(new Request(request,{cache:'no-store',signal:controller.signal}));}finally{clearTimeout(timer);}}
async function networkFirst(request){try{const response=await fetchFreshWithTimeout(request);if(!response?.ok){const cached=await cachedFallback(request);return cached||response;}const cache=await caches.open(CACHE_NAME);cacheStatic(cache,request,response).catch(()=>{});return response;}catch{const cached=await cachedFallback(request);if(cached)return cached;if(request.mode==='navigate')return(await caches.match('/index.html',{ignoreSearch:true}))||Response.error();return Response.error();}}
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/')){event.respondWith(fetch(request).catch(()=>new Response('',{status:503,statusText:'Service Unavailable'})));return;}
  if(request.mode==='navigate'||url.pathname.endsWith('.js')||url.pathname.endsWith('.mjs')||url.pathname.endsWith('.css')||url.pathname==='/index.html'||url.pathname==='/'){event.respondWith(networkFirst(request));return;}
  event.respondWith(cachedFallback(request).then(cached=>cached||fetch(request).then(response=>{if(response?.ok){const clone=response.clone();caches.open(CACHE_NAME).then(cache=>cacheStatic(cache,request,clone)).catch(()=>{});}return response;})));
});
