import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, heuristicRank, requestAiRank } from './reader-rank.js';
import { mountFocus, prewarmSummaryChunk } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';

const READER_MODES = ['news', 'knowledge', 'papers'];
const MIXED_WARM_TTL = 5 * 60 * 1000;
let focusHandle = null;
let swipeDetach = null;
let compactDetach = null;
let mixedWarmPromise = null;
let mixedWarmItems = [];
let mixedWarmAt = 0;

const paperTrack = () => state.paperTrack === 'creative' ? 'creative' : 'core';
const creativeFamily = () => ['applied', 'general'].includes(state.creativePaperFamily) ? state.creativePaperFamily : 'all';
const contextId = (mode, track = 'core') => mode === 'papers' ? `papers:${track}` : mode;
const readKey = (mode, track) => `pdv2:read:${contextId(mode, track)}`;
const selectedFeedKey = mode => `pdv2:readerSelectedFeed:${mode}`;
const rankKey = (mode, track, family = 'all') => `pdv2:rank:${contextId(mode, track)}:${track === 'creative' ? family : 'all'}`;

function storageGet(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
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
function getSelectedFeed(mode) { return storageGet(selectedFeedKey(mode), ''); }
function setSelectedFeed(mode, name) { storageSet(selectedFeedKey(mode), name || ''); }
function modeLabel(mode) { return mode === 'papers' ? '論文' : mode === 'knowledge' ? '知識' : 'ニュース'; }

function setReaderMode(mode) {
  if (!READER_MODES.includes(mode)) return;
  update('lastReaderMode', mode);
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
function annotationFamily(item, track, family) {
  if (track !== 'creative') return '';
  if (family !== 'all') return family;
  return creativeFamiliesOf(item).includes('general') ? 'general' : 'applied';
}
function annotateItems(items, mode, track = 'core', family = 'all') {
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

function buildPaperTrackLevel(onChange) {
  const wrap = el('div', { class: 'paper-track-level' });
  wrap.append(segmented([
    { value: 'core', label: '製品・熱研究' },
    { value: 'creative', label: '独創研究' }
  ], paperTrack(), onChange));
  return wrap;
}

function currentSourceLabel(mode, track, family) {
  if (mode === 'papers') {
    if (track === 'core') return '製品・熱研究';
    if (family === 'general') return '一般独創';
    if (family === 'applied') return '応用発想';
    return '独創研究';
  }
  return getSelectedFeed(mode) || 'All';
}

function buildSourceDock(mode, track, family, { onSourceChange, onRecommend }) {
  const dock = el('div', { class: 'reader-source-dock reader-sticky-context' });
  const rail = el('div', { class: 'chips reader-source-scroll reader-feed-chips' });

  if (mode === 'papers') {
    if (track === 'core') {
      rail.append(el('button', { class: 'chip active', type: 'button', text: '製品・熱研究' }));
    } else {
      [
        { value: 'all', label: 'すべて' },
        { value: 'applied', label: '応用発想' },
        { value: 'general', label: '一般独創' }
      ].forEach(item => rail.append(el('button', {
        class: `chip ${family === item.value ? 'active' : ''}`,
        type: 'button',
        text: item.label,
        onclick: () => onSourceChange?.({ family: item.value })
      })));
    }
  } else {
    const selected = getSelectedFeed(mode);
    rail.append(el('button', {
      class: `chip ${!selected ? 'active' : ''}`,
      type: 'button',
      text: 'All',
      onclick: () => onSourceChange?.({ feed: '' })
    }));
    feedsFor(mode).forEach(feed => rail.append(el('button', {
      class: `chip ${selected === feed.name ? 'active' : ''}`,
      type: 'button',
      text: feed.name,
      onclick: () => onSourceChange?.({ feed: feed.name })
    })));
  }

  const compactActive = el('button', {
    class: 'chip active reader-source-active-compact',
    type: 'button',
    text: currentSourceLabel(mode, track, family),
    onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' })
  });
  const recommend = el('button', {
    class: 'soft-button reader-recommend-overlay',
    type: 'button',
    text: 'おすすめへ',
    onclick: onRecommend
  });

  dock.append(rail, compactActive, recommend);
  centerActiveChip(rail);
  return dock;
}

function bentoFallbackLabel(item) {
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '製品熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    return '応用発想';
  }
  return item?.feedName || item?.source || modeLabel(item?._readerMode);
}

function renderBento(host, mode, track, family, items, { onOpen }) {
  const read = getRead(mode, track);
  const wrap = el('div', { class: 'reader-bento-view' });
  const search = el('input', { class: 'reader-bento-search', placeholder: 'タイトル・媒体を検索' });
  const grid = el('div', { class: 'reader-bento-grid' });

  const draw = () => {
    grid.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const filtered = items.filter(item => !q || [item?.title, item?.titleJa, item?.source, item?.feedName]
      .filter(Boolean).join(' ').toLowerCase().includes(q));

    filtered.forEach((item, filteredIndex) => {
      const unread = !read.has(item.id);
      const card = el('button', { class: `reader-bento-card ${filteredIndex === 0 ? 'is-hero' : ''}`, type: 'button' });
      const media = el('div', { class: 'reader-bento-media' });
      if (item?.image) {
        const image = el('img', {
          src: item.image,
          alt: '',
          loading: filteredIndex <= 2 ? 'eager' : 'lazy',
          decoding: 'async',
          referrerpolicy: 'no-referrer'
        });
        image.addEventListener('error', () => media.classList.add('image-failed'), { once: true });
        media.append(image);
      } else media.classList.add('image-failed');
      media.append(el('span', { class: 'reader-bento-fallback', text: bentoFallbackLabel(item) }));

      const meta = [];
      if (unread) meta.push(el('span', { class: 'badge', text: 'NEW' }));
      meta.push(el('span', { text: item?.source || item?.feedName || '' }), el('span', { text: shortDate(item?.pubDate) }));
      card.append(media, el('div', { class: 'reader-bento-copy' }, [
        el('div', { class: 'reader-bento-meta' }, meta),
        el(filteredIndex === 0 ? 'h2' : 'h3', { class: 'reader-bento-title', text: item?.titleJa || item?.title || '無題' })
      ]));
      card.onclick = () => {
        read.add(item.id);
        saveRead(mode, track, read);
        onOpen(item, filteredIndex, filtered);
      };
      grid.append(card);
    });

    if (!filtered.length) grid.append(el('div', { class: 'empty reader-bento-empty', text: '該当する記事がありません' }));
  };

  search.addEventListener('input', draw);
  draw();
  wrap.append(search, grid);
  host.replaceChildren(wrap);
}

function interleaveRecommendationGroups(groups) {
  const queues = groups.filter(rows => Array.isArray(rows) && rows.length).map(rows => [...rows]);
  const result = [];
  const seen = new Set();
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      while (queue.length) {
        const next = queue.shift();
        const key = String(next?.id || next?.link || `${next?.feedName || ''}|${next?.title || ''}`);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        result.push(next);
        added = true;
        break;
      }
    }
  }
  return result;
}

function paperRecommendations(items, track, family) {
  const rankMode = track === 'creative' ? creativeRankMode(family) : 'papers';
  const unread = getRead('papers', track);
  const heuristic = heuristicRank(items, rankMode, unread);
  const byKey = new Map(items.map(item => [String(item?.id || ''), item]));
  const ordered = [];
  const used = new Set();

  for (const row of cachedAiRanking('papers', track, family)) {
    const item = byKey.get(String(row?.id || ''));
    if (!item || used.has(item.id)) continue;
    ordered.push(item);
    used.add(item.id);
  }
  for (const row of heuristic) {
    if (used.has(row.item.id)) continue;
    ordered.push(row.item);
    used.add(row.item.id);
  }
  return ordered;
}

async function loadModeRecommendations(mode, { track = 'core', family = 'all', onProgress } = {}) {
  onProgress?.(12, `${modeLabel(mode)}の記事を取得中`);
  if (mode === 'papers') {
    const result = await loadReader('papers', {
      paperTrack: track,
      fastOnly: true,
      preferCache: false,
      onProgress: () => onProgress?.(52, '論文を整理中')
    });
    let rows = result.items;
    if (track === 'creative') rows = filterCreativeItems(rows, family);
    const annotated = annotateItems(rows, 'papers', track, family);
    onProgress?.(78, '面白さを優先して並べ替え中');
    return paperRecommendations(annotated, track, family);
  }

  const result = await loadReader(mode, {
    selectedFeed: '',
    preferCache: false,
    onProgress: () => onProgress?.(52, '登録した取得先を均等に確認中')
  });
  const annotated = annotateItems(result.items, mode);
  onProgress?.(78, '更新日時を優先しておすすめを選別中');
  return chooseTop(annotated, mode, getRead(mode, 'core'), 0, cachedAiRanking(mode, 'core'));
}

async function loadMixedRecommendations(onProgress) {
  let completed = 0;
  const notify = text => {
    completed += 1;
    onProgress?.(12 + completed * 17, text);
  };
  const jobs = [
    loadReader('news', { selectedFeed: '', preferCache: false }).finally(() => notify('ニュースを確認しました')),
    loadReader('knowledge', { selectedFeed: '', preferCache: false }).finally(() => notify('知識を確認しました')),
    loadReader('papers', { paperTrack: 'core', fastOnly: true, preferCache: false }).finally(() => notify('製品・熱研究を確認しました')),
    loadReader('papers', { paperTrack: 'creative', fastOnly: true, preferCache: false }).finally(() => notify('独創研究を確認しました'))
  ];
  const results = await Promise.allSettled(jobs);
  const value = index => results[index].status === 'fulfilled' ? results[index].value.items : [];

  const news = annotateItems(value(0), 'news');
  const knowledge = annotateItems(value(1), 'knowledge');
  const core = annotateItems(value(2), 'papers', 'core');
  const creative = annotateItems(value(3), 'papers', 'creative', 'all');

  onProgress?.(86, '新しさと面白さで並べ替え中');
  const newsSelected = chooseTop(news, 'news', getRead('news', 'core'), 0, cachedAiRanking('news', 'core'));
  const knowledgeSelected = chooseTop(knowledge, 'knowledge', getRead('knowledge', 'core'), 0, cachedAiRanking('knowledge', 'core'));
  const papers = interleaveRecommendationGroups([
    paperRecommendations(core, 'core', 'all'),
    paperRecommendations(creative, 'creative', 'all')
  ]);

  return interleaveRecommendationGroups([newsSelected, knowledgeSelected, papers]);
}

function warmCacheFresh() {
  return mixedWarmItems.length > 0 && Date.now() - mixedWarmAt < MIXED_WARM_TTL;
}

function ensureMixedRecommendationsWarm() {
  if (warmCacheFresh()) return Promise.resolve(mixedWarmItems);
  if (mixedWarmPromise) return mixedWarmPromise;
  mixedWarmPromise = loadMixedRecommendations().then(items => {
    mixedWarmItems = items;
    mixedWarmAt = Date.now();
    return items;
  }).finally(() => { mixedWarmPromise = null; });
  return mixedWarmPromise;
}

export async function warmReaderRecommendations() {
  const recommendations = await ensureMixedRecommendationsWarm();
  if (recommendations.length > 1) {
    await prewarmSummaryChunk(recommendations, { startIndex: 1, count: Math.min(9, recommendations.length - 1) });
  }
  return recommendations;
}

function recommendationLoading(host, mixed) {
  const fill = el('div', { class: 'reader-recommend-progress-fill' });
  const value = el('span', { class: 'reader-recommend-progress-value', text: '8%' });
  const status = el('span', { text: mixed ? 'ニュース・知識・論文の取得先を確認中' : '登録した取得先を確認中' });
  const progress = el('div', { class: 'reader-recommend-progress' }, [
    status,
    el('div', { class: 'reader-recommend-progress-track' }, [fill]),
    value
  ]);
  const box = el('div', { class: 'reader-recommend-loading' }, [
    el('strong', { text: 'おすすめを選んでいます…' }),
    el('span', { text: mixed ? 'ニュース・知識は新しさ、論文は面白さを優先' : '登録した取得先からおすすめを選別します' }),
    progress
  ]);
  host.replaceChildren(box);

  let current = 0.08;
  const set = (percent, text) => {
    current = Math.max(current, Math.min(1, Number(percent || 0) / 100));
    fill.style.setProperty('--reader-recommend-progress', String(current));
    value.textContent = `${Math.round(current * 100)}%`;
    if (text) status.textContent = text;
  };
  set(8);
  return set;
}

function paperContextStates() {
  return [
    { track: 'core', family: 'all' },
    { track: 'creative', family: 'all' },
    { track: 'creative', family: 'applied' },
    { track: 'creative', family: 'general' }
  ];
}

function sourceStates(mode) {
  if (mode === 'papers') return paperContextStates();
  return ['', ...feedsFor(mode).map(feed => feed.name)];
}

function applyModeBoundary(nextMode, direction) {
  setReaderMode(nextMode);
  if (nextMode === 'papers') {
    const target = direction > 0 ? paperContextStates()[0] : paperContextStates().at(-1);
    update('paperTrack', target.track);
    if (target.track === 'creative') update('creativePaperFamily', target.family);
    return;
  }
  const states = sourceStates(nextMode);
  setSelectedFeed(nextMode, direction > 0 ? states[0] : states.at(-1));
}

function stepReaderContext(mode, direction, rerender) {
  if (![-1, 1].includes(direction)) return;

  if (mode === 'papers') {
    const states = paperContextStates();
    const track = paperTrack();
    const family = track === 'creative' ? creativeFamily() : 'all';
    let current = states.findIndex(row => row.track === track && row.family === family);
    if (current < 0 && track === 'creative') current = 1;
    if (current < 0) current = 0;
    const next = current + direction;
    if (next >= 0 && next < states.length) {
      const target = states[next];
      update('paperTrack', target.track);
      if (target.track === 'creative') update('creativePaperFamily', target.family);
      rerender();
      return;
    }
    if (direction < 0) {
      applyModeBoundary('knowledge', -1);
      rerender();
    }
    return;
  }

  const states = sourceStates(mode);
  const selected = getSelectedFeed(mode);
  let current = states.indexOf(selected);
  if (current < 0) current = 0;
  const next = current + direction;
  if (next >= 0 && next < states.length) {
    setSelectedFeed(mode, states[next]);
    rerender();
    return;
  }

  const modeIndex = READER_MODES.indexOf(mode);
  const nextModeIndex = modeIndex + direction;
  if (nextModeIndex < 0 || nextModeIndex >= READER_MODES.length) return;
  applyModeBoundary(READER_MODES[nextModeIndex], direction);
  rerender();
}

function installReaderListSwipe(node, mode, rerender) {
  let start = null;
  let suppressUntil = 0;
  const shouldIgnore = target => Boolean(target?.closest?.('input,textarea,select,a,.reader-source-dock,.reader-mode-nav,.paper-track-level,.reader-search'));
  const onStart = event => {
    if (event.touches?.length !== 1 || shouldIgnore(event.target)) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
  };
  const onEnd = event => {
    if (!start || !event.changedTouches?.length) { start = null; return; }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy) * 1.35) return;
    suppressUntil = Date.now() + 430;
    stepReaderContext(mode, dx > 0 ? 1 : -1, rerender);
  };
  const blockClick = event => {
    if (Date.now() >= suppressUntil) return;
    event.preventDefault();
    event.stopPropagation();
  };
  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchend', onEnd, { passive: true });
  node.addEventListener('click', blockClick, true);
  return () => {
    node.removeEventListener('touchstart', onStart);
    node.removeEventListener('touchend', onEnd);
    node.removeEventListener('click', blockClick, true);
  };
}

export async function renderReader(root, {
  navigate,
  refresh = false,
  readerRecommendations = false,
  recommendationMode = '',
  recommendationTrack = '',
  recommendationFamily = ''
}) {
  focusHandle?.destroy?.(); focusHandle = null;
  swipeDetach?.(); swipeDetach = null;
  compactDetach?.(); compactDetach = null;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';
  const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
  const scopedMode = READER_MODES.includes(recommendationMode) ? recommendationMode : '';
  const scopedTrack = scopedMode === 'papers' ? (recommendationTrack === 'creative' ? 'creative' : 'core') : 'core';
  const scopedFamily = scopedMode === 'papers' && scopedTrack === 'creative'
    ? (['applied', 'general'].includes(recommendationFamily) ? recommendationFamily : 'all')
    : 'all';
  const mixedRecommendation = readerRecommendations && !scopedMode;

  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root, { navigate, refresh: force, readerRecommendations: false });
  const switchMode = nextMode => {
    if (!READER_MODES.includes(nextMode) || nextMode === mode) return;
    setReaderMode(nextMode);
    renderReader(root, { navigate, readerRecommendations: false });
  };

  const header = topbar('読む', {
    subtitle: readerRecommendations
      ? (scopedMode ? `${modeLabel(scopedMode)}からおすすめ` : 'ニュース・知識・論文からおすすめ')
      : mode === 'papers' ? '論文' : modeLabel(mode),
    actions: [
      { html: iconSvg('plus', { size: 20 }), title: '追加/編集', onClick: () => manageFeeds(mode, rerender) },
      { html: iconSvg('refresh', { size: 20 }), title: '更新', onClick: () => rerender(true) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  });
  screen.append(header);

  const modeNav = el('div', { class: 'reader-mode-nav' });
  modeNav.append(segmented([
    { value: 'news', label: 'ニュース' },
    { value: 'knowledge', label: '知識' },
    { value: 'papers', label: '論文' }
  ], mode, switchMode));
  screen.append(modeNav);

  if (mode === 'papers') {
    screen.append(buildPaperTrackLevel(value => {
      update('paperTrack', value);
      if (value === 'creative' && !['all', 'applied', 'general'].includes(state.creativePaperFamily)) update('creativePaperFamily', 'all');
      renderReader(root, { navigate, readerRecommendations: false });
    }));
  }

  const host = el('div', { class: 'reader-content-host' });
  const openRecommendation = () => renderReader(root, {
    navigate, readerRecommendations: true, recommendationMode: mode, recommendationTrack: track, recommendationFamily: family
  });

  if (!readerRecommendations) {
    const sourceDock = buildSourceDock(mode, track, family, {
      onSourceChange: next => {
        if (mode === 'papers') {
          if (track === 'creative' && next?.family) update('creativePaperFamily', next.family);
        } else setSelectedFeed(mode, next?.feed || '');
        renderReader(root, { navigate, readerRecommendations: false });
      },
      onRecommend: openRecommendation
    });
    screen.append(sourceDock);
  }

  screen.append(host);
  root.replaceChildren(screen);

  const openArticleSequence = (item, initialIndex, visibleItems) => {
    const rows = Array.isArray(visibleItems) && visibleItems.length ? visibleItems : [item];
    screen.classList.remove('reader-list-open', 'reader-list-motion-compact');
    screen.classList.add('reader-focus-open', 'reader-article-open');
    window.scrollTo({ top: 0, behavior: 'auto' });
    focusHandle?.destroy?.();
    focusHandle = mountFocus(host, {
      items: rows,
      initialIndex,
      label: currentSourceLabel(mode, track, family),
      summaryMode: mode,
      onList: () => renderReader(root, { navigate, readerRecommendations: false }),
      onIndexChange: (_, activeItem) => {
        const r = getRead(mode, track);
        r.add(activeItem.id);
        saveRead(mode, track, r);
      },
      onPrevFeed: () => {
        const i = READER_MODES.indexOf(mode);
        if (i > 0) switchMode(READER_MODES[i - 1]);
      },
      onNextFeed: () => {
        const i = READER_MODES.indexOf(mode);
        if (i < READER_MODES.length - 1) switchMode(READER_MODES[i + 1]);
      }
    });
  };

  if (readerRecommendations) {
    screen.classList.add('reader-focus-open', 'reader-recommendations-open');
    const setLoadingProgress = recommendationLoading(host, mixedRecommendation);
    try {
      const recommendations = mixedRecommendation
        ? await ensureMixedRecommendationsWarm()
        : await loadModeRecommendations(scopedMode, {
          track: scopedTrack,
          family: scopedFamily,
          onProgress: setLoadingProgress
        });
      if (!recommendations.length) throw new Error('おすすめ記事を準備できませんでした');
      if (mixedRecommendation && recommendations.length > 1) {
        prewarmSummaryChunk(recommendations, { startIndex: 1, count: Math.min(9, recommendations.length - 1) }).catch(() => {});
      }
      setLoadingProgress(100, 'おすすめを表示します');

      const returnToOrigin = () => {
        const returnMode = mixedRecommendation ? 'news' : scopedMode;
        setReaderMode(returnMode);
        if (returnMode === 'papers') {
          update('paperTrack', scopedTrack);
          if (scopedTrack === 'creative') update('creativePaperFamily', scopedFamily);
        }
        renderReader(root, { navigate, readerRecommendations: false });
      };

      const recommendationSwitch = direction => {
        if (!scopedMode) return;
        const i = READER_MODES.indexOf(scopedMode);
        const next = i + direction;
        if (next < 0 || next >= READER_MODES.length) return;
        const nextMode = READER_MODES[next];
        setReaderMode(nextMode);
        renderReader(root, {
          navigate,
          readerRecommendations: true,
          recommendationMode: nextMode,
          recommendationTrack: nextMode === 'papers' ? paperTrack() : '',
          recommendationFamily: nextMode === 'papers' ? creativeFamily() : ''
        });
      };

      requestAnimationFrame(() => {
        focusHandle = mountFocus(host, {
          items: recommendations,
          label: scopedMode ? `${modeLabel(scopedMode)}おすすめ` : 'おすすめ',
          summaryMode: scopedMode,
          onList: returnToOrigin,
          onPrevFeed: () => recommendationSwitch(-1),
          onNextFeed: () => recommendationSwitch(1),
          onIndexChange: (_, item) => {
            const m = item._readerMode || scopedMode || 'news';
            const t = item._paperTrack || 'core';
            const r = getRead(m, t);
            r.add(item.id);
            saveRead(m, t, r);
          }
        });
      });
    } catch (error) {
      screen.classList.remove('reader-focus-open');
      host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
    }
    return;
  }

  screen.classList.add('reader-list-open');
  swipeDetach = installReaderListSwipe(screen, mode, () => renderReader(root, { navigate, readerRecommendations: false }));
  host.replaceChildren(el('div', { class: 'card', html: '<div class="loading">記事一覧を読み込み中...</div>' }));

  try {
    const selectedFeed = getSelectedFeed(mode);
    const showList = rows => {
      const visible = mode === 'papers' && track === 'creative' ? filterCreativeItems(rows, family) : rows;
      const annotated = annotateItems(visible, mode, track, family);
      renderBento(host, mode, track, family, annotated, { onOpen: openArticleSequence });
      return annotated;
    };

    const result = await loadReader(mode, {
      force: refresh,
      selectedFeed,
      paperTrack: track,
      onProgress: items => {
        if (!items?.length || host.querySelector('.reader-bento-view')) return;
        showList(items);
      }
    });
    const annotated = showList(result.items);
    compactDetach = installShrinkingHeader(screen, {
      threshold: 72,
      className: 'reader-list-motion-compact',
      range: 58,
      hysteresis: 20
    });

    if (state.settings.rankWithAi && annotated.length) {
      const rankMode = mode === 'papers' && track === 'creative' ? creativeRankMode(family) : mode;
      requestAiRank(annotated, rankMode).then(data => {
        if (data?.ranking?.length) storageSet(rankKey(mode, track, family), JSON.stringify({ at: Date.now(), ranking: data.ranking }));
      }).catch(() => {});
    }
  } catch (error) {
    host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
  }
}
