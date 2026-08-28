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
    return { key: 'technology', label: '改善事例', total: 1 };
  }
  if (url.pathname === '/api/creative-papers-feed') {
    return { key: 'creative', label: '一般独創', total: 1 };
  }

  const request = normalizeComparable(url.href);
  const newsFeeds = Array.isArray(state?.newsFeeds) ? state.newsFeeds : [];
  if (newsFeeds.some(feed => targetForFeed(feed?.url) === request)) {
    return { key: 'news', label: 'ニュース', total: Math.max(1, newsFeeds.length) };
  }
  const knowledgeFeeds = Array.isArray(state?.knowledgeFeeds) ? state.knowledgeFeeds : [];
  if (knowledgeFeeds.some(feed => targetForFeed(feed?.url) === request)) {
    return { key: 'knowledge', label: '知識', total: Math.max(1, knowledgeFeeds.length) };
  }
  return null;
}

function recommendationKind(box) {
  const text = String(box?.textContent || '');
  if (/ニュース・知識・改善事例/.test(text)) return 'mixed';
  if (/技術リサーチ全タブ/.test(text)) return 'papers';
  return 'scoped';
}

function createSingleProgress() {
  const row = document.createElement('div');
  row.className = 'reader-recommend-progress';
  row.dataset.readerLoadingStage = 'single';
  row.style.margin = '0';

  const status = document.createElement('span');
  status.textContent = '保存済みReader記事を確認中';
  const track = document.createElement('div');
  track.className = 'reader-recommend-progress-track';
  const fill = document.createElement('div');
  fill.className = 'reader-recommend-progress-fill';
  fill.style.setProperty('--reader-recommend-progress', '0.08');
  track.append(fill);
  const value = document.createElement('span');
  value.className = 'reader-recommend-progress-value';
  value.textContent = '8%';
  row.append(status, track, value);
  return { row, status, fill, value };
}

function setProgress(session, percent, text = '') {
  if (!session) return;
  const next = Math.max(session.percent || 0, Math.min(100, Math.round(Number(percent) || 0)));
  session.percent = next;
  session.single.fill.style.setProperty('--reader-recommend-progress', String(next / 100));
  session.single.value.textContent = `${next}%`;
  if (text) session.single.status.textContent = text;
}

function loadingBox() {
  return document.querySelector('.reader-recommendations-open .reader-recommend-loading');
}

function directDescription(box) {
  return Array.from(box?.children || []).find(node => node.tagName === 'SPAN') || null;
}

function expectedCacheSteps(kind) {
  if (kind === 'mixed') return 3;
  if (kind === 'papers') return 2;
  return 1;
}

function networkStatus(session) {
  const active = [...session.network.values()].filter(row => row.active > 0).map(row => row.label);
  const unique = [...new Set(active)];
  const label = unique.length ? `${unique.join('・')}を取得中` : '最新記事を取得中';
  const expected = Math.max(session.networkExpected, session.networkStarted, 1);
  return `${label}（${Math.min(session.networkCompleted, expected)}/${expected}）`;
}

function updateNetworkProgress(session) {
  const expected = Math.max(session.networkExpected, session.networkStarted, 1);
  const ratio = Math.min(1, session.networkCompleted / expected);
  setProgress(session, 18 + ratio * 60, networkStatus(session));
}

function ensureSession() {
  const box = loadingBox();
  if (!box) return null;
  const existing = sessions.get(box);
  if (existing) return existing;

  const original = box.querySelector('.reader-recommend-progress');
  if (!original) return null;
  const kind = recommendationKind(box);
  const single = createSingleProgress();
  original.style.display = 'none';
  box.append(single.row);

  const title = box.querySelector('strong');
  const description = directDescription(box);
  if (title) title.textContent = 'おすすめを準備しています…';
  if (description) description.textContent = '保存済みReader記事を優先してすばやく表示します';

  const session = {
    box, original, single, title, description, kind,
    percent: 8,
    cacheSeen: new Set(),
    networkStarted: 0,
    networkCompleted: 0,
    networkExpected: 0,
    networkStartedFlag: false,
    network: new Map(),
    observer: null
  };
  sessions.set(box, session);

  const originalStatus = original.querySelector('span');
  const syncFromOriginal = () => {
    const text = String(originalStatus?.textContent || '');
    if (!text || !box.isConnected) return;

    if (/おすすめを表示します/.test(text)) {
      setProgress(session, 100, 'カード表示を準備しました');
      return;
    }

    if (/整理中|選別中|新しい順に整理中/.test(text)) {
      setProgress(session, 86, 'おすすめ順を整理中');
      return;
    }

    if (!session.networkStartedFlag) {
      const cachedStatus = /ニュースを最新化しました|知識を最新化しました|改善事例を確認しました/.test(text);
      if (cachedStatus) {
        if (/ニュース/.test(text)) session.cacheSeen.add('news');
        else if (/知識/.test(text)) session.cacheSeen.add('knowledge');
        else if (/改善事例/.test(text)) session.cacheSeen.add('technology');
        const expected = expectedCacheSteps(session.kind);
        const done = Math.min(expected, session.cacheSeen.size);
        const percent = 20 + (done / expected) * 48;
        const label = done >= expected
          ? '保存済み記事を読み込みました'
          : `保存済み記事を読み込み中（${done}/${expected}）`;
        setProgress(session, percent, label);
        return;
      }

      if (/保存済みの技術リサーチを確認中/.test(text)) {
        setProgress(session, 15, '保存済みReader記事を確認中');
        return;
      }
      if (/技術リサーチ本体を更新確認中/.test(text)) {
        setProgress(session, 38, '保存済み技術リサーチを読み込み中');
        return;
      }
      if (/一般独創を高速確認中/.test(text)) {
        setProgress(session, 64, '保存済み一般独創を確認中');
        return;
      }
      if (/登録した取得先を均等に確認中/.test(text)) {
        setProgress(session, 62, '保存済み記事を読み込み中');
      }
    }
  };

  session.observer = new MutationObserver(syncFromOriginal);
  session.observer.observe(original, { subtree: true, childList: true, characterData: true });
  syncFromOriginal();
  return session;
}

function startNetwork(session, context) {
  if (!session || !context) return null;
  if (!session.networkStartedFlag) {
    session.networkStartedFlag = true;
    if (session.description) session.description.textContent = '保存済み記事がないため、最新記事を取得しています';
    setProgress(session, 18, `${context.label}を取得中`);
  }

  let row = session.network.get(context.key);
  if (!row) {
    row = { label: context.label, total: Math.max(1, context.total || 1), active: 0, started: 0, completed: 0 };
    session.network.set(context.key, row);
    session.networkExpected += row.total;
  }
  row.active += 1;
  row.started += 1;
  session.networkStarted += 1;
  updateNetworkProgress(session);
  return row;
}

function finishNetwork(session, row) {
  if (!session || !row) return;
  row.active = Math.max(0, row.active - 1);
  row.completed += 1;
  session.networkCompleted += 1;
  updateNetworkProgress(session);
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
      finishNetwork(session, row);
      return response;
    } catch (error) {
      finishNetwork(session, row);
      throw error;
    }
  };
}
