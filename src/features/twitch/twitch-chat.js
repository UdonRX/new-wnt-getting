import { showToast } from '../../shared/dom.js';

const PROFILE_KEY = 'pdv2:twitchOAuthProfile';
let socket = null;

function readProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    return value && typeof value === 'object' && value.login ? value : null;
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  try {
    if (profile?.login) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_KEY);
  } catch {}
}

function cleanOAuthQuery() {
  const url = new URL(location.href);
  for (const key of ['code', 'state', 'scope', 'error', 'error_description']) url.searchParams.delete(key);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash && !url.hash.includes('access_token=') ? url.hash : ''}`);
}

export async function handleTwitchOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const legacyHash = location.hash.includes('access_token=');
  if (!code && !error && !legacyHash) return { handled: false, connected: Boolean(readProfile()), profile: readProfile() };

  if (legacyHash) {
    cleanOAuthQuery();
    showToast('旧Twitch認証を検出しました。もう一度Twitch連携してください', 4500);
    return { handled: true, connected: false, error: 'legacy-oauth' };
  }

  if (error) {
    const message = params.get('error_description') || error;
    cleanOAuthQuery();
    showToast(`Twitch連携に失敗しました: ${message}`, 4500);
    return { handled: true, connected: false, error: message };
  }

  try {
    const response = await fetch('/api/twitch-oauth?mode=exchange', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state })
    });
    const data = await response.json().catch(() => ({}));
    cleanOAuthQuery();
    if (!response.ok || !data?.connected) throw new Error(data?.error || 'Twitch連携に失敗しました');
    saveProfile(data.user);
    const name = data.user?.displayName || data.user?.login || 'Twitch';
    showToast(`Twitch連携完了: ${name}`, 4000);
    return { handled: true, connected: true, profile: data.user || null };
  } catch (error) {
    cleanOAuthQuery();
    saveProfile(null);
    showToast(error?.message || 'Twitch連携に失敗しました', 4500);
    return { handled: true, connected: false, error: error?.message || String(error) };
  }
}

export function getTwitchChatProfile() {
  return readProfile();
}

export function hasTwitchChatToken() {
  return Boolean(readProfile());
}

export async function refreshTwitchChatStatus() {
  try {
    const response = await fetch('/api/twitch-oauth?mode=status', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.connected) {
      saveProfile(null);
      return { connected: false, user: null, error: data?.error || '' };
    }
    saveProfile(data.user);
    return { connected: true, user: data.user || null };
  } catch (error) {
    return { connected: Boolean(readProfile()), user: readProfile(), error: error?.message || String(error) };
  }
}

export async function startTwitchLogin() {
  const response = await fetch('/api/twitch-oauth?mode=start', { cache: 'no-store', credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.authorizeUrl) throw new Error(data?.error || 'Twitch認証を開始できません');
  location.assign(data.authorizeUrl);
}

export async function disconnectTwitchChat() {
  try {
    await fetch('/api/twitch-oauth?mode=disconnect', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } finally {
    saveProfile(null);
    try { socket?.close(); } catch {}
    socket = null;
  }
}

export function connectTwitchChat({ broadcasterId, onMessage, onStatus }) {
  if (!hasTwitchChatToken()) throw new Error('Twitch連携が必要です');
  try { socket?.close(); } catch {}

  const connect = url => {
    socket = new WebSocket(url || 'wss://eventsub.wss.twitch.tv/ws');
    socket.onopen = () => onStatus?.('接続中');
    socket.onmessage = async event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const type = data.metadata?.message_type;
      if (type === 'session_welcome') {
        const sessionId = data.payload?.session?.id;
        onStatus?.('購読中');
        const response = await fetch('/api/twitch-eventsub', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, broadcasterId })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) saveProfile(null);
          onStatus?.(result.error || '購読失敗');
          return;
        }
        onStatus?.(`コメント接続済み${result.login ? ` (@${result.login})` : ''}`);
      } else if (type === 'notification' && data.metadata?.subscription_type === 'channel.chat.message') {
        const item = data.payload?.event;
        onMessage?.({
          id: item?.message_id || crypto.randomUUID(),
          name: item?.chatter_user_name || '',
          text: item?.message?.text || ''
        });
      } else if (type === 'session_reconnect') {
        const reconnectUrl = data.payload?.session?.reconnect_url;
        if (reconnectUrl) connect(reconnectUrl);
      } else if (type === 'revocation') {
        onStatus?.('コメント権限が失効しました');
      }
    };
    socket.onerror = () => onStatus?.('コメント接続エラー');
    socket.onclose = () => onStatus?.('コメント切断');
  };

  connect();
  return () => {
    try { socket?.close(); } catch {}
    socket = null;
  };
}
