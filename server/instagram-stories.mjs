const WEB_APP_ID = '936619743392459';
const DEFAULT_ASBD_ID = '198387';
const MAX_ACCOUNTS = 12;
const EMBED_CONCURRENCY = 3;
const PROFILE_CACHE_MS = 60_000;
const STORY_CACHE_MS = 45_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

const state = globalThis.__PDV2_INSTAGRAM_STORY_STATE__ || (globalThis.__PDV2_INSTAGRAM_STORY_STATE__ = {
  profileCache: new Map(),
  storyCache: new Map(),
  inflight: new Map(),
  rate: new Map()
});

function headerValue(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function firstForwarded(value) {
  return headerValue(value).split(',')[0].trim();
}

function normalizeUsername(raw) {
  let username = String(raw || '').trim();
  if (username.startsWith('@')) username = username.slice(1);
  if (!USERNAME_RE.test(username)) throw new Error(`無効なInstagramユーザー名: ${raw}`);
  return username.toLowerCase();
}

function safeDiagnosticUsername(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 30);
}

function diagnosticLog(event, data = {}) {
  console.log('[instagram-stories][diag]', event, data);
}

function diagnosticErrorMessage(error) {
  const message = String(error?.message || '');
  if (!message) return null;
  return message
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[redacted-url]')
    .replace(/(?:cookie|authorization|x-csrftoken|x-ig-app-id|x-asbd-id)\s*[:=]\s*[^\s,;]+/gi, '[redacted-header]')
    .slice(0, 300);
}

function storyApiErrorCategory(status) {
  if (status === 401) return 'authentication';
  if (status === 403) return 'forbidden_or_instagram_block';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'client_error';
  if (typeof status === 'number' && status >= 500) return 'instagram_server_error';
  return 'unknown';
}

function storyApiResultName(status) {
  if (status === 401) return 'story_api_401';
  if (status === 403) return 'story_api_403';
  if (status === 429) return 'story_api_429';
  return 'story_api_error';
}

function parseBody(req) {
  const body = req?.body;
  if (!body) return {};
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return {};
}

function parseUsernames(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const unique = [];
  for (const value of values) {
    if (!String(value || '').trim()) continue;
    const username = normalizeUsername(value);
    if (!unique.includes(username)) unique.push(username);
  }
  if (!unique.length) throw new Error('usernames が必要です。');
  if (unique.length > MAX_ACCOUNTS) throw new Error(`1回最大${MAX_ACCOUNTS}アカウントです。`);
  return unique;
}

function authConfig() {
  const sessionid = String(process.env.INSTAGRAM_SESSIONID || '').trim();
  const csrftoken = String(process.env.INSTAGRAM_CSRFTOKEN || '').trim();
  const dsUserId = String(process.env.INSTAGRAM_DS_USER_ID || '').trim();
  const rur = String(process.env.INSTAGRAM_RUR || '').trim();
  const cookies = [];
  if (sessionid) cookies.push(`sessionid=${sessionid}`);
  if (csrftoken) cookies.push(`csrftoken=${csrftoken}`);
  if (dsUserId) cookies.push(`ds_user_id=${dsUserId}`);
  if (rur) cookies.push(`rur=${rur}`);
  return { sessionid, csrftoken, dsUserId, cookie: cookies.join('; ') };
}

function storyHeaders(auth) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
    'User-Agent': UA,
    'X-IG-App-ID': WEB_APP_ID,
    'X-ASBD-ID': String(process.env.INSTAGRAM_ASBD_ID || DEFAULT_ASBD_ID),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.instagram.com/',
    Cookie: auth.cookie
  };
  if (auth.csrftoken) headers['X-CSRFToken'] = auth.csrftoken;
  return headers;
}

function expectedHost(req) {
  return firstForwarded(req?.headers?.['x-forwarded-host'] || req?.headers?.host).toLowerCase();
}

function sameOriginAllowed(req) {
  const host = expectedHost(req);
  if (!host) return false;

  const fetchSite = headerValue(req?.headers?.['sec-fetch-site']).toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site') return false;

  const candidates = [headerValue(req?.headers?.origin), headerValue(req?.headers?.referer)].filter(Boolean);
  for (const value of candidates) {
    try {
      if (new URL(value).host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }

  const clientMarker = headerValue(req?.headers?.['x-instagram-story-client']);
  if (clientMarker !== '1') return false;
  return Boolean(fetchSite || candidates.length);
}

function clientKey(req) {
  return firstForwarded(req?.headers?.['x-forwarded-for']) ||
    firstForwarded(req?.headers?.['x-real-ip']) ||
    expectedHost(req) ||
    'unknown';
}

function allowRate(req) {
  const now = Date.now();
  const key = clientKey(req);
  const recent = (state.rate.get(key) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    state.rate.set(key, recent);
    return false;
  }
  recent.push(now);
  state.rate.set(key, recent);
  if (state.rate.size > 200) {
    for (const [entryKey, timestamps] of state.rate) {
      if (!timestamps.some(ts => now - ts < RATE_WINDOW_MS)) state.rate.delete(entryKey);
    }
  }
  return true;
}

function cacheGet(map, key, maxAge) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.at || 0) > maxAge) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
  if (map.size > 160) {
    const oldest = [...map.entries()].sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0)).slice(0, map.size - 120);
    oldest.forEach(([oldKey]) => map.delete(oldKey));
  }
  return value;
}

function decodeLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function decodedVariants(html) {
  const out = [];
  let current = String(html || '');
  for (let level = 0; level < 5; level += 1) {
    if (!out.includes(current)) out.push(current);
    current = decodeLayer(current);
  }
  return out;
}

function extractBalancedObject(text, startIndex) {
  let depth = 0;
  let quote = '';
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { inString = false; quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function profileFromObject(object, username) {
  const id = object?.id ?? object?.pk ?? object?.pk_id;
  const objectUsername = String(object?.username ?? object?.user_name ?? '').toLowerCase();
  if (objectUsername !== username || !/^\d{5,30}$/.test(String(id || ''))) return null;
  return {
    id: String(id),
    username,
    fullName: object?.full_name || object?.fullName || null,
    profilePicUrl: object?.profile_pic_url_hd || object?.profile_pic_url || object?.profilePicUrl || null,
    isVerified: typeof object?.is_verified === 'boolean' ? object.is_verified : null,
    isPrivate: typeof object?.is_private === 'boolean' ? object.is_private : null
  };
}

function extractProfile(html, username) {
  const matches = [];
  for (const input of decodedVariants(html)) {
    const marker = /["'](?:owner|user|profile_user|profileUser)["']\s*:\s*\{/gi;
    let match;
    while ((match = marker.exec(input))) {
      const start = input.indexOf('{', match.index);
      const raw = start >= 0 ? extractBalancedObject(input, start) : null;
      if (!raw) continue;
      try {
        const profile = profileFromObject(JSON.parse(raw), username);
        if (profile) matches.push(profile);
      } catch {
        const userMatch = raw.match(/["'](?:username|user_name)["']\s*:\s*["']([^"']+)["']/i);
        const idMatch = raw.match(/["'](?:id|pk|pk_id)["']\s*:\s*["']?(\d{5,30})["']?/i);
        if (userMatch?.[1]?.toLowerCase() !== username || !idMatch?.[1]) continue;
        const picMatch = raw.match(/["'](?:profile_pic_url_hd|profile_pic_url|profilePicUrl)["']\s*:\s*["']([^"']+)["']/i);
        matches.push({
          id: idMatch[1],
          username,
          fullName: null,
          profilePicUrl: picMatch?.[1] ? decodeLayer(picMatch[1]) : null,
          isVerified: null,
          isPrivate: null
        });
      }
    }
  }

  const grouped = new Map();
  for (const item of matches) {
    const current = grouped.get(item.id);
    if (!current) grouped.set(item.id, item);
    else if (!current.profilePicUrl && item.profilePicUrl) current.profilePicUrl = item.profilePicUrl;
  }
  return [...grouped.values()][0] || null;
}

async function fetchEmbedProfile(username) {
  const cached = cacheGet(state.profileCache, username, PROFILE_CACHE_MS);
  if (cached) return cached;

  const url = `https://www.instagram.com/${encodeURIComponent(username)}/embed/`;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(10_000)
    });
    const html = await response.text();
    const profile = response.ok ? extractProfile(html, username) : null;
    diagnosticLog('embed_request', {
      username: safeDiagnosticUsername(username),
      status: response.status,
      ok: response.ok,
      html_length: html.length
    });
    diagnosticLog('user_id_extraction', {
      username: safeDiagnosticUsername(username),
      extracted: Boolean(profile?.id)
    });
    return cacheSet(state.profileCache, username, {
      username,
      profile,
      status: response.status,
      error: response.ok && !profile ? 'Embed HTMLからuser IDを抽出できませんでした。' : (!response.ok ? `Embed HTTP ${response.status}` : null)
    });
  } catch (error) {
    diagnosticLog('embed_exception', {
      username: safeDiagnosticUsername(username),
      category: 'network_or_fetch_exception',
      error_name: String(error?.name || 'Error').slice(0, 100),
      error_message: diagnosticErrorMessage(error)
    });
    return { username, profile: null, status: 'ERROR', error: error?.message || String(error) };
  }
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, runWorker));
  return results;
}

function bestImage(item) {
  const candidates = [
    ...(item?.image_versions2?.candidates || []),
    ...(item?.image_versions?.candidates || [])
  ].filter(entry => entry?.url);
  candidates.sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)));
  return candidates[0]?.url || null;
}

function bestVideo(item) {
  const candidates = [...(item?.video_versions || [])].filter(entry => entry?.url);
  candidates.sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)));
  return candidates[0]?.url || null;
}

function unixToIso(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
}

function mapStory(item, index) {
  const imageUrl = bestImage(item);
  const videoUrl = bestVideo(item);
  return {
    index,
    id: String(item?.pk ?? item?.id ?? ''),
    code: item?.code || null,
    type: Number(item?.media_type) === 2 || videoUrl ? 'video' : imageUrl ? 'image' : 'unknown',
    takenAt: unixToIso(item?.taken_at),
    expiringAt: unixToIso(item?.expiring_at),
    width: Number(item?.original_width || item?.image_versions2?.candidates?.[0]?.width || 0) || null,
    height: Number(item?.original_height || item?.image_versions2?.candidates?.[0]?.height || 0) || null,
    imageUrl,
    videoUrl,
    hasAudio: typeof item?.has_audio === 'boolean' ? item.has_audio : null
  };
}

function storyContainer(payload, userId) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.reels && typeof payload.reels === 'object' && !Array.isArray(payload.reels)) return payload.reels[userId] || null;
  if (Array.isArray(payload.reels_media)) return payload.reels_media.find(entry => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId)) || null;
  if (Array.isArray(payload.reels)) return payload.reels.find(entry => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId)) || null;
  return null;
}

async function fetchStoriesBatch(userIds, auth) {
  if (!userIds.length) return { ok: true, payload: { reels: {}, status: 'ok' }, status: 'SKIPPED', error: null };

  const startedAt = Date.now();
  diagnosticLog('story_api_request_start', {
    user_count: userIds.length,
    has_user_ids: userIds.length > 0,
    method: 'GET',
    endpoint_mode: 'per_user_story'
  });

  const reels = {};
  let successCount = 0;
  let failureCount = 0;
  let totalStoryCount = 0;

  try {
    for (const userId of userIds) {
      const endpoint = new URL(`https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/story/`);
      const requestStartedAt = Date.now();

      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          redirect: 'follow',
          headers: storyHeaders(auth),
          signal: AbortSignal.timeout(12_000)
        });
        const text = await response.text();

        let payload = null;
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }

        const elapsedMs = Date.now() - requestStartedAt;
        // /feed/user/{id}/story/ returns stories under payload.reel.items.
        // A HTTP 200 response can still contain {status:"fail", message:"login_required"}.
        const reel = payload && typeof payload === 'object' && payload.reel && typeof payload.reel === 'object'
          ? payload.reel
          : null;
        const items = Array.isArray(reel?.items) ? reel.items : [];
        const statusValue = payload && typeof payload === 'object' ? payload.status : undefined;
        const messageValue = payload && typeof payload === 'object' ? payload.message : undefined;
        const logoutReasonValue = payload && typeof payload === 'object' ? payload.logout_reason : undefined;
        const statusType = statusValue === null ? 'null' : Array.isArray(statusValue) ? 'array' : typeof statusValue;
        const statusStringLength = typeof statusValue === 'string' ? statusValue.length : null;
        const statusIsEmpty = typeof statusValue === 'string' ? statusValue.trim().length === 0 : null;
        const statusCategory = typeof statusValue === 'string'
          ? (/^(ok|success|done)$/i.test(statusValue.trim()) ? 'ok_like'
            : /(error|fail|invalid|login|auth|block|challenge|checkpoint|rate|limit|forbidden|unauth)/i.test(statusValue) ? 'error_like'
            : 'other_string')
          : 'not_string';
        const apiMessage = typeof messageValue === 'string'
          ? messageValue.replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 120)
          : null;
        const apiErrorCategory = /(login_required|auth|unauth|session|csrf)/i.test(apiMessage || '') || logoutReasonValue != null
          ? 'authentication'
          : /(challenge|checkpoint|blocked|spam|rate)/i.test(apiMessage || '')
            ? 'instagram_access_restriction'
            : statusCategory === 'error_like'
              ? 'instagram_api_error'
              : null;

        diagnosticLog('story_api_user_response', {
          user_id_present: Boolean(userId),
          status: response.status,
          ok: response.ok,
          elapsed_ms: elapsedMs,
          content_type: (response.headers.get('content-type') || '').slice(0, 120),
          response_text_length: text.length,
          json_parsed: Boolean(payload),
          top_level_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
          status_type: statusType,
          status_string_length: statusStringLength,
          status_is_empty: statusIsEmpty,
          status_category: statusCategory,
          api_message: apiMessage,
          logout_reason_present: logoutReasonValue != null,
          api_error_category: apiErrorCategory,
          has_reel: Boolean(reel),
          reel_key_count: reel && typeof reel === 'object' ? Object.keys(reel).length : 0,
          item_count: items.length,
          has_items: Array.isArray(reel?.items)
        });

        if (response.ok && payload && !apiErrorCategory && reel) {
          reels[String(userId)] = {
            ...(payload && typeof payload === 'object' ? payload : {}),
            id: Number(userId) || userId,
            items
          };
          successCount += 1;
          totalStoryCount += items.length;
        } else {
          failureCount += 1;
          diagnosticLog('story_api_user_error', {
            status: response.status,
            category: apiErrorCategory || storyApiErrorCategory(response.status),
            api_message: apiMessage,
            logout_reason_present: logoutReasonValue != null
          });
        }
      } catch (error) {
        failureCount += 1;
        diagnosticLog('story_api_user_exception', {
          category: 'network_or_fetch_exception',
          error_name: String(error?.name || 'Error').slice(0, 100),
          error_message: diagnosticErrorMessage(error),
          elapsed_ms: Date.now() - requestStartedAt
        });
      }
    }

    const elapsedMs = Date.now() - startedAt;
    diagnosticLog('story_api_response', {
      status: failureCount > 0 && successCount === 0 ? 'ERROR' : 200,
      ok: successCount > 0,
      elapsed_ms: elapsedMs,
      story_count: totalStoryCount,
      successful_user_count: successCount,
      failed_user_count: failureCount,
      acquisition_mode: 'GET /api/v1/feed/user/{user_id}/story/',
      response_shape: 'reel.items'
    });

    diagnosticLog('story_response_diagnosis', {
      diagnosis: totalStoryCount > 0
        ? 'user_story_endpoint_returned_items'
        : failureCount > 0
          ? 'user_story_endpoint_returned_api_error'
          : 'user_story_endpoint_returned_zero_items',
      requested_user_id_count: userIds.length,
      successful_user_count: successCount,
      failed_user_count: failureCount,
      reels_key_count: Object.keys(reels).length,
      story_count: totalStoryCount
    });

    return {
      ok: successCount > 0,
      payload: { reels, status: successCount > 0 ? 'ok' : 'fail' },
      status: successCount > 0 ? 200 : 'ERROR',
      error: successCount > 0 ? null : 'Story APIへ接続できませんでした。'
    };
  } catch (error) {
    diagnosticLog('story_api_exception', {
      category: 'network_or_fetch_exception',
      error_name: String(error?.name || 'Error').slice(0, 100),
      error_message: diagnosticErrorMessage(error),
      elapsed_ms: Date.now() - startedAt
    });
    return { ok: false, payload: null, status: 'ERROR', error: error?.message || String(error) };
  }
}

async function buildStoryResponse(usernames) {
  const cacheKey = usernames.join(',');
  const cached = cacheGet(state.storyCache, cacheKey, STORY_CACHE_MS);
  if (cached) return { ...cached, cached: true };

  if (state.inflight.has(cacheKey)) return state.inflight.get(cacheKey);

  const task = (async () => {
    const auth = authConfig();
    diagnosticLog('env_presence', {
      INSTAGRAM_DS_USER_ID: Boolean(String(process.env.INSTAGRAM_DS_USER_ID || '').trim()),
      STORY_DIAGNOSTIC_KEY: Boolean(String(process.env.STORY_DIAGNOSTIC_KEY || '').trim()),
      INSTAGRAM_SESSIONID: Boolean(String(process.env.INSTAGRAM_SESSIONID || '').trim()),
      INSTAGRAM_CSRFTOKEN: Boolean(String(process.env.INSTAGRAM_CSRFTOKEN || '').trim()),
      INSTAGRAM_RUR: Boolean(String(process.env.INSTAGRAM_RUR || '').trim())
    });
    if (!auth.sessionid) {
      const error = new Error('Instagram Story認証が未設定です。');
      error.code = 'AUTH_MISSING';
      throw error;
    }

    const embedResults = await mapLimit(usernames, EMBED_CONCURRENCY, fetchEmbedProfile);
    const resolvedProfiles = embedResults.filter(entry => entry.profile?.id).map(entry => entry.profile);
    const storyBatch = await fetchStoriesBatch(resolvedProfiles.map(profile => profile.id), auth);

    const accounts = embedResults.map(entry => {
      const username = safeDiagnosticUsername(entry.username);
      if (!entry.profile?.id) {
        diagnosticLog('result', {
          username,
          result: 'user_id_extraction_failed'
        });
        return {
          username: entry.username,
          status: 'id_unresolved',
          activeStory: false,
          storyCount: 0,
          stories: [],
          profile: null,
          error: entry.error || 'user IDを取得できませんでした。'
        };
      }

      if (!storyBatch.ok) {
        diagnosticLog('result', {
          username,
          result: storyApiResultName(storyBatch.status)
        });
        return {
          username: entry.username,
          status: 'story_error',
          activeStory: false,
          storyCount: 0,
          stories: [],
          profile: entry.profile,
          error: storyBatch.error || 'Story APIへ接続できませんでした。'
        };
      }

      const container = storyContainer(storyBatch.payload, entry.profile.id);
      const items = Array.isArray(container?.items) ? container.items : [];
      const stories = items.slice(0, 50).map(mapStory).filter(story => story.id && (story.imageUrl || story.videoUrl));
      diagnosticLog('result', {
        username,
        result: 'success',
        story_count: stories.length
      });
      return {
        username: entry.username,
        status: 'ok',
        activeStory: stories.length > 0,
        storyCount: stories.length,
        stories,
        profile: entry.profile,
        latestReelMedia: Number(container?.latest_reel_media || 0) || null,
        expiringAt: unixToIso(container?.expiring_at),
        error: null
      };
    });

    const result = {
      ok: true,
      checkedAt: new Date().toISOString(),
      accountCount: accounts.length,
      activeAccountCount: accounts.filter(account => account.activeStory).length,
      failedAccountCount: accounts.filter(account => account.status !== 'ok').length,
      storyApiCallCount: resolvedProfiles.length > 0 ? 1 : 0,
      accounts,
      cached: false
    };
    cacheSet(state.storyCache, cacheKey, result);
    return result;
  })().finally(() => state.inflight.delete(cacheKey));

  state.inflight.set(cacheKey, task);
  return task;
}

function jsonError(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

export default async function instagramStories(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') return jsonError(res, 405, 'POSTのみ対応しています。');
  if (!sameOriginAllowed(req)) return jsonError(res, 403, 'このStory APIは同一オリジンのアプリからのみ利用できます。');
  if (!allowRate(req)) {
    res.setHeader('Retry-After', '60');
    return jsonError(res, 429, 'Story取得が短時間に集中しています。少し待って再試行してください。');
  }

  let usernames;
  try { usernames = parseUsernames(parseBody(req).usernames); }
  catch (error) { return jsonError(res, 400, error?.message || 'usernames が不正です。'); }

  try {
    const result = await buildStoryResponse(usernames);
    return res.status(200).json(result);
  } catch (error) {
    if (error?.code === 'AUTH_MISSING') return jsonError(res, 503, error.message, { setupRequired: true });
    return jsonError(res, 502, 'Instagram Storyを取得できませんでした。');
  }
}
