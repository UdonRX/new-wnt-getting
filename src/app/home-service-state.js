let observer=null;
function markSeen(service){
  if(service!=='youtube'&&service!=='x')return;
  try{localStorage.setItem(`pdv2:lastSeen:${service}`,String(Date.now()));}catch{}
  window.dispatchEvent(new CustomEvent('pdv2:service-seen',{detail:{service,at:Date.now()}}));
}
function stopObserver(){try{observer?.disconnect?.();}catch{}observer=null;}
function snapshotInstagram(root){
  const tray=root?.querySelector('.ig-story-tray');if(!tray)return false;
  const accounts=[...tray.querySelectorAll('.ig-story-bubble')].map(button=>{
    const label=String(button.getAttribute('aria-label')||''),match=label.match(/@([^の]+)のStory/),username=match?.[1]||String(button.querySelector('.ig-story-label')?.textContent||'').trim(),profilePicUrl=button.querySelector('img')?.currentSrc||button.querySelector('img')?.src||'';
    return username?{username,profilePicUrl,unread:button.dataset.unread==='1'}:null;
  }).filter(Boolean);if(!accounts.length)return false;
  const snapshot={at:Date.now(),accounts};try{localStorage.setItem('pdv2:instagramStorySnapshot:v1',JSON.stringify(snapshot));}catch{}
  window.dispatchEvent(new CustomEvent('pdv2:instagram-story-cache-updated',{detail:snapshot}));return true;
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
  };
  const onBefore=()=>stopObserver();
  window.addEventListener('pdv2:navigation-complete',onComplete);window.addEventListener('pdv2:before-navigate',onBefore);
  return{destroy(){stopObserver();window.removeEventListener('pdv2:navigation-complete',onComplete);window.removeEventListener('pdv2:before-navigate',onBefore);}};
}
