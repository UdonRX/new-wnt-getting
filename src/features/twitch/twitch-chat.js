import { showToast } from '../../shared/dom.js';

const PROFILE_KEY = 'pdv2:twitchOAuthProfile';
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
let socket = null;
let activeStop = null;

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

function safeLogText(value, max = 220) {
  return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, max);
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

export async function refreshTwitchChatStatus({ brief = false, strict = false } = {}) {
  try {
    const query = brief ? '&brief=1' : '';
    const response = await fetch(`/api/twitch-oauth?mode=status${query}`, { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.connected) {
      saveProfile(null);
      return { connected: false, user: null, error: data?.error || '' };
    }
    saveProfile(data.user);
    return { connected: true, user: data.user || null };
  } catch (error) {
    return {
      connected: strict ? false : Boolean(readProfile()),
      user: strict ? null : readProfile(),
      error: error?.message || String(error)
    };
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
    activeStop?.();
    activeStop = null;
    try { socket?.close(); } catch {}
    socket = null;
    saveProfile(null);
  }
}

export function connectTwitchChat({ broadcasterId, onMessage, onStatus }) {
  if (!hasTwitchChatToken()) throw new Error('Twitch連携が必要です');
  activeStop?.();

  let stopped = false;
  let retryTimer = null;
  let retryAttempt = 0;
  let pendingReconnectSocket = null;
  let receivedAnyComment = false;
  const liveSockets = new Set();
  const subscribedSessions = new Set();
  const seenMessageIds = new Set();

  const setStatus = value => {
    if (!stopped) onStatus?.(value);
  };

  const clearWatchdog = ws => {
    if (!ws) return;
    clearTimeout(ws.__pdv2Watchdog);
    ws.__pdv2Watchdog = null;
  };

  const armWatchdog = (ws, seconds) => {
    clearWatchdog(ws);
    const timeoutSeconds = Math.max(10, Number(seconds) || 10);
    ws.__pdv2KeepaliveSeconds = timeoutSeconds;
    ws.__pdv2Watchdog = setTimeout(() => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      console.error(`[TWITCH CHAT] ERROR keepalive_timeout seconds=${timeoutSeconds}`);
      setStatus('通信停止を検出・再接続中');
      try { ws.close(); } catch { scheduleReconnect(); }
    }, (timeoutSeconds + 5) * 1000);
  };

  const rememberMessage = id => {
    const value = String(id || '').trim();
    if (!value) return true;
    if (seenMessageIds.has(value)) return false;
    seenMessageIds.add(value);
    if (seenMessageIds.size > 240) seenMessageIds.delete(seenMessageIds.values().next().value);
    return true;
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer || pendingReconnectSocket) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(retryAttempt, 5)));
    const jitter = Math.floor(Math.random() * 350);
    retryAttempt += 1;
    console.info(`[TWITCH CHAT] RECONNECT delayMs=${delay + jitter} attempt=${retryAttempt}`);
    setStatus('再接続中');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) openSocket(EVENTSUB_URL, { resume: false });
    }, delay + jitter);
  };

  const subscribe = async (ws, sessionId) => {
    const id = String(sessionId || '').trim();
    if (!id || subscribedSessions.has(id) || stopped) return;
    subscribedSessions.add(id);
    console.info('[TWITCH CHAT] SUBSCRIBE_START');
    setStatus('EventSub購読中');
    try {
      const response = await fetch('/api/twitch-eventsub', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id, broadcasterId })
      });
      const result = await response.json().catch(() => ({}));
      const twitchMessage = safeLogText(result?.twitchMessage || result?.message || result?.error || '');
      if (!response.ok) {
        subscribedSessions.delete(id);
        if (response.status === 401 || response.status === 403) saveProfile(null);
        console.error(`[TWITCH CHAT] ERROR subscribe status=${response.status} message=${twitchMessage || 'unknown'}`);
        setStatus(`購読失敗 (${response.status})${twitchMessage ? `: ${twitchMessage}` : ''}`);
        ws.__pdv2NoReconnect = response.status === 401 || response.status === 403;
        try { ws.close(); } catch {}
        return;
      }
      retryAttempt = 0;
      const subscriptionId = String(result?.subscription?.id || result?.subscriptionId || '');
      console.info(`[TWITCH CHAT] SUBSCRIBE_OK${subscriptionId ? ` subscriptionId=${subscriptionId}` : ''}`);
      setStatus(`コメント接続済み${result.login ? ` (@${result.login})` : ''}`);
    } catch (error) {
      subscribedSessions.delete(id);
      console.error(`[TWITCH CHAT] ERROR subscribe_fetch ${safeLogText(error?.message || error)}`);
      setStatus('購読通信エラー・再接続中');
      try { ws.close(); } catch { scheduleReconnect(); }
    }
  };

  const openSocket = (url, { resume = false, previous = null } = {}) => {
    if (stopped) return null;
    let ws;
    try {
      ws = new WebSocket(url || EVENTSUB_URL);
    } catch (error) {
      console.error(`[TWITCH CHAT] ERROR websocket_create ${safeLogText(error?.message || error)}`);
      scheduleReconnect();
      return null;
    }
    liveSockets.add(ws);
    if (resume) pendingReconnectSocket = ws;
    else socket = ws;

    ws.onopen = () => {
      console.info('[TWITCH CHAT] WS_OPEN');
      setStatus('WebSocket接続済み');
    };

    ws.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); }
      catch (error) {
        console.error(`[TWITCH CHAT] ERROR invalid_json ${safeLogText(error?.message || error)}`);
        return;
      }
      const type = data.metadata?.message_type;
      if (ws.__pdv2KeepaliveSeconds) armWatchdog(ws, ws.__pdv2KeepaliveSeconds);

      if (type === 'session_welcome') {
        const session = data.payload?.session || {};
        const sessionId = String(session.id || '');
        console.info(`[TWITCH CHAT] WELCOME sessionId=${sessionId}`);
        armWatchdog(ws, session.keepalive_timeout_seconds);
        if (resume) {
          pendingReconnectSocket = null;
          socket = ws;
          retryAttempt = 0;
          setStatus(receivedAnyComment ? 'コメント受信確認済み' : 'コメント接続済み');
          if (previous && previous !== ws) {
            previous.__pdv2IntentionalClose = true;
            clearWatchdog(previous);
            try { previous.close(1000, 'eventsub reconnect'); } catch {}
          }
        } else {
          subscribe(ws, sessionId);
        }
        return;
      }

      if (type === 'session_keepalive') {
        console.info('[TWITCH CHAT] KEEPALIVE');
        return;
      }

      if (type === 'notification' && data.metadata?.subscription_type === 'channel.chat.message') {
        const item = data.payload?.event || {};
        const messageId = String(item.message_id || data.metadata?.message_id || crypto.randomUUID());
        if (!rememberMessage(messageId)) return;
        const user = String(item.chatter_user_name || item.chatter_user_login || '');
        console.info(`[TWITCH CHAT] COMMENT id=${messageId} user=${safeLogText(user, 80)}`);
        onMessage?.({ id: messageId, name: user, text: item.message?.text || '' });
        if (!receivedAnyComment) {
          receivedAnyComment = true;
          setStatus('コメント受信確認済み');
        }
        return;
      }

      if (type === 'session_reconnect') {
        const reconnectUrl = String(data.payload?.session?.reconnect_url || '');
        console.info('[TWITCH CHAT] RECONNECT');
        setStatus('再接続中');
        if (reconnectUrl && !pendingReconnectSocket) {
          openSocket(reconnectUrl, { resume: true, previous: ws });
        } else if (!reconnectUrl) {
          console.error('[TWITCH CHAT] ERROR reconnect_url_missing');
          try { ws.close(); } catch { scheduleReconnect(); }
        }
        return;
      }

      if (type === 'revocation') {
        const reason = safeLogText(data.payload?.subscription?.status || 'revoked');
        console.error(`[TWITCH CHAT] ERROR revocation ${reason}`);
        setStatus(`コメント権限が失効しました (${reason})`);
        ws.__pdv2NoReconnect = true;
      }
    };

    ws.onerror = () => {
      console.error('[TWITCH CHAT] ERROR websocket');
      setStatus('コメント接続エラー・再接続待ち');
    };

    ws.onclose = event => {
      clearWatchdog(ws);
      liveSockets.delete(ws);
      const reason = safeLogText(event.reason || '');
      console.info(`[TWITCH CHAT] WS_CLOSE code=${event.code} reason=${reason}`);
      if (stopped || ws.__pdv2IntentionalClose || ws.__pdv2NoReconnect) return;
      if (ws === pendingReconnectSocket) pendingReconnectSocket = null;
      if (pendingReconnectSocket && ws !== pendingReconnectSocket) return;
      if (socket === ws) socket = null;
      scheduleReconnect();
    };

    return ws;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(retryTimer);
    retryTimer = null;
    pendingReconnectSocket = null;
    for (const ws of liveSockets) {
      ws.__pdv2IntentionalClose = true;
      clearWatchdog(ws);
      try { ws.close(1000, 'user stop'); } catch {}
    }
    liveSockets.clear();
    if (activeStop === stop) activeStop = null;
    socket = null;
  };

  activeStop = stop;
  openSocket(EVENTSUB_URL, { resume: false });
  return stop;
}
