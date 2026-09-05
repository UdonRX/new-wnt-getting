import { getValidTwitchUserToken, twitchConfig } from './twitch-auth.mjs';

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); }
    catch { return {}; }
  }
  return req.body || {};
}

function safeMessage(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const body = jsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const broadcasterId = String(body.broadcasterId || '').trim();
  console.info('[TWITCH EVENTSUB] REQUEST', {
    broadcasterId: broadcasterId || '(missing)',
    sessionIdPrefix: sessionId ? sessionId.slice(0, 12) : '(missing)'
  });
  if (!sessionId || !broadcasterId) {
    console.error('[TWITCH EVENTSUB] ERROR missing sessionId/broadcasterId');
    return res.status(400).json({ error: 'sessionId / broadcasterId が必要です', status: 400 });
  }

  try {
    const auth = await getValidTwitchUserToken(req, res);
    if (!auth) {
      console.error('[TWITCH EVENTSUB] ERROR auth_required');
      return res.status(401).json({ error: 'Twitch再連携が必要です', status: 401, twitchMessage: 'OAuth user token is missing, expired, or lacks user:read:chat' });
    }
    const userId = String(auth.validation?.user_id || '');
    console.info('[TWITCH EVENTSUB] AUTH_OK', { userId, login: String(auth.validation?.login || '') });
    const { clientId } = twitchConfig();
    console.info('[TWITCH EVENTSUB] SUBSCRIBE_START', { broadcasterId, userId });
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId,
          user_id: userId
        },
        transport: { method: 'websocket', session_id: sessionId }
      }),
      signal: AbortSignal.timeout(9000)
    });
    const data = await response.json().catch(() => ({}));
    const twitchMessage = safeMessage(data?.message || data?.error || '');
    console.info(`[TWITCH EVENTSUB] SUBSCRIBE_RESPONSE status=${response.status}`, twitchMessage ? { message: twitchMessage } : {});
    if (!response.ok) {
      console.error(`[TWITCH EVENTSUB] ERROR subscribe status=${response.status} message=${twitchMessage || 'unknown'}`);
      return res.status(response.status).json({
        error: 'EventSub購読に失敗しました',
        status: response.status,
        twitchMessage: twitchMessage || 'Twitch returned an error without a message'
      });
    }
    const subscription = data.data?.[0] || null;
    const subscriptionId = String(subscription?.id || '');
    console.info(`[TWITCH EVENTSUB] SUBSCRIBE_OK subscriptionId=${subscriptionId || '(unknown)'}`);
    return res.status(200).json({
      ok: true,
      status: 200,
      userId,
      login: auth.validation?.login || '',
      subscriptionId,
      subscription
    });
  } catch (error) {
    const message = safeMessage(error?.message || error || 'EventSub接続エラー');
    console.error(`[TWITCH EVENTSUB] ERROR ${error?.name || 'Error'} ${message}`);
    return res.status(error?.statusCode || 500).json({ error: 'EventSub接続エラー', status: error?.statusCode || 500, twitchMessage: message });
  }
}
