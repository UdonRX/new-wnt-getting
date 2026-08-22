/* Personal Dashboard v2.18.4
 * - stream Reader summaries without passing through the old retry wrapper
 * - prefetch the next Reader card
 * - bypass the v2.18.2 Wikipedia daily double-fetch on the critical path
 */

const rawFetchV2184 = window.fetch.bind(window);
await import('./runtime-v2182.js');
const inheritedFetchV2184 = window.fetch.bind(window);

const summaryCacheV2184 = new Map();
const summaryInflightV2184 = new Map();
const prefetchInflightV2184 = new Map();
const typingV2184 = new WeakMap();

function cleanV2184(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseBodyV2184(init) {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body);
  } catch {}
  return {};
}

function summaryKeyV2184(body = {}) {
  return `${cleanV2184(body.url || body.link) || cleanV2184(body.title)}::${cleanV2184(body.mode) || 'auto'}::v2184`;
}

function jsonResponseV2184(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function hrefV2184(value = '') {
  try { return new URL(value, location.href).href; } catch { return String(value || ''); }
}

function cardForBodyV2184(body = {}) {
  const cards = [...document.querySelectorAll('.reader-swipe-card')];
  const wanted = hrefV2184(body.url || body.link || '');
  if (wanted) {
    const hit = cards.find(card => hrefV2184(card.querySelector('.reader-story-open')?.href || '') === wanted);
    if (hit) return hit;
  }
  const title = cleanV2184(body.title);
  return cards.find(card => cleanV2184(card.querySelector('[data-reader-title]')?.textContent || '') === title) || null;
}

function typeTowardV2184(node, target) {
  if (!node) return;
  const wanted = String(target || '');
  let state = typingV2184.get(node);
  if (!state) {
    state = { target: '', shown: '', raf: 0 };
    typingV2184.set(node, state);
  }
  state.target = wanted;
  if (!state.target.startsWith(state.shown)) state.shown = '';
  if (state.raf) return;

  const tick = () => {
    state.raf = 0;
    if (!node.isConnected) return;
    const chars = Array.from(state.target);
    const current = Array.from(state.shown).length;
    if (current >= chars.length) return;
    const remaining = chars.length - current;
    const step = remaining > 42 ? 4 : remaining > 18 ? 3 : 2;
    state.shown = chars.slice(0, current + step).join('');
    node.textContent = state.shown;
    if (Array.from(state.shown).length < chars.length) state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function partialTaggedV2184(text = '') {
  const source = String(text || '').replace(/\r/g, '');
  const labels = ['タイトル', '結論/事実', '背景/特徴', '影響/展望'];
  const out = {};
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const startMatch = new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'm').exec(source);
    if (!startMatch) continue;
    const start = startMatch.index + startMatch[0].length;
    let end = source.length;
    for (let j = i + 1; j < labels.length; j += 1) {
      const next = new RegExp(`(?:^|\\n)${labels[j]}\\s*[:：]`, 'm').exec(source.slice(start));
      if (next) { end = start + next.index; break; }
    }
    out[label] = cleanV2184(source.slice(start, end));
  }
  return out;
}

function paintStreamV2184(body, accumulated) {
  const card = cardForBodyV2184(body);
  if (!card) return;
  card.dataset.summaryProvider = 'gemini-stream-v2184';
  const partial = partialTaggedV2184(accumulated);
  if (partial['タイトル']) typeTowardV2184(card.querySelector('[data-reader-title]'), partial['タイトル']);
  const rows = [...card.querySelectorAll('.reader-story-summary-row')];
  ['結論/事実','背景/特徴','影響/展望'].forEach((label, index) => {
    if (!partial[label]) return;
    typeTowardV2184(rows[index]?.querySelector('.reader-story-summary-text'), partial[label]);
  });
  const label = card.querySelector('[data-reader-loading-text]');
  if (label) label.textContent = 'AI要約を生成中';
  const bar = card.querySelector('[data-reader-progress-bar]');
  if (bar) bar.style.width = '90%';
  const value = card.querySelector('[data-reader-progress-value]');
  if (value) value.textContent = '90%';
}

function nextPayloadV2184(body) {
  const card = cardForBodyV2184(body);
  const next = card?.nextElementSibling?.matches?.('.reader-swipe-card') ? card.nextElementSibling : null;
  if (!next) return null;
  const url = next.querySelector('.reader-story-open')?.href || '';
  if (!url) return null;
  return {
    url,
    title: cleanV2184(next.querySelector('[data-reader-title]')?.textContent || ''),
    description: '',
    source: cleanV2184(next.querySelector('.reader-story-source-name')?.textContent || ''),
    category: cleanV2184(next.querySelector('.reader-story-category-badge')?.textContent || ''),
    mode: cleanV2184(body.mode) || '',
    allowAi: true,
    fast: true,
    prefetch: true
  };
}

function prefetchNextV2184(body) {
  const payload = nextPayloadV2184(body);
  if (!payload) return;
  const key = summaryKeyV2184(payload);
  if (summaryCacheV2184.has(key) || prefetchInflightV2184.has(key)) return;
  const task = rawFetchV2184('/api/summary?prefetch=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(14_000)
  }).then(async response => {
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (data?.lines?.length === 3 && !['unavailable','insufficient'].includes(String(data?.provider || ''))) {
      summaryCacheV2184.set(key, data);
    }
    return data;
  }).catch(() => null).finally(() => prefetchInflightV2184.delete(key));
  prefetchInflightV2184.set(key, task);
}

async function consumeStreamV2184(body) {
  const response = await rawFetchV2184('/api/summary?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    cache: 'no-store',
    body: JSON.stringify({
      ...body,
      description: Array.from(cleanV2184(body.description)).slice(0, 500).join('')
    }),
    signal: AbortSignal.timeout(24_000)
  });
  if (!response.ok || !response.body) throw new Error(`summary stream ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finalSummary = null;
  let prefetchStarted = false;

  const consumeLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'delta' && event.text) {
      accumulated += event.text;
      paintStreamV2184(body, accumulated);
      if (!prefetchStarted) {
        prefetchStarted = true;
        setTimeout(() => prefetchNextV2184(body), 180);
      }
    } else if (event.type === 'done' && event.summary) {
      finalSummary = event.summary;
    } else if (event.type === 'error') {
      throw new Error(event.error || 'summary stream error');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!prefetchStarted) prefetchNextV2184(body);
  if (!finalSummary?.lines?.length) throw new Error('summary stream ended without usable result');
  return finalSummary;
}

async function fastSummaryV2184(body) {
  const key = summaryKeyV2184(body);
  if (summaryCacheV2184.has(key)) return summaryCacheV2184.get(key);
  if (summaryInflightV2184.has(key)) return summaryInflightV2184.get(key);

  const task = consumeStreamV2184(body).catch(async () => {
    const response = await rawFetchV2184('/api/summary?retry=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        ...body,
        description: Array.from(cleanV2184(body.description)).slice(0, 500).join('')
      }),
      signal: AbortSignal.timeout(18_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `summary ${response.status}`);
    return data;
  }).then(summary => {
    if (summary?.cacheable !== false && summary?.lines?.length === 3) summaryCacheV2184.set(key, summary);
    return summary;
  }).finally(() => summaryInflightV2184.delete(key));

  summaryInflightV2184.set(key, task);
  return task;
}

async function wikipediaDailyFastV2184(input, init) {
  // v2.18.2 waited for BOTH the Vercel endpoint and a second direct Wikimedia
  // reconstruction. The server endpoint already contains today's data, so the
  // duplicate direct fetch is removed from the initial-render critical path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await rawFetchV2184(input, { ...(init || {}), signal: controller.signal });
  } catch (error) {
    // Keep the older direct fallback only for a genuine server/network failure.
    return inheritedFetchV2184(input, init);
  } finally {
    clearTimeout(timer);
  }
}

window.fetch = async function pdv2184Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetchV2184(input, init); }

  if (url.origin === location.origin && url.pathname === '/api/summary' && String(init?.method || 'GET').toUpperCase() === 'POST') {
    return jsonResponseV2184(await fastSummaryV2184(parseBodyV2184(init)));
  }
  if (url.origin === location.origin && url.pathname === '/api/wikipedia' && url.searchParams.get('mode') === 'daily') {
    return wikipediaDailyFastV2184(input, init);
  }
  return inheritedFetchV2184(input, init);
};

try {
  if (localStorage.getItem('pdv2:runtime:v2184') !== '1') {
    localStorage.removeItem('reader-summary-cache-v2180');
    localStorage.setItem('pdv2:runtime:v2184', '1');
  }
} catch {}
