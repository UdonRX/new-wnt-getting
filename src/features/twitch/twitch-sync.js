const TWITCH_PLAYER_SDK = 'https://player.twitch.tv/js/embed/v1.js';
const EVENTSUB_HOST = 'eventsub.wss.twitch.tv';
const MAX_SYNC_DELAY_MS = 20000;
const NativeWebSocket = window.WebSocket;

let sdkPromise = null;
let activePlayer = null;
let activePlayerHost = null;
let statsTimer = null;
let videoLatencyMs = null;
let bufferMs = null;
let lastPlayerLogAt = 0;
let lastPlayerLogLatency = null;
let lastSync = {
  eventSubMs: null,
  syncWaitMs: null,
  renderQueueMs: null,
  actualWaitMs: null
};
const latencySamples = [];
const pendingRender = [];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatMs(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}秒` : '--';
}

function parseTwitchTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  return Date.parse(raw.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:\d{2})$/i, '$1$2'));
}

function median(values) {
  const list = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : null;
}

function diagnosticNodes() {
  return [...document.querySelectorAll('.twitch-inline-player .twitch-sync-runtime')];
}

function ensureDiagnostic(panel = document.querySelector('.twitch-inline-player')) {
  if (!panel) return null;
  let node = panel.querySelector('.twitch-sync-runtime');
  if (node) return node;
  const info = panel.querySelector('.twitch-inline-info');
  if (!info) return null;
  node = document.createElement('div');
  node.className = 'source-note twitch-sync-runtime';
  node.style.marginTop = '5px';
  node.style.opacity = '.78';
  info.append(node);
  return node;
}

function refreshDiagnostic() {
  const text = Number.isFinite(videoLatencyMs)
    ? `同期診断: 動画 ${formatMs(videoLatencyMs)} / EventSub ${formatMs(lastSync.eventSubMs)} / 自動待機 ${formatMs(lastSync.syncWaitMs)} / 表示待ち ${formatMs(lastSync.renderQueueMs)}`
    : '同期診断: 動画遅延を測定中…';
  const nodes = diagnosticNodes();
  if (!nodes.length) {
    const node = ensureDiagnostic();
    if (node) node.textContent = text;
    return;
  }
  nodes.forEach(node => { node.textContent = text; });
}

function loadSdk() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TWITCH_PLAYER_SDK}"]`);
    const finish = () => window.Twitch?.Player ? resolve(window.Twitch) : reject(new Error('Twitch Player SDK unavailable'));
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => reject(new Error('Twitch Player SDK load error')), { once: true });
      setTimeout(finish, 2500);
      return;
    }
    const script = document.createElement('script');
    script.src = TWITCH_PLAYER_SDK;
    script.async = true;
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error('Twitch Player SDK load error')), { once: true });
    document.head.append(script);
  }).catch(error => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

function stopStats({ pause = false } = {}) {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (pause) {
    try { activePlayer?.pause?.(); } catch {}
  }
  activePlayer = null;
  activePlayerHost = null;
  videoLatencyMs = null;
  bufferMs = null;
  latencySamples.length = 0;
  refreshDiagnostic();
}

function parseIframeSource(iframe) {
  try {
    const url = new URL(iframe.src, location.href);
    const channel = String(url.searchParams.get('channel') || '').trim();
    const video = String(url.searchParams.get('video') || '').trim();
    if (!channel && !video) return null;
    return { channel, video };
  } catch {
    return null;
  }
}

function pollStats(player, host, live) {
  if (activePlayer !== player || activePlayerHost !== host || !host.isConnected) {
    if (activePlayerHost === host) stopStats();
    return;
  }
  try {
    const stats = player.getPlaybackStats?.() || {};
    const latency = finite(stats.hlsLatencyBroadcaster);
    const buffer = finite(stats.bufferSize);
    if (live && latency != null && latency >= 0) {
      latencySamples.push(latency * 1000);
      if (latencySamples.length > 5) latencySamples.shift();
      videoLatencyMs = median(latencySamples);
    }
    bufferMs = buffer != null && buffer >= 0 ? buffer * 1000 : null;
    refreshDiagnostic();
    if (Number.isFinite(videoLatencyMs) && (lastPlayerLogLatency == null || Math.abs(videoLatencyMs - lastPlayerLogLatency) >= 250 || Date.now() - lastPlayerLogAt > 10000)) {
      lastPlayerLogLatency = videoLatencyMs;
      lastPlayerLogAt = Date.now();
      console.info(`[TWITCH SYNC] PLAYER videoLatencyMs=${Math.round(videoLatencyMs)} bufferMs=${Number.isFinite(bufferMs) ? Math.round(bufferMs) : 'na'}`);
    }
  } catch (error) {
    console.warn('[TWITCH SYNC] PLAYER_STATS_ERROR', error?.message || error);
  }
}

async function upgradeIframe(iframe) {
  const host = iframe.closest('.twitch-embed-min');
  if (!host || host.dataset.pdv2SyncPlayer === '1') return;
  const source = parseIframeSource(iframe);
  if (!source) return;
  host.dataset.pdv2SyncPlayer = 'pending';
  try {
    const Twitch = await loadSdk();
    if (!iframe.isConnected || !host.isConnected) return;
    host.dataset.pdv2SyncPlayer = '1';
    stopStats({ pause: true });
    const mount = document.createElement('div');
    mount.id = `pdv2-sync-player-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    Object.assign(mount.style, { width: '100%', height: '100%' });
    host.replaceChildren(mount);
    const options = { width: '100%', height: '100%', autoplay: false, muted: false, parent: [location.hostname] };
    if (source.channel) options.channel = source.channel;
    else options.video = source.video.startsWith('v') ? source.video : `v${source.video}`;
    const player = new Twitch.Player(mount.id, options);
    activePlayer = player;
    activePlayerHost = host;
    latencySamples.length = 0;
    videoLatencyMs = null;
    bufferMs = null;
    const live = Boolean(source.channel);
    const poll = () => pollStats(player, host, live);
    try { player.addEventListener?.(Twitch.Player.READY, poll); } catch {}
    try { player.addEventListener?.(Twitch.Player.PLAYING, poll); } catch {}
    setTimeout(poll, 1200);
    statsTimer = setInterval(poll, 2000);
    console.info(`[TWITCH SYNC] PLAYER_UPGRADED live=${live}`);
  } catch (error) {
    host.dataset.pdv2SyncPlayer = 'fallback';
    console.warn('[TWITCH SYNC] SDK_FALLBACK', error?.message || error);
    refreshDiagnostic();
  }
}

function scanPlayers(root = document) {
  if (root instanceof Element && root.matches('.twitch-embed-min iframe')) upgradeIframe(root);
  root.querySelectorAll?.('.twitch-embed-min iframe').forEach(upgradeIframe);
  if (root instanceof Element) ensureDiagnostic(root.closest('.twitch-inline-player') || (root.matches('.twitch-inline-player') ? root : null));
}

function commentInfo(data) {
  if (data?.metadata?.message_type !== 'notification' || data?.metadata?.subscription_type !== 'channel.chat.message') return null;
  const event = data?.payload?.event || {};
  const id = String(event.message_id || data?.metadata?.message_id || '');
  const text = String(event.message?.text || '').replace(/[\r\n]+/g, ' ').trim();
  const sentAt = String(data?.metadata?.message_timestamp || '');
  const sentEpoch = parseTwitchTimestamp(sentAt);
  const receivedEpoch = Date.now();
  const rawEventSub = Number.isFinite(sentEpoch) ? receivedEpoch - sentEpoch : NaN;
  const eventSubMs = Number.isFinite(rawEventSub) ? clamp(rawEventSub, 0, 30000) : null;
  const syncWaitMs = Number.isFinite(videoLatencyMs)
    ? clamp(videoLatencyMs - (Number.isFinite(eventSubMs) ? eventSubMs : 0), 0, MAX_SYNC_DELAY_MS)
    : 0;
  return { id, text, sentAt, eventSubMs, syncWaitMs, receivedPerf: performance.now(), receivedEpoch };
}

function deliverSynced(socket, handler, event, info) {
  const run = () => {
    if (socket.readyState === NativeWebSocket.CLOSED || socket.readyState === NativeWebSocket.CLOSING) return;
    const deliveredPerf = performance.now();
    const actualWaitMs = Math.max(0, deliveredPerf - info.receivedPerf);
    const record = { ...info, deliveredPerf, actualWaitMs };
    pendingRender.push(record);
    if (pendingRender.length > 120) pendingRender.splice(0, pendingRender.length - 120);
    lastSync = { ...lastSync, eventSubMs: info.eventSubMs, syncWaitMs: info.syncWaitMs, actualWaitMs };
    refreshDiagnostic();
    console.info(`[TWITCH SYNC] DELIVER id=${info.id} videoMs=${Number.isFinite(videoLatencyMs) ? Math.round(videoLatencyMs) : 'na'} eventSubMs=${Number.isFinite(info.eventSubMs) ? Math.round(info.eventSubMs) : 'na'} targetWaitMs=${Math.round(info.syncWaitMs)} actualWaitMs=${Math.round(actualWaitMs)}`);
    handler.call(socket, event);
  };
  if (info.syncWaitMs > 8) return setTimeout(run, info.syncWaitMs);
  run();
  return null;
}

class SyncedWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    if (protocols === undefined) super(url);
    else super(url, protocols);
    this.__pdv2MessageHandler = null;
    this.__pdv2SyncTimers = new Set();
    let isEventSub = false;
    try { isEventSub = new URL(String(url)).hostname === EVENTSUB_HOST; } catch {}
    NativeWebSocket.prototype.addEventListener.call(this, 'message', event => {
      const handler = this.__pdv2MessageHandler;
      if (typeof handler !== 'function') return;
      if (!isEventSub) {
        handler.call(this, event);
        return;
      }
      let data;
      try { data = JSON.parse(event.data); } catch {
        handler.call(this, event);
        return;
      }
      const info = commentInfo(data);
      if (!info) {
        handler.call(this, event);
        return;
      }
      console.info(`[TWITCH SYNC] EVENTSUB id=${info.id} eventSubMs=${Number.isFinite(info.eventSubMs) ? Math.round(info.eventSubMs) : 'na'} videoMs=${Number.isFinite(videoLatencyMs) ? Math.round(videoLatencyMs) : 'na'} syncWaitMs=${Math.round(info.syncWaitMs)}`);
      const timer = deliverSynced(this, handler, event, info);
      if (timer) {
        this.__pdv2SyncTimers.add(timer);
        setTimeout(() => this.__pdv2SyncTimers.delete(timer), info.syncWaitMs + 1000);
      }
    });
    NativeWebSocket.prototype.addEventListener.call(this, 'close', () => {
      for (const timer of this.__pdv2SyncTimers) clearTimeout(timer);
      this.__pdv2SyncTimers.clear();
    });
  }
  set onmessage(handler) { this.__pdv2MessageHandler = typeof handler === 'function' ? handler : null; }
  get onmessage() { return this.__pdv2MessageHandler; }
}

try {
  Object.defineProperty(SyncedWebSocket, 'name', { value: 'WebSocket' });
  window.WebSocket = SyncedWebSocket;
  console.info('[TWITCH SYNC] EVENTSUB_DELAY_HOOK_READY');
} catch (error) {
  console.error('[TWITCH SYNC] EVENTSUB_DELAY_HOOK_ERROR', error?.message || error);
}

function matchPendingRender(node) {
  if (!pendingRender.length) return null;
  const text = String(node.textContent || '').trim();
  let index = -1;
  if (text) index = pendingRender.findIndex((row, i) => i < 12 && row.text === text);
  if (index < 0) index = 0;
  return pendingRender.splice(index, 1)[0] || null;
}

function observeCommentNode(node) {
  if (!(node instanceof Element) || !node.matches('.twitch-nico-comment')) return;
  const row = matchPendingRender(node);
  if (!row) return;
  const renderQueueMs = Math.max(0, performance.now() - row.deliveredPerf);
  lastSync = { ...lastSync, eventSubMs: row.eventSubMs, syncWaitMs: row.syncWaitMs, actualWaitMs: row.actualWaitMs, renderQueueMs };
  refreshDiagnostic();
  console.info(`[TWITCH SYNC] RENDER id=${row.id} renderQueueMs=${Math.round(renderQueueMs)} totalClientWaitMs=${Math.round(row.actualWaitMs + renderQueueMs)}`);
}

const observer = new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      scanPlayers(node);
      observeCommentNode(node);
      node.querySelectorAll?.('.twitch-nico-comment').forEach(observeCommentNode);
    }
  }
  if (activePlayerHost && !activePlayerHost.isConnected) stopStats();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
scanPlayers(document);
loadSdk().then(() => console.info('[TWITCH SYNC] PLAYER_SDK_READY')).catch(error => console.warn('[TWITCH SYNC] PLAYER_SDK_PRELOAD_ERROR', error?.message || error));
