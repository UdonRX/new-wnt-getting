const API = '/api/research?__route=reader-deep-dive';
const CK = 'reader-deep-dive-cache-v2';
const TTL = 864e5;
const LIMIT = 96;
const SEARCH_MS = 2950;
const ENRICH_MS = 10000;
const DWELL = 650;
const PAGE_COUNT = 4;
const pageLane = ['', 'timeline', 'perspectives', 'future'];
const payloads = new Map();
const flight = new Map();
const enrichFlight = new Map();
const ctrls = new WeakMap();
let gesture = null;

function c(v = '', n = 500) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
}
function aid(card) { return c(card?.dataset?.articleId || card?.dataset?.key, 700); }
function ck(id, lane) { return `${id}::${lane}`; }
function allCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CK) || '{}');
    const now = Date.now();
    const out = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (entry?.value && entry?.ts && now - Number(entry.ts) <= TTL) out[key] = entry;
    }
    return out;
  } catch { return {}; }
}
function cacheGet(id, lane) { return allCache()[ck(id, lane)]?.value || null; }
function cacheSet(id, lane, value) {
  if (!id || !lane || !value) return;
  try {
    const raw = allCache();
    raw[ck(id, lane)] = { ts: Date.now(), value };
    const kept = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, LIMIT);
    localStorage.setItem(CK, JSON.stringify(Object.fromEntries(kept)));
  } catch {}
}
function node(tag, className = '', text = '') {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}
function hostLabel(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return '出典'; }
}
function sourceLink(url = '', label = '') {
  const a = node('a', 'reader-deep-source', label || hostLabel(url));
  a.href = url || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function styles() {
  if (document.getElementById('reader-deep-dive-style-v3')) return;
  const style = node('style');
  style.id = 'reader-deep-dive-style-v3';
  style.textContent = `
.reader-story-card.reader-deep-enabled{display:block!important;padding:0!important;overflow:hidden!important}
.reader-deep-viewport{position:absolute;inset:0;overflow:hidden;contain:layout paint}
.reader-deep-track{display:flex;width:100%;height:100%;transition:transform .28s cubic-bezier(.22,.76,.25,1);will-change:transform}
.reader-story-card.reader-deep-dragging .reader-deep-track{transition:none!important}
.reader-deep-page{position:relative;flex:0 0 100%;width:100%;height:100%;box-sizing:border-box;overflow:hidden;background:radial-gradient(circle at 86% 5%,color-mix(in srgb,var(--reader-card-accent-local) 8%,transparent),transparent 27%),linear-gradient(180deg,#0b0e13,#07090d);color:#fff}
.reader-deep-now{display:grid!important;grid-template-rows:minmax(150px,30%) minmax(0,1fr) auto;gap:clamp(8px,1.15dvh,12px);padding:max(12px,calc(env(safe-area-inset-top) + 8px)) max(16px,calc(env(safe-area-inset-right) + 12px)) 34px max(16px,calc(env(safe-area-inset-left) + 12px))}
.reader-deep-analysis{display:flex;flex-direction:column;gap:12px;padding:max(26px,calc(env(safe-area-inset-top) + 18px)) max(20px,calc(env(safe-area-inset-right) + 18px)) 46px max(20px,calc(env(safe-area-inset-left) + 18px))}
.reader-deep-kicker{font-size:10px;font-weight:850;letter-spacing:.14em;color:color-mix(in srgb,var(--reader-card-accent-local) 62%,#fff)}
.reader-deep-heading{margin:0;font-size:24px;line-height:1.16;letter-spacing:-.035em;font-weight:820}
.reader-deep-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:-4px;color:rgba(255,255,255,.48);font-size:11px;line-height:1.45;font-weight:600}
.reader-deep-body{min-height:0;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.reader-deep-loading,.reader-deep-empty,.reader-deep-error{margin:auto 0;color:rgba(255,255,255,.52);font-size:12px;line-height:1.6}
.reader-deep-loading{display:grid;gap:10px}
.reader-deep-line{height:4px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.reader-deep-line:after{content:'';display:block;width:42%;height:100%;background:var(--reader-card-accent-local);animation:ddload 1.05s ease-in-out infinite alternate}
@keyframes ddload{from{transform:translateX(-20%)}to{transform:translateX(170%)}}
.reader-deep-timeline{display:grid}
.reader-deep-event{position:relative;display:grid;grid-template-columns:66px minmax(0,1fr);gap:11px;padding:0 0 12px}
.reader-deep-event:not(:last-child):before{content:'';position:absolute;left:28px;top:18px;bottom:-2px;width:1px;background:rgba(255,255,255,.1)}
.reader-deep-date{position:relative;color:rgba(255,255,255,.68);font-size:10px;font-weight:800}
.reader-deep-date:after{content:'';position:absolute;right:7px;top:4px;width:7px;height:7px;border-radius:50%;background:var(--reader-card-accent-local)}
.reader-deep-main,.reader-deep-copy{min-width:0;display:grid;gap:5px}
.reader-deep-top,.reader-deep-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.reader-deep-tag,.reader-deep-badge{display:inline-flex;padding:3px 6px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:rgba(255,255,255,.045);color:rgba(255,255,255,.68);font-size:8px;font-weight:760}
.reader-deep-metric{color:#fff;font-size:10px;font-weight:800}
.reader-deep-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:rgba(255,255,255,.78);font-size:12px;line-height:1.48}
.reader-deep-quote{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;padding-left:9px;border-left:2px solid color-mix(in srgb,var(--reader-card-accent-local) 42%,transparent);color:rgba(255,255,255,.56);font-size:10px}
.reader-deep-source{width:max-content;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in srgb,var(--reader-card-accent-local) 58%,#fff);font-size:8.5px;text-decoration:none}
.reader-deep-issues{display:grid;gap:10px}
.reader-deep-issue,.reader-deep-future-item{display:grid;gap:8px;padding:11px;border:1px solid rgba(255,255,255,.07);border-radius:15px;background:rgba(30,41,59,.34)}
.reader-deep-issue-title{font-size:11px;font-weight:800}
.reader-deep-view{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px}
.reader-deep-actor{font-size:9px;font-weight:780;color:rgba(255,255,255,.82)}
.reader-deep-region{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.reader-deep-region-col{display:grid;gap:5px;padding:9px;border-radius:12px;background:rgba(255,255,255,.035)}
.reader-deep-region-label,.reader-deep-watch-title{font-size:8px;font-weight:800;color:rgba(255,255,255,.48)}
.reader-deep-future{display:grid;gap:9px}
.reader-deep-future-item{grid-template-columns:62px minmax(0,1fr)}
.reader-deep-time{font-size:9px;font-weight:820;color:color-mix(in srgb,var(--reader-card-accent-local) 62%,#fff)}
.reader-deep-impact{font-size:8px;font-weight:760;color:rgba(255,255,255,.55)}
.reader-deep-watch{display:grid;gap:6px}
.reader-deep-watch-row{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 9px;border-radius:11px;background:rgba(255,255,255,.035)}
.reader-deep-watch-date{font-size:9px;font-weight:820}
.reader-deep-watch-event{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:rgba(255,255,255,.70)}
.reader-deep-dots{position:absolute;z-index:12;left:50%;bottom:12px;display:flex;gap:5px;transform:translateX(-50%);pointer-events:none}
.reader-deep-dot{width:5px;height:5px;border-radius:999px;background:rgba(255,255,255,.22);transition:.2s}
.reader-deep-dot.is-active{width:13px;background:color-mix(in srgb,var(--reader-card-accent-local) 70%,#fff)}
@media(prefers-reduced-motion:reduce){.reader-deep-track{transition:none}.reader-deep-line:after{animation:none}}
`;
  document.head.append(style);
}

function capture() {
  if (window.__PDV2_READER_DEEP_CAPTURED_V3) return;
  window.__PDV2_READER_DEEP_CAPTURED_V3 = true;
  const upstream = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function readerDeepCaptureFetch(input, init = {}) {
    try {
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      const url = new URL(typeof input === 'string' ? input : input?.url || '', location.href);
      if (method === 'POST' && url.pathname === '/api/summary' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const id = c(body?.articleId, 700);
        if (id) payloads.set(id, body);
      }
    } catch {}
    return upstream(input, init);
  };
}

function shell(kicker, heading) {
  const page = node('section', 'reader-deep-page reader-deep-analysis');
  page.append(node('div', 'reader-deep-kicker', kicker), node('h2', 'reader-deep-heading', heading), node('div', 'reader-deep-title'));
  const body = node('div', 'reader-deep-body');
  page.append(body);
  return { page, body, title: page.querySelector('.reader-deep-title') };
}
function loading(body, lane) {
  const labels = {
    timeline: '過去の転換点を検索しています…',
    perspectives: '異なる視点を検索しています…',
    future: '今後の予定・見通しを検索しています…'
  };
  body.replaceChildren();
  const wrap = node('div', 'reader-deep-loading');
  wrap.append(node('div', '', labels[lane]), node('div', 'reader-deep-line'));
  body.append(wrap);
}
function empty(body, text) { body.replaceChildren(node('div', 'reader-deep-empty', text)); }

function renderTimeline(body, rows = []) {
  if (!rows.length) return empty(body, '時間内に、裏付けのある過去イベントは確認できませんでした。');
  const list = node('div', 'reader-deep-timeline');
  rows.slice(0, 4).forEach(item => {
    const event = node('div', 'reader-deep-event');
    const date = node('div', 'reader-deep-date', c(item.date, 18));
    const main = node('div', 'reader-deep-main');
    const top = node('div', 'reader-deep-top');
    top.append(node('span', 'reader-deep-tag', c(item.tag, 16)));
    if (item.metric) top.append(node('span', 'reader-deep-metric', c(item.metric, 38)));
    main.append(top, node('div', 'reader-deep-text', c(item.text, 110)));
    if (item.quote) main.append(node('div', 'reader-deep-quote', `“${c(item.quote, 90)}”`));
    if (item.sourceUrl) main.append(sourceLink(item.sourceUrl));
    event.append(date, main);
    list.append(event);
  });
  body.replaceChildren(list);
}
function renderViews(body, data = {}) {
  const issues = Array.isArray(data.perspectives) ? data.perspectives : [];
  const regionGap = Array.isArray(data.regionGap) ? data.regionGap[0] : null;
  if (!issues.length && !regionGap) return empty(body, '時間内に、裏付けのある異なる視点や国内外差は確認できませんでした。');
  body.replaceChildren();
  if (issues.length) {
    const list = node('div', 'reader-deep-issues');
    issues.slice(0, 2).forEach(issue => {
      const box = node('section', 'reader-deep-issue');
      box.append(node('div', 'reader-deep-issue-title', c(issue.issue, 28)));
      (issue.views || []).slice(0, 2).forEach(view => {
        const row = node('div', 'reader-deep-view');
        const copy = node('div', 'reader-deep-copy');
        row.append(node('span', 'reader-deep-badge', c(view.stance, 12)));
        copy.append(node('div', 'reader-deep-actor', `[${c(view.actor, 30)}]`), node('div', 'reader-deep-text', c(view.text, 96)));
        if (view.sourceUrl) copy.append(sourceLink(view.sourceUrl));
        row.append(copy);
        box.append(row);
      });
      list.append(box);
    });
    body.append(list);
  }
  if (regionGap) {
    const grid = node('div', 'reader-deep-region');
    [['日本', regionGap.japan, regionGap.japanSourceUrl], ['海外', regionGap.overseas, regionGap.overseasSourceUrl]].forEach(([label, text, url]) => {
      const col = node('div', 'reader-deep-region-col');
      col.append(node('div', 'reader-deep-region-label', label), node('div', 'reader-deep-text', c(text, 78)));
      if (url) col.append(sourceLink(url));
      grid.append(col);
    });
    body.append(grid);
  }
}
function typeLabel(type) { return type === 'fact' ? '事実' : type === 'expert' ? '専門家見解' : 'シナリオ'; }
function renderFuture(body, data = {}) {
  const rows = Array.isArray(data.future) ? data.future : [];
  const watch = Array.isArray(data.nextWatch) ? data.nextWatch : [];
  if (!rows.length && !watch.length) return empty(body, '時間内に、裏付けのある今後の予定・見解は確認できませんでした。');
  body.replaceChildren();
  if (rows.length) {
    const list = node('div', 'reader-deep-future');
    rows.slice(0, 3).forEach(item => {
      const row = node('section', 'reader-deep-future-item');
      const copy = node('div', 'reader-deep-copy');
      const meta = node('div', 'reader-deep-meta');
      row.append(node('div', 'reader-deep-time', c(item.timeframe, 12)));
      meta.append(node('span', 'reader-deep-badge', typeLabel(item.type)));
      if (item.actor) meta.append(node('span', 'reader-deep-actor', `[${c(item.actor, 30)}]`));
      copy.append(meta, node('div', 'reader-deep-text', c(item.text, 98)));
      const impact = node('div', 'reader-deep-meta');
      if (item.impactMarket && item.impactMarket !== 'unknown') impact.append(node('span', 'reader-deep-impact', `市場 ${item.impactMarket}`));
      if (item.impactLife && item.impactLife !== 'unknown') impact.append(node('span', 'reader-deep-impact', `生活 ${item.impactLife}`));
      if (impact.childNodes.length) copy.append(impact);
      if (item.sourceUrl) copy.append(sourceLink(item.sourceUrl));
      row.append(copy);
      list.append(row);
    });
    body.append(list);
  }
  if (watch.length) {
    const box = node('div', 'reader-deep-watch');
    box.append(node('div', 'reader-deep-watch-title', 'NEXT WATCH'));
    watch.slice(0, 2).forEach(item => {
      const row = node('div', 'reader-deep-watch-row');
      row.append(node('div', 'reader-deep-watch-date', c(item.date, 20)), node('div', 'reader-deep-watch-event', c(item.event, 74)), sourceLink(item.sourceUrl, '出典'));
      box.append(row);
    });
    body.append(box);
  }
}

function context(card) {
  const id = aid(card);
  const payload = payloads.get(id) || {};
  const title = c(payload.title || card.querySelector('[data-reader-title]')?.textContent || '記事', 260);
  const source = c(payload.source || card.querySelector('.reader-story-source-name')?.textContent, 120);
  const category = c(payload.category || card.querySelector('.reader-story-category-badge')?.textContent, 120);
  const url = c(payload.url || payload.link || card.querySelector('.reader-story-open')?.href, 1000);
  const visible = c([...card.querySelectorAll('.reader-story-summary-text')].map(n => n.textContent || '').join(' '), 700);
  const pending = /(抽出しています|確認しています|整理しています|生成中)/.test(visible);
  const summary = !pending && visible.length >= 30 ? visible : c(payload.description, 500) || visible;
  return { articleId: id, title, source, category, url, summary };
}

function searchContext(card) {
  const base = context(card);
  let title = base.title;
  const suffix = title.match(/\s+(?:-|–|—|｜)\s+([^｜|]{2,32})\s*$/)?.[1] || title.match(/[（(]([^（）()]{2,32})[）)]\s*$/)?.[1] || '';
  if (suffix) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title
      .replace(new RegExp(`\\s*[（(]${escaped}[）)]\\s*$`, 'i'), '')
      .replace(new RegExp(`\\s*(?:-|–|—|｜|\\|)\\s*${escaped}\\s*$`, 'i'), '')
      .trim();
  }
  title = title.replace(/[「『“\"]([^」』”\"]{8,48})[」』”\"]/g, (all, quote) =>
    /(?:受け止め|思う|考え|述べ|話し|語り|謝罪|批判|コメント|発言|したい|していく|します|ました|です|ます)/.test(quote) ? ' ' : all
  ).replace(/\s+/g, ' ').trim();
  const text = `${title} ${base.summary}`;
  const aliases = [];
  const specs = [
    [/ネトフリ|netflix/i, 'Netflix'],
    [/中止|取りやめ|撤回|打ち切り/i, 'cancelled cancellation'],
    [/コラボ|コラボレーション|協業/i, 'collaboration'],
    [/法相|法務大臣/i, 'Justice Minister'],
    [/死去|死亡|亡くな|逝去|訃報/i, 'died death obituary'],
    [/国防総省|防衛総省/i, 'Pentagon Department of Defense'],
    [/連邦地方裁判所|連邦裁判所|連邦判事/i, 'federal judge federal court'],
    [/サプライチェーンリスク/i, 'supply chain risk'],
    [/判決|判断/i, 'ruling'],
    [/訴訟|提訴/i, 'lawsuit'],
    [/買収/i, 'acquisition'],
    [/提携|協業/i, 'partnership'],
    [/規制/i, 'regulation'],
    [/承認/i, 'approval'],
    [/発売|提供開始/i, 'launch release']
  ];
  for (const [re, alias] of specs) if (re.test(text)) aliases.push(alias);
  const searchTitle = c(`${title} ${aliases.join(' ')}`, 260);
  return { ...base, title: searchTitle || base.title };
}

function render(ctrl, pageIndex, data) {
  const page = ctrl.pages[pageIndex - 1];
  if (!page) return;
  if (pageIndex === 1) renderTimeline(page.body, data.timeline || []);
  if (pageIndex === 2) renderViews(page.body, data);
  if (pageIndex === 3) renderFuture(page.body, data);
}

async function request(card, lane, phase = 'search', evidence = []) {
  const id = aid(card);
  const key = `${id}::${lane}::${phase}`;
  const map = phase === 'search' ? flight : enrichFlight;
  const timeout = phase === 'search' ? SEARCH_MS : ENRICH_MS;
  if (phase === 'search') {
    const hit = cacheGet(id, lane);
    if (hit) return hit;
  }
  if (map.has(key)) return map.get(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const promise = fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: controller.signal,
    body: JSON.stringify({ ...(phase === 'search' ? searchContext(card) : context(card)), lane, phase, evidence })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
    if (phase === 'search') cacheSet(id, lane, data);
    return data;
  }).finally(() => {
    clearTimeout(timer);
    map.delete(key);
  });
  map.set(key, promise);
  return promise;
}
function scheduleEnrich(card, ctrl, pageIndex, lane, data) {
  const state = ctrl.lanes[lane];
  if (!state || state.timer || state.attempted || data?.enriched || !data?.evidence?.length || ctrl.destroyed) return;
  state.timer = setTimeout(() => {
    state.timer = 0;
    if (ctrl.destroyed || !card.isConnected || ctrl.page !== pageIndex || state.attempted) return;
    state.attempted = true;
    request(card, lane, 'enrich', data.evidence).then(enriched => {
      if (ctrl.destroyed) return;
      const merged = { ...data, ...enriched, enriched: Boolean(enriched.enriched) };
      cacheSet(aid(card), lane, merged);
      state.data = merged;
      if (card.isConnected && ctrl.page === pageIndex) render(ctrl, pageIndex, merged);
    }).catch(() => {});
  }, DWELL);
}
function ensure(card, ctrl, pageIndex) {
  const lane = pageLane[pageIndex];
  const state = ctrl.lanes[lane];
  const page = ctrl.pages[pageIndex - 1];
  if (!lane || !state || !page || ctrl.destroyed) return;
  page.title.textContent = context(card).title;
  if (state.status === 'ready' && state.data) {
    render(ctrl, pageIndex, state.data);
    scheduleEnrich(card, ctrl, pageIndex, lane, state.data);
    return;
  }
  if (state.status === 'loading') return;
  state.status = 'loading';
  loading(page.body, lane);
  request(card, lane).then(data => {
    if (ctrl.destroyed || !card.isConnected) return;
    state.status = 'ready';
    state.data = data;
    render(ctrl, pageIndex, data);
    scheduleEnrich(card, ctrl, pageIndex, lane, data);
  }).catch(error => {
    if (ctrl.destroyed || !card.isConnected) return;
    state.status = 'error';
    page.body.replaceChildren(node('div', 'reader-deep-error', /TAVILY_API_KEY/i.test(String(error?.message || '')) ? 'Tavily APIキーを確認してください。' : '約3秒以内に検索結果を取得できませんでした。'));
  });
}

function laneState() {
  return { status: 'idle', data: null, timer: 0, attempted: false };
}
function activate(card) {
  const existing = ctrls.get(card);
  if (existing && !existing.destroyed) return existing;
  const originalNodes = [...card.childNodes];
  if (!originalNodes.length) return null;
  const viewport = node('div', 'reader-deep-viewport');
  const track = node('div', 'reader-deep-track');
  const now = node('section', 'reader-deep-page reader-deep-now');
  originalNodes.forEach(child => now.append(child));
  const past = shell('PAST', 'なぜ今？');
  const views = shell('VIEWS', 'どう見られている？');
  const future = shell('NEXT', '次に何が起こる？');
  loading(past.body, 'timeline');
  loading(views.body, 'perspectives');
  loading(future.body, 'future');
  track.append(now, past.page, views.page, future.page);
  viewport.append(track);
  const dotWrap = node('div', 'reader-deep-dots');
  const dots = Array.from({ length: PAGE_COUNT }, (_, index) => {
    const dot = node('span', `reader-deep-dot${index === 0 ? ' is-active' : ''}`);
    dotWrap.append(dot);
    return dot;
  });
  card.classList.add('reader-deep-enabled');
  card.dataset.deepPage = '0';
  card.replaceChildren(viewport, dotWrap);
  const ctrl = {
    card,
    page: 0,
    track,
    now,
    dots,
    pages: [past, views, future],
    destroyed: false,
    unwrapTimer: 0,
    lanes: { timeline: laneState(), perspectives: laneState(), future: laneState() }
  };
  ctrls.set(card, ctrl);
  return ctrl;
}
function clearLaneTimers(ctrl) {
  for (const state of Object.values(ctrl?.lanes || {})) {
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = 0;
  }
}
function deactivate(card) {
  const ctrl = ctrls.get(card);
  if (!ctrl || ctrl.destroyed) return;
  ctrl.destroyed = true;
  clearLaneTimers(ctrl);
  if (ctrl.unwrapTimer) clearTimeout(ctrl.unwrapTimer);
  const originalNodes = [...ctrl.now.childNodes];
  card.classList.remove('reader-deep-enabled', 'reader-deep-dragging');
  delete card.dataset.deepPage;
  card.replaceChildren(...originalNodes);
  ctrls.delete(card);
}
function setTrack(ctrl, page, dragPx = 0, immediate = false) {
  if (!ctrl || ctrl.destroyed) return;
  ctrl.card.classList.toggle('reader-deep-dragging', immediate);
  ctrl.track.style.transform = dragPx
    ? `translate3d(calc(-${page * 100}% + ${dragPx}px),0,0)`
    : `translate3d(-${page * 100}%,0,0)`;
}
function setPage(card, ctrl, nextPage, { unwrapNow = true } = {}) {
  if (!ctrl || ctrl.destroyed) return;
  const to = Math.max(0, Math.min(PAGE_COUNT - 1, nextPage));
  const oldLane = pageLane[ctrl.page];
  if (oldLane && ctrl.lanes[oldLane]?.timer) {
    clearTimeout(ctrl.lanes[oldLane].timer);
    ctrl.lanes[oldLane].timer = 0;
  }
  ctrl.page = to;
  setTrack(ctrl, to, 0, false);
  ctrl.dots.forEach((dot, index) => dot.classList.toggle('is-active', index === to));
  card.dataset.deepPage = String(to);
  if (to > 0) ensure(card, ctrl, to);
  if (to === 0 && unwrapNow) {
    if (ctrl.unwrapTimer) clearTimeout(ctrl.unwrapTimer);
    ctrl.unwrapTimer = setTimeout(() => {
      if (!ctrl.destroyed && ctrl.page === 0) deactivate(card);
    }, 310);
  }
}

function interactive(target) { return Boolean(target?.closest?.('a,button,input,textarea,select')); }
function feedFor(card) { return card?.closest?.('.reader-swipe-feed') || null; }
function lockFeed(shot) {
  const feed = shot.feed;
  if (!feed || shot.feedLocked) return;
  shot.feedLocked = true;
  shot.snapType = feed.style.scrollSnapType;
  shot.scrollBehavior = feed.style.scrollBehavior;
  shot.scrollTop = Number(feed.scrollTop || 0);
  feed.style.scrollSnapType = 'none';
  feed.style.scrollBehavior = 'auto';
}
function unlockFeed(shot) {
  const feed = shot?.feed;
  if (!feed || !shot.feedLocked) return;
  shot.feedLocked = false;
  feed.style.scrollSnapType = shot.snapType || '';
  feed.style.scrollBehavior = shot.scrollBehavior || '';
}
function holdVertical(shot) {
  if (!shot?.feed || !shot.feed.isConnected) return;
  if (Math.abs(Number(shot.feed.scrollTop || 0) - shot.scrollTop) > 0.5) shot.feed.scrollTop = shot.scrollTop;
}
function dragDistance(shot, dx) {
  const page = shot.ctrl?.page ?? shot.basePage ?? 0;
  if ((page === 0 && dx > 0) || (page === PAGE_COUNT - 1 && dx < 0)) return dx * 0.24;
  return dx;
}
function resetGesture() {
  if (!gesture) return;
  const shot = gesture;
  gesture = null;
  if (shot.ctrl && !shot.ctrl.destroyed) shot.card.classList.remove('reader-deep-dragging');
  unlockFeed(shot);
}
function beginHorizontal(shot) {
  if (shot.lock === 'horizontal') return true;
  const ctrl = activate(shot.card);
  if (!ctrl) return false;
  shot.ctrl = ctrl;
  shot.basePage = ctrl.page;
  shot.lock = 'horizontal';
  lockFeed(shot);
  return true;
}
function beginVertical(shot) {
  shot.lock = 'vertical';
  if (ctrls.has(shot.card)) deactivate(shot.card);
}

function installGesture() {
  if (window.__PDV2_READER_DEEP_GESTURE_V3) return;
  window.__PDV2_READER_DEEP_GESTURE_V3 = true;

  document.addEventListener('touchstart', event => {
    resetGesture();
    if (event.touches?.length !== 1 || interactive(event.target)) return;
    const card = event.target?.closest?.('.reader-story-card');
    if (!card || !card.closest('.reader-focus-open')) return;
    // Reader focus already has older horizontal handlers on the feed and, when opened from Bento,
    // the list-level swipe listener can still be attached to the screen. Do not let either record
    // this touchstart. Native vertical scrolling is unaffected because propagation is stopped
    // without preventDefault(). This module becomes the sole JS owner of card gestures.
    event.stopImmediatePropagation();
    const point = event.touches[0];
    gesture = {
      card,
      feed: feedFor(card),
      x: point.clientX,
      y: point.clientY,
      startedAt: performance.now(),
      lock: 'pending',
      ctrl: ctrls.get(card) || null,
      basePage: ctrls.get(card)?.page || 0,
      feedLocked: false,
      snapType: '',
      scrollBehavior: '',
      scrollTop: Number(feedFor(card)?.scrollTop || 0)
    };
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', event => {
    const shot = gesture;
    if (!shot || event.touches?.length !== 1 || !shot.card?.isConnected) return;
    const point = event.touches[0];
    const dx = point.clientX - shot.x;
    const dy = point.clientY - shot.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    if (shot.lock === 'pending' && Math.max(ax, ay) >= 10) {
      if (ax > ay * 1.18) {
        if (!beginHorizontal(shot)) { resetGesture(); return; }
      } else if (ay > ax * 1.18) {
        beginVertical(shot);
      }
    }
    if (shot.lock !== 'horizontal' || !shot.ctrl || shot.ctrl.destroyed) return;

    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    holdVertical(shot);
    setTrack(shot.ctrl, shot.basePage, dragDistance(shot, dx), true);
  }, { passive: false, capture: true });

  document.addEventListener('touchend', event => {
    const shot = gesture;
    if (!shot || !event.changedTouches?.length) { resetGesture(); return; }
    const point = event.changedTouches[0];
    const dx = point.clientX - shot.x;
    const dy = point.clientY - shot.y;
    const elapsed = Math.max(1, performance.now() - shot.startedAt);
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    if (shot.lock === 'pending') {
      if (ax >= 42 && ax > ay * 1.18) beginHorizontal(shot);
      else if (ay > ax * 1.18) beginVertical(shot);
    }

    if (shot.lock === 'horizontal' && shot.ctrl && !shot.ctrl.destroyed) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      holdVertical(shot);
      const width = Math.max(280, Number(shot.card.clientWidth || window.innerWidth || 390));
      const threshold = Math.min(58, Math.max(42, width * 0.14));
      const velocity = ax / elapsed;
      const commit = ax >= threshold || (ax >= 28 && velocity >= 0.42);
      let target = shot.basePage;
      if (commit) target += dx < 0 ? 1 : -1;
      target = Math.max(0, Math.min(PAGE_COUNT - 1, target));
      shot.card.classList.remove('reader-deep-dragging');
      unlockFeed(shot);
      setPage(shot.card, shot.ctrl, target, { unwrapNow: target === 0 });
      gesture = null;
      return;
    }
    resetGesture();
  }, { passive: false, capture: true });

  document.addEventListener('touchcancel', () => {
    const shot = gesture;
    if (shot?.ctrl && !shot.ctrl.destroyed) {
      shot.card.classList.remove('reader-deep-dragging');
      setTrack(shot.ctrl, shot.ctrl.page, 0, false);
    }
    resetGesture();
  }, { passive: true, capture: true });
}

styles();
capture();
installGesture();
