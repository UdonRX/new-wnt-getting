import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem } from '../../shared/components.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';

const READER_MODES = ['news', 'knowledge', 'papers'];

let view = 'list';
let allItems = [];
let focusHandle = null;
let modeSwipeDetach = null;
let recommendationIndex = 0;
let articleIndex = 0;
let readerSessionStarted = false;

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
          <div class="list-meta"><span>${item.source || ''}</span><span>${shortDate(item.pubDate)}</span></div>
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

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';

  // 「読む」へ入った最初の1回だけおすすめ。
  // ニュース/知識では保存済みの小タブに依存せず All から候補を選ぶ。
  if (firstEntry) {
    view = 'recommendations';
    recommendationIndex = 0;
    if (mode !== 'papers') setSelectedFeed(mode, '');
  }

  const screen = el('section', { class: 'screen reader-screen' });
  const rerender = (force = false) => renderReader(root, { navigate, refresh: force });

  screen.append(topbar('読む', {
    subtitle: mode === 'papers'
      ? (track === 'creative' ? '論文・独創研究' : '論文・製品／熱研究')
      : 'ニュース・知識・論文',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manageFeeds(mode, rerender) },
      { label: '↻', title: '更新', onClick: () => rerender(true) },
      { label: '⚙︎', title: '設定', onClick: () => navigate('settings') }
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

  const cycleFeed = delta => {
    const feeds = feedsFor(mode);
    if (feeds.length <= 1) return;

    const names = ['', ...feeds.map(feed => feed.name)];
    const current = getSelectedFeed(mode);
    const index = Math.max(0, names.indexOf(current));
    const next = Math.max(0, Math.min(names.length - 1, index + delta));
    if (next === index) return;

    setSelectedFeed(mode, names[next]);
    view = 'list';
    articleIndex = 0;
    renderReader(root, { navigate });
  };

  const cyclePaperTrack = delta => {
    const tracks = ['core', 'creative'];
    const index = tracks.indexOf(track);
    const next = Math.max(0, Math.min(tracks.length - 1, index + delta));
    if (next === index) return;

    update('paperTrack', tracks[next]);
    view = 'list';
    articleIndex = 0;
    renderReader(root, { navigate });
  };

  const cycleCreativeFamily = delta => {
    const families = ['all', 'applied', 'general'];
    const current = creativeFamily();
    const index = families.indexOf(current);
    const next = Math.max(0, Math.min(families.length - 1, index + delta));
    if (next === index) return;

    update('creativePaperFamily', families[next]);
    view = 'list';
    articleIndex = 0;
    renderReader(root, { navigate });
  };

  const horizontalOptions = mode === 'papers'
    ? (track === 'creative'
      ? {
          onPrevFeed: () => cycleCreativeFamily(-1),
          onNextFeed: () => cycleCreativeFamily(1),
          horizontalHint: '独創研究タブ'
        }
      : {
          onPrevFeed: () => cyclePaperTrack(-1),
          onNextFeed: () => cyclePaperTrack(1),
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

      const detachListSwipe = attachSwipe(host, {
        left: horizontalOptions.onNextFeed,
        right: horizontalOptions.onPrevFeed,
        threshold: 72
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

    // 初回おすすめ。件数はUI上で固定せず、取得できた件数をそのまま進捗に使う。
    // ニュース/知識では firstEntry 時に selectedFeed を All に戻しているため、
    // すべての小タブの記事を候補にランキングされる。
    const read = getRead(mode, track);
    chosen = chooseTop(
      visibleItems,
      rankMode,
      read,
      Math.min(5, visibleItems.length),
      state.settings.rankWithAi ? cachedAiRanking(mode, track, family) : []
    );

    if (!chosen.length) {
      view = 'list';
      renderContent();
      return;
    }

    recommendationIndex = Math.max(0, Math.min(recommendationIndex, chosen.length - 1));
    host.replaceChildren();

    focusHandle = mountFocus(host, {
      items: chosen,
      initialIndex: recommendationIndex,
      label: recommendationLabel(mode, track, family),
      progressHost,
      onList: () => {
        view = 'list';
        renderContent();
        scrollContentToTop(host);
      },
      onEnd: () => {
        // 最後のおすすめを読み切った後、末尾でもう一度上スワイプ → 記事一覧。
        view = 'list';
        recommendationIndex = 0;
        renderContent();
        scrollContentToTop(host);
      },
      onIndexChange: (index, item) => {
        recommendationIndex = index;
        read.add(item.id);
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
          allItems = items;
          renderContent();
        }
      }
    });

    allItems = result.items;
    renderContent();

    if (state.settings.rankWithAi && allItems.length) {
      const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
      const visible = mode === 'papers' && track === 'creative'
        ? filterCreativeItems(allItems, family)
        : allItems;
      const rankMode = mode === 'papers' && track === 'creative'
        ? creativeRankMode(family)
        : mode;

      requestAiRank(visible, rankMode)
        .then(data => {
          if (data?.ranking?.length) {
            localStorage.setItem(rankKey(mode, track, family), JSON.stringify({
              at: Date.now(),
              ranking: data.ranking
            }));
          }
        })
        .catch(() => {});
    }
  } catch (err) {
    progressHost.replaceChildren();
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
