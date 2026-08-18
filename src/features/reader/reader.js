import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager } from '../../shared/components.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';
import { CREATIVE_PAPER_GROUPS, CREATIVE_PAPER_FAMILIES, webOfScienceQuery, scopusQuery } from '../../../shared/paper-creative-keywords.js';

let view = 'focus';
let allItems = [];
let focusHandle = null;

const paperTrack = () => state.paperTrack === 'creative' ? 'creative' : 'core';
const creativeFamily = () => ['applied','general'].includes(state.creativePaperFamily) ? state.creativePaperFamily : 'all';
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

function focusLabel(mode, track = 'core', family = 'all') {
  if (mode === 'papers') {
    if (track !== 'creative') return '注目論文';
    if (family === 'general') return '一般独創ピックアップ';
    if (family === 'applied') return '応用発想ピックアップ';
    return '独創研究ピックアップ';
  }
  return mode === 'knowledge' ? 'いま読む5件' : 'いま押さえる5件';
}

function creativeFamiliesOf(item) {
  const text = String(item?.description || '');
  const result = [];
  if (/独創区分:\s*[^\n]*応用発想/i.test(text)) result.push('applied');
  if (/独創区分:\s*[^\n]*一般独創/i.test(text)) result.push('general');
  // V2.1以前のキャッシュは独創区分を持たないため応用発想として互換表示する。
  if (!result.length) result.push('applied');
  return result;
}

function filterCreativeItems(items, family) {
  if (family === 'all') return items;
  return items.filter(item => creativeFamiliesOf(item).includes(family));
}

function creativeRankMode(family) {
  if (family === 'general') return 'papers-creative-general';
  if (family === 'applied') return 'papers-creative-applied';
  return 'papers-creative-all';
}

function getSelectedFeed(mode) {
  return localStorage.getItem(selectedFeedKey(mode)) || '';
}

function setSelectedFeed(mode, name) {
  localStorage.setItem(selectedFeedKey(mode), name || '');
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
      rerender();
    }
  }), { title: `${modeLabel(mode)}のタブ編集` });
}

function renderFeedChips(host, mode, onChange) {
  if (mode === 'papers') return;
  const feeds = feedsFor(mode);
  if (feeds.length <= 1) return;
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
  host.append(chips);
}

function creativeKeywordSheet() {
  const wrap = el('div', { class: 'paper-keyword-sheet' });
  wrap.append(
    el('p', {
      class: 'muted-copy',
      text: '独創研究は「珍しい題材」だけでは採用せず、異なる領域の接続＋鋭い問い＋実験・測定・モデル・因果推論などの検証性が同時に見える研究を優先します。'
    })
  );

  for (const familyId of ['applied', 'general']) {
    const meta = CREATIVE_PAPER_FAMILIES[familyId];
    wrap.append(
      el('div', { class: 'paper-keyword-family-title', text: meta.label }),
      el('p', { class: 'muted-copy', text: meta.description })
    );

    CREATIVE_PAPER_GROUPS.filter(group => group.family === familyId).forEach(group => {
      const card = el('article', { class: 'paper-keyword-card' });
      card.append(
        el('h3', { text: group.label }),
        el('p', { class: 'paper-keyword-intent', text: group.intent }),
        el('div', { class: 'paper-keyword-label', text: '日本語キーワード' }),
        el('div', { class: 'paper-keyword-tags', text: group.jaKeywords.join(' ／ ') }),
        el('div', { class: 'paper-keyword-label', text: '英語キーワード' }),
        el('div', { class: 'paper-keyword-tags', text: group.enKeywords.join(' ／ ') }),
        el('div', { class: 'paper-keyword-label', text: 'Web of Science向け' }),
        el('code', { class: 'paper-query-code', text: webOfScienceQuery(group) }),
        el('div', { class: 'paper-keyword-label', text: 'Scopus向け' }),
        el('code', { class: 'paper-query-code', text: scopusQuery(group) })
      );
      wrap.append(card);
    });
  }

  openSheet(wrap, { title: '独創研究の検索キーワード' });
}

function renderPaperTrack(host, rerender, onFamilyChange) {
  const track = paperTrack();
  const row = el('div', { class: 'paper-track-row' });
  row.append(segmented([
    { value: 'core', label: '製品・熱' },
    { value: 'creative', label: '独創研究' }
  ], track, value => {
    update('paperTrack', value);
    view = 'focus';
    rerender();
  }));

  row.append(el('button', {
    class: 'soft-button paper-keyword-button',
    type: 'button',
    text: '検索意図',
    title: '独創研究キーワードと狙い',
    onclick: creativeKeywordSheet
  }));

  host.append(row);

  if (track === 'creative') {
    const family = creativeFamily();
    const familyRow = el('div', { class: 'paper-family-row' });
    familyRow.append(segmented([
      { value: 'all', label: 'すべて' },
      { value: 'applied', label: '応用発想' },
      { value: 'general', label: '一般独創' }
    ], family, value => {
      update('creativePaperFamily', value);
      view = 'focus';
      onFamilyChange?.();
    }));
    host.append(familyRow);
  }

  const family = creativeFamily();
  host.append(el('div', {
    class: 'paper-track-note',
    text: track === 'creative'
      ? family === 'general'
        ? '既存の製品キーワードとの関係は不要。異分野接続 × 身近な疑問 × 検証性で選定。←→は「製品・熱」と切替。'
        : family === 'applied'
          ? '既存テーマへ異分野の原理を持ち込む応用発想を表示。←→は「製品・熱」と切替。'
          : '応用発想＋一般独創を混合表示。ピックアップは両方に偏らないよう選定。←→で「製品・熱」と切替。'
      : '炊飯・真空断熱・蓄熱・対象製品・競合メーカーを中心に選定。←→スワイプで「独創研究」へ。'
  }));
}

function renderList(host, mode, track, family, items, onOpen) {
  const read = getRead(mode, track);
  const lastSeen = Number(localStorage.getItem(lastSeenKey(mode, track, family)) || 0);
  const newCount = items.filter(i => new Date(i.pubDate).getTime() > lastSeen).length;
  const header = el('div', { class: 'reader-list-header' }, [
    el('strong', { text: newCount ? `前回から ${newCount}件` : '全記事' }),
    el('small', { text: `${items.length}件` })
  ]);
  const search = el('input', { class: 'reader-search', placeholder: 'タイトル・媒体・研究軸を検索' });
  const list = el('div', { class: 'list' });

  const draw = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    let marker = false;
    items
      .filter(i => !q || `${i.title} ${i.titleJa || ''} ${i.source} ${i.description || ''}`.toLowerCase().includes(q))
      .forEach((item, index) => {
        if (!marker && lastSeen && new Date(item.pubDate).getTime() <= lastSeen) {
          list.append(el('div', { class: 'previous-line', text: '前回ここまで' }));
          marker = true;
        }
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
        button.innerHTML = `<div class="list-item-title">${unread ? '<span class="unread-dot"></span>' : ''}${item.titleJa || item.title}</div>${item.titleJa ? `<div class="focus-original">${item.title}</div>` : ''}<div class="list-meta"><span>${item.source || ''}</span><span>${shortDate(item.pubDate)}</span></div>`;
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

export async function renderReader(root, { navigate, refresh = false }) {
  view = 'focus';
  allItems = [];
  focusHandle?.destroy?.();
  focusHandle = null;

  const mode = state.readerMode || 'news';
  const track = mode === 'papers' ? paperTrack() : 'core';
  const screen = el('section', { class: 'screen' });
  const rerender = () => renderReader(root, { navigate, refresh: true });

  screen.append(topbar('読む', {
    subtitle: mode === 'papers'
      ? (track === 'creative' ? '論文・独創研究' : '論文・製品／熱研究')
      : 'ニュース・知識・論文',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manageFeeds(mode, rerender) },
      { label: '↻', title: '更新', onClick: rerender },
      { label: '⚙︎', title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const toolbar = el('div', { class: 'reader-toolbar' });
  toolbar.append(segmented([
    { value: 'news', label: 'ニュース' },
    { value: 'knowledge', label: '知識' },
    { value: 'papers', label: '論文' }
  ], mode, value => {
    update('lastReaderMode', value);
    view = 'focus';
    renderReader(root, { navigate });
  }));

  let focusBadge = null;
  let requestCurrentAiRank = () => {};
  if (mode === 'papers') renderPaperTrack(
    toolbar,
    () => renderReader(root, { navigate }),
    () => {
      if (focusBadge) focusBadge.textContent = focusLabel(mode, track, creativeFamily());
      renderContent();
      requestCurrentAiRank();
    }
  );
  else renderFeedChips(toolbar, mode, () => { view = 'focus'; renderReader(root, { navigate }); });

  const viewBar = el('div', { class: 'reader-viewbar' });
  focusBadge = el('div', { class: 'badge', text: focusLabel(mode, track, track === 'creative' ? creativeFamily() : 'all') });
  viewBar.append(
    focusBadge,
    el('button', {
      class: 'soft-button',
      type: 'button',
      text: view === 'list' ? 'ショート表示' : '≡ 全一覧',
      onclick: () => { view = view === 'list' ? 'focus' : 'list'; renderContent(); }
    })
  );
  toolbar.append(viewBar);
  screen.append(toolbar);

  const host = el('div');
  screen.append(host);
  root.replaceChildren(screen);
  host.append(el('div', { class: 'card', html: '<div class="loading">読み込み中...</div>' }));

  if (mode === 'papers') {
    window.addEventListener('pdv2:paper-titles', () => {
      try {
        const translated = JSON.parse(localStorage.getItem('pdv2:paperTitleJa') || '{}');
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
    const index = Math.max(0, names.indexOf(current));
    const next = Math.max(0, Math.min(names.length - 1, index + delta));
    if (next === index) return;
    setSelectedFeed(mode, names[next]);
    view = 'focus';
    renderReader(root, { navigate });
  };

  const cyclePaperTrack = delta => {
    const tracks = ['core', 'creative'];
    const index = tracks.indexOf(track);
    const next = Math.max(0, Math.min(tracks.length - 1, index + delta));
    if (next === index) return;
    update('paperTrack', tracks[next]);
    view = 'focus';
    renderReader(root, { navigate });
  };

  const horizontalOptions = mode === 'papers'
    ? { onPrevFeed: () => cyclePaperTrack(-1), onNextFeed: () => cyclePaperTrack(1), horizontalHint: '論文タブ' }
    : { onPrevFeed: () => cycleFeed(-1), onNextFeed: () => cycleFeed(1), horizontalHint: 'RSSタブ' };

  const renderContent = () => {
    focusHandle?.destroy?.();
    const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
    const visibleItems = mode === 'papers' && track === 'creative'
      ? filterCreativeItems(allItems, family)
      : allItems;
    const rankMode = mode === 'papers' && track === 'creative' ? creativeRankMode(family) : mode;

    if (focusBadge) focusBadge.textContent = focusLabel(mode, track, family);

    if (!visibleItems.length) {
      host.innerHTML = `<div class="empty">${track === 'creative' && family === 'general' ? '一般独創の候補を取得中です。更新すると再検索します。' : '記事がありません'}</div>`;
      return;
    }

    if (view === 'list') {
      renderList(host, mode, track, family, visibleItems, (item, index) => {
        view = 'focus';
        chosen = visibleItems;
        host.replaceChildren();
        focusHandle = mountFocus(host, {
          items: chosen,
          initialIndex: index,
          label: mode === 'papers' && track === 'creative'
            ? (family === 'general' ? '一般独創一覧' : family === 'applied' ? '応用発想一覧' : '独創研究一覧')
            : '全記事',
          onList: () => { view = 'list'; renderContent(); },
          onIndexChange: (_, it) => {
            const r = getRead(mode, track);
            r.add(it.id);
            saveRead(mode, track, r);
          },
          ...horizontalOptions
        });
      });
      const detachListSwipe = attachSwipe(host, {
        left: horizontalOptions.onNextFeed,
        right: horizontalOptions.onPrevFeed,
        threshold: 72
      });
      focusHandle = { destroy: detachListSwipe };
      return;
    }

    const read = getRead(mode, track);
    chosen = chooseTop(
      visibleItems,
      rankMode,
      read,
      5,
      state.settings.rankWithAi ? cachedAiRanking(mode, track, family) : []
    );
    host.replaceChildren();
    focusHandle = mountFocus(host, {
      items: chosen,
      label: focusLabel(mode, track, family),
      onList: () => { view = 'list'; renderContent(); },
      onIndexChange: (_, it) => {
        read.add(it.id);
        saveRead(mode, track, read);
      },
      ...horizontalOptions
    });
  };

  requestCurrentAiRank = () => {
    if (!state.settings.rankWithAi || !allItems.length) return;
    const family = mode === 'papers' && track === 'creative' ? creativeFamily() : 'all';
    const visibleItems = mode === 'papers' && track === 'creative' ? filterCreativeItems(allItems, family) : allItems;
    if (!visibleItems.length) return;
    const rankMode = mode === 'papers' && track === 'creative' ? creativeRankMode(family) : mode;
    requestAiRank(visibleItems, rankMode).then(data => {
      if (data?.ranking?.length) {
        localStorage.setItem(rankKey(mode, track, family), JSON.stringify({ at: Date.now(), ranking: data.ranking }));
      }
    }).catch(() => {});
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

    requestCurrentAiRank();
  } catch (err) {
    host.innerHTML = `<div class="error-box">${err.message}</div>`;
  }
}
