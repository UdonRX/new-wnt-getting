let observer=null;
let homeSocialRefreshJob=null;
function markSeen(service){
  if(service!=='youtube'&&service!=='x'&&service!=='instagram')return;
  try{localStorage.setItem(`pdv2:lastSeen:${service}`,String(Date.now()));}catch{}
  window.dispatchEvent(new CustomEvent('pdv2:service-seen',{detail:{service,at:Date.now()}}));
}
function refreshHomeSocial(){
  if(homeSocialRefreshJob)return homeSocialRefreshJob;
  homeSocialRefreshJob=import('../features/twitter/social-home-refresh.js')
    .then(module=>module.refreshHomeSocialFeeds?.())
    .catch(error=>console.warn('[home-social-refresh]',error?.message||error))
    .finally(()=>{homeSocialRefreshJob=null});
  return homeSocialRefreshJob;
}
function scheduleHomeSocial(root){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(root?.querySelector('.home-screen'))refreshHomeSocial();
  }));
}
function stopObserver(){try{observer?.disconnect?.();}catch{}observer=null;}
function storyUsername(button){
  const label=String(button?.getAttribute?.('aria-label')||''),match=label.match(/@([^の]+)のStory/);
  return String(match?.[1]||button?.querySelector?.('.ig-story-label')?.textContent||'').trim();
}
function openRequestedInstagramStory(root,buttons=[]){
  let requested='';try{requested=String(sessionStorage.getItem('pdv2:openInstagramStory')||'').trim();}catch{}
  if(!requested)return false;
  const target=buttons.find(button=>storyUsername(button).toLowerCase()===requested.toLowerCase());
  if(!target)return false;
  try{sessionStorage.removeItem('pdv2:openInstagramStory');}catch{}
  queueMicrotask(()=>{if(target.isConnected)target.click();});
  return true;
}
function snapshotInstagram(root){
  const tray=root?.querySelector('.ig-story-tray');if(!tray)return false;
  const buttons=[...tray.querySelectorAll('.ig-story-bubble')];
  const accounts=buttons.map(button=>{
    const username=storyUsername(button),profilePicUrl=button.querySelector('img')?.currentSrc||button.querySelector('img')?.src||'';
    return username?{username,profilePicUrl,unread:button.dataset.unread==='1'}:null;
  }).filter(Boolean);if(!accounts.length)return false;
  const snapshot={at:Date.now(),accounts};try{localStorage.setItem('pdv2:instagramStorySnapshot:v1',JSON.stringify(snapshot));}catch{}
  window.dispatchEvent(new CustomEvent('pdv2:instagram-story-cache-updated',{detail:snapshot}));
  openRequestedInstagramStory(root,buttons);
  return true;
}
function armInstagram(root){
  stopObserver();const capture=()=>snapshotInstagram(root);capture();observer=new MutationObserver(capture);observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-unread','src']});
}
export function installHomeServiceState({root}={}){
  const onComplete=event=>{
    const detail=event?.detail||{},options=detail.options||{},screen=detail.screen||'';
    if(options.serviceSeen)markSeen(options.serviceSeen);
    else if(screen==='media'&&(options.mediaMode||'youtube')==='youtube')markSeen('youtube');
    else if(screen==='twitter'&&String(options.snsMode||localStorage.getItem('pdv2:lastSnsMode')||'x').toLowerCase()!=='instagram')markSeen('x');
    if(screen==='twitter'&&String(options.snsMode||'').toLowerCase()==='instagram')requestAnimationFrame(()=>armInstagram(root));else stopObserver();
    if(screen==='home')scheduleHomeSocial(root);
  };
  const onBefore=()=>stopObserver();
  window.addEventListener('pdv2:navigation-complete',onComplete);window.addEventListener('pdv2:before-navigate',onBefore);
  scheduleHomeSocial(root);
  return{destroy(){stopObserver();window.removeEventListener('pdv2:navigation-complete',onComplete);window.removeEventListener('pdv2:before-navigate',onBefore);}};
}
