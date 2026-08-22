/* Personal Dashboard v2.18.3 — fast streaming summaries + next-card prefetch. */

const rawFetchV2183 = window.fetch.bind(window);
await import('./runtime-v2182.js');
const inheritedFetchV2183 = window.fetch.bind(window);

const summaryClientCache = new Map();
const summaryClientInFlight = new Map();
const prefetchInFlight = new Map();
const typingState = new WeakMap();

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function summaryBody(init) {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body);
  } catch {}
  return {};
}
function summaryKey(body = {}) {
  return `${clean(body.url || body.link) || clean(body.title)}::${clean(body.mode) || 'auto'}::v2183`;
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function normalizedHref(value = '') {
  try { return new URL(value, location.href).href; } catch { return String(value || ''); }
}
function cardForBody(body = {}) {
  const wanted = normalizedHref(body.url || body.link || '');
  const cards = [...document.querySelectorAll('.reader-swipe-card')];
  if (wanted) {
    const direct = cards.find(card => normalizedHref(card.querySelector('.reader-story-open')?.href || '') === wanted);
    if (direct) return direct;
  }
  const title = clean(body.title);
  return cards.find(card => clean(card.querySelector('[data-reader-title]')?.textContent || '') === title) || null;
}

function typeToward(node, target) {
  if (!node) return;
  const nextTarget = String(target || '');
  let state = typingState.get(node);
  if (!state) {
    state = { target: '', shown: '', raf: 0 };
    typingState.set(node, state);
  }
  state.target = nextTarget;
  if (state.target.startsWith(state.shown) === false) state.shown = '';
  if (state.raf) return;
  const tick = () => {
    state.raf = 0;
    if (!node.isConnected) return;
    const chars = Array.from(state.target);
    const shownCount = Array.from(state.shown).length;
    if (shownCount >= chars.length) return;
    const remaining = chars.length - shownCount;
    const step = remaining > 36 ? 4 : remaining > 14 ? 3 : 2;
    state.shown = chars.slice(0, shownCount + step).join('');
    node.textContent = state.shown;
    if (Array.from(state.shown).length < chars.length) state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function partialTagged(text = '') {
  const source = String(text || '').replace(/\r/g, '');
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const result = {};
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const match = new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'm').exec(source);
    if (!match) continue;
    const start = match.index + match[0].length;
    let end = source.length;
    for (let j = i + 1; j < labels.length; j += 1) {
      const next = new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`, 'm').exec(source.slice(start));
      if (next) { end = start + next.index; break; }
    }
    result[label] = clean(source.slice(start, end));
  }
  return result;
}

function paintStreamingSummary(body, accumulated) {
  const card = cardForBody(body);
  if (!card) return;
  card.dataset.summaryProvider = 'gemini-streaming';
  const partial = partialTagged(accumulated);
  if (partial['タイトル']) typeToward(card.querySelector('[data-reader-title]'), partial['タイトル']);
  const rows = [...card.querySelectorAll('.reader-story-summary-row')];
  ['結論/事実','背景/特徴','影響/展望'].forEach((label, index) => {
    const text = partial[label];
    if (!text) return;
    const node = rows[index]?.querySelector('.reader-story-summary-text');
    typeToward(node, text);
  });
  const loading = card.querySelector('[data-reader-loading-text]');
  if (loading) loading.textContent = 'AI要約を生成中';
  const bar = card.querySelector('[data-reader-progress-bar]');
  if (bar) bar.style.width = '88%';
  const value = card.querySelector('[data-reader-progress-value]');
  if (value) value.textContent = '88%';
}

function nextCardPayload(body) {
  const card = cardForBody(body);
  const next = card?.nextElementSibling?.matches?.('.reader-swipe-card') ? card.nextElementSibling : null;
  if (!next) return null;
  const url = next.querySelector('.reader-story-open')?.href || '';
  if (!url) return null;
  return {
    url,
    title: clean(next.querySelector('[data-reader-title]')?.textContent || ''),
    description: '',
    source: clean(next.querySelector('.reader-story-source-name')?.textContent || ''),
    category: clean(next.querySelector('.reader-story-category-badge')?.textContent || ''),
    mode: clean(body.mode) || '',
    allowAi: true,
    fast: true,
    preferFullText: true,
    prefetch: true
  };
}

function prefetchNext(body) {
  const payload = nextCardPayload(body);
  if (!payload) return;
  const key = summaryKey(payload);
  if (summaryClientCache.has(key) || prefetchInFlight.has(key)) return;
  const job = rawFetchV2183('/api/summary?prefetch=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(18_000)
  }).then(async response => {
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (data?.lines?.length === 3) summaryClientCache.set(key, data);
    return data;
  }).catch(() => null).finally(() => prefetchInFlight.delete(key));
  prefetchInFlight.set(key, job);
}

async function consumeSummaryStream(body) {
  const response = await rawFetchV2183('/api/summary?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    cache: 'no-store',
    body: JSON.stringify({ ...body, description: Array.from(clean(body.description)).slice(0, 500).join('') }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok || !response.body) throw new Error(`summary stream ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finalSummary = null;
  let prefetchStarted = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'delta' && event.text) {
        accumulated += event.text;
        paintStreamingSummary(body, accumulated);
        if (!prefetchStarted) {
          prefetchStarted = true;
          setTimeout(() => prefetchNext(body), 250);
        }
      } else if (event.type === 'done' && event.summary) {
        finalSummary = event.summary;
      } else if (event.type === 'error') {
        throw new Error(event.error || 'summary stream error');
      }
    }
  }
  if (!prefetchStarted) prefetchNext(body);
  if (!finalSummary?.lines?.length) throw new Error('summary stream ended without result');
  return finalSummary;
}

async function fastSummary(body) {
  const key = summaryKey(body);
  if (summaryClientCache.has(key)) return summaryClientCache.get(key);
  if (summaryClientInFlight.has(key)) return summaryClientInFlight.get(key);
  const job = consumeSummaryStream(body).then(summary => {
    if (summary?.cacheable !== false) summaryClientCache.set(key, summary);
    return summary;
  }).catch(async () => {
    const response = await rawFetchV2183('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ ...body, description: Array.from(clean(body.description)).slice(0, 500).join('') }),
      signal: AbortSignal.timeout(18_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `summary ${response.status}`);
    return data;
  }).finally(() => summaryClientInFlight.delete(key));
  summaryClientInFlight.set(key, job);
  return job;
}

window.fetch = async function pdv2183Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetchV2183(input, init); }
  if (url.origin === location.origin && url.pathname === '/api/summary' && String(init?.method || 'GET').toUpperCase() === 'POST') {
    const body = summaryBody(init);
    const result = await fastSummary(body);
    return jsonResponse(result);
  }
  return inheritedFetchV2183(input, init);
};

try {
  if (localStorage.getItem('pdv2:runtime:v2183') !== '1') {
    localStorage.removeItem('reader-summary-cache-v2180');
    localStorage.removeItem('pdv2:youtubeCache:v2160');
    localStorage.setItem('pdv2:runtime:v2183', '1');
  }
} catch {}
