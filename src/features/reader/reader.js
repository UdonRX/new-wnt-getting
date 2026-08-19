import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager } from '../../shared/components.js';
import { loadReader, feedsFor, readReaderCache } from './reader-data.js';
import { chooseTop } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';
import { iconSvg } from '../../shared/icons.js';

const READER_MODES = ['news', 'knowledge', 'papers'];

let view = 'list';
let allItems = [];
let focusHandle = null;
let modeSwipeDetach = null;
let recommendationIndex = 0;
let articleIndex = 0;
let openedArticle = null;
let readerSessionStarted = false;

function readerItemKey(item) {
  return String(item?.id || item?.link || item?.url || `${item?.source || ''}|${item?.title || ''}`);
}

function recommendationWindowJst(now = Date.now()) {
  const JST = 9 * 60 * 60 * 1000;
  const jst = new Date(now + JST);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();
  const h = jst.getUTCHours();

  const startHour = h < 6 ? 0 : h < 12 ? 6 : h < 18 ? 12 : 18;
  const nextHour = h < 6 ? 6 : h < 12 ? 12 : h < 18 ? 18 : 24;
  const key = h < 6 ? 'late' : h < 12 ? 'morning' : h < 18 ? 'noon' : 'night';

  const start = Date.UTC(y, m, d, startHour, 0, 0) - JST;
  const until = nextHour === 24
    ? Date.UTC(y, m, d + 1, 0, 0, 0) - JST
    : Date.UTC(y, m, d, nextHour, 0, 0) - JST;

  return {
    day: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    key,
    start,
    until
  };
}

function itemPubMs(item) {
  const ms = new Date(item?.pubDate || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function newestFirst(items) {
  return [...items].sort((a, b) => itemPubMs(b) - itemPubMs(a));
}

/*
 * ニュース/知識:
 * 今の「未明・朝・昼・夜」の開始以降に公開された記事を全部おすすめ対象にする。
 * その時間帯に1件も無い場合だけ、直近12時間へ広げる。
 * 件数のslice()はしない。
 */
function freshRecommendationItems(items, windowInfo) {
  const now = Date.now();
  const dated = newestFirst(items).filter(item => itemPubMs(item) > 0);
  const currentWindow = dated.filter(item => {
    const ms = itemPubMs(item);
    return ms >= windowInfo.start && ms <= now + 5 * 60 * 1000;
  });
  if (currentWindow.length) return currentWindow;

  const recent = dated.filter(item => itemPubMs(item) >= now - 12 * 60 * 60 * 1000);
  if (recent.length) return recent;

  // pubDateを持たない独自RSSでも完全に空にしない。
  return newestFirst(items);
}

/*
 * 論文:
 * 更新頻度が低いので時間帯では切らず、直近1年の対象論文を既存heuristicで順位付け。
 * limitは候補総数を渡すため「3件/5件」等の固定上限を設けない。
 * まず未読を全部、全て既読なら順位付き候補を全部返す。
 */
function paperRecommendationItems(items, readSet) {
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const recent = newestFirst(items).filter(item => {
    const ms = itemPubMs(item);
    return !ms || ms >= cutoff;
  });
  const ranked = chooseTop(recent, 'papers', readSet, recent.length, []);
  const unread = ranked.filter(item => !readSet.has(item.id));
  return unread.length ? unread : ranked;
}

function interleaveAll(buckets) {
  const rows = buckets.map(bucket => Array.isArray(bucket) ? bucket : []);
  const out = [];
  let index = 0;
  while (rows.some(bucket => index < bucket.length)) {
    rows.forEach(bucket => {
      if (bucket[index]) out.push(bucket[index]);
    });
    index += 1;
  }
  return uniqueItems(out);
}


/*
 * 「読む」から別画面へ出たら、次回入った時にだけおすすめを再表示する。
 * Reader内部のカテゴリ切替・小タブ切替ではリセットしない。
 */
window.addEventListener('pdv2:before-navigate', event => {
  const target = event?.detail?.screen;
  if (target !== 'reader' || state.screen !== 'reader') {
    readerSessionStarted = false;
  }
});

const paperTrack = () => state.paperTrack === 'creative' ? 'creative' : 'core';
const creativeFamily = () => ['applied', 'general'].includes(state.creativePaperFamily)
  ? state.creativePaperFamily
  : 'all';
const contextId = (mode, track = 'core') => mode === 'papers' ? `papers:${track}` : mode;
const readKey = (mode, track) => `pdv2:read:${contextId(mode, track)}`;
const selectedFeedKey = mode => `pdv2:readerSelectedFeed:${mode}`;
const getRead = (mode, track) => new Set(JSON.parse(localStorage.getItem(readKey(mode, track)) || '[]'));
const saveRead = (mode, track, set) => localStorage.setItem(readKey(mode, track), JSON.stringify([...set].slice(-1500)));
const lastSeenKey = (mode, track, family = 'all') => `pdv2:lastReaderSeen:${contextId(mode, track)}:${track === 'creative' ? family : 'all'}`;
const rankKey = (mode, track, family = 'all') => `pdv2:rank:${contextId(mode, track)}:${track === 'creative' ? family : 'all'}`;

function modeLabel(mode) {
  return mode === 'papers' ? '論文' : mode === 'knowledge' ? '知識' : 'ニュース';
}

function recommendationLabel(mode, track = 'core', family = 'all') {
  if (mode === 'papers') {
    if (track !== 'creative') return 'おすすめ論文';
    if (family === 'general') return '一般独創のおすすめ';
    if (family === 'applied') return '応用発想のおすすめ';
    return '独創研究のおすすめ';
  }
  return 'おすすめ';
}

function creativeFamiliesOf(item) {
  const text = String(item?.description || '');
  const result = [];
  if (/独創区分:\s*[^\n]*応用発想/i.test(text)) result.push('applied');
  if (/独創区分:\s*[^\n]*一般独創/i.test(text)) result.push('general');
  if (!result.length) result.push('applied');
  return result;
}

function filterCreativeItems(items, family) {
  return family === 'all'
    ? items
    : items.filter(item => creativeFamiliesOf(item).includes(family));
}

function creativeRankMode(family) {
  return family === 'general'
    ? 'papers-creative-general'
    : family === 'applied'
      ? 'papers-creative-applied'
      : 'papers-creative-all';
}

function getSelectedFeed(mode) {
  return localStorage.getItem(selectedFeedKey(mode)) || '';
}

function setSelectedFeed(mode, name) {
  localStorage.setItem(selectedFeedKey(mode), name || '');
}

function itemDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/(?:公開年|出版年):\s*(\d{4})/);
  if (/日付精度:\s*不明/.test(description)) return '日付不明';
  if (/日付精度:\s*年/.test(description) && yearOnly) return `${yearOnly[1]}年`;
  return shortDate(item?.pubDate);
}

function centerActiveChip(chips, { behavior = 'auto' } = {}) {
  // 古い選択位置を一度動かしてから戻す処理を避けるため、
  // 新DOMが描画された後に「現在のactive」だけへ1回スクロールする。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!chips?.isConnected) return;
    const active = chips.querySelector('.chip.active');
    if (!active) return;
    const max = Math.max(0, chips.scrollWidth - chips.clientWidth);
    const target = Math.max(0, Math.min(max,
      active.offsetLeft - (chips.clientWidth - active.offsetWidth) / 2
    ));
    chips.scrollTo({ left: target, behavior });
  }));
}

function attachReaderListSwipe(host, { left, right, threshold = 68 } = {}) {
  let start = null;
  let horizontal = false;

  const clear = () => {
    start = null;
    horizontal = false;
    host.classList.remove('reader-horizontal-swiping');
    if (document.activeElement?.matches?.('.reader-content-host .list-item')) document.activeElement.blur();
  };

  const onStart = event => {
    if (event.touches?.length !== 1) return clear();
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
    horizontal = false;
  };

  const onMove = event => {
    if (!start || event.touches?.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      horizontal = true;
      host.classList.add('reader-horizontal-swiping');
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    if (horizontal && event.cancelable) event.preventDefault();
  };

  const onEnd = event => {
    if (!start || !event.changedTouches?.length) return clear();
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const isSwipe = Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2;
    const direction = dx < 0 ? 'left' : 'right';
    clear();
    if (!isSwipe) return;
    if (direction === 'left') left?.();
    else right?.();
  };

  host.addEventListener('touchstart', onStart, { passive: true });
  host.addEventListener('touchmove', onMove, { passive: false });
  host.addEventListener('touchend', onEnd, { passive: true });
  host.addEventListener('touchcancel', clear, { passive: true });
  return () => {
    host.removeEventListener('touchstart', onStart);
    host.removeEventListener('touchmove', onMove);
    host.removeEventListener('touchend', onEnd);
    host.removeEventListener('touchcancel', clear);
    clear();
  };
}

function manageFeeds(mode, rerender) {
  const key = mode === 'papers'
    ? 'paperFeeds'
    : mode === 'knowledge'
      ? 'knowledgeFeeds'
      : 'newsFeeds';

  const sheet = openSheet(collectionManager({
    items: state[key],
    fields: [
      { key: 'name', label: 'タブ名', placeholder: '名称' },
      { key: 'url', label: 'RSS URL', placeholder: 'https://... または /api/...' }
    ],
    onSave: draft => {
      update(key, draft);
      sheet.close();
      setSelectedFeed(mode, '');
      view = 'list';
      rerender(true);
    }
  }), { title: `${modeLabel(mode)}のタブ編集` });
}

function buildFeedChips(mode, onChange) {
  if (mode === 'papers') return null;

  const feeds = feedsFor(mode);
  if (feeds.length <= 1) return null;

  const selected = getSelectedFeed(mode);
  const chips = el('div', { class: 'chips reader-feed-chips' });

  chips.append(el('button', {
    class: `chip ${!selected ? 'active' : ''}`,
    type: 'button',
    text: 'All',
    onclick: () => {
      setSelectedFeed(mode, '');
      onChange();
    }
  }));

  feeds.forEach(feed => chips.append(el('button', {
    class: `chip ${selected === feed.name ? 'active' : ''}`,
    type: 'button',
    text: feed.name,
    onclick: () => {
      setSelectedFeed(mode, feed.name);
      onChange();
    }
  })));

  centerActiveChip(chips, { behavior: 'auto' });
  return chips;
}

function buildPaperTrackLevel(onChange) {
  const wrap = el('div', { class: 'paper-track-level' });
  wrap.append(segmented([
    { value: 'core', label: '製品・熱研究' },
    { value: 'creative', label: '独創研究' }
  ], paperTrack(), onChange));
  return wrap;
}

function buildCreativeFamilyTabs(onChange) {
  const family = creativeFamily();
  const row = el('div', { class: 'paper-family-row chips' });

  [
    { value: 'all', label: 'すべて' },
    { value: 'applied', label: '応用発想' },
    { value: 'general', label: '一般独創' }
  ].forEach(item => row.append(el('button', {
    class: `chip ${family === item.value ? 'active' : ''}`,
    type: 'button',
    text: item.label,
    onclick: () => onChange(item.value)
  })));

  centerActiveChip(row, { behavior: 'auto' });
  return row;
}

function renderList(host, mode, track, family, items, onOpen) {
  const read = getRead(mode, track);
  const lastSeen = Number(localStorage.getItem(lastSeenKey(mode, track, family)) || 0);
  const newCount = items.filter(item => new Date(item.pubDate).getTime() > lastSeen).length;

  const header = el('div', { class: 'reader-list-toolbar' }, [
    el('div', { class: 'reader-list-header' }, [
      el('strong', { text: newCount ? `前回から ${newCount}件` : '全記事' }),
      el('small', { text: ` ${items.length}件` })
    ])
  ]);

  const search = el('input', {
    class: 'reader-search',
    placeholder: 'タイトル・媒体を検索'
  });

  const list = el('div', { class: 'list' });

  const draw = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();

    items
      .filter(item => !q || `${item.title} ${item.titleJa || ''} ${item.source}`.toLowerCase().includes(q))
      .forEach((item, index) => {
        const unread = !read.has(item.id);
        const button = el('button', {
          class: 'list-item',
          type: 'button',
          onclick: () => {
            read.add(item.id);
            saveRead(mode, track, read);
            onOpen(item, index);
          }
        });

        button.innerHTML = `
          <div class="list-item-title">${unread ? '<span class="unread-dot"></span>' : ''}${item.titleJa || item.title}</div>
          ${item.titleJa ? `<div class="focus-original">${item.title}</div>` : ''}
          <div class="list-meta"><span>${item.source || ''}</span><span>${itemDateLabel(item)}</span></div>
        `;
        list.append(button);
      });
  };

  search.addEventListener('input', draw);
  draw();
  host.replaceChildren(header, search, list);
  localStorage.setItem(lastSeenKey(mode, track, family), String(Date.now()));
}

function cachedAiRanking(mode, track, family = 'all') {
  try {
    const data = JSON.parse(localStorage.getItem(rankKey(mode, track, family)) || 'null');
    if (!data?.ranking?.length || Date.now() - Number(data.at || 0) > 6 * 60 * 60 * 1000) return [];
    return data.ranking;
  } catch {
    return [];
  }
}


function tagRecommendation(item, mode, track = 'core') {
  return {
    ...item,
    _readerMode: mode,
    _paperTrack: track,
    _recommendationLabel: mode === 'news' ? 'ニュース' : mode === 'knowledge' ? '知識' : '論文'
  };
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item?.id || item?.link || item?.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadMixedRecommendations(force = false, onProgress = () => {}) {
  const cacheKey = 'pdv2:mixedRecommendations:v211';
  const CACHE_TTL = 2 * 60 * 60 * 1000;

  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached?.items?.length && Date.now() - Number(cached.at || 0) < CACHE_TTL) {
        onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news','knowledge','papers'], cached: true });
        return cached.items.map(item => ({ ...item, pubDate: new Date(item.pubDate) }));
      }
    } catch {}
  }

  const done = new Set();
  const updateProgress = (bucket, label) => {
    done.add(bucket);
    const percent = 8 + Math.round(done.size / 3 * 88);
    onProgress({ percent, label, done: [...done] });
  };
  onProgress({ percent: 8, label: '候補を準備しています', done: [] });

  const newsJob = loadReader('news', {
    force,
    selectedFeed: '',
    preferCache: !force
  }).then(result => {
    updateProgress('news', 'ニュースを選びました');
    return result?.items || [];
  }).catch(() => {
    updateProgress('news', 'ニュースを確認しました');
    return readReaderCache('news')?.items || [];
  });

  const knowledgeJob = loadReader('knowledge', {
    force,
    selectedFeed: '',
    preferCache: !force
  }).then(result => {
    updateProgress('knowledge', '知識を選びました');
    return result?.items || [];
  }).catch(() => {
    updateProgress('knowledge', '知識を確認しました');
    return readReaderCache('knowledge')?.items || [];
  });

  const papersJob = (async () => {
    const cachedCore = !force ? readReaderCache('papers', 'core')?.items || [] : [];
    const cachedCreative = !force ? readReaderCache('papers', 'creative')?.items || [] : [];
    if (cachedCore.length || cachedCreative.length) {
      updateProgress('papers', '論文を選びました');
      return { core: cachedCore, creative: cachedCreative };
    }

    // 初回でも deep 検索を待たない。fast だけを並列取得し、Reader表示を先に返す。
    const [coreResult, creativeResult] = await Promise.allSettled([
      loadReader('papers', { force, selectedFeed: '', paperTrack: 'core', fastOnly: true }),
      loadReader('papers', { force, selectedFeed: '', paperTrack: 'creative', fastOnly: true })
    ]);
    updateProgress('papers', '論文を選びました');
    return {
      core: coreResult.status === 'fulfilled' ? coreResult.value?.items || [] : [],
      creative: creativeResult.status === 'fulfilled' ? creativeResult.value?.items || [] : []
    };
  })().catch(() => {
    updateProgress('papers', '論文を確認しました');
    return {
      core: readReaderCache('papers', 'core')?.items || [],
      creative: readReaderCache('papers', 'creative')?.items || []
    };
  });

  const [newsRows, knowledgeRows, paperRows] = await Promise.all([newsJob, knowledgeJob, papersJob]);

  const news = uniqueItems(newsRows).map(item => tagRecommendation(item, 'news', 'core'));
  const knowledge = uniqueItems(knowledgeRows).map(item => tagRecommendation(item, 'knowledge', 'core'));
  const core = uniqueItems(paperRows.core || []).map(item => tagRecommendation(item, 'papers', 'core'));
  const creative = uniqueItems(paperRows.creative || []).map(item => tagRecommendation(item, 'papers', 'creative'));

  const newsTop = chooseTop(news, 'news', getRead('news', 'core'), Math.min(4, news.length), []);
  const knowledgeTop = chooseTop(knowledge, 'knowledge', getRead('knowledge', 'core'), Math.min(4, knowledge.length), []);
  const coreTop = chooseTop(core, 'papers', getRead('papers', 'core'), Math.min(3, core.length), []);
  const creativeTop = chooseTop(creative, 'papers', getRead('papers', 'creative'), Math.min(3, creative.length), []);

  const paperTop = [];
  for (let i = 0; i < 3; i += 1) {
    if (coreTop[i]) paperTop.push(coreTop[i]);
    if (creativeTop[i]) paperTop.push(creativeTop[i]);
  }

  const mixed = [];
  const buckets = [newsTop, knowledgeTop, paperTop];
  for (let i = 0; i < 4; i += 1) buckets.forEach(bucket => { if (bucket[i]) mixed.push(bucket[i]); });
  const result = uniqueItems(mixed).slice(0, 10);

  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: result })); } catch {}
  onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news','knowledge','papers'] });
  return result;
}

export function warmReaderRecommendations() {
  return loadMixedRecommendations(false, () => {});
}

function createRecommendationLoader() {
  const card = el('div', { class: 'card recommendation-loading-card' });
  const title = el('strong', { text: '今日のおすすめを選んでいます' });
  const label = el('div', { class: 'recommendation-loading-label', text: '候補を準備しています' });
  const track = el('div', { class: 'recommendation-loading-track' });
  const fill = el('div', { class: 'recommendation-loading-fill' });
  track.append(fill);
  const steps = el('div', { class: 'recommendation-loading-steps' });
  const stepNodes = new Map();
  [['news','ニュース'],['knowledge','知識'],['papers','論文']].forEach(([key, text]) => {
    const node = el('span', { text });
    stepNodes.set(key, node);
    steps.append(node);
  });
  card.append(title, label, track, steps);
  return {
    node: card,
    update(state = {}) {
      fill.style.width = `${Math.max(6, Math.min(100, Number(state.percent || 0)))}%`;
      if (state.label) label.textContent = state.label;
      const done = new Set(state.done || []);
      stepNodes.forEach((node, key) => node.classList.toggle('done', done.has(key)));
    }
  };
}

function markRecommendationRead(item) {
  const mode = item?._readerMode || 'news';
  const track = item?._paperTrack || 'core';
  const read = getRead(mode, track);
  read.add(item.id);
  saveRead(mode, track, read);
}

function scrollContentToTop(host) {
  requestAnimationFrame(() => {
    if (!host?.isConnected) return;
    host.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
}

export async function renderReader(root, { navigate, refresh = false }) {
  allItems = [];
  focusHandle?.destroy?.();
  focusHandle = null;
  modeSwipeDetach?.();
  modeSwipeDetach = null;

  const firstEntry = !readerSessionStarted;
  readerSessionStarted = true;

  // V2.10: Readerへ外から入った時だけ、ニュース・知識・論文を横断したおすすめを表示。
  // おすすめを閉じた後の起点は必ず「ニュース / All」に統一する。
  if (firstEntry) {
    update('lastReaderMode', 'news');
    setSelectedFeed('news', '');
    view = 'recommendations';
    recommendationIndex = 0;
  }

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';

  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root, { navigate, refresh: force });

  screen.append(topbar('読む', {
    subtitle: mode === 'papers'
      ? (track === 'creative' ? '論文・独創研究' : '論文・製品／熱研究')
      : 'ニュース・知識・論文',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manageFeeds(mode, rerender) },
      { label: '↻', title: '更新', onClick: () => rerender(true) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const switchMode = value => {
    if (!READER_MODES.includes(value) || value === mode) return;
    update('lastReaderMode', value);
    view = 'list';
    articleIndex = 0;
    renderReader(root, { navigate });
  };

  const cycleMode = delta => {
    const index = READER_MODES.indexOf(mode);
    const next = Math.max(0, Math.min(READER_MODES.length - 1, index + delta));
    if (next !== index) switchMode(READER_MODES[next]);
  };

  const modeNav = el('div', { class: 'reader-mode-nav' });
  modeNav.append(segmented([
    { value: 'news', label: 'ニュース' },
    { value: 'knowledge', label: '知識' },
    { value: 'papers', label: '論文' }
  ], mode, switchMode));
  screen.append(modeNav);

  modeSwipeDetach = attachSwipe(modeNav, {
    left: () => cycleMode(1),
    right: () => cycleMode(-1),
    threshold: 40
  });

  if (mode === 'papers') {
    screen.append(buildPaperTrackLevel(value => {
      update('paperTrack', value);
      view = 'list';
      articleIndex = 0;
      renderReader(root, { navigate });
    }));
  }

  const sticky = el('div', { class: 'reader-sticky-context' });
  const lowestTabsHost = el('div', { class: 'reader-lowest-tabs-host' });
  const progressHost = el('div', { class: 'reader-progress-host' });

  if (mode !== 'papers') {
    const chips = buildFeedChips(mode, () => {
      view = 'list';
      articleIndex = 0;
      renderReader(root, { navigate });
    });
    if (chips) lowestTabsHost.append(chips);
  } else if (track === 'creative') {
    lowestTabsHost.append(buildCreativeFamilyTabs(value => {
      update('creativePaperFamily', value);
      view = 'list';
      articleIndex = 0;
      renderReader(root, { navigate });
    }));
  }

  sticky.append(lowestTabsHost, progressHost);
  screen.append(sticky);

  const host = el('div', { class: 'reader-content-host' });
  screen.append(host);
  root.replaceChildren(screen);
  host.append(el('div', { class: 'card', html: '<div class="loading">読み込み中...</div>' }));

  if (mode === 'papers') {
    window.addEventListener('pdv2:paper-titles', () => {
      try {
        const translated = JSON.parse(localStorage.getItem('pdv2:paperTitleJa') || '{}');
        allItems.forEach(item => {
          if (translated[item.title]) item.titleJa = translated[item.title];
        });
        if (allItems.length) renderContent();
      } catch {}
    }, { once: true });
  }

  let chosen = [];
  let recommendationItems = [];

  const goLeaf = ({ nextMode = mode, feed, nextTrack, family } = {}) => {
    if (nextMode !== mode) update('lastReaderMode', nextMode);
    if (feed !== undefined && nextMode !== 'papers') setSelectedFeed(nextMode, feed);
    if (nextMode === 'papers' && nextTrack) update('paperTrack', nextTrack);
    if (nextMode === 'papers' && family) update('creativePaperFamily', family);
    view = 'list';
    articleIndex = 0;
    renderReader(root, { navigate });
  };

  const lastFeedName = targetMode => {
    const names = feedsFor(targetMode).map(feed => feed.name).filter(Boolean);
    return names[names.length - 1] || '';
  };

  const cycleFeed = delta => {
    const names = ['', ...feedsFor(mode).map(feed => feed.name)];
    const current = getSelectedFeed(mode);
    const index = Math.max(0, names.indexOf(current));
    const nextIndex = index + delta;

    if (nextIndex >= 0 && nextIndex < names.length) {
      setSelectedFeed(mode, names[nextIndex]);
      view = 'list';
      articleIndex = 0;
      renderReader(root, { navigate });
      return;
    }

    // ニュース右端 → 知識 All / 知識 All → ニュース右端
    if (mode === 'news' && delta > 0) {
      goLeaf({ nextMode: 'knowledge', feed: '' });
      return;
    }
    if (mode === 'knowledge' && delta < 0) {
      goLeaf({ nextMode: 'news', feed: lastFeedName('news') });
      return;
    }

    // 知識右端 → 論文「製品・熱研究」
    if (mode === 'knowledge' && delta > 0) {
      goLeaf({ nextMode: 'papers', nextTrack: 'core' });
    }
  };

  const cyclePaperCore = delta => {
    if (delta > 0) {
      // 製品・熱研究 → 独創研究「すべて」
      goLeaf({ nextMode: 'papers', nextTrack: 'creative', family: 'all' });
    } else {
      // 製品・熱研究 → 知識右端
      goLeaf({ nextMode: 'knowledge', feed: lastFeedName('knowledge') });
    }
  };

  const cycleCreativeFamily = delta => {
    const families = ['all', 'applied', 'general'];
    const current = creativeFamily();
    const index = Math.max(0, families.indexOf(current));
    const next = index + delta;

    if (next >= 0 && next < families.length) {
      update('creativePaperFamily', families[next]);
      view = 'list';
      articleIndex = 0;
      renderReader(root, { navigate });
      return;
    }

    // 独創研究「すべて」から右スワイプ → 製品・熱研究
    if (delta < 0 && index === 0) goLeaf({ nextMode: 'papers', nextTrack: 'core' });
  };

  const horizontalOptions = mode === 'papers'
    ? (track === 'creative'
      ? {
          onPrevFeed: () => cycleCreativeFamily(-1),
          onNextFeed: () => cycleCreativeFamily(1),
          horizontalHint: '独創研究タブ'
        }
      : {
          onPrevFeed: () => cyclePaperCore(-1),
          onNextFeed: () => cyclePaperCore(1),
          horizontalHint: '論文タブ'
        })
    : {
        onPrevFeed: () => cycleFeed(-1),
        onNextFeed: () => cycleFeed(1),
        horizontalHint: 'RSSタブ'
      };

  const renderContent = () => {
    focusHandle?.destroy?.();
    focusHandle = null;
    progressHost.replaceChildren();

    if (view === 'recommendations') {
      if (!recommendationItems.length) {
        host.replaceChildren(el('div', { class: 'empty', text: 'おすすめを取得できませんでした。記事一覧を表示します。' }));
        setTimeout(() => {
          setSelectedFeed('news', '');
          update('lastReaderMode', 'news');
          view = 'list';
          renderReader(root, { navigate });
        }, 450);
        return;
      }

      recommendationIndex = Math.max(0, Math.min(recommendationIndex, recommendationItems.length - 1));
      host.replaceChildren();

      const closeRecommendations = () => {
        // ユーザー指定: おすすめ終了後は必ずニュースのAllへ。
        setSelectedFeed('news', '');
        update('lastReaderMode', 'news');
        view = 'list';
        recommendationIndex = 0;
        renderReader(root, { navigate });
      };

      focusHandle = mountFocus(host, {
        items: recommendationItems,
        initialIndex: recommendationIndex,
        label: 'おすすめ',
        progressHost,
        onStart: closeRecommendations,
        onList: closeRecommendations,
        onEnd: closeRecommendations,
        onIndexChange: (index, item) => {
          recommendationIndex = index;
          markRecommendationRead(item);
        },
        horizontalHint: 'おすすめ'
      });
      return;
    }

    const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
    const visibleItems = mode === 'papers' && track === 'creative'
      ? filterCreativeItems(allItems, family)
      : allItems;
    const rankMode = mode === 'papers' && track === 'creative'
      ? creativeRankMode(family)
      : mode;

    if (!visibleItems.length) {
      host.innerHTML = `<div class="empty">${track === 'creative' && family === 'general'
        ? '一般独創の候補を取得中です。更新すると再検索します。'
        : '記事がありません'}</div>`;
      return;
    }

    if (view === 'list') {
      renderList(host, mode, track, family, visibleItems, (_item, index) => {
        view = 'article';
        articleIndex = index;
        renderContent();
      });

      const detachListSwipe = attachReaderListSwipe(host, {
        left: horizontalOptions.onNextFeed,
        right: horizontalOptions.onPrevFeed,
        threshold: 68
      });
      focusHandle = { destroy: detachListSwipe };
      return;
    }

    if (view === 'article') {
      articleIndex = Math.max(0, Math.min(articleIndex, visibleItems.length - 1));
      host.replaceChildren();

      focusHandle = mountFocus(host, {
        items: visibleItems,
        initialIndex: articleIndex,
        label: '記事',
        progressHost: null,
        onStart: () => {
          view = 'list';
          renderContent();
          scrollContentToTop(host);
        },
        onList: () => {
          view = 'list';
          renderContent();
          scrollContentToTop(host);
        },
        onIndexChange: (index, item) => {
          articleIndex = index;
          const read = getRead(mode, track);
          read.add(item.id);
          saveRead(mode, track, read);
        },
        ...horizontalOptions
      });
      return;
    }

    // recommendations は上の専用分岐で処理する。

  };

  try {
    if (view === 'recommendations') {
      const loader = createRecommendationLoader();
      host.replaceChildren(loader.node);
      recommendationItems = await loadMixedRecommendations(refresh, progress => loader.update(progress));
      renderContent();
      return;
    }

    const selectedFeed = getSelectedFeed(mode);
    const result = await loadReader(mode, {
      force: refresh,
      selectedFeed,
      paperTrack: track,
      onProgress: items => {
        if (!allItems.length && items.length) {
          allItems = items;
          renderContent();
        }
      }
    });

    allItems = result.items;
    renderContent();

  } catch (err) {
    progressHost.replaceChildren();
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
