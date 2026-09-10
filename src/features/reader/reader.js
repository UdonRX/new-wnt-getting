import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { loadReader, readReaderCache, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { loadCrossSourceRecommendations } from './reader-recommendations.js';
import { dedupePaperItems, rankKnowledgeAttention, refreshKnowledgeTrendScores, rankPaperAttention, stampPaperItems } from './reader-attention.js';
import { shortDate } from '../../shared/time.js';

const READER_MODES = ['news', 'knowledge', 'papers'];
const MIXED_WARM_TTL = 5 * 60 * 1000;
const TECHNOLOGY_VERSION_RE = /研究方式:\s*生産技術/i;

let focusHandle = null;
let swipeDetach = null;
let compactDetach = null;
let mixedWarmPromise = null;
let mixedWarmItems = [];
let mixedWarmAt = 0;

const contextId = (mode, track = 'core') => mode === 'papers' ? 'papers:technology' : mode;
const readKey = (mode, track) => `pdv2:read:${contextId(mode, track)}`;
const selectedFeedKey = mode => `pdv2:readerSelectedFeed:${mode}`;
const rankKey = (mode, track) => `pdv2:rank:${contextId(mode, track)}:all`;

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
function isTechnologyResearchItem(item) {
  const text = [item?.feedName, item?.source, item?.description].filter(Boolean).join(' ');
  return /技術リサーチ/.test(text) && TECHNOLOGY_VERSION_RE.test(String(item?.description || ''));
}
function technologyCategoryOf(item) {
  if (!isTechnologyResearchItem(item)) return '';
  const description = String(item?.description || '');
  const match = description.match(/カテゴリ:\s*([^｜\n]+)/i);
  if (match?.[1]) return match[1].trim();
  const source = String(item?.feedName || item?.source || '');
  return source.match(/技術リサーチ\s*[｜:：]\s*([^｜:：]+)/)?.[1]?.trim() || '';
}
function creativeFamiliesOf(item) {
  const text = String(item?.description || '');
  const result = [];
  if (/独創区分:\s*[^\n]*応用発想/i.test(text)) result.push('applied');
  if (/独創区分:\s*[^\n]*一般独創/i.test(text)) result.push('general');
  if (!result.length) result.push('applied');
  return result;
}
function isGeneralCreativeItem(item) {
  return creativeFamiliesOf(item).includes('general') && !isTechnologyResearchItem(item);
}
function recommendationTimestamp(item) {
  const explicit = Number(item?.publishedTimestamp);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const parsed = new Date(item?.pubDate || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function newestRecommendationOrder(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(item => {
    const key = String(item?.link || item?.id || `${item?.feedName || ''}|${item?.title || ''}`).trim().toLowerCase();
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  }).sort((a, b) => recommendationTimestamp(b) - recommendationTimestamp(a));
}
function researchDescriptionField(item, label) {
  const source = String(item?.description || '');
  const marker = `${label}:`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const rest = source.slice(start + marker.length);
  return rest.split('｜')[0].trim();
}
function readerListDate(item, mode) {
  if (mode === 'papers' && isTechnologyResearchItem(item)) {
    const precision = researchDescriptionField(item, '日付精度');
    if (precision === '不明') return '日付不明';
    if (precision === '年') {
      const year = researchDescriptionField(item, '公開年') || researchDescriptionField(item, '出版年');
      return /^\d{4}$/.test(year) ? `${year}年` : '年のみ';
    }
    if (technologyCategoryOf(item) === '論文・研究') {
      const date = new Date(item?.pubDate || 0);
      if (Number.isFinite(date.getTime()) && date.getTime() > 0) {
        return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
      }
      return '日付不明';
    }
  }
  return shortDate(item?.pubDate);
}
function modeLabel(mode) { return mode === 'papers' ? '論文・研究' : mode === 'knowledge' ? '知識' : 'ニュース'; }
function setReaderMode(mode) {
  if (!READER_MODES.includes(mode)) return;
  update('lastReaderMode', mode);
}
async function settleWithin(promise, timeoutMs, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function annotateItems(items, mode) {
  return (Array.isArray(items) ? items : []).map(item => {
    const description = String(item?.description || '');
    const isTechnology = mode === 'papers' && isTechnologyResearchItem(item);
    const version = description.match(/研究方式:\s*生産技術[^｜\n]*-v(\d+)/i)?.[1] || '';
    const originalLink = String(item?.link || '');
    const link = isTechnology && version && originalLink
      ? `${originalLink.replace(/#.*$/, '')}#trv${version}c2`
      : item?.link;
    return {
      ...item,
      link,
      _readerMode: mode,
      _paperTrack: mode === 'papers' ? 'technology' : '',
      _creativeFamily: mode === 'papers' && isGeneralCreativeItem(item) ? 'general' : ''
    };
  });
}
function cachedAiRanking(mode, track) {
  try {
    const data = JSON.parse(storageGet(rankKey(mode, track), 'null'));
    if (!data?.ranking?.length || Date.now() - Number(data.at || 0) > 6 * 60 * 60 * 1000) return [];
    return data.ranking;
  } catch { return []; }
}

function manageFeeds(mode, rerender) {
  const key = mode === 'knowledge' ? 'knowledgeFeeds' : 'newsFeeds';
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
function currentSourceLabel(mode) {
  if (mode === 'papers') return '論文・研究';
  return getSelectedFeed(mode) || 'All';
}
function buildSourceDock(mode, { onSourceChange, onRecommend }) {
  const dock = el('div', { class: 'reader-source-dock reader-sticky-context' });
  const rail = el('div', { class: 'chips reader-source-scroll reader-feed-chips' });
  const selected = getSelectedFeed(mode);
  rail.append(el('button', { class: `chip ${!selected ? 'active' : ''}`, type: 'button', text: 'All', onclick: () => onSourceChange?.({ feed: '' }) }));
  feedsFor(mode).forEach(feed => rail.append(el('button', {
    class: `chip ${selected === feed.name ? 'active' : ''}`,
    type: 'button', text: feed.name,
    onclick: () => onSourceChange?.({ feed: feed.name })
  })));
  const compactActive = el('button', {
    class: 'chip active reader-source-active-compact', type: 'button', text: currentSourceLabel(mode),
    onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' })
  });
  const recommend = el('button', { class: 'soft-button reader-recommend-overlay', type: 'button', text: 'おすすめへ', onclick: onRecommend });
  dock.append(rail, compactActive, recommend);
  centerActiveChip(rail);
  return dock;
}
function buildPaperDock(onRecommend) {
  return el('div', { class: 'reader-source-dock reader-sticky-context' }, [
    el('span', { class: 'chip active reader-source-active-compact', text: '統合フィード' }),
    el('button', { class: 'soft-button reader-recommend-overlay', type: 'button', text: 'おすすめへ', onclick: onRecommend })
  ]);
}

function bentoFallbackLabel(item) {
  if (item?._readerMode === 'papers') {
    if (isGeneralCreativeItem(item)) return '一般独創';
    return technologyCategoryOf(item) || item?.feedName || item?.source || '論文・研究';
  }
  return item?.feedName || item?.source || modeLabel(item?._readerMode);
}
function renderBento(host, mode, track, items, { onOpen }) {
  const read = getRead(mode, track);
  const wrap = el('div', { class: 'reader-bento-view' });
  const search = el('input', { class: 'reader-bento-search', placeholder: 'タイトル・媒体を検索' });
  const grid = el('div', { class: 'reader-bento-grid' });
  const draw = () => {
    grid.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const filtered = items.filter(item => !q || [item?.title, item?.titleJa, item?.source, item?.feedName].filter(Boolean).join(' ').toLowerCase().includes(q));
    filtered.forEach((item, filteredIndex) => {
      const unread = !read.has(item.id);
      const card = el('button', { class: `reader-bento-card ${filteredIndex === 0 ? 'is-hero' : ''}`, type: 'button' });
      const media = el('div', { class: 'reader-bento-media' });
      if (item?.image) {
        const image = el('img', { src: item.image, alt: '', loading: filteredIndex <= 2 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
        image.addEventListener('error', () => media.classList.add('image-failed'), { once: true });
        media.append(image);
      } else media.classList.add('image-failed');
      media.append(el('span', { class: 'reader-bento-fallback', text: bentoFallbackLabel(item) }));
      const meta = [];
      if (unread) meta.push(el('span', { class: 'badge', text: 'NEW' }));
      meta.push(el('span', { text: item?.source || item?.feedName || '' }), el('span', { text: readerListDate(item, mode) }));
      card.append(media, el('div', { class: 'reader-bento-copy' }, [
        el('div', { class: 'reader-bento-meta' }, meta),
        el(filteredIndex === 0 ? 'h2' : 'h3', { class: 'reader-bento-title', text: item?.titleJa || item?.title || '無題' })
      ]));
      card.onclick = () => {
        read.add(item.id); saveRead(mode, track, read); onOpen(item, filteredIndex, filtered);
      };
      grid.append(card);
    });
    if (!filtered.length) grid.append(el('div', { class: 'empty reader-bento-empty', text: '該当する記事がありません' }));
  };
  search.addEventListener('input', draw);
  draw(); wrap.append(search, grid); host.replaceChildren(wrap);
}

async function readPaperCacheRows() {
  const [coreCache, creativeCache] = await Promise.all([
    readReaderCache('papers', 'technology'),
    readReaderCache('papers', 'creative')
  ]);
  return {
    items: stampPaperItems(dedupePaperItems([...(coreCache?.items || []), ...(creativeCache?.items || [])])),
    fresh: Boolean(coreCache?.fresh && creativeCache?.fresh),
    core: coreCache?.items || [],
    creative: creativeCache?.items || []
  };
}

async function loadPaperRows({ force = false, fastOnly = false, preferCache = false, onProgress } = {}) {
  const cached = await readPaperCacheRows();
  if (cached.items.length) onProgress?.(cached.items, { cached: true, paperSource: 'unified' });
  if (preferCache && !force && cached.items.length && cached.fresh) return { items: cached.items, failures: [], cached: true };

  const jobs = [
    loadReader('papers', {
      force, paperTrack: 'core', fastOnly: true, preferCache,
      onProgress: items => onProgress?.(stampPaperItems(dedupePaperItems([...(items || []), ...cached.creative])), { paperSource: 'technology' })
    }).then(result => ({ kind: 'core', result })),
    loadReader('papers', {
      force, paperTrack: 'creative', fastOnly, preferCache,
      onProgress: items => onProgress?.(stampPaperItems(dedupePaperItems([...cached.core, ...(items || [])])), { paperSource: 'creative' })
    }).then(result => ({ kind: 'creative', result }))
  ];
  const settled = await Promise.allSettled(jobs);
  const items = [], failures = [];
  for (const row of settled) {
    if (row.status === 'fulfilled') {
      items.push(...(row.value.result?.items || []));
      failures.push(...(row.value.result?.failures || []));
    } else failures.push({ feed: '論文・研究', error: row.reason });
  }
  const merged = stampPaperItems(dedupePaperItems(items.length ? items : cached.items));
  if (merged.length) return { items: merged, failures };
  if (settled.some(row => row.status === 'rejected')) throw settled.find(row => row.status === 'rejected').reason;
  return { items: [], failures };
}

async function loadPaperRecommendations(onProgress) {
  onProgress?.(16, '保存済みの論文・研究を確認中');
  const cached = await readPaperCacheRows();
  let core = cached.core;
  let creative = cached.creative;

  onProgress?.(34, '生産技術の登録先を更新確認中');
  const [coreResult, creativeResult] = await Promise.all([
    settleWithin(
      loadReader('papers', { paperTrack: 'core', fastOnly: true, preferCache: false }),
      12_000,
      { items: core }
    ),
    settleWithin(
      loadReader('papers', { paperTrack: 'creative', fastOnly: true, preferCache: false }),
      12_000,
      { items: creative }
    )
  ]);
  if (coreResult?.items?.length) core = coreResult.items;
  if (creativeResult?.items?.length) creative = creativeResult.items;

  onProgress?.(82, 'Paper Attention Scoreで整理中');
  const merged = stampPaperItems(dedupePaperItems([...core, ...creative]));
  return annotateItems(rankPaperAttention(merged, getRead('papers', 'technology')), 'papers');
}

async function loadModeRecommendations(mode, { onProgress } = {}) {
  onProgress?.(12, `${modeLabel(mode)}の記事を取得中`);
  if (mode === 'papers') return loadPaperRecommendations(onProgress);
  const result = await loadReader(mode, {
    selectedFeed: '', preferCache: false,
    onProgress: () => onProgress?.(52, '登録した取得先を均等に確認中')
  });
  const annotated = annotateItems(result.items, mode);
  if (mode === 'knowledge') {
    onProgress?.(72, 'Google Trendsと登録RSSを照合中');
    const trendScores = await refreshKnowledgeTrendScores(annotated);
    onProgress?.(88, '注目度・鮮度・未読を整理中');
    return rankKnowledgeAttention(annotated, getRead(mode, 'core'), trendScores);
  }
  onProgress?.(78, '更新日時を優先しておすすめを選別中');
  return chooseTop(annotated, mode, getRead(mode, 'core'), 0, cachedAiRanking(mode, 'core'));
}

async function loadMixedRecommendations(onProgress, { forceSources = false } = {}) {
  try {
    return await loadCrossSourceRecommendations(onProgress);
  } catch (error) {
    console.warn('[recommendations:fallback]', {
      stage: error?.stage || 'cross-source',
      requestId: error?.requestId || '',
      message: error?.message || String(error)
    });
    onProgress?.(18, '新方式に失敗したため登録RSSへ切替中');
  }

  let completed = 0;
  const notify = text => {
    completed += 1;
    onProgress?.(12 + completed * 22, text);
  };
  const technologyJob = (async () => {
    const cached = await readReaderCache('papers', 'technology');
    return settleWithin(
      loadReader('papers', { paperTrack: 'core', fastOnly: true, preferCache: false }),
      12_000,
      { items: cached?.items || [] }
    );
  })();
  const jobs = [
    loadReader('news', { selectedFeed: '', force: forceSources, preferCache: false }).finally(() => notify('ニュースを最新化しました')),
    loadReader('knowledge', { selectedFeed: '', force: forceSources, preferCache: false }).finally(() => notify('知識を最新化しました')),
    technologyJob.finally(() => notify('改善事例を確認しました'))
  ];
  const results = await Promise.allSettled(jobs);
  const value = index => results[index].status === 'fulfilled' ? results[index].value.items : [];
  const news = annotateItems(value(0), 'news');
  const knowledge = annotateItems(value(1), 'knowledge');
  const cases = annotateItems(
    value(2).filter(item => isTechnologyResearchItem(item) && technologyCategoryOf(item) === '改善事例'),
    'papers'
  );
  onProgress?.(88, 'ニュース・知識・改善事例を新しい順に整理中');
  return newestRecommendationOrder([...news, ...knowledge, ...cases]);
}

function warmCacheFresh() { return mixedWarmItems.length > 0 && Date.now() - mixedWarmAt < MIXED_WARM_TTL; }
function ensureMixedRecommendationsWarm() {
  if (warmCacheFresh()) return Promise.resolve(newestRecommendationOrder(mixedWarmItems));
  if (mixedWarmPromise) return mixedWarmPromise;
  mixedWarmPromise = loadMixedRecommendations(undefined, { forceSources: false }).then(items => {
    mixedWarmItems = items; mixedWarmAt = Date.now(); return newestRecommendationOrder(items);
  }).finally(() => { mixedWarmPromise = null; });
  return mixedWarmPromise;
}
export async function warmReaderRecommendations() { return ensureMixedRecommendationsWarm(); }

function recommendationLoading(host, mixed, scopedMode = '') {
  const fill = el('div', { class: 'reader-recommend-progress-fill' });
  const value = el('span', { class: 'reader-recommend-progress-value', text: '8%' });
  const statusText = mixed ? 'ニュース・知識・改善事例を最新化中' : scopedMode === 'papers' ? '論文・研究の登録先を確認中' : '登録した取得先を確認中';
  const status = el('span', { text: statusText });
  const progress = el('div', { class: 'reader-recommend-progress' }, [status, el('div', { class: 'reader-recommend-progress-track' }, [fill]), value]);
  const box = el('div', { class: 'reader-recommend-loading' }, [
    el('strong', { text: 'おすすめを選んでいます…' }),
    el('span', { text: mixed ? 'ニュース・知識・改善事例の全記事を新しい順に表示します' : scopedMode === 'papers' ? '論文・研究をPaper Attention Scoreで表示します' : '登録した取得先からおすすめを選別します' }),
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
  set(8); return set;
}

function sourceStates(mode) {
  if (mode === 'papers') return [''];
  return ['', ...feedsFor(mode).map(feed => feed.name)];
}
function applyModeBoundary(nextMode, direction) {
  setReaderMode(nextMode);
  if (nextMode === 'papers') return;
  const states = sourceStates(nextMode);
  setSelectedFeed(nextMode, direction > 0 ? states[0] : states.at(-1));
}
function stepReaderContext(mode, direction, rerender) {
  if (![-1, 1].includes(direction)) return;
  const states = sourceStates(mode), selected = mode === 'papers' ? '' : getSelectedFeed(mode);
  let current = states.indexOf(selected); if (current < 0) current = 0;
  const next = current + direction;
  if (next >= 0 && next < states.length && mode !== 'papers') {
    setSelectedFeed(mode, states[next]); rerender(); return;
  }
  const modeIndex = READER_MODES.indexOf(mode), nextModeIndex = modeIndex + direction;
  if (nextModeIndex < 0 || nextModeIndex >= READER_MODES.length) return;
  applyModeBoundary(READER_MODES[nextModeIndex], direction); rerender();
}
function installReaderListSwipe(node, mode, rerender) {
  let start = null, suppressUntil = 0;
  const shouldIgnore = target => Boolean(target?.closest?.('input,textarea,select,a,.reader-source-dock,.reader-mode-nav,.paper-track-level,.reader-search'));
  const onStart = event => {
    if (event.touches?.length !== 1 || shouldIgnore(event.target)) return;
    const touch = event.touches[0]; start = { x: touch.clientX, y: touch.clientY };
  };
  const onEnd = event => {
    if (!start || !event.changedTouches?.length) { start = null; return; }
    const touch = event.changedTouches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y; start = null;
    if (Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy) * 1.35) return;
    suppressUntil = Date.now() + 430; stepReaderContext(mode, dx > 0 ? 1 : -1, rerender);
  };
  const blockClick = event => {
    if (Date.now() >= suppressUntil) return;
    event.preventDefault(); event.stopPropagation();
  };
  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchend', onEnd, { passive: true });
  node.addEventListener('click', blockClick, true);
  return () => {
    node.removeEventListener('touchstart', onStart); node.removeEventListener('touchend', onEnd); node.removeEventListener('click', blockClick, true);
  };
}

export async function renderReader(root, {
  navigate, refresh = false, readerRecommendations = false,
  recommendationMode = '', recommendationTrack = '', openId = ''
}) {
  focusHandle?.destroy?.(); focusHandle = null;
  swipeDetach?.(); swipeDetach = null;
  compactDetach?.(); compactDetach = null;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? 'technology' : 'core';
  const scopedMode = READER_MODES.includes(recommendationMode) ? recommendationMode : '';
  const mixedRecommendation = readerRecommendations && !scopedMode;

  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root, { navigate, refresh: force, readerRecommendations: false });
  const switchMode = nextMode => {
    if (!READER_MODES.includes(nextMode) || nextMode === mode) return;
    setReaderMode(nextMode); renderReader(root, { navigate, readerRecommendations: false });
  };

  const actions = [];
  if (mode !== 'papers') actions.push({ html: iconSvg('plus', { size: 20 }), title: '追加/編集', onClick: () => manageFeeds(mode, rerender) });
  actions.push(
    { html: iconSvg('refresh', { size: 20 }), title: '更新', onClick: () => rerender(true) },
    { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
  );
  const header = topbar('読む', {
    subtitle: readerRecommendations
      ? (scopedMode === 'papers' ? '論文・研究のおすすめ' : scopedMode ? `${modeLabel(scopedMode)}からおすすめ` : 'ニュース・知識・改善事例を新しい順')
      : modeLabel(mode),
    actions
  });
  screen.append(header);
  const modeNav = el('div', { class: 'reader-mode-nav' });
  modeNav.append(segmented([
    { value: 'news', label: 'ニュース' },
    { value: 'knowledge', label: '知識' },
    { value: 'papers', label: '論文・研究' }
  ], mode, switchMode));
  screen.append(modeNav);

  const host = el('div', { class: 'reader-content-host' });
  const openRecommendation = () => mode === 'papers'
    ? renderReader(root, { navigate, readerRecommendations: true, recommendationMode: 'papers', recommendationTrack: 'technology' })
    : renderReader(root, { navigate, readerRecommendations: true });

  if (!readerRecommendations) {
    if (mode === 'papers') screen.append(buildPaperDock(openRecommendation));
    else screen.append(buildSourceDock(mode, {
      onSourceChange: next => {
        setSelectedFeed(mode, next?.feed || '');
        renderReader(root, { navigate, readerRecommendations: false });
      },
      onRecommend: openRecommendation
    }));
  }
  screen.append(host); root.replaceChildren(screen);

  const openArticleSequence = (item, initialIndex, visibleItems) => {
    const rows = Array.isArray(visibleItems) && visibleItems.length ? visibleItems : [item];
    screen.classList.remove('reader-list-open', 'reader-list-motion-compact');
    screen.classList.add('reader-focus-open', 'reader-article-open');
    window.scrollTo({ top: 0, behavior: 'auto' });
    focusHandle?.destroy?.();
    focusHandle = mountFocus(host, {
      items: rows, initialIndex, label: currentSourceLabel(mode), summaryMode: mode,
      onList: () => renderReader(root, { navigate, readerRecommendations: false }),
      onIndexChange: (_, activeItem) => { const r = getRead(mode, track); r.add(activeItem.id); saveRead(mode, track, r); },
      onPrevFeed: () => { const i = READER_MODES.indexOf(mode); if (i > 0) switchMode(READER_MODES[i - 1]); },
      onNextFeed: () => { const i = READER_MODES.indexOf(mode); if (i < READER_MODES.length - 1) switchMode(READER_MODES[i + 1]); }
    });
  };

  if (readerRecommendations) {
    screen.classList.add('reader-focus-open', 'reader-recommendations-open');
    const setLoadingProgress = recommendationLoading(host, mixedRecommendation, scopedMode);
    try {
      const recommendations = mixedRecommendation
        ? await loadMixedRecommendations(setLoadingProgress, { forceSources: true })
        : await loadModeRecommendations(scopedMode, { onProgress: setLoadingProgress });
      if (mixedRecommendation) {
        mixedWarmItems = recommendations;
        mixedWarmAt = Date.now();
      }
      if (!recommendations.length) throw new Error('おすすめ記事がありません');
      setLoadingProgress(100, 'おすすめを表示します');

      const returnToOrigin = () => {
        const returnMode = mixedRecommendation ? mode : scopedMode;
        setReaderMode(returnMode);
        renderReader(root, { navigate, readerRecommendations: false });
      };
      const recommendationSwitch = direction => {
        if (!scopedMode) return;
        const i = READER_MODES.indexOf(scopedMode), next = i + direction;
        if (next < 0 || next >= READER_MODES.length) return;
        const nextMode = READER_MODES[next];
        setReaderMode(nextMode);
        renderReader(root, {
          navigate, readerRecommendations: true, recommendationMode: nextMode,
          recommendationTrack: nextMode === 'papers' ? 'technology' : ''
        });
      };
      requestAnimationFrame(() => {
        focusHandle = mountFocus(host, {
          items: recommendations,
          label: scopedMode === 'papers' ? '論文・研究' : 'おすすめ',
          summaryMode: scopedMode,
          onList: returnToOrigin,
          onPrevFeed: () => recommendationSwitch(-1),
          onNextFeed: () => recommendationSwitch(1),
          onIndexChange: (_, item) => {
            const m = item._readerMode || scopedMode || 'news';
            const t = m === 'papers' ? 'technology' : 'core';
            const r = getRead(m, t); r.add(item.id); saveRead(m, t, r);
          }
        });
      });
    } catch (error) {
      screen.classList.remove('reader-focus-open');
      host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
    }
    return;
  }

  if (openId) {
    try {
      const cachedRows = mode === 'papers'
        ? (await readPaperCacheRows()).items
        : ((await readReaderCache(mode, track))?.items || []);
      const annotatedCached = annotateItems(cachedRows, mode);
      const cachedIndex = annotatedCached.findIndex(item => String(item?.id || '') === String(openId));
      if (cachedIndex >= 0) {
        const r = getRead(mode, track); r.add(String(openId)); saveRead(mode, track, r);
        openArticleSequence(annotatedCached[cachedIndex], cachedIndex, annotatedCached);
        if (mode === 'papers') loadPaperRows({ force: false, fastOnly: true, preferCache: false }).catch(() => {});
        else loadReader(mode, { selectedFeed: '', force: false, preferCache: false, backgroundRefresh: true }).catch(() => {});
        return;
      }
    } catch {}
  }

  screen.classList.add('reader-list-open');
  swipeDetach = installReaderListSwipe(screen, mode, () => renderReader(root, { navigate, readerRecommendations: false }));
  host.replaceChildren(el('div', { class: 'card', html: '<div class="loading">記事一覧を読み込み中...</div>' }));

  try {
    const selectedFeed = getSelectedFeed(mode);
    const showList = rows => {
      const prepared = mode === 'papers' ? stampPaperItems(dedupePaperItems(rows)) : rows;
      const annotated = annotateItems(prepared, mode);
      renderBento(host, mode, track, annotated, { onOpen: openArticleSequence });
      return annotated;
    };
    const result = mode === 'papers'
      ? await loadPaperRows({
        force: refresh,
        onProgress: (items, meta = {}) => {
          if (!items?.length) return;
          if (!host.querySelector('.reader-bento-view') || meta?.cached || meta?.paperSource === 'technology') showList(items);
        }
      })
      : await loadReader(mode, {
        force: refresh, selectedFeed,
        onProgress: (items, meta = {}) => {
          if (!items?.length) return;
          if (!host.querySelector('.reader-bento-view') || meta?.cached) showList(items);
        }
      });
    const annotated = showList(result.items);
    if (openId) {
      const targetIndex = annotated.findIndex(item => String(item?.id || '') === String(openId));
      if (targetIndex >= 0) {
        const r = getRead(mode, track); r.add(String(openId)); saveRead(mode, track, r);
        openArticleSequence(annotated[targetIndex], targetIndex, annotated);
        return;
      }
    }
    compactDetach = installShrinkingHeader(screen, { threshold: 72, className: 'reader-list-motion-compact', range: 58, hysteresis: 20 });
    if (state.settings.rankWithAi && annotated.length) {
      requestAiRank(annotated, mode).then(data => {
        if (data?.ranking?.length) storageSet(rankKey(mode, track), JSON.stringify({ at: Date.now(), ranking: data.ranking }));
      }).catch(() => {});
    }
  } catch (error) {
    host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
  }
}
