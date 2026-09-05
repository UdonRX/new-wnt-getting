import {
  clearTwitchAuthCookies,
  createTwitchState,
  exchangeTwitchAuthorizationCode,
  getValidTwitchUserToken,
  setTwitchAuthCookies,
  twitchConfig,
  twitchUserProfile,
  verifyTwitchState
} from './twitch-auth.mjs';

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); }
    catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const mode = String(first(req.query?.mode) || '').trim().toLowerCase();

  try {
    if (mode === 'start') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
      const { clientId, redirectUri } = twitchConfig();
      const state = createTwitchState();
      const url = new URL('https://id.twitch.tv/oauth2/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'user:read:chat');
      url.searchParams.set('state', state);
      return res.status(200).json({ ok: true, authorizeUrl: url.href, redirectUri });
    }

    if (mode === 'exchange') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const body = jsonBody(req);
      const code = String(body.code || '').trim();
      const state = String(body.state || '').trim();
      if (!code || !state) return res.status(400).json({ error: 'code / state が必要です' });
      if (!verifyTwitchState(state)) return res.status(400).json({ error: 'Twitch認証stateが無効または期限切れです' });
      const { tokens, validation } = await exchangeTwitchAuthorizationCode(code);
      setTwitchAuthCookies(res, tokens);
      const user = await twitchUserProfile(tokens.access_token, validation);
      return res.status(200).json({ ok: true, connected: true, user });
    }

    if (mode === 'status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
      const auth = await getValidTwitchUserToken(req, res);
      if (!auth) return res.status(200).json({ ok: true, connected: false, user: null });
      const brief = String(first(req.query?.brief) || '') === '1';
      const user = brief ? {
        id: String(auth.validation?.user_id || ''),
        login: String(auth.validation?.login || ''),
        displayName: String(auth.validation?.login || ''),
        profileImageUrl: ''
      } : await twitchUserProfile(auth.accessToken, auth.validation);
      return res.status(200).json({ ok: true, connected: true, user });
    }

    if (mode === 'disconnect') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      clearTwitchAuthCookies(res);
      return res.status(200).json({ ok: true, connected: false });
    }

    if (mode === 'config') {
      const { clientId, redirectUri } = twitchConfig();
      return res.status(200).json({ ok: true, twitchClientId: clientId, redirectUri });
    }

    return res.status(400).json({ error: 'Unknown Twitch OAuth mode' });
  } catch (error) {
    console.error('[twitch-oauth]', { mode, name: error?.name, message: error?.message || String(error) });
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Twitch OAuthエラー' });
  }
}
