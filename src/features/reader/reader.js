import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem } from '../../shared/components.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';

const READER_MODES = ['news', 'knowledge', 'papers'];
let view = 'focus';
let allItems = [];
let focusHandle = null;
let modeSwipeDetach = null;

const paperTrack = () => state.paperTrack === 'creative' ? 'creative' : 'core';
const creativeFamily = () => ['applied', 'general'].includes(state.creativePaperFamily) ? state.creativePaperFamily : 'all';
const contextId = (mode, track = 'core') => mode === 'papers' ? `papers:${track}` : mode;
const readKey = (mode, track) => `pdv2:read:${contextId(mode, track)}`;
const selectedFeedKey = mode => `pdv2:readerSelectedFeed:${mode}`;
const lastSeenKey = (mode, track, family = 'all') => `pdv2:lastReaderSeen:${contextId(mode, track)}:${track === 'creative' ? family : 'all'}`;
const rankKey = (mode, track, family = 'all') => `pdv2:rank:${contextId(mode, track)}:${track === 'creative' ? family : 'all'}`;

function storageGet(key, fallback = '') {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}
function getRead(mode, track) {
  try { return new Set(JSON.parse(storageGet(readKey(mode, track), '[]'))); }
  catch { return new Set(); }
}
function saveRead(mode, track, set) {
  storageSet(readKey(mode, track), JSON.stringify([...set].slice(-1500)));
}
function modeLabel(mode) { return mode === 'papers' ? '論文' : mode === 'knowledge' ? '知識' : 'ニュース'; }
function focusLabel(mode, track = 'core', family = 'all') {
  if (mode === 'papers') {
    if (track !== 'creative') return '製品熱研究';
    if (family === 'general') return '一般独創';
    if (family === 'applied') return '応用発想';
    return '独創研究';
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
  return family === 'all' ? items : items.filter(item => creativeFamiliesOf(item).includes(family));
}
function creativeRankMode(family) {
  return family === 'general' ? 'papers-creative-general' : family === 'applied' ? 'papers-creative-applied' : 'papers-creative-all';
}
function getSelectedFeed(mode) { return storageGet(selectedFeedKey(mode), ''); }
function setSelectedFeed(mode, name) { storageSet(selectedFeedKey(mode), name || ''); }

function manageFeeds(mode, rerender) {
  const key = mode === 'papers' ? 'paperFeeds' : mode === 'knowledge' ? 'knowledgeFeeds' : 'newsFeeds';
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
    onclick: () => { setSelectedFeed(mode, ''); onChange(); }
  }));
  feeds.forEach(feed => chips.append(el('button', {
    class: `chip ${selected === feed.name ? 'active' : ''}`,
    type: 'button',
    text: feed.name,
    onclick: () => { setSelectedFeed(mode, feed.name); onChange(); }
  })));
  centerActiveChip(chips);
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
  centerActiveChip(row);
  return row;
}

function annotationFamily(item, track, family) {
  if (track !== 'creative') return '';
  if (family !== 'all') return family;
  return creativeFamiliesOf(item).includes('general') ? 'general' : 'applied';
}

function annotateItems(items, mode, track, family) {
  return (Array.isArray(items) ? items : []).map(item => ({
    ...item,
    _readerMode: mode,
    _paperTrack: mode === 'papers' ? track : '',
    _creativeFamily: mode === 'papers' ? annotationFamily(item, track, family) : ''
  }));
}

function cachedAiRanking(mode, track, family = 'all') {
  try {
    const data = JSON.parse(storageGet(rankKey(mode, track, family), 'null'));
    if (!data?.ranking?.length || Date.now() - Number(data.at || 0) > 6 * 60 * 60 * 1000) return [];
    return data.ranking;
  } catch { return []; }
}

function bentoFallbackLabel(item) {
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '製品熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    return '応用発想';
  }
  return item?.feedName || item?.source || modeLabel(item?._readerMode);
}

function renderBento(host, mode, track, family, items, onOpen, onBack) {
  const read = getRead(mode, track);
  const lastSeen = Number(storageGet(lastSeenKey(mode, track, family), '0'));
  const newCount = items.filter(item => {
    const time = new Date(item?.pubDate || 0).getTime();
    return Number.isFinite(time) && time > lastSeen;
  }).length;

  const wrap = el('div', { class: 'reader-bento-view' });
  const toolbar = el('div', { class: 'reader-bento-toolbar' }, [
    el('div', { class: 'reader-bento-toolbar-copy' }, [
      el('strong', { text: 'Bento一覧' }),
      el('small', { text: newCount ? `前回から ${newCount}件 / 全${items.length}件` : `全${items.length}件` })
    ]),
    el('button', { class: 'soft-button', type: 'button', text: 'おすすめへ', onclick: onBack })
  ]);
  const search = el('input', { class: 'reader-bento-search', placeholder: 'タイトル・媒体を検索' });
  const grid = el('div', { class: 'reader-bento-grid' });

  const draw = () => {
    grid.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const filtered = items.filter(item => !q || [item?.title, item?.titleJa, item?.source, item?.feedName].filter(Boolean).join(' ').toLowerCase().includes(q));
    filtered.forEach((item, filteredIndex) => {
      const originalIndex = items.indexOf(item);
      const unread = !read.has(item.id);
      const card = el('button', {
        class: `reader-bento-card ${filteredIndex === 0 ? 'is-hero' : ''}`,
        type: 'button',
        onclick: () => {
          read.add(item.id);
          saveRead(mode, track, read);
          onOpen(item, originalIndex);
        }
      });
      const media = el('div', { class: 'reader-bento-media' });
      if (item?.image) {
        const image = el('img', { src: item.image, alt: '', loading: filteredIndex <= 2 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
        image.addEventListener('error', () => media.classList.add('image-failed'), { once: true });
        media.append(image);
      } else {
        media.classList.add('image-failed');
      }
      media.append(el('span', { class: 'reader-bento-fallback', text: bentoFallbackLabel(item) }));
      const metaChildren = [];
      if (unread) metaChildren.push(el('span', { class: 'badge', text: 'NEW' }));
      metaChildren.push(el('span', { text: item?.source || item?.feedName || '' }));
      metaChildren.push(el('span', { text: shortDate(item?.pubDate) }));
      const tag = filteredIndex === 0 ? 'h2' : 'h3';
      card.append(media, el('div', { class: 'reader-bento-copy' }, [
        el('div', { class: 'reader-bento-meta' }, metaChildren),
        el(tag, { class: 'reader-bento-title', text: item?.titleJa || item?.title || '無題' })
      ]));
      grid.append(card);
    });
    if (!filtered.length) grid.append(el('div', { class: 'empty reader-bento-empty', text: '該当する記事がありません' }));
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(toolbar, search, grid);
  host.replaceChildren(wrap);
  storageSet(lastSeenKey(mode, track, family), String(Date.now()));
}

export async function renderReader(root, { navigate, refresh = false }) {
  view = 'focus';
  allItems = [];
  focusHandle?.destroy?.();
  focusHandle = null;
  modeSwipeDetach?.();
  modeSwipeDetach = null;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';
  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root, { navigate, refresh: force });

  screen.append(topbar('読む', {
    subtitle: mode === 'papers' ? (track === 'creative' ? '論文・独創研究' : '論文・製品／熱研究') : 'ニュース・知識・論文',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manageFeeds(mode, rerender) },
      { label: '↻', title: '更新', onClick: () => rerender(true) },
      { label: '⚙︎', title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const switchMode = value => {
    if (!READER_MODES.includes(value) || value === mode) return;
    update('lastReaderMode', value);
    view = 'focus';
    renderReader(root, { navigate });
  };
  const cycleMode = delta => {
    const i = READER_MODES.indexOf(mode);
    const next = Math.max(0, Math.min(READER_MODES.length - 1, i + delta));
    if (next !== i) switchMode(READER_MODES[next]);
  };

  const modeNav = el('div', { class: 'reader-mode-nav' });
  modeNav.append(segmented([
    { value: 'news', label: 'ニュース' },
    { value: 'knowledge', label: '知識' },
    { value: 'papers', label: '論文' }
  ], mode, switchMode));
  screen.append(modeNav);
  modeSwipeDetach = attachSwipe(modeNav, { left: () => cycleMode(1), right: () => cycleMode(-1), threshold: 40 });

  if (mode === 'papers') {
    screen.append(buildPaperTrackLevel(value => {
      update('paperTrack', value);
      view = 'focus';
      renderReader(root, { navigate });
    }));
  }

  const sticky = el('div', { class: 'reader-sticky-context' });
  const lowestTabsHost = el('div', { class: 'reader-lowest-tabs-host' });
  const progressHost = el('div', { class: 'reader-progress-host' });
  if (mode !== 'papers') {
    const chips = buildFeedChips(mode, () => { view = 'focus'; renderReader(root, { navigate }); });
    if (chips) lowestTabsHost.append(chips);
  } else if (track === 'creative') {
    lowestTabsHost.append(buildCreativeFamilyTabs(value => {
      update('creativePaperFamily', value);
      view = 'focus';
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
        const translated = JSON.parse(storageGet('pdv2:paperTitleJa', '{}'));
        allItems.forEach(item => { if (translated[item.title]) item.titleJa = translated[item.title]; });
        if (allItems.length) renderContent();
      } catch {}
    }, { once: true });
  }

  let chosen = [];
  const cycleFeed = delta => {
    const feeds = feedsFor(mode);
    if (feeds.length <= 1) return;
    const names = ['', ...feeds.map(feed => feed.name)];
    const current = getSelectedFeed(mode);
    const i = Math.max(0, names.indexOf(current));
    const next = Math.max(0, Math.min(names.length - 1, i + delta));
    if (next === i) return;
    setSelectedFeed(mode, names[next]);
    view = 'focus';
    renderReader(root, { navigate });
  };
  const cyclePaperTrack = delta => {
    const tracks = ['core', 'creative'];
    const i = tracks.indexOf(track);
    const next = Math.max(0, Math.min(tracks.length - 1, i + delta));
    if (next === i) return;
    update('paperTrack', tracks[next]);
    view = 'focus';
    renderReader(root, { navigate });
  };
  const cycleCreativeFamily = delta => {
    const families = ['all', 'applied', 'general'];
    const current = creativeFamily();
    const i = families.indexOf(current);
    const next = Math.max(0, Math.min(families.length - 1, i + delta));
    if (next === i) return;
    update('creativePaperFamily', families[next]);
    view = 'focus';
    renderReader(root, { navigate });
  };

  const horizontalOptions = mode === 'papers'
    ? (track === 'creative'
      ? { onPrevFeed: () => cycleCreativeFamily(-1), onNextFeed: () => cycleCreativeFamily(1) }
      : { onPrevFeed: () => cyclePaperTrack(-1), onNextFeed: () => cyclePaperTrack(1) })
    : { onPrevFeed: () => cycleFeed(-1), onNextFeed: () => cycleFeed(1) };

  const renderContent = () => {
    focusHandle?.destroy?.();
    focusHandle = null;
    progressHost.replaceChildren();
    const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
    const visibleItems = mode === 'papers' && track === 'creative' ? filterCreativeItems(allItems, family) : allItems;
    const rankMode = mode === 'papers' && track === 'creative' ? creativeRankMode(family) : mode;

    if (!visibleItems.length) {
      screen.classList.remove('reader-focus-open');
      host.innerHTML = `<div class="empty">${track === 'creative' && family === 'general' ? '一般独創の候補を取得中です。更新すると再検索します。' : '記事がありません'}</div>`;
      return;
    }

    if (view === 'list') {
      screen.classList.remove('reader-focus-open');
      renderBento(host, mode, track, family, visibleItems, (_item, index) => {
        view = 'focus';
        chosen = visibleItems;
        screen.classList.add('reader-focus-open');
        host.replaceChildren();
        focusHandle = mountFocus(host, {
          items: chosen,
          initialIndex: index,
          label: focusLabel(mode, track, family),
          summaryMode: mode,
          onList: () => { view = 'list'; renderContent(); },
          onIndexChange: (_, it) => {
            const r = getRead(mode, track);
            r.add(it.id);
            saveRead(mode, track, r);
          },
          ...horizontalOptions
        });
      }, () => { view = 'focus'; renderContent(); });
      const detachListSwipe = attachSwipe(host, { left: horizontalOptions.onNextFeed, right: horizontalOptions.onPrevFeed, threshold: 72 });
      focusHandle = { destroy: detachListSwipe };
      return;
    }

    screen.classList.add('reader-focus-open');
    const read = getRead(mode, track);
    // news/knowledgeはreader-rank.js側でグローバル件数上限を無視し、取得先を公平に選ぶ。
    chosen = chooseTop(visibleItems, rankMode, read, 5, state.settings.rankWithAi ? cachedAiRanking(mode, track, family) : []);
    host.replaceChildren();
    focusHandle = mountFocus(host, {
      items: chosen,
      label: focusLabel(mode, track, family),
      summaryMode: mode,
      onList: () => { view = 'list'; renderContent(); },
      onIndexChange: (_, it) => {
        read.add(it.id);
        saveRead(mode, track, read);
      },
      ...horizontalOptions
    });
  };

  try {
    const selectedFeed = getSelectedFeed(mode);
    const result = await loadReader(mode, {
      force: refresh,
      selectedFeed,
      paperTrack: track,
      onProgress: items => {
        if (!allItems.length && items.length) {
          const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
          allItems = annotateItems(items, mode, track, family);
          renderContent();
        }
      }
    });
    const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
    allItems = annotateItems(result.items, mode, track, family);
    renderContent();

    if (state.settings.rankWithAi && allItems.length) {
      const visible = mode === 'papers' && track === 'creative' ? filterCreativeItems(allItems, family) : allItems;
      const rankMode = mode === 'papers' && track === 'creative' ? creativeRankMode(family) : mode;
      requestAiRank(visible, rankMode).then(data => {
        if (data?.ranking?.length) storageSet(rankKey(mode, track, family), JSON.stringify({ at: Date.now(), ranking: data.ranking }));
      }).catch(() => {});
    }
  } catch (err) {
    screen.classList.remove('reader-focus-open');
    progressHost.replaceChildren();
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
