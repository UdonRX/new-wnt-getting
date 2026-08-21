import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';

const READER_MODES = ['news', 'knowledge', 'papers'];
let focusHandle = null;
let swipeDetach = null;
let compactDetach = null;

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

function buildFeedChips(mode, onChange) {
  if (mode === 'papers') return null;
  const feeds = feedsFor(mode);
  if (feeds.length <= 1) return null;
  const selected = getSelectedFeed(mode);
  const chips = el('div', { class: 'chips reader-feed-chips' });
  chips.append(el('button', {
    class: `chip ${!selected ? 'active' : ''}`,
    type: 'button', text: 'All',
    onclick: () => { setSelectedFeed(mode, ''); onChange(); }
  }));
  feeds.forEach(feed => chips.append(el('button', {
    class: `chip ${selected === feed.name ? 'active' : ''}`,
    type: 'button', text: feed.name,
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
    type: 'button', text: item.label,
    onclick: () => onChange(item.value)
  })));
  centerActiveChip(row);
  return row;
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

function bentoFallbackLabel(item) {
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '製品熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    return '応用発想';
  }
  return item?.feedName || item?.source || modeLabel(item?._readerMode);
}

function renderBento(host, mode, track, family, items, { onOpen, onRecommend }) {
  const read = getRead(mode, track);
  const wrap = el('div', { class: 'reader-bento-view' });
  const stickyBar = el('div', { class: 'reader-list-sticky-bar' }, [
    el('button', {
      class: 'chip active reader-list-current-source',
      type: 'button', text: currentSourceLabel(mode, track, family),
      onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' })
    }),
    el('button', { class: 'soft-button reader-list-recommend', type: 'button', text: 'おすすめへ', onclick: onRecommend })
  ]);
  const search = el('input', { class: 'reader-bento-search', placeholder: 'タイトル・媒体を検索' });
  const grid = el('div', { class: 'reader-bento-grid' });

  const draw = () => {
    grid.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const filtered = items.filter(item => !q || [item?.title,item?.titleJa,item?.source,item?.feedName].filter(Boolean).join(' ').toLowerCase().includes(q));
    filtered.forEach((item, filteredIndex) => {
      const unread = !read.has(item.id);
      const card = el('button', { class: `reader-bento-card ${filteredIndex === 0 ? 'is-hero' : ''}`, type: 'button' });
      const media = el('div', { class: 'reader-bento-media' });
      if (item?.image) {
        const image = el('img', { src:item.image, alt:'', loading:filteredIndex<=2?'eager':'lazy', decoding:'async', referrerpolicy:'no-referrer' });
        image.addEventListener('error', () => media.classList.add('image-failed'), { once:true });
        media.append(image);
      } else media.classList.add('image-failed');
      media.append(el('span', { class:'reader-bento-fallback', text:bentoFallbackLabel(item) }));
      const meta = [];
      if (unread) meta.push(el('span',{class:'badge',text:'NEW'}));
      meta.push(el('span',{text:item?.source || item?.feedName || ''}), el('span',{text:shortDate(item?.pubDate)}));
      card.append(media, el('div',{class:'reader-bento-copy'},[
        el('div',{class:'reader-bento-meta'},meta),
        el(filteredIndex===0?'h2':'h3',{class:'reader-bento-title',text:item?.titleJa || item?.title || '無題'})
      ]));
      card.onclick = () => {
        read.add(item.id);
        saveRead(mode,track,read);
        onOpen(item);
      };
      grid.append(card);
    });
    if (!filtered.length) grid.append(el('div',{class:'empty reader-bento-empty',text:'該当する記事がありません'}));
  };
  search.addEventListener('input',draw);
  draw();
  wrap.append(stickyBar,search,grid);
  host.replaceChildren(wrap);
}

function interleaveRecommendationGroups(groups) {
  const queues = groups.map(rows => [...rows]);
  const result = [];
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next) { result.push(next); added = true; }
    }
  }
  return result;
}

async function loadMixedRecommendations() {
  const jobs = await Promise.allSettled([
    loadReader('news', { preferCache: true }),
    loadReader('knowledge', { preferCache: true }),
    loadReader('papers', { paperTrack: 'core', fastOnly: true, preferCache: true }),
    loadReader('papers', { paperTrack: 'creative', fastOnly: true, preferCache: true })
  ]);

  const value = index => jobs[index].status === 'fulfilled' ? jobs[index].value.items : [];
  const news = annotateItems(value(0),'news');
  const knowledge = annotateItems(value(1),'knowledge');
  const core = annotateItems(value(2),'papers','core');
  const creative = annotateItems(value(3),'papers','creative','all');

  const newsSelected = chooseTop(news,'news',getRead('news','core'),5,cachedAiRanking('news','core')).slice(0,6);
  const knowledgeSelected = chooseTop(knowledge,'knowledge',getRead('knowledge','core'),5,cachedAiRanking('knowledge','core')).slice(0,5);
  const coreSelected = chooseTop(core,'papers',getRead('papers','core'),4,cachedAiRanking('papers','core')).slice(0,4);
  const creativeSelected = chooseTop(creative,'papers-creative-all',getRead('papers','creative'),3,cachedAiRanking('papers','creative','all')).slice(0,3);

  const papers = interleaveRecommendationGroups([coreSelected,creativeSelected]);
  return interleaveRecommendationGroups([newsSelected,knowledgeSelected,papers]).slice(0,18);
}


export async function warmReaderRecommendations() {
  await Promise.allSettled([
    loadReader('news', { preferCache: false }),
    loadReader('knowledge', { preferCache: false }),
    loadReader('papers', { paperTrack: 'core', fastOnly: true, preferCache: false }),
    loadReader('papers', { paperTrack: 'creative', fastOnly: true, preferCache: false })
  ]);
}

export async function renderReader(root, {
  navigate,
  refresh = false,
  readerRecommendations = false
}) {
  focusHandle?.destroy?.(); focusHandle = null;
  swipeDetach?.(); swipeDetach = null;
  compactDetach?.(); compactDetach = null;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';
  const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root,{navigate,refresh:force,readerRecommendations:false});

  const header = topbar('読む', {
    subtitle: readerRecommendations ? 'ニュース・知識・論文からおすすめ' : mode === 'papers' ? '論文' : modeLabel(mode),
    actions: [
      { html:iconSvg('plus',{size:20}), title:'追加/編集', onClick:()=>manageFeeds(mode,rerender) },
      { html:iconSvg('refresh',{size:20}), title:'更新', onClick:()=>rerender(true) },
      { html:iconSvg('settings',{size:20}), title:'設定', onClick:()=>navigate('settings') }
    ]
  });
  screen.append(header);

  const modeNav = el('div',{class:'reader-mode-nav'});
  modeNav.append(segmented([
    {value:'news',label:'ニュース'},
    {value:'knowledge',label:'知識'},
    {value:'papers',label:'論文'}
  ],mode,value=>{
    if (!READER_MODES.includes(value) || value===mode) return;
    update('lastReaderMode',value);
    renderReader(root,{navigate,readerRecommendations:false});
  }));
  screen.append(modeNav);
  swipeDetach = attachSwipe(modeNav,{
    left:()=>{ const i=READER_MODES.indexOf(mode); if(i<READER_MODES.length-1){update('lastReaderMode',READER_MODES[i+1]);renderReader(root,{navigate,readerRecommendations:false});}},
    right:()=>{ const i=READER_MODES.indexOf(mode); if(i>0){update('lastReaderMode',READER_MODES[i-1]);renderReader(root,{navigate,readerRecommendations:false});}},
    threshold:40
  });

  if (mode==='papers') {
    screen.append(buildPaperTrackLevel(value=>{
      update('paperTrack',value);
      renderReader(root,{navigate,readerRecommendations:false});
    }));
  }

  const stickyContext = el('div',{class:'reader-sticky-context'});
  if (mode!=='papers') {
    const chips = buildFeedChips(mode,()=>renderReader(root,{navigate,readerRecommendations:false}));
    if (chips) stickyContext.append(chips);
  } else if (track==='creative') {
    stickyContext.append(buildCreativeFamilyTabs(value=>{
      update('creativePaperFamily',value);
      renderReader(root,{navigate,readerRecommendations:false});
    }));
  }
  screen.append(stickyContext);
  const host = el('div',{class:'reader-content-host'});
  screen.append(host);
  root.replaceChildren(screen);

  const openSingleArticle = item => {
    screen.classList.remove('reader-list-open','reader-list-compact');
    screen.classList.add('reader-focus-open','reader-article-open');
    window.scrollTo({top:0,behavior:'auto'});
    focusHandle?.destroy?.();
    focusHandle = mountFocus(host,{
      items:[item],
      label:currentSourceLabel(mode,track,family),
      summaryMode:item._readerMode || mode,
      onList:()=>renderReader(root,{navigate,readerRecommendations:false})
    });
  };

  if (readerRecommendations) {
    screen.classList.add('reader-focus-open','reader-recommendations-open');
    host.replaceChildren(el('div',{class:'reader-recommend-loading'},[
      el('strong',{text:'おすすめを選んでいます'}),
      el('span',{text:'ニュース・知識は新しさ、論文は面白さを優先'}),
      el('div',{class:'reader-modern-loader-track'},[el('div',{class:'reader-modern-loader-fill'})])
    ]));
    try {
      const mixed = await loadMixedRecommendations();
      if (!mixed.length) throw new Error('おすすめ記事を準備できませんでした');
      focusHandle = mountFocus(host,{
        items:mixed,
        label:'おすすめ',
        summaryMode:'',
        onList:()=>renderReader(root,{navigate,readerRecommendations:false}),
        onIndexChange:(_,item)=>{
          const m=item._readerMode || 'news';
          const t=item._paperTrack || 'core';
          const r=getRead(m,t); r.add(item.id); saveRead(m,t,r);
        }
      });
    } catch (error) {
      screen.classList.remove('reader-focus-open');
      host.replaceChildren(el('div',{class:'error-box',text:error.message}));
    }
    return;
  }

  screen.classList.add('reader-list-open');
  host.replaceChildren(el('div',{class:'card',html:'<div class="loading">記事一覧を読み込み中...</div>'}));

  try {
    const selectedFeed = getSelectedFeed(mode);
    const result = await loadReader(mode,{
      force:refresh,
      selectedFeed,
      paperTrack:track,
      onProgress:items=>{
        if (!items?.length || host.querySelector('.reader-bento-view')) return;
        const annotated = annotateItems(mode==='papers'&&track==='creative'?filterCreativeItems(items,family):items,mode,track,family);
        renderBento(host,mode,track,family,annotated,{
          onOpen:openSingleArticle,
          onRecommend:()=>navigate('reader',{source:'bottom-nav'})
        });
      }
    });
    let items = result.items;
    if (mode==='papers'&&track==='creative') items=filterCreativeItems(items,family);
    const annotated=annotateItems(items,mode,track,family);
    renderBento(host,mode,track,family,annotated,{
      onOpen:openSingleArticle,
      onRecommend:()=>navigate('reader',{source:'bottom-nav'})
    });
    compactDetach=installShrinkingHeader(screen,{threshold:56,className:'reader-list-compact'});

    if (state.settings.rankWithAi && annotated.length) {
      const rankMode=mode==='papers'&&track==='creative'?creativeRankMode(family):mode;
      requestAiRank(annotated,rankMode).then(data=>{
        if(data?.ranking?.length) storageSet(rankKey(mode,track,family),JSON.stringify({at:Date.now(),ranking:data.ranking}));
      }).catch(()=>{});
    }
  } catch (error) {
    host.replaceChildren(el('div',{class:'error-box',text:error.message}));
  }
}
