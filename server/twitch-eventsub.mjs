import { getValidTwitchUserToken, twitchConfig } from './twitch-auth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const sessionId = String(body.sessionId || '').trim();
  const broadcasterId = String(body.broadcasterId || '').trim();
  if (!sessionId || !broadcasterId) return res.status(400).json({ error: 'sessionId / broadcasterId が必要です' });

  try {
    const auth = await getValidTwitchUserToken(req, res);
    if (!auth) return res.status(401).json({ error: 'Twitch再連携が必要です' });
    const { clientId } = twitchConfig();
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
          user_id: auth.validation.user_id
        },
        transport: { method: 'websocket', session_id: sessionId }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data?.message || 'EventSub購読に失敗しました' });
    return res.status(200).json({
      ok: true,
      userId: auth.validation.user_id,
      login: auth.validation.login || '',
      subscription: data.data?.[0] || null
    });
  } catch (error) {
    console.error('[twitch-eventsub]', error);
    return res.status(500).json({ error: error?.message || 'EventSub接続エラー' });
  }
}
