import { instagramAccounts, instagramProfileUrl } from './instagram-accounts.js';

const BATCH_SIZE = 10;
const CACHE_MS = 35_000;
const VIEWED_KEY = 'instagramStoryViewedIdsV1';
const VIEWED_TTL = 48 * 60 * 60 * 1000;
const VIEWED_MAX = 320;
const instances = new WeakMap();

function ensureStyles() {
  if (document.getElementById('instagram-story-styles')) return;
  const style = document.createElement('style');
  style.id = 'instagram-story-styles';
  style.textContent = `
.ig-story-tray{margin:0 -14px 2px;padding:9px 10px 10px;border-bottom:1px solid var(--line);overflow:hidden}.ig-story-tray[hidden]{display:none!important}
.ig-story-scroll{display:flex;gap:10px;overflow-x:auto;padding:1px;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}.ig-story-scroll::-webkit-scrollbar{display:none}
.ig-story-bubble{flex:0 0 68px;display:grid;justify-items:center;gap:5px;padding:0;border:0;background:transparent;color:var(--text);font:inherit}.ig-story-ring{width:60px;height:60px;padding:3px;border-radius:50%;display:grid;place-items:center;background:#5f6068}.ig-story-bubble[data-unread="1"] .ig-story-ring{background:linear-gradient(145deg,#743cff,#e73c85 58%,#ff9e45);box-shadow:0 5px 20px rgba(221,62,130,.16)}
.ig-story-face{width:100%;height:100%;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:var(--surface-2);border:2px solid var(--surface);font-size:12px;font-weight:800}.ig-story-face img{width:100%;height:100%;object-fit:cover}.ig-story-label{width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:10px;color:var(--muted)}
.ig-story-viewer[hidden]{display:none!important}.ig-story-viewer{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;background:#000}.ig-story-frame{position:relative;width:min(100vw,520px);height:100dvh;overflow:hidden;background:#050506}.ig-story-media{position:absolute;inset:0;display:grid;place-items:center;background:#000}.ig-story-media img,.ig-story-media video{width:100%;height:100%;object-fit:contain;background:#000}.ig-story-error{padding:24px;color:#ddd;text-align:center;font-size:12px;line-height:1.6}
.ig-story-progress{position:absolute;z-index:8;left:8px;right:8px;top:max(8px,env(safe-area-inset-top));display:flex;gap:4px}.ig-story-seg{flex:1;height:2px;border-radius:9px;overflow:hidden;background:rgba(255,255,255,.28)}.ig-story-fill{display:block;width:0;height:100%;background:#fff}
.ig-story-head{position:absolute;z-index:9;top:calc(max(8px,env(safe-area-inset-top)) + 10px);left:9px;right:9px;display:flex;align-items:center;justify-content:space-between;color:#fff;text-shadow:0 1px 7px #000}.ig-story-user{display:flex;align-items:center;gap:8px;min-width:0}.ig-story-avatar{width:34px;height:34px;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:#24242c;border:1px solid rgba(255,255,255,.25);font-size:11px;font-weight:800}.ig-story-avatar img{width:100%;height:100%;object-fit:cover}.ig-story-user strong{display:block;font-size:12px}.ig-story-user small{display:block;color:#d1d1d7;font-size:9px}.ig-story-close{width:40px;height:40px;border:0;border-radius:50%;background:rgba(0,0,0,.3);color:#fff;font-size:28px}
.ig-story-hit{position:absolute;z-index:7;top:80px;bottom:56px;border:0;background:transparent;padding:0}.ig-story-prev{left:0;width:35%}.ig-story-next{right:0;width:65%}.ig-story-open{position:absolute;z-index:10;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);padding:8px 12px;border:1px solid rgba(255,255,255,.28);border-radius:999px;background:rgba(0,0,0,.4);color:#fff;text-decoration:none;font-size:10px;white-space:nowrap}body.ig-story-opened{overflow:hidden!important;touch-action:none}`;
  document.head.append(style);
}

const initials = value => String(value || '?').slice(0, 2).toUpperCase();

function loadViewed() {
  const now = Date.now();
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}');
    return new Map(Object.entries(raw || {})
      .filter(([id, ts]) => id && Number.isFinite(Number(ts)) && now - Number(ts) < VIEWED_TTL)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, VIEWED_MAX)
      .map(([id, ts]) => [id, Number(ts)]));
  } catch { return new Map(); }
}

function saveViewed(map) {
  try {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, VIEWED_MAX);
    localStorage.setItem(VIEWED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function elapsed(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

export function disposeInstagramStories(root) {
  const cleanup = instances.get(root);
  if (!cleanup) return;
  instances.delete(root);
  cleanup();
}

export function installInstagramStories(root, { generation, isCurrent } = {}) {
  disposeInstagramStories(root);
  ensureStyles();
  const screen = root.querySelector('.instagram-screen');
  const feed = screen?.querySelector('.instagram-feed-host');
  if (!screen || !feed) return () => {};

  const tray = document.createElement('section');
  tray.className = 'ig-story-tray';
  tray.setAttribute('aria-label', 'Instagram Story');
  const scroll = document.createElement('div');
  scroll.className = 'ig-story-scroll';
  tray.append(scroll);
  screen.insertBefore(tray, feed);

  const viewer = document.createElement('div');
  viewer.className = 'ig-story-viewer';
  viewer.hidden = true;
  viewer.setAttribute('aria-hidden', 'true');
  viewer.innerHTML = `<div class="ig-story-frame" role="dialog" aria-modal="true" aria-label="Instagram Story Viewer">
    <div class="ig-story-progress"></div>
    <div class="ig-story-head"><div class="ig-story-user"><div class="ig-story-avatar"></div><div><strong></strong><small></small></div></div><button class="ig-story-close" type="button" aria-label="Storyを閉じる">×</button></div>
    <div class="ig-story-media"></div><button class="ig-story-hit ig-story-prev" type="button" aria-label="前へ"></button><button class="ig-story-hit ig-story-next" type="button" aria-label="次へ"></button>
    <a class="ig-story-open" target="_blank" rel="noopener noreferrer" hidden>Instagramで開く</a></div>`;
  document.body.append(viewer);

  const progress = viewer.querySelector('.ig-story-progress');
  const avatar = viewer.querySelector('.ig-story-avatar');
  const user = viewer.querySelector('.ig-story-user strong');
  const time = viewer.querySelector('.ig-story-user small');
  const media = viewer.querySelector('.ig-story-media');
  const fallback = viewer.querySelector('.ig-story-open');
  const refreshButton = screen.querySelector('.topbar button[title="更新"],.topbar [aria-label="更新"]');

  let disposed = false;
  let controller = null;
  let inflight = null;
  let inflightKey = '';
  let lastKey = '';
  let lastAt = 0;
  let records = new Map();
  let viewed = loadViewed();
  let renderToken = 0;
  const state = { accounts: [], accountIndex: 0, storyIndex: 0, timer: 0, video: null };
  const active = () => !disposed && screen.isConnected && (!isCurrent || isCurrent(generation));
  const activeAccounts = () => instagramAccounts().map(name => records.get(name)).filter(x => x?.status === 'ok' && x.activeStory && x.stories?.length);

  const renderTray = () => {
    if (!active()) return;
    const accounts = activeAccounts();
    scroll.replaceChildren();
    tray.hidden = !accounts.length;
    for (const account of accounts) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ig-story-bubble';
      button.dataset.unread = account.stories.some(s => s.id && !viewed.has(String(s.id))) ? '1' : '0';
      button.setAttribute('aria-label', `@${account.username}のStoryを開く`);
      const ring = document.createElement('span'); ring.className = 'ig-story-ring';
      const face = document.createElement('span'); face.className = 'ig-story-face';
      const pic = String(account.profile?.profilePicUrl || '');
      if (pic) {
        const img = document.createElement('img'); img.src = pic; img.alt = `@${account.username}`; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => face.replaceChildren(document.createTextNode(initials(account.username))), { once: true }); face.append(img);
      } else face.textContent = initials(account.username);
      ring.append(face);
      const label = document.createElement('span'); label.className = 'ig-story-label'; label.textContent = account.username;
      button.append(ring, label); button.addEventListener('click', () => openViewer(account.username)); scroll.append(button);
    }
  };

  const clearPlayback = () => {
    renderToken += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = 0;
    media.querySelectorAll('img').forEach(img => { img.onload = null; img.onerror = null; img.removeAttribute('src'); });
    if (state.video) { try { state.video.pause(); state.video.removeAttribute('src'); state.video.load(); } catch {} state.video = null; }
  };

  const current = () => ({ account: state.accounts[state.accountIndex], story: state.accounts[state.accountIndex]?.stories?.[state.storyIndex] });
  const close = () => { clearPlayback(); viewer.hidden = true; viewer.setAttribute('aria-hidden', 'true'); document.body.classList.remove('ig-story-opened'); media.replaceChildren(); fallback.hidden = true; };
  const markViewed = story => { if (!story?.id) return; viewed.set(String(story.id), Date.now()); viewed = new Map([...viewed.entries()].sort((a,b)=>b[1]-a[1]).slice(0,VIEWED_MAX)); saveViewed(viewed); renderTray(); };
  const showFallback = (account, story) => { fallback.href = story?.id ? `https://www.instagram.com/stories/${encodeURIComponent(account.username)}/${encodeURIComponent(story.id)}/` : instagramProfileUrl(account.username); fallback.hidden = false; };

  const next = () => {
    const { account } = current(); if (!account) return close();
    if (state.storyIndex + 1 < account.stories.length) state.storyIndex += 1;
    else if (state.accountIndex + 1 < state.accounts.length) { state.accountIndex += 1; state.storyIndex = 0; }
    else return close();
    renderViewer();
  };
  const prev = () => {
    if (state.storyIndex > 0) state.storyIndex -= 1;
    else if (state.accountIndex > 0) { state.accountIndex -= 1; state.storyIndex = Math.max(0, state.accounts[state.accountIndex].stories.length - 1); }
    renderViewer();
  };

  function renderViewer() {
    clearPlayback();
    const token = renderToken;
    const { account, story } = current();
    if (!account || !story || !active()) return close();
    markViewed(story); fallback.hidden = true; media.replaceChildren(); viewer.hidden = false; viewer.setAttribute('aria-hidden', 'false'); document.body.classList.add('ig-story-opened');
    user.textContent = `@${account.username}`; time.textContent = elapsed(story.takenAt);
    avatar.replaceChildren();
    if (account.profile?.profilePicUrl) { const img = document.createElement('img'); img.src = account.profile.profilePicUrl; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.addEventListener('error',()=>avatar.replaceChildren(document.createTextNode(initials(account.username))),{once:true}); avatar.append(img); } else avatar.textContent = initials(account.username);
    progress.replaceChildren(); let fill = null;
    account.stories.forEach((_, i) => { const seg=document.createElement('span'); seg.className='ig-story-seg'; const f=document.createElement('span'); f.className='ig-story-fill'; f.style.width=i<state.storyIndex?'100%':'0%'; seg.append(f); progress.append(seg); if(i===state.storyIndex) fill=f; });

    if (story.type === 'video' && story.videoUrl) {
      const video = document.createElement('video'); video.src = story.videoUrl; video.poster = story.imageUrl || ''; video.playsInline = true; video.setAttribute('playsinline',''); video.preload='auto'; video.autoplay=true;
      video.addEventListener('timeupdate',()=>{ if(token===renderToken && fill && video.duration>0) fill.style.width=`${Math.min(100,video.currentTime/video.duration*100)}%`; });
      video.addEventListener('ended',()=>{ if(token===renderToken) next(); },{once:true});
      video.addEventListener('error',()=>{ if(token!==renderToken)return; media.innerHTML='<div class="ig-story-error">動画を読み込めませんでした。</div>'; showFallback(account,story); },{once:true});
      media.append(video); state.video=video; video.play().catch(()=>{ if(token===renderToken) video.controls=true; }); return;
    }
    if (story.imageUrl) {
      const img=document.createElement('img'); img.src=story.imageUrl; img.alt=`@${account.username} Story`; img.referrerPolicy='no-referrer';
      img.addEventListener('load',()=>{ if(token!==renderToken)return; if(fill){fill.style.transition='width 5s linear';requestAnimationFrame(()=>fill.style.width='100%');} state.timer=setTimeout(()=>{if(token===renderToken)next();},5000); },{once:true});
      img.addEventListener('error',()=>{ if(token!==renderToken)return; media.innerHTML='<div class="ig-story-error">画像を読み込めませんでした。</div>'; showFallback(account,story); },{once:true}); media.append(img); return;
    }
    media.innerHTML='<div class="ig-story-error">表示できるStoryメディアがありません。</div>'; showFallback(account,story);
  }

  function openViewer(username) { const accounts=activeAccounts(); const i=accounts.findIndex(x=>x.username===username); if(i<0)return; state.accounts=accounts; state.accountIndex=i; state.storyIndex=0; renderViewer(); }

  const fetchBatch = async (names, signal) => {
    const response = await fetch('/api/instagram-stories',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-Instagram-Story-Client':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({usernames:names}),signal});
    const data=await response.json().catch(()=>({})); if(!response.ok||!data.ok||!Array.isArray(data.accounts))throw new Error(data.error||`Story HTTP ${response.status}`); return data.accounts;
  };

  const refresh = (force=false) => {
    const names=instagramAccounts(), key=names.join(',');
    if(!names.length){records.clear();tray.hidden=true;return Promise.resolve();}
    if(!force&&key===lastKey&&Date.now()-lastAt<CACHE_MS){renderTray();return Promise.resolve();}
    if(inflight&&key===inflightKey)return inflight;
    controller?.abort(); controller=new AbortController(); inflightKey=key; const signal=controller.signal;
    inflight=(async()=>{ const nextRecords=new Map();
      for(let i=0;i<names.length;i+=BATCH_SIZE){ if(!active()||signal.aborted)return; try{(await fetchBatch(names.slice(i,i+BATCH_SIZE),signal)).forEach(x=>{if(x?.username)nextRecords.set(String(x.username).toLowerCase(),x);});}catch(error){if(error?.name==='AbortError')return;console.warn('[instagram-stories-batch]',error?.message||error);} if(i+BATCH_SIZE<names.length){try{await sleep(160,signal);}catch{return;}} }
      if(!active()||signal.aborted)return; records=nextRecords; lastKey=key; lastAt=Date.now(); renderTray();
    })().finally(()=>{if(inflightKey===key){inflight=null;inflightKey='';}}); return inflight;
  };

  const onAccounts=()=>refresh(false).catch(()=>{}), onRefresh=()=>refresh(true).catch(()=>{}), onKey=event=>{if(viewer.hidden)return;if(event.key==='Escape')close();else if(event.key==='ArrowLeft')prev();else if(event.key==='ArrowRight')next();}, onNavigate=()=>disposeInstagramStories(root);
  viewer.querySelector('.ig-story-close').addEventListener('click',close); viewer.querySelector('.ig-story-prev').addEventListener('click',prev); viewer.querySelector('.ig-story-next').addEventListener('click',next);
  refreshButton?.addEventListener('click',onRefresh); window.addEventListener('pdv2:instagram-accounts-changed',onAccounts); window.addEventListener('pdv2:before-navigate',onNavigate,{once:true}); document.addEventListener('keydown',onKey);

  const cleanup=()=>{if(disposed)return;disposed=true;controller?.abort();close();refreshButton?.removeEventListener('click',onRefresh);window.removeEventListener('pdv2:instagram-accounts-changed',onAccounts);window.removeEventListener('pdv2:before-navigate',onNavigate);document.removeEventListener('keydown',onKey);tray.remove();viewer.remove();};
  instances.set(root,cleanup); refresh(false).catch(error=>{if(error?.name!=='AbortError'&&active()){console.warn('[instagram-stories]',error?.message||error);tray.hidden=true;}}); return cleanup;
}
