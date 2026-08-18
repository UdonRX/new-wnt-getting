import { el, showToast } from '../../shared/dom.js';
import { connectTwitchChat, hasTwitchChatToken, startTwitchLogin } from './twitch-chat.js';

let cleanupChat = null;
let activeHost = null;
let fullscreenPanel = null;

function stopChat(){ cleanupChat?.(); cleanupChat=null; }

export function cleanupTwitchPlayer(){
  stopChat();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  fullscreenPanel?.classList.remove('player-pseudo-fullscreen');
  fullscreenPanel=null;
  if(activeHost?.isConnected) activeHost.replaceChildren();
  activeHost=null;
}

window.addEventListener('pdv2:before-navigate', cleanupTwitchPlayer);

// Twitch公式Embedを覆わないため、コメントはプレイヤー直下の専用レーンを流す。
function addFlying(lane,msg,density='normal'){
  const limit=density==='low'?3:density==='high'?8:5;
  const existing=[...lane.querySelectorAll('.flying-comment')];
  while(existing.length>=limit)existing.shift()?.remove();
  const c=el('div',{class:'flying-comment',text:msg.text});
  c.style.top=`${5+Math.random()*48}%`;
  c.style.animationDuration=`${6+Math.random()*2}s`;
  lane.append(c);
  setTimeout(()=>c.remove(),9000);
}

async function enterLandscape(panel){
  try{
    if(panel.requestFullscreen){
      await panel.requestFullscreen();
      fullscreenPanel=panel;
      try{await screen.orientation?.lock?.('landscape');}catch{}
      return;
    }
  }catch{}
  panel.classList.toggle('player-pseudo-fullscreen');
  fullscreenPanel=panel.classList.contains('player-pseudo-fullscreen')?panel:null;
  showToast(panel.classList.contains('player-pseudo-fullscreen')?'端末を横向きにすると見やすくなります':'通常表示に戻しました');
}

function buildIframe(entry){
  const live=!entry.videoId;
  const parent=location.hostname;
  const q=new URLSearchParams({parent,autoplay:'false',muted:'false'});
  if(live)q.set('channel',entry.snapshot.broadcaster.login);
  else q.set('video',`v${String(entry.videoId).replace(/^v/,'')}`);
  return el('iframe',{
    src:`https://player.twitch.tv/?${q}`,
    allowfullscreen:'true',
    allow:'autoplay; fullscreen',
    title:live?`${entry.snapshot.broadcaster.displayName} LIVE`:'Twitch archive'
  });
}

export function mountTwitchPlayer({host,queue,index=0,settings}){
  if(!host||!Array.isArray(queue)||!queue.length)return;
  stopChat();
  activeHost=host;
  let current=Math.max(0,Math.min(index,queue.length-1));

  const render=()=>{
    stopChat();
    const entry=queue[current];
    const {snapshot,videoId=''}=entry;
    const live=!videoId;
    const archive=live?null:snapshot.archives.find(v=>v.id===videoId);
    const panel=el('section',{class:'twitch-inline-player'});

    const top=el('div',{class:'twitch-inline-head'});
    top.append(
      el('div',{},[
        el('div',{class:'twitch-inline-kicker',text:live?'LIVE':'アーカイブ'}),
        el('strong',{text:snapshot.broadcaster.displayName})
      ]),
      el('button',{class:'icon-button twitch-close',type:'button','aria-label':'プレイヤーを閉じる',text:'✕',onclick:()=>cleanupTwitchPlayer()})
    );

    const stage=el('div',{class:'twitch-inline-stage'});
    const min=el('div',{class:'twitch-embed-min'});
    min.append(buildIframe(entry));
    stage.append(min);

    const commentLane=el('div',{class:'twitch-comment-lane'});
    commentLane.append(el('div',{class:'comment-lane-placeholder',text:'Twitch連携すると、ここをコメントが流れます'}));

    const info=el('div',{class:'twitch-inline-info'});
    info.append(el('div',{class:'player-title',text:live?snapshot.live.title:(archive?.title||'アーカイブ')}));
    const status=el('div',{class:'source-note'});

    const controls=el('div',{class:'twitch-inline-controls'});
    const prev=el('button',{class:'player-soft',type:'button',text:'‹ 前へ',disabled:current<=0,onclick:()=>{if(current>0){current--;render();}}});
    const next=el('button',{class:'player-soft',type:'button',text:'次へ ›',disabled:current>=queue.length-1,onclick:()=>{if(current<queue.length-1){current++;render();}}});
    const landscape=el('button',{class:'player-soft',type:'button',text:'↔ 横画面',onclick:()=>enterLandscape(panel)});
    const external=el('a',{
      class:'player-soft',target:'_blank',rel:'noopener noreferrer',
      href:live?snapshot.live.url:`https://www.twitch.tv/videos/${videoId}`,
      text:'Twitchで開く ↗'
    });
    controls.append(prev,next,landscape,external);

    if(live){
      const chatBtn=el('button',{class:'player-soft',type:'button',text:hasTwitchChatToken()?'コメント開始':'Twitch連携'});
      chatBtn.onclick=async()=>{
        if(!hasTwitchChatToken()){
          try{await startTwitchLogin();}catch(err){showToast(err.message);}
          return;
        }
        if(cleanupChat){
          stopChat(); chatBtn.textContent='コメント開始'; status.textContent='コメントを停止しました'; return;
        }
        commentLane.querySelector('.comment-lane-placeholder')?.remove();
        cleanupChat=connectTwitchChat({
          broadcasterId:snapshot.broadcaster.id,
          onMessage:m=>addFlying(commentLane,m,settings?.twitchCommentDensity||'normal'),
          onStatus:s=>status.textContent=s
        });
        chatBtn.textContent='コメント停止';
      };
      controls.append(chatBtn);
    }

    info.append(controls,status);
    panel.append(top,stage);
    if(live)panel.append(commentLane);
    panel.append(info);
    host.replaceChildren(panel);
    requestAnimationFrame(()=>host.scrollIntoView({behavior:'smooth',block:'start'}));
  };

  render();
}
