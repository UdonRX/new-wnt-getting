import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem } from '../../shared/components.js';
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

window.addEventListener('pdv2:before-navigate', event => {
  const target = event?.detail?.screen;
  if (target !== 'reader' || state.screen !== 'reader') {
    readerSessionStarted = false;
    openedArticle = null;
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
  return newestFirst(items);
}

function paperRecommendationItems(items, readSet) {
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const recent = newestFirst(items).filter(item => {
    const ms = itemPubMs(item);
    return !ms || ms >= cutoff;
  });
  if (!recent.length) return [];

  // chooseTop() は媒体偏りを抑える都合で、limitを全件数にしても
  // 同一媒体の記事を一部飛ばすことがある。おすすめ件数を固定しない
  // v2.14では、chooseTop() の上位順を先頭に置いたうえで残りも全件残す。
  const rankedHead = chooseTop(recent, 'papers', readSet, recent.length, []);
  const ranked = uniqueItems([...rankedHead, ...recent]);

  // 未読を先に並べるだけで、既読だから候補から消すことはしない。
  // これにより対象期間内の「おすすめにできる論文」は件数上限なしで表示できる。
  return [
    ...ranked.filter(item => !readSet.has(item.id)),
    ...ranked.filter(item => readSet.has(item.id))
  ];
}

function modeLabel(mode) {
  return mode === 'papers' ? '論文' : mode === 'knowledge' ? '知識' : 'ニュース';
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

function getSelectedFeed(mode) {
  return localStorage.getItem(selectedFeedKey(mode)) || '';
}

function setSelectedFeed(mode, name) {
  localStorage.setItem(selectedFeedKey(mode), name || '');
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
      openedArticle = null;
      articleIndex = 0;
      rerender(true);
    }
  }), { title: `${modeLabel(mode)}のタブ編集` });
}

function centerActiveChip(chips) {
  const active = chips?.querySelector('.chip.active');
  if (active) centerScrollItem(chips, active, { behavior: 'smooth' });
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

  requestAnimationFrame(() => centerActiveChip(chips));
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
  requestAnimationFrame(() => centerActiveChip(row));
  return row;
}

function itemDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/公開年:\s*((?:19|20)\d{2})/i)?.[1];
  if (yearOnly && /日付精度:\s*年/i.test(description)) return yearOnly;
  return shortDate(item.pubDate);
}

function renderList(host, mode, track, family, items, onOpen) {
  const read = getRead(mode, track);
  const lastSeen = Number(localStorage.getItem(lastSeenKey(mode, track, family)) || 0);
  const newCount = items.filter(item => itemPubMs(item) > lastSeen).length;

  const header = el('div', { class: 'reader-list-toolbar' }, [
    el('div', { class: 'reader-list-header' }, [
      el('strong', { text: newCount ? `前回から ${newCount}件` : '全記事' }),
      el('small', { text: ` ${items.length}件` })
    ])
  ]);

  const search = el('input', { class: 'reader-search', placeholder: 'タイトル・媒体を検索' });
  const list = el('div', { class: 'list' });

  const draw = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const visible = items.filter(item => !q || `${item.title} ${item.titleJa || ''} ${item.source} ${item.description || ''}`.toLowerCase().includes(q));

    visible.forEach(item => {
      const unread = !read.has(item.id);
      const button = el('button', {
        class: 'list-item',
        type: 'button',
        onclick: () => {
          read.add(item.id);
          saveRead(mode, track, read);
          onOpen(item);
        }
      });
      button.innerHTML = `
        <div class="list-item-title">${unread ? '<span class="unread-dot"></span>' : ''}${item.titleJa || item.title}</div>
        ${item.titleJa ? `<div class="focus-original">${item.title}</div>` : ''}
        <div class="list-meta"><span>${item.source || ''}</span><span>${itemDateLabel(item)}</span></div>
      `;
      list.append(button);
    });

    if (!visible.length) list.append(el('div', { class: 'empty', text: '検索結果がありません' }));
  };

  search.addEventListener('input', draw);
  draw();
  host.replaceChildren(header, search, list);
  localStorage.setItem(lastSeenKey(mode, track, family), String(Date.now()));
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
  return (items || []).filter(item => {
    const key = readerItemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

async function loadMixedRecommendations(force = false, onProgress = () => {}) {
  const windowInfo = recommendationWindowJst();
  const cacheKey = `pdv2:mixedRecommendations:v214:${windowInfo.day}:${windowInfo.key}`;
  const CACHE_TTL = Math.max(60 * 1000, Math.min(15 * 60 * 1000, windowInfo.until - Date.now()));

  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached?.items?.length && Date.now() - Number(cached.at || 0) < CACHE_TTL) {
        onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news', 'knowledge', 'papers'], cached: true });
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

  // ニュース・知識は15分キャッシュが切れたら実取得して旬のものへ更新する。
  const newsJob = loadReader('news', {
    force,
    selectedFeed: '',
    preferCache: false
  }).then(result => {
    updateProgress('news', '新着ニュースを確認しました');
    return result?.items || [];
  }).catch(() => {
    updateProgress('news', 'ニュースを確認しました');
    return readReaderCache('news')?.items || [];
  });

  const knowledgeJob = loadReader('knowledge', {
    force,
    selectedFeed: '',
    preferCache: false
  }).then(result => {
    updateProgress('knowledge', '新着の知識記事を確認しました');
    return result?.items || [];
  }).catch(() => {
    updateProgress('knowledge', '知識を確認しました');
    return readReaderCache('knowledge')?.items || [];
  });

  // 論文は更新頻度が低いのでキャッシュ優先。キャッシュが無い時のみfast取得を並列実行する。
  const papersJob = (async () => {
    const cachedCore = !force ? readReaderCache('papers', 'core')?.items || [] : [];
    const cachedCreative = !force ? readReaderCache('papers', 'creative')?.items || [] : [];
    if (cachedCore.length || cachedCreative.length) {
      updateProgress('papers', 'おすすめ論文を選びました');
      return { core: cachedCore, creative: cachedCreative };
    }

    const [coreResult, creativeResult] = await Promise.allSettled([
      loadReader('papers', { force, selectedFeed: '', paperTrack: 'core', fastOnly: true }),
      loadReader('papers', { force, selectedFeed: '', paperTrack: 'creative', fastOnly: true })
    ]);
    updateProgress('papers', 'おすすめ論文を選びました');
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

  const newsTop = freshRecommendationItems(news, windowInfo);
  const knowledgeTop = freshRecommendationItems(knowledge, windowInfo);
  const coreTop = paperRecommendationItems(core, getRead('papers', 'core'));
  const creativeTop = paperRecommendationItems(creative, getRead('papers', 'creative'));
  const paperTop = interleaveAll([coreTop, creativeTop]);
  const result = interleaveAll([newsTop, knowledgeTop, paperTop]);

  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: result })); } catch {}
  onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news', 'knowledge', 'papers'] });
  return result;
}

export function warmReaderRecommendations() {
  return loadMixedRecommendations(false, () => {});
}

function createRecommendationLoader() {
  const card = el('div', { class: 'card recommendation-loading-card' });
  const title = el('strong', { text: 'おすすめを選んでいます' });
  const label = el('div', { class: 'recommendation-loading-label', text: '候補を準備しています' });
  const track = el('div', { class: 'recommendation-loading-track' });
  const fill = el('div', { class: 'recommendation-loading-fill' });
  track.append(fill);
  const steps = el('div', { class: 'recommendation-loading-steps' });
  const stepNodes = new Map();
  [['news', 'ニュース'], ['knowledge', '知識'], ['papers', '論文']].forEach(([key, text]) => {
    const node = el('span', { text });
    stepNodes.set(key, node);
    steps.append(node);
  });
  card.append(title, label, track, steps);

  return {
    node: card,
    update(progress = {}) {
      fill.style.width = `${Math.max(6, Math.min(100, Number(progress.percent || 0)))}%`;
      if (progress.label) label.textContent = progress.label;
      const completed = new Set(progress.done || []);
      stepNodes.forEach((node, key) => node.classList.toggle('done', completed.has(key)));
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

function attachReaderListSwipe(host, options) {
  return attachSwipe(host, options);
}

export async function renderReader(root, { navigate, refresh = false }) {
  allItems = [];
  focusHandle?.destroy?.();
  focusHandle = null;
  modeSwipeDetach?.();
  modeSwipeDetach = null;

  const firstEntry = !readerSessionStarted;
  readerSessionStarted = true;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';

  if (firstEntry) {
    view = 'recommendations';
    recommendationIndex = 0;
    openedArticle = null;
    if (mode !== 'papers') setSelectedFeed(mode, '');
  }

  const screen = el('section', { class: 'screen reader-screen' });
  screen.style.setProperty('--reader-active-color', state.settings?.colors?.[mode] || 'var(--feature-color)');
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
    openedArticle = null;
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
      openedArticle = null;
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
      openedArticle = null;
      articleIndex = 0;
      renderReader(root, { navigate });
    });
    if (chips) lowestTabsHost.append(chips);
  } else if (track === 'creative') {
    lowestTabsHost.append(buildCreativeFamilyTabs(value => {
      update('creativePaperFamily', value);
      view = 'list';
      openedArticle = null;
      articleIndex = 0;
      renderReader(root, { navigate });
    }));
  }

  sticky.append(lowestTabsHost, progressHost);
  screen.append(sticky);

  const host = el('div', { class: 'reader-content-host' });
  screen.append(host);
  root.replaceChildren(screen);
  host.append(el('div', { class: 'card reader-load-card' }, [
    el('div', { class: 'loading', text: '読み込み中...' }),
    el('div', { class: 'reader-load-track' }, [el('div', { class: 'reader-load-fill' })])
  ]));

  if (mode === 'papers') {
    window.addEventListener('pdv2:paper-titles', () => {
      try {
        const translated = JSON.parse(localStorage.getItem('pdv2:paperTitleJa') || '{}');
        allItems.forEach(item => {
          if (translated[item.title]) item.titleJa = translated[item.title];
        });
        if (allItems.length && view !== 'article') renderContent();
      } catch {}
    }, { once: true });
  }

  let recommendationItems = [];

  const goLeaf = ({ nextMode = mode, feed, nextTrack, family } = {}) => {
    if (nextMode !== mode) update('lastReaderMode', nextMode);
    if (feed !== undefined && nextMode !== 'papers') setSelectedFeed(nextMode, feed);
    if (nextMode === 'papers' && nextTrack) update('paperTrack', nextTrack);
    if (nextMode === 'papers' && family) update('creativePaperFamily', family);
    view = 'list';
    openedArticle = null;
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
      openedArticle = null;
      articleIndex = 0;
      renderReader(root, { navigate });
      return;
    }

    if (mode === 'news' && delta > 0) {
      goLeaf({ nextMode: 'knowledge', feed: '' });
      return;
    }
    if (mode === 'knowledge' && delta < 0) {
      goLeaf({ nextMode: 'news', feed: lastFeedName('news') });
      return;
    }
    if (mode === 'knowledge' && delta > 0) {
      goLeaf({ nextMode: 'papers', nextTrack: 'core' });
    }
  };

  const cyclePaperCore = delta => {
    if (delta > 0) goLeaf({ nextMode: 'papers', nextTrack: 'creative', family: 'all' });
    else goLeaf({ nextMode: 'knowledge', feed: lastFeedName('knowledge') });
  };

  const cycleCreativeFamily = delta => {
    const families = ['all', 'applied', 'general'];
    const current = creativeFamily();
    const index = Math.max(0, families.indexOf(current));
    const next = index + delta;

    if (next >= 0 && next < families.length) {
      update('creativePaperFamily', families[next]);
      view = 'list';
      openedArticle = null;
      articleIndex = 0;
      renderReader(root, { navigate });
      return;
    }

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
        host.replaceChildren(el('div', { class: 'empty', text: 'おすすめ記事がありません' }));
        return;
      }

      recommendationIndex = Math.max(0, Math.min(recommendationIndex, recommendationItems.length - 1));
      host.replaceChildren();

      const closeRecommendations = () => {
        setSelectedFeed('news', '');
        update('lastReaderMode', 'news');
        view = 'list';
        openedArticle = null;
        recommendationIndex = 0;
        articleIndex = 0;
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

    if (!visibleItems.length) {
      host.innerHTML = `<div class="empty">${track === 'creative' && family === 'general'
        ? '一般独創の候補を取得中です。更新すると再検索します。'
        : '記事がありません'}</div>`;
      return;
    }

    if (view === 'list') {
      renderList(host, mode, track, family, visibleItems, item => {
        openedArticle = { ...item };
        view = 'article';
        articleIndex = Math.max(0, visibleItems.findIndex(row => readerItemKey(row) === readerItemKey(item)));
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
      const openedKey = readerItemKey(openedArticle);
      let articleItems = visibleItems;
      let selectedIndex = openedArticle
        ? visibleItems.findIndex(item => readerItemKey(item) === openedKey)
        : articleIndex;

      if (openedArticle && selectedIndex < 0) {
        articleItems = [
          openedArticle,
          ...visibleItems.filter(item => readerItemKey(item) !== openedKey)
        ];
        selectedIndex = 0;
      }

      selectedIndex = Math.max(0, Math.min(selectedIndex, articleItems.length - 1));
      articleIndex = selectedIndex;
      host.replaceChildren();

      focusHandle = mountFocus(host, {
        items: articleItems,
        initialIndex: selectedIndex,
        label: '記事',
        progressHost: null,
        summaryMode: mode,
        onStart: () => {
          openedArticle = null;
          view = 'list';
          renderContent();
          scrollContentToTop(host);
        },
        onList: () => {
          openedArticle = null;
          view = 'list';
          renderContent();
          scrollContentToTop(host);
        },
        onIndexChange: (index, item) => {
          articleIndex = index;
          openedArticle = { ...item };
          const read = getRead(mode, track);
          read.add(item.id);
          saveRead(mode, track, read);
        },
        ...horizontalOptions
      });
    }
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
          if (view !== 'article') renderContent();
        }
      }
    });

    allItems = result.items;
    if (view !== 'article') renderContent();
  } catch (err) {
    progressHost.replaceChildren();
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
