import crypto from 'node:crypto';

const ACCESS_COOKIE = 'pdv2_twitch_access';
const REFRESH_COOKIE = 'pdv2_twitch_refresh';
const DEFAULT_REDIRECT_URI = 'https://new-wnt-getting.vercel.app/';
const STATE_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
const VALIDATION_CACHE_MAX_MS = 60 * 1000;
const validationCache = new Map();

function clean(value) {
  return String(value || '').trim();
}

function parseCookies(req) {
  const raw = String(req.headers?.cookie || '');
  const out = {};
  raw.split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  });
  return out;
}

function cookie(name, value, maxAge) {
  const encoded = encodeURIComponent(String(value || ''));
  return `${name}=${encoded}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge || 0))}; HttpOnly; Secure; SameSite=Lax`;
}

function appendCookies(res, values) {
  const current = res.getHeader?.('Set-Cookie');
  const existing = Array.isArray(current) ? current : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...existing, ...values]);
}

export function twitchConfig() {
  const clientId = clean(process.env.TWITCH_CLIENT_ID);
  const clientSecret = clean(process.env.TWITCH_CLIENT_SECRET);
  const redirectUri = clean(process.env.TWITCH_REDIRECT_URI) || DEFAULT_REDIRECT_URI;
  if (!clientId) throw Object.assign(new Error('TWITCH_CLIENT_ID が未設定です'), { statusCode: 500 });
  if (!clientSecret) throw Object.assign(new Error('TWITCH_CLIENT_SECRET が未設定です'), { statusCode: 500 });
  if (!/^https:\/\//i.test(redirectUri)) throw Object.assign(new Error('TWITCH_REDIRECT_URI はHTTPS URLで指定してください'), { statusCode: 500 });
  return { clientId, clientSecret, redirectUri };
}

function stateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function validationCacheKey(accessToken) {
  return crypto.createHash('sha256').update(accessToken).digest('base64url');
}

function readValidationCache(accessToken) {
  const key = validationCacheKey(accessToken);
  const row = validationCache.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (row) validationCache.delete(key);
    return null;
  }
  return row.validation;
}

function writeValidationCache(accessToken, validation) {
  const expiresInMs = Math.max(5000, Number(validation?.expires_in || 60) * 1000);
  const expiresAt = Date.now() + Math.min(VALIDATION_CACHE_MAX_MS, expiresInMs);
  validationCache.set(validationCacheKey(accessToken), { expiresAt, validation });
  while (validationCache.size > 40) validationCache.delete(validationCache.keys().next().value);
  return validation;
}

export function createTwitchState() {
  const { clientSecret } = twitchConfig();
  const payload = `${Date.now()}.${crypto.randomBytes(18).toString('base64url')}`;
  return `${payload}.${stateSignature(payload, clientSecret)}`;
}

export function verifyTwitchState(state) {
  const { clientSecret } = twitchConfig();
  const raw = clean(state);
  const pieces = raw.split('.');
  if (pieces.length !== 3) return false;
  const payload = `${pieces[0]}.${pieces[1]}`;
  const expected = stateSignature(payload, clientSecret);
  const actual = pieces[2];
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  const createdAt = Number(pieces[0]);
  return Number.isFinite(createdAt) && createdAt > 0 && Math.abs(Date.now() - createdAt) <= STATE_MAX_AGE_MS;
}

export function setTwitchAuthCookies(res, tokens) {
  const access = clean(tokens?.access_token);
  const refresh = clean(tokens?.refresh_token);
  const expiresIn = Math.max(60, Number(tokens?.expires_in || 3600));
  const values = [];
  if (access) values.push(cookie(ACCESS_COOKIE, access, expiresIn));
  if (refresh) values.push(cookie(REFRESH_COOKIE, refresh, REFRESH_COOKIE_MAX_AGE));
  if (values.length) appendCookies(res, values);
}

export function clearTwitchAuthCookies(res) {
  appendCookies(res, [cookie(ACCESS_COOKIE, '', 0), cookie(REFRESH_COOKIE, '', 0)]);
}

export async function validateTwitchAccessToken(accessToken) {
  const token = clean(accessToken);
  if (!token) return null;
  const cached = readValidationCache(token);
  if (cached) return cached;
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.user_id) return null;
  return writeValidationCache(token, data);
}

async function refreshTwitchToken(refreshToken) {
  const { clientId, clientSecret } = twitchConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: clean(refreshToken),
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) return null;
  return data;
}

function ensureAuthorized(validation) {
  const { clientId } = twitchConfig();
  if (!validation || validation.client_id !== clientId) return false;
  const scopes = new Set(Array.isArray(validation.scopes) ? validation.scopes : []);
  return scopes.has('user:read:chat');
}

export async function getValidTwitchUserToken(req, res) {
  const cookies = parseCookies(req);
  let accessToken = clean(cookies[ACCESS_COOKIE]);
  let refreshToken = clean(cookies[REFRESH_COOKIE]);
  let validation = accessToken ? await validateTwitchAccessToken(accessToken) : null;

  if (validation && ensureAuthorized(validation)) {
    return { accessToken, refreshToken, validation };
  }

  if (refreshToken) {
    const refreshed = await refreshTwitchToken(refreshToken);
    if (refreshed?.access_token) {
      accessToken = clean(refreshed.access_token);
      refreshToken = clean(refreshed.refresh_token) || refreshToken;
      validation = await validateTwitchAccessToken(accessToken);
      if (validation && ensureAuthorized(validation)) {
        setTwitchAuthCookies(res, { ...refreshed, refresh_token: refreshToken });
        return { accessToken, refreshToken, validation };
      }
    }
  }

  clearTwitchAuthCookies(res);
  return null;
}

export async function exchangeTwitchAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = twitchConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: clean(code),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw Object.assign(new Error(data?.message || 'Twitch認証コードを交換できませんでした'), { statusCode: response.status || 502 });
  }
  const validation = await validateTwitchAccessToken(data.access_token);
  if (!ensureAuthorized(validation)) {
    throw Object.assign(new Error('Twitch認証に user:read:chat 権限がありません'), { statusCode: 403 });
  }
  return { tokens: data, validation };
}

export async function twitchUserProfile(accessToken, validation = null) {
  const { clientId } = twitchConfig();
  const vd = validation || await validateTwitchAccessToken(accessToken);
  if (!vd?.user_id) return null;
  try {
    const response = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(vd.user_id)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    const user = data?.data?.[0];
    if (response.ok && user) {
      return {
        id: String(user.id || vd.user_id),
        login: String(user.login || vd.login || ''),
        displayName: String(user.display_name || user.login || vd.login || ''),
        profileImageUrl: String(user.profile_image_url || '')
      };
    }
  } catch {}
  return {
    id: String(vd.user_id || ''),
    login: String(vd.login || ''),
    displayName: String(vd.login || ''),
    profileImageUrl: ''
  };
}
