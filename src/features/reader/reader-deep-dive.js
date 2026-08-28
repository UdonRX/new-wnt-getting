const API = '/api/research?__route=reader-deep-dive';
const CACHE_KEY = 'reader-deep-dive-cache-v1';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 48;
const FETCH_TIMEOUT_MS = 2950;
const payloads = new Map();
const inflight = new Map();
const controllers = new WeakMap();
let touchStart = null;

function clean(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function articleIdOf(card) {
  return clean(card?.dataset?.articleId || card?.dataset?.key || '', 700);
}

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const now = Date.now();
    const out = {};
    for (const [key, entry] of Object.entries(raw || {})) {
      if (!entry?.value || !entry?.ts || now - Number(entry.ts) > CACHE_TTL) continue;
      out[key] = entry;
    }
    return out;
  } catch { return {}; }
}

function cacheGet(id) {
  const raw = loadCache();
  return raw[id]?.value || null;
}

function cacheSet(id, value) {
  if (!id || !value) return;
  try {
    const raw = loadCache();
    raw[id] = { ts: Date.now(), value };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, CACHE_LIMIT);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function hostLabel(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return '出典'; }
}

function sourceLink(url = '', label = '') {
  const a = document.createElement('a');
  a.className = 'reader-deep-source';
  a.href = url || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label || hostLabel(url);
  return a;
}

function node(tag, className = '', text = '') {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

function injectStyles() {
  if (document.getElementById('reader-deep-dive-style')) return;
  const style = document.createElement('style');
  style.id = 'reader-deep-dive-style';
  style.textContent = `
.reader-story-card.reader-deep-enabled{display:block!important;padding:0!important;overflow:hidden!important}
.reader-deep-viewport{position:absolute;inset:0;overflow:hidden;background:inherit}
.reader-deep-track{display:flex;width:100%;height:100%;will-change:transform;transition:transform .28s cubic-bezier(.22,.76,.25,1)}
.reader-deep-page{position:relative;flex:0 0 100%;width:100%;height:100%;min-width:0;box-sizing:border-box;overflow:hidden;background:radial-gradient(circle at 86% 5%,color-mix(in srgb,var(--reader-card-accent-local) 8%,transparent),transparent 27%),linear-gradient(180deg,#0b0e13 0%,#07090d 100%);color:#fff}
.reader-deep-page-now{display:grid!important;grid-template-rows:minmax(150px,30%) minmax(0,1fr) auto;gap:clamp(8px,1.15dvh,12px);padding:max(12px,calc(env(safe-area-inset-top) + 8px)) max(16px,calc(env(safe-area-inset-right) + 12px)) 34px max(16px,calc(env(safe-area-inset-left) + 12px))}
.reader-deep-page-analysis{display:flex;flex-direction:column;gap:12px;padding:max(26px,calc(env(safe-area-inset-top) + 18px)) max(20px,calc(env(safe-area-inset-right) + 18px)) 46px max(20px,calc(env(safe-area-inset-left) + 18px))}
.reader-deep-kicker{font-size:10px;font-weight:850;letter-spacing:.14em;color:color-mix(in srgb,var(--reader-card-accent-local) 62%,#fff);text-transform:uppercase}
.reader-deep-heading{margin:0;font-size:24px;line-height:1.16;letter-spacing:-.035em;font-weight:820;color:#fff}
.reader-deep-story-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:-4px;color:rgba(255,255,255,.48);font-size:11px;line-height:1.45;font-weight:600}
.reader-deep-body{min-height:0;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.reader-deep-loading{margin:auto 0;display:grid;gap:10px;color:rgba(255,255,255,.55);font-size:12px;line-height:1.5}
.reader-deep-loading-line{height:4px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.reader-deep-loading-line::after{content:'';display:block;width:42%;height:100%;border-radius:inherit;background:var(--reader-card-accent-local);animation:readerDeepLoad 1.05s ease-in-out infinite alternate}
@keyframes readerDeepLoad{from{transform:translateX(-20%)}to{transform:translateX(170%)}}
.reader-deep-empty{margin:auto 0;padding:16px 0;color:rgba(255,255,255,.48);font-size:12px;line-height:1.65}
.reader-deep-timeline{display:grid;gap:0;overflow:hidden}
.reader-deep-event{position:relative;display:grid;grid-template-columns:66px minmax(0,1fr);gap:11px;padding:0 0 12px}
.reader-deep-event:not(:last-child)::before{content:'';position:absolute;left:28px;top:18px;bottom:-2px;width:1px;background:rgba(255,255,255,.10)}
.reader-deep-date{position:relative;color:rgba(255,255,255,.68);font-size:10px;font-weight:800;font-variant-numeric:tabular-nums}
.reader-deep-date::after{content:'';position:absolute;right:7px;top:4px;width:7px;height:7px;border-radius:50%;background:var(--reader-card-accent-local);box-shadow:0 0 0 4px color-mix(in srgb,var(--reader-card-accent-local) 14%,transparent)}
.reader-deep-event-main{min-width:0;display:grid;gap:5px}
.reader-deep-event-top{display:flex;align-items:center;gap:7px;min-width:0}
.reader-deep-tag,.reader-deep-badge{display:inline-flex;width:max-content;max-width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:rgba(255,255,255,.045);color:rgba(255,255,255,.68);font-size:8px;font-weight:760;line-height:1;white-space:nowrap}
.reader-deep-metric{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;font-size:10px;font-weight:800}
.reader-deep-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:rgba(255,255,255,.78);font-size:12px;font-weight:570;line-height:1.48}
.reader-deep-quote{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;padding-left:9px;border-left:2px solid color-mix(in srgb,var(--reader-card-accent-local) 42%,transparent);color:rgba(255,255,255,.56);font-size:10px;line-height:1.45}
.reader-deep-source{width:max-content;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in srgb,var(--reader-card-accent-local) 58%,#fff);font-size:8.5px;text-decoration:none;opacity:.85}
.reader-deep-issues{display:grid;gap:10px}
.reader-deep-issue{display:grid;gap:8px;padding:11px;border:1px solid rgba(255,255,255,.07);border-radius:15px;background:rgba(30,41,59,.34)}
.reader-deep-issue-title{font-size:11px;font-weight:800;color:#fff}
.reader-deep-view{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start}
.reader-deep-view-copy{min-width:0;display:grid;gap:4px}
.reader-deep-actor{font-size:9px;font-weight:780;color:rgba(255,255,255,.82)}
.reader-deep-region{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:2px}
.reader-deep-region-col{display:grid;gap:5px;padding:9px;border-radius:12px;background:rgba(255,255,255,.035)}
.reader-deep-region-label{font-size:8px;font-weight:800;color:rgba(255,255,255,.48);letter-spacing:.05em}
.reader-deep-future{display:grid;gap:9px}
.reader-deep-future-item{display:grid;grid-template-columns:62px minmax(0,1fr);gap:10px;padding:10px;border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(30,41,59,.34)}
.reader-deep-time{font-size:9px;font-weight:820;color:color-mix(in srgb,var(--reader-card-accent-local) 62%,#fff)}
.reader-deep-future-copy{min-width:0;display:grid;gap:5px}
.reader-deep-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.reader-deep-impact{font-size:8px;font-weight:760;color:rgba(255,255,255,.55)}
.reader-deep-watch{display:grid;gap:6px;padding-top:1px}
.reader-deep-watch-title{font-size:9px;font-weight:850;letter-spacing:.08em;color:rgba(255,255,255,.48)}
.reader-deep-watch-row{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 9px;border-radius:11px;background:rgba(255,255,255,.035)}
.reader-deep-watch-date{font-size:9px;font-weight:820;color:#fff;font-variant-numeric:tabular-nums}
.reader-deep-watch-event{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:rgba(255,255,255,.70)}
.reader-deep-dots{position:absolute;z-index:12;left:50%;bottom:12px;display:flex;align-items:center;gap:5px;transform:translateX(-50%);pointer-events:none}
.reader-deep-dot{width:5px;height:5px;border-radius:999px;background:rgba(255,255,255,.22);transition:width .2s ease,background .2s ease}
.reader-deep-dot.is-active{width:13px;background:color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff)}
.reader-deep-error{margin:auto 0;display:grid;gap:5px;color:rgba(255,255,255,.54);font-size:12px;line-height:1.55}
.reader-deep-error strong{color:rgba(255,255,255,.78);font-size:13px}
@media (prefers-reduced-motion:reduce){.reader-deep-track{transition:none}.reader-deep-loading-line::after{animation:none}}
`;
  document.head.append(style);
}

function captureSummaryPayloads() {
  if (window.__PDV2_READER_DEEP_CAPTURED) return;
  window.__PDV2_READER_DEEP_CAPTURED = true;
  const upstream = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function readerDeepCaptureFetch(input, init = {}) {
    try {
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      const url = new URL(typeof input === 'string' ? input : input?.url || '', location.href);
      if (method === 'POST' && url.pathname === '/api/summary' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const id = clean(body?.articleId, 700);
        if (id) payloads.set(id, body);
      }
    } catch {}
    return upstream(input, init);
  };
}

function pageShell(kicker, heading) {
  const page = node('section', 'reader-deep-page reader-deep-page-analysis');
  page.append(node('div', 'reader-deep-kicker', kicker), node('h2', 'reader-deep-heading', heading), node('div', 'reader-deep-story-title'));
  const body = node('div', 'reader-deep-body');
  page.append(body);
  return { page, body, title: page.querySelector('.reader-deep-story-title') };
}

function loading(body) {
  body.replaceChildren();
  const wrap = node('div', 'reader-deep-loading');
  wrap.append(node('div', '', '裏付けのある情報を確認しています…'), node('div', 'reader-deep-loading-line'));
  body.append(wrap);
}

function empty(body, text) {
  body.replaceChildren(node('div', 'reader-deep-empty', text));
}

function renderTimeline(body, rows = []) {
  if (!rows.length) return empty(body, '現在のニュースにつながる、裏付けのある重要な過去イベントは確認できませんでした。');
  const list = node('div', 'reader-deep-timeline');
  rows.slice(0, 4).forEach(row => {
    const event = node('div', 'reader-deep-event');
    const date = node('div', 'reader-deep-date', clean(row.date, 18));
    const main = node('div', 'reader-deep-event-main');
    const top = node('div', 'reader-deep-event-top');
    top.append(node('span', 'reader-deep-tag', clean(row.tag, 16)));
    if (row.metric) top.append(node('span', 'reader-deep-metric', clean(row.metric, 38)));
    main.append(top, node('div', 'reader-deep-text', clean(row.text, 110)));
    if (row.quote) main.append(node('div', 'reader-deep-quote', `“${clean(row.quote, 90)}”`));
    if (row.sourceUrl) main.append(sourceLink(row.sourceUrl));
    event.append(date, main);
    list.append(event);
  });
  body.replaceChildren(list);
}

function renderPerspectives(body, data = {}) {
  const issues = Array.isArray(data.perspectives) ? data.perspectives : [];
  const region = Array.isArray(data.regionGap) ? data.regionGap[0] : null;
  if (!issues.length && !region) return empty(body, '裏付けのある対立構造や国内外の明確な報道差は確認できませんでした。');
  body.replaceChildren();
  if (issues.length) {
    const list = node('div', 'reader-deep-issues');
    issues.slice(0, 2).forEach(issue => {
      const box = node('section', 'reader-deep-issue');
      box.append(node('div', 'reader-deep-issue-title', clean(issue.issue, 28)));
      (issue.views || []).slice(0, 2).forEach(view => {
        const row = node('div', 'reader-deep-view');
        row.append(node('span', 'reader-deep-badge', clean(view.stance, 12)));
        const copy = node('div', 'reader-deep-view-copy');
        copy.append(node('div', 'reader-deep-actor', `[${clean(view.actor, 30)}]`), node('div', 'reader-deep-text', clean(view.text, 96)));
        if (view.sourceUrl) copy.append(sourceLink(view.sourceUrl));
        row.append(copy);
        box.append(row);
      });
      list.append(box);
    });
    body.append(list);
  }
  if (region) {
    const wrap = node('div', 'reader-deep-region');
    const jp = node('div', 'reader-deep-region-col');
    jp.append(node('div', 'reader-deep-region-label', '日本'), node('div', 'reader-deep-text', clean(region.japan, 80)), sourceLink(region.japanSourceUrl));
    const ov = node('div', 'reader-deep-region-col');
    ov.append(node('div', 'reader-deep-region-label', '海外'), node('div', 'reader-deep-text', clean(region.overseas, 80)), sourceLink(region.overseasSourceUrl));
    wrap.append(jp, ov);
    body.append(wrap);
  }
}

function typeLabel(type) {
  if (type === 'fact') return '事実';
  if (type === 'expert') return '専門家見解';
  return 'シナリオ';
}

function impactLabel(value) {
  if (value === 'high') return 'HIGH';
  if (value === 'medium') return 'MED';
  if (value === 'low') return 'LOW';
  return '—';
}

function renderFuture(body, data = {}) {
  const rows = Array.isArray(data.future) ? data.future : [];
  const watch = Array.isArray(data.nextWatch) ? data.nextWatch : [];
  if (!rows.length && !watch.length) return empty(body, '裏付けのある予定・専門家見解・条件付きシナリオは確認できませんでした。');
  body.replaceChildren();
  if (rows.length) {
    const list = node('div', 'reader-deep-future');
    rows.slice(0, 3).forEach(row => {
      const item = node('section', 'reader-deep-future-item');
      item.append(node('div', 'reader-deep-time', clean(row.timeframe, 12)));
      const copy = node('div', 'reader-deep-future-copy');
      const meta = node('div', 'reader-deep-meta');
      meta.append(node('span', 'reader-deep-badge', typeLabel(row.type)));
      if (row.actor) meta.append(node('span', 'reader-deep-actor', `[${clean(row.actor, 30)}]`));
      copy.append(meta, node('div', 'reader-deep-text', clean(row.text, 100)));
      const impact = node('div', 'reader-deep-meta');
      impact.append(node('span', 'reader-deep-impact', `市場 ${impactLabel(row.impactMarket)}`), node('span', 'reader-deep-impact', `生活 ${impactLabel(row.impactLife)}`));
      if (row.sourceUrl) impact.append(sourceLink(row.sourceUrl));
      copy.append(impact);
      item.append(copy);
      list.append(item);
    });
    body.append(list);
  }
  if (watch.length) {
    const box = node('div', 'reader-deep-watch');
    box.append(node('div', 'reader-deep-watch-title', 'NEXT WATCH'));
    watch.slice(0, 2).forEach(row => {
      const line = node('div', 'reader-deep-watch-row');
      line.append(node('div', 'reader-deep-watch-date', clean(row.date, 20)), node('div', 'reader-deep-watch-event', clean(row.event, 74)), sourceLink(row.sourceUrl, '出典'));
      box.append(line);
    });
    body.append(box);
  }
}

function contextFor(card) {
  const id = articleIdOf(card);
  const captured = payloads.get(id) || {};
  const title = clean(captured.title || card.querySelector('[data-reader-title]')?.textContent || '記事', 260);
  const source = clean(captured.source || card.querySelector('.reader-story-source-name')?.textContent || '', 120);
  const category = clean(captured.category || card.querySelector('.reader-story-category-badge')?.textContent || '', 120);
  const url = clean(captured.url || captured.link || card.querySelector('.reader-story-open')?.href || '', 1000);
  const summary = clean(Array.from(card.querySelectorAll('.reader-story-summary-text')).map(n => n.textContent || '').join(' '), 700);
  return { articleId: id, title, source, category, url, summary };
}

async function fetchDeep(card) {
  const id = articleIdOf(card);
  const cached = cacheGet(id);
  if (cached) return cached;
  if (inflight.has(id)) return inflight.get(id);
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  const promise = fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: c.signal,
    body: JSON.stringify(contextFor(card))
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
    cacheSet(id, data);
    return data;
  }).finally(() => {
    clearTimeout(timer);
    inflight.delete(id);
  });
  inflight.set(id, promise);
  return promise;
}

function renderError(controller, error) {
  const message = /TAVILY_API_KEY/i.test(String(error?.message || ''))
    ? 'Tavily APIキーを確認してください。'
    : '3秒以内に裏付け情報を取得できませんでした。';
  controller.deepPages.forEach(({ body }) => {
    body.replaceChildren();
    const box = node('div', 'reader-deep-error');
    box.append(node('strong', '', '深掘り情報を表示できません'), node('span', '', message));
    body.append(box);
  });
}

function ensureDeep(card, controller) {
  if (controller.state === 'ready' || controller.state === 'loading') return;
  controller.state = 'loading';
  controller.deepPages.forEach(({ body }) => loading(body));
  const current = contextFor(card).title;
  controller.deepPages.forEach(page => { page.title.textContent = current; });
  fetchDeep(card).then(data => {
    if (!card.isConnected) return;
    controller.state = 'ready';
    renderTimeline(controller.deepPages[0].body, data.timeline || []);
    renderPerspectives(controller.deepPages[1].body, data);
    renderFuture(controller.deepPages[2].body, data);
  }).catch(error => {
    if (!card.isConnected) return;
    controller.state = 'error';
    renderError(controller, error);
  });
}

function move(card, next) {
  const c = controllers.get(card);
  if (!c) return false;
  const target = Math.max(0, Math.min(3, next));
  if (target === c.page) return false;
  c.page = target;
  c.track.style.transform = `translate3d(-${target * 100}%,0,0)`;
  c.dots.forEach((dot, i) => dot.classList.toggle('is-active', i === target));
  card.dataset.deepPage = String(target);
  if (target > 0) ensureDeep(card, c);
  return true;
}

function installCard(card) {
  if (!card || card.dataset.deepInstalled === '1') return;
  card.dataset.deepInstalled = '1';
  card.classList.add('reader-deep-enabled');
  const existing = Array.from(card.childNodes);
  const viewport = node('div', 'reader-deep-viewport');
  const track = node('div', 'reader-deep-track');
  const now = node('section', 'reader-deep-page reader-deep-page-now');
  existing.forEach(child => now.append(child));
  const past = pageShell('PAST', 'なぜ今？');
  const views = pageShell('VIEWS', 'どう見られている？');
  const future = pageShell('NEXT', '次に何が起こる？');
  [past, views, future].forEach(page => loading(page.body));
  track.append(now, past.page, views.page, future.page);
  viewport.append(track);
  const dotsWrap = node('div', 'reader-deep-dots');
  const dots = Array.from({ length: 4 }, (_, i) => {
    const dot = node('span', `reader-deep-dot${i === 0 ? ' is-active' : ''}`);
    dotsWrap.append(dot);
    return dot;
  });
  card.replaceChildren(viewport, dotsWrap);
  controllers.set(card, { page: 0, track, dots, deepPages: [past, views, future], state: 'idle' });
}

function scan(root = document) {
  if (root instanceof Element && root.matches('.reader-story-card')) installCard(root);
  root.querySelectorAll?.('.reader-story-card').forEach(installCard);
}

function installObserver() {
  scan(document);
  const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(n => {
    if (n.nodeType === 1) scan(n);
  })));
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function installSwipeCapture() {
  document.addEventListener('touchstart', event => {
    if (event.touches?.length !== 1) return;
    const t = event.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, target: event.target };
  }, { passive: true, capture: true });

  document.addEventListener('touchend', event => {
    if (!touchStart || !event.changedTouches?.length) return;
    const start = touchStart;
    touchStart = null;
    if (start.target?.closest?.('a,button,input,textarea,select')) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    const card = start.target?.closest?.('.reader-story-card');
    const c = controllers.get(card);
    if (!card || !c) return;
    const handled = dx < 0 ? (c.page < 3 && move(card, c.page + 1)) : (c.page > 0 && move(card, c.page - 1));
    if (handled) event.stopImmediatePropagation();
  }, { passive: true, capture: true });
}

injectStyles();
captureSummaryPayloads();
installSwipeCapture();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installObserver, { once: true });
else installObserver();
