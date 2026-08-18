import { showToast } from '../../shared/dom.js';

const TOKEN_KEY='pdv2:twitchOAuthToken';
const STATE_KEY='pdv2:twitchOAuthState';
let socket=null;

export async function handleTwitchOAuthReturn(){
  if(!location.hash.includes('access_token='))return false;
  const p=new URLSearchParams(location.hash.slice(1));const token=p.get('access_token'),state=p.get('state');const expected=sessionStorage.getItem(STATE_KEY);
  if(!token||!state||state!==expected)throw new Error('Twitch認証stateが一致しません');
  sessionStorage.setItem(TOKEN_KEY,token);sessionStorage.removeItem(STATE_KEY);history.replaceState(null,'',location.pathname+location.search);showToast('Twitchコメント連携が完了しました');return true;
}
export function hasTwitchChatToken(){return Boolean(sessionStorage.getItem(TOKEN_KEY));}
export async function startTwitchLogin(){
  const cfg=await fetch('/api/twitch-feed?mode=config',{cache:'no-store'}).then(r=>r.json());if(!cfg.twitchClientId)throw new Error('TWITCH_CLIENT_ID が未設定です');
  const state=crypto.randomUUID();sessionStorage.setItem(STATE_KEY,state);const redirect=`${location.origin}${location.pathname}`;const u=new URL('https://id.twitch.tv/oauth2/authorize');u.searchParams.set('response_type','token');u.searchParams.set('client_id',cfg.twitchClientId);u.searchParams.set('redirect_uri',redirect);u.searchParams.set('scope','user:read:chat');u.searchParams.set('state',state);location.href=u.href;
}
export function disconnectTwitchChat(){sessionStorage.removeItem(TOKEN_KEY);try{socket?.close()}catch{};socket=null;}

export function connectTwitchChat({broadcasterId,onMessage,onStatus}){
  const token=sessionStorage.getItem(TOKEN_KEY);if(!token)throw new Error('Twitch連携が必要です');
  try{socket?.close()}catch{}
  const connect=url=>{
    socket=new WebSocket(url||'wss://eventsub.wss.twitch.tv/ws');
    socket.onopen=()=>onStatus?.('接続中');
    socket.onmessage=async event=>{
      let data;try{data=JSON.parse(event.data)}catch{return;}
      const type=data.metadata?.message_type;
      if(type==='session_welcome'){
        const sessionId=data.payload?.session?.id;onStatus?.('購読中');
        const r=await fetch('/api/twitch-eventsub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,sessionId,broadcasterId})});const d=await r.json();if(!r.ok){onStatus?.(d.error||'購読失敗');return;}onStatus?.('コメント接続済み');
      }else if(type==='notification'&&data.metadata?.subscription_type==='channel.chat.message'){
        const e=data.payload?.event;onMessage?.({id:e?.message_id||crypto.randomUUID(),name:e?.chatter_user_name||'',text:e?.message?.text||''});
      }else if(type==='session_reconnect'){
        const u=data.payload?.session?.reconnect_url;if(u)connect(u);
      }else if(type==='revocation'){onStatus?.('権限が失効しました');}
    };
    socket.onerror=()=>onStatus?.('コメント接続エラー');socket.onclose=()=>onStatus?.('コメント切断');
  };connect();return()=>{try{socket?.close()}catch{};socket=null;};
}
