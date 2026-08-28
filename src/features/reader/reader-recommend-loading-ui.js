import { state } from '../../app/store.js';

const upstreamFetch = globalThis.fetch?.bind(globalThis);
const sessions = new WeakMap();
const KNOWN_RSS_SOURCE = [
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/monoist\.xml(?:\?|$)/i, 'monoist'],
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/eetimes\.xml(?:\?|$)/i, 'eetimes'],
  [/^https?:\/\/(?:www\.)?gigazine\.net\/news\/rss_2\.0\/(?:\?|$)/i, 'gigazine']
];

function normalizeComparable(value = '') {
  try {
    const url = new URL(String(value || ''), location.origin);
    url.searchParams.delete('_fresh');
    return `${url.pathname}${url.search}`;
  } catch { return String(value || ''); }
}

function targetForFeed(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return normalizeComparable(raw);
  const known = KNOWN_RSS_SOURCE.find(([pattern]) => pattern.test(raw));
  if (known) return `/api/rss?source=${encodeURIComponent(known[1])}`;
  return `/api/rss?url=${encodeURIComponent(raw)}`;
}

function requestContext(input) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }

  if (url.pathname === '/api/summary' && url.searchParams.get('technologyResearch') === '1') {
    return { key: 'technology', label: '改善事例を取得', total: 1 };
  }
  if (url.pathname === '/api/creative-papers-feed') {
    return { key: 'creative', label: '一般独創を取得', total: 1 };
  }

  const request = normalizeComparable(url.href);
  const newsFeeds = Array.isArray(state?.newsFeeds) ? state.newsFeeds : [];
  if (newsFeeds.some(feed => targetForFeed(feed?.url) === request)) {
    return { key: 'news', label: 'ニュースを取得', total: Math.max(1, newsFeeds.length) };
  }
  const knowledgeFeeds = Array.isArray(state?.knowledgeFeeds) ? state.knowledgeFeeds : [];
  if (knowledgeFeeds.some(feed => targetForFeed(feed?.url) === request)) {
    return { key: 'knowledge', label: '知識を取得', total: Math.max(1, knowledgeFeeds.length) };
  }
  return null;
}

function createRow(list, key, label, { beforeKey = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'reader-recommend-progress';
  row.dataset.readerLoadingStage = key;
  row.style.margin = '0';

  const status = document.createElement('span');
  status.textContent = label;
  const track = document.createElement('div');
  track.className = 'reader-recommend-progress-track';
  const fill = document.createElement('div');
  fill.className = 'reader-recommend-progress-fill';
  fill.style.setProperty('--reader-recommend-progress', '0');
  track.append(fill);
  const value = document.createElement('span');
  value.className = 'reader-recommend-progress-value';
  value.textContent = '0%';
  row.append(status, track, value);

  const before = beforeKey ? list.querySelector(`[data-reader-loading-stage="${beforeKey}"]`) : null;
  if (before) list.insertBefore(row, before);
  else list.append(row);
  return { row, status, fill, value, percent: 0 };
}

function setRow(stage, percent, text = '') {
  if (!stage) return;
  const next = Math.max(stage.percent || 0, Math.min(100, Math.round(Number(percent) || 0)));
  stage.percent = next;
  stage.fill.style.setProperty('--reader-recommend-progress', String(next / 100));
  stage.value.textContent = `${next}%`;
  if (text) stage.status.textContent = text;
}

function loadingBox() {
  return document.querySelector('.reader-recommendations-open .reader-recommend-loading');
}

function ensureSession() {
  const box = loadingBox();
  if (!box) return null;
  const existing = sessions.get(box);
  if (existing) return existing;

  const original = box.querySelector('.reader-recommend-progress');
  if (!original) return null;
  original.style.display = 'none';

  const list = document.createElement('div');
  list.className = 'reader-recommend-stage-list';
  list.style.display = 'grid';
  list.style.gap = '12px';
  list.style.width = '100%';
  list.style.marginTop = '4px';
  box.append(list);

  const stage = {
    cache: createRow(list, 'cache', '保存済みReader記事を確認'),
    sort: createRow(list, 'sort', 'おすすめ順を整理'),
    display: createRow(list, 'display', 'カード表示を準備')
  };
  setRow(stage.cache, 12, '保存済みReader記事を確認中');

  const session = {
    box, list, original, stage,
    networkStarted: false,
    cacheLoadSeen: new Set(),
    network: new Map(),
    observer: null
  };
  sessions.set(box, session);

  const originalStatus = original.querySelector('span');
  const syncFromOriginal = () => {
    const text = String(originalStatus?.textContent || '');
    if (!text || !box.isConnected) return;

    const cachedStatus = /ニュースを最新化しました|知識を最新化しました|改善事例を確認しました/.test(text);
    if (cachedStatus && !session.networkStarted) {
      setRow(stage.cache, 100, '保存済みReader記事を確認しました');
      if (!stage.cacheLoad) stage.cacheLoad = createRow(list, 'cache-load', '保存済み記事を読み込み', { beforeKey: 'sort' });
      if (/ニュース/.test(text)) session.cacheLoadSeen.add('news');
      else if (/知識/.test(text)) session.cacheLoadSeen.add('knowledge');
      else if (/改善事例/.test(text)) session.cacheLoadSeen.add('technology');
      const expected = /技術リサーチ全タブ/.test(String(box.textContent || '')) ? 2 : 3;
      setRow(stage.cacheLoad, Math.min(100, Math.max(34, session.cacheLoadSeen.size / expected * 100)), '保存済み記事を読み込み中');
    }

    if (/整理中|選別中/.test(text)) {
      if (!session.networkStarted) {
        setRow(stage.cache, 100, '保存済みReader記事を確認しました');
        if (!stage.cacheLoad) stage.cacheLoad = createRow(list, 'cache-load', '保存済み記事を読み込み', { beforeKey: 'sort' });
        setRow(stage.cacheLoad, 100, '保存済み記事を読み込みました');
      }
      setRow(stage.sort, 78, 'おすすめ順を整理中');
    }
    if (/おすすめを表示します/.test(text)) {
      if (stage.cacheLoad) setRow(stage.cacheLoad, 100, '保存済み記事を読み込みました');
      session.network.forEach(row => setRow(row.stage, 100, `${row.label}しました`));
      setRow(stage.sort, 100, 'おすすめ順を整理しました');
      setRow(stage.display, 100, 'カードを表示します');
    }
  };
  session.observer = new MutationObserver(syncFromOriginal);
  session.observer.observe(original, { subtree: true, childList: true, characterData: true });
  syncFromOriginal();
  return session;
}

function startNetwork(session, context) {
  if (!session || !context) return null;
  session.networkStarted = true;
  setRow(session.stage.cache, 100, '保存済み記事なし・最新記事を取得します');
  if (session.stage.cacheLoad?.row?.isConnected) session.stage.cacheLoad.row.remove();
  session.stage.cacheLoad = null;

  let row = session.network.get(context.key);
  if (!row) {
    const stage = createRow(session.list, `network-${context.key}`, context.label, { beforeKey: 'sort' });
    row = { stage, label: context.label.replace(/を取得$/, ''), total: Math.max(1, context.total || 1), started: 0, completed: 0 };
    session.network.set(context.key, row);
  }
  row.started += 1;
  const activePercent = Math.min(85, Math.max(12, row.completed / row.total * 100 + 12));
  setRow(row.stage, activePercent, `${row.label}を取得中`);
  return row;
}

function finishNetwork(row, ok) {
  if (!row) return;
  row.completed += 1;
  const percent = Math.min(100, row.completed / row.total * 100);
  const label = ok ? `${row.label}を取得中` : `${row.label}の取得を確認中`;
  setRow(row.stage, percent, percent >= 100 ? `${row.label}を取得しました` : label);
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_READER_RECOMMEND_LOADING_UI_INSTALLED) {
  window.__PDV2_READER_RECOMMEND_LOADING_UI_INSTALLED = true;

  const mountObserver = new MutationObserver(() => { ensureSession(); });
  mountObserver.observe(document.documentElement, { subtree: true, childList: true });

  globalThis.fetch = async function readerRecommendationLoadingUiFetch(input, init = {}) {
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    if (method !== 'GET') return upstreamFetch(input, init);
    const session = ensureSession();
    if (!session) return upstreamFetch(input, init);
    const context = requestContext(input);
    if (!context) return upstreamFetch(input, init);

    const row = startNetwork(session, context);
    try {
      const response = await upstreamFetch(input, init);
      finishNetwork(row, response?.ok !== false);
      return response;
    } catch (error) {
      finishNetwork(row, false);
      throw error;
    }
  };
}
