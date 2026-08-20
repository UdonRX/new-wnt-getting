import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, collectionManager } from '../../shared/components.js';
import { loadReader, feedsFor, readReaderCache } from './reader-data.js';
import { chooseTop } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { iconSvg } from '../../shared/icons.js';

let view = 'feed';
let focusHandle = null;
let readerSessionStarted = false;
let recommendationIndex = 0;
let transitionKey = '';
let catalogFilter = 'all';
let activeTopic = '';
let universeMemory = null;

const FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'news', label: 'ニュース' },
  { value: 'knowledge', label: '知識' },
  { value: 'paper-core', label: '製品・熱' },
  { value: 'paper-applied', label: '応用発想' },
  { value: 'paper-general', label: '一般独創' }
];

const TOPIC_GROUPS = [
  ['AI', /\bAI\b|人工知能|生成AI|ChatGPT|OpenAI|Gemini|LLM/i],
  ['半導体', /半導体|チップ|SiC|GaN|TSMC|NVIDIA|Intel|AMD/i],
  ['政治', /政治|国会|政府|首相|内閣|政党|法案|選挙/i],
  ['経済', /経済|景気|GDP|物価|インフレ|金利|日銀|為替|円相場|株価|市場/i],
  ['企業', /企業|決算|買収|提携|新製品|事業|工場|投資|経営/i],
  ['テクノロジー', /テクノロジ|技術|ソフトウェア|アプリ|スマホ|ロボット|量子/i],
  ['自動車', /自動車|EV|電気自動車|トヨタ|ホンダ|日産|Tesla|テスラ/i],
  ['製造', /製造|生産|工法|工程|設備|自動化|品質|コスト削減|工場/i],
  ['材料', /材料|素材|樹脂|金属|セラミック|複合材|接合|はんだ/i],
  ['エネルギー', /エネルギー|電力|原発|太陽光|再生可能|蓄電池|水素/i],
  ['科学', /研究|科学|宇宙|実験|発見|論文|生物|物理|化学/i],
  ['海外', /米国|アメリカ|中国|台湾|欧州|EU|韓国|ロシア|ウクライナ|中東/i]
];

const TOPIC_STOP_WORDS = new Set([
  'ニュース','発表','今回','今後','関係','対応','開始','最新','日本','国内','海外','情報','記事','明らか','について',
  'Reuters','BBC','Google','更新','新た','可能性','問題','政府','企業'
].map(value => value.toLowerCase()));

window.addEventListener('pdv2:before-navigate', event => {
  const target = event?.detail?.screen;
  if (target !== 'reader' || state.screen !== 'reader') {
    readerSessionStarted = false;
    focusHandle?.destroy?.();
    focusHandle = null;
    transitionKey = '';
    activeTopic = '';
    document.body.classList.remove('reader-immersive');
  }
});

function readerItemKey(item) {
  return String(item?.id || item?.link || item?.url || `${item?.source || ''}|${item?.title || ''}`);
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

function itemPubMs(item) {
  const ms = new Date(item?.pubDate || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function newestFirst(items) {
  return [...(items || [])].sort((a, b) => itemPubMs(b) - itemPubMs(a));
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
  return { day: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, key, start, until };
}

function balanceBySource(items) {
  const groups = new Map();
  newestFirst(items).forEach(item => {
    const source = String(item?.feedName || item?.source || 'その他').trim() || 'その他';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(item);
  });
  return interleaveAll([...groups.values()]);
}

function freshTimedItems(items, windowInfo) {
  const now = Date.now();
  const dated = newestFirst(items).filter(item => itemPubMs(item) > 0);
  const current = dated.filter(item => {
    const ms = itemPubMs(item);
    return ms >= windowInfo.start && ms <= now + 5 * 60 * 1000;
  });
  if (current.length) return balanceBySource(current);
  const recent = dated.filter(item => itemPubMs(item) >= now - 12 * 60 * 60 * 1000);
  return balanceBySource(recent.length ? recent : newestFirst(items));
}

function creativeFamiliesOf(item) {
  const text = `${item?.title || ''}\n${item?.description || ''}`;
  const result = [];
  if (/独創区分:\s*[^\n]*応用発想/i.test(text) || /応用発想/i.test(text)) result.push('applied');
  if (/独創区分:\s*[^\n]*一般独創/i.test(text) || /一般独創/i.test(text)) result.push('general');
  if (!result.length) result.push('applied');
  return result;
}

function paperRecommendationItems(items, track = 'core') {
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const recent = newestFirst(items).filter(item => {
    const ms = itemPubMs(item);
    return !ms || ms >= cutoff;
  });
  if (!recent.length) return [];

  const readKey = `pdv2:read:papers:${track}`;
  let read = new Set();
  try { read = new Set(JSON.parse(localStorage.getItem(readKey) || '[]')); } catch {}
  const rankedHead = chooseTop(recent, 'papers', read, recent.length, []);
  const ranked = uniqueItems([...rankedHead, ...recent]);
  return [...ranked.filter(item => !read.has(item.id)), ...ranked.filter(item => read.has(item.id))];
}

function labelFor(mode, track = 'core', family = '') {
  if (mode === 'news') return 'ニュース';
  if (mode === 'knowledge') return '専門知識';
  if (track === 'core') return '製品・熱研究';
  if (family === 'general') return '一般独創';
  if (family === 'applied') return '応用発想';
  return '独創研究';
}

function tagItem(item, mode, track = 'core', family = '') {
  const tagged = {
    ...item,
    _readerMode: mode,
    _paperTrack: track,
    _creativeFamily: family,
    _recommendationLabel: labelFor(mode, track, family)
  };
  return tagged;
}

function tagCreativeRows(rows) {
  return uniqueItems(rows).map(item => {
    const families = creativeFamiliesOf(item);
    const family = families.includes('general') && !families.includes('applied') ? 'general' : 'applied';
    return tagItem(item, 'papers', 'creative', family);
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

function universeFromCaches() {
  const news = uniqueItems(readReaderCache('news')?.items || []).map(item => tagItem(item, 'news'));
  const knowledge = uniqueItems(readReaderCache('knowledge')?.items || []).map(item => tagItem(item, 'knowledge'));
  const core = uniqueItems(readReaderCache('papers', 'core')?.items || []).map(item => tagItem(item, 'papers', 'core'));
  const creative = tagCreativeRows(readReaderCache('papers', 'creative')?.items || []);
  if (!news.length && !knowledge.length && !core.length && !creative.length) return null;
  return buildUniverse({ news, knowledge, core, creative });
}

function buildUniverse({ news, knowledge, core, creative }) {
  const windowInfo = recommendationWindowJst();
  const applied = creative.filter(item => item._creativeFamily !== 'general');
  const general = creative.filter(item => item._creativeFamily === 'general');

  const feed = interleaveAll([
    freshTimedItems(news, windowInfo),
    freshTimedItems(knowledge, windowInfo),
    paperRecommendationItems(core, 'core'),
    paperRecommendationItems(applied, 'creative'),
    paperRecommendationItems(general, 'creative')
  ]);

  const catalog = uniqueItems([
    ...feed,
    ...newestFirst(news),
    ...newestFirst(knowledge),
    ...newestFirst(core),
    ...newestFirst(creative)
  ]);

  return { feed, catalog, buckets: { news, knowledge, core, applied, general } };
}

async function loadReaderUniverse(force = false, onProgress = () => {}) {
  const windowInfo = recommendationWindowJst();
  const cacheKey = `pdv2:readerUniverse:v2143:${windowInfo.day}:${windowInfo.key}`;
  const CACHE_TTL = Math.max(60 * 1000, Math.min(15 * 60 * 1000, windowInfo.until - Date.now()));

  if (!force && universeMemory && Date.now() - universeMemory.at < CACHE_TTL) {
    onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news', 'knowledge', 'papers'] });
    return universeMemory.data;
  }

  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      const fromCaches = universeFromCaches();
      if (cached?.feed?.length && fromCaches && Date.now() - Number(cached.at || 0) < CACHE_TTL) {
        const feedMap = new Map(fromCaches.catalog.map(item => [readerItemKey(item), item]));
        const feed = cached.feed.map(row => ({ ...row, pubDate: new Date(row.pubDate) })).map(row => feedMap.get(readerItemKey(row)) || row);
        const data = { ...fromCaches, feed };
        universeMemory = { at: Date.now(), data };
        onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news', 'knowledge', 'papers'] });
        return data;
      }
    } catch {}
  }

  const done = new Set();
  const mark = (key, label) => {
    done.add(key);
    onProgress({ percent: 10 + Math.round(done.size / 3 * 84), label, done: [...done] });
  };
  onProgress({ percent: 8, label: '旬の記事を集めています', done: [] });

  const newsJob = loadReader('news', { force, selectedFeed: '', preferCache: false })
    .then(result => { mark('news', 'ニュースを更新しました'); return result?.items || []; })
    .catch(() => { mark('news', 'ニュースを確認しました'); return readReaderCache('news')?.items || []; });

  const knowledgeJob = loadReader('knowledge', { force, selectedFeed: '', preferCache: false })
    .then(result => { mark('knowledge', '知識記事を更新しました'); return result?.items || []; })
    .catch(() => { mark('knowledge', '知識を確認しました'); return readReaderCache('knowledge')?.items || []; });

  const papersJob = Promise.allSettled([
    loadReader('papers', { force, selectedFeed: '', paperTrack: 'core', fastOnly: true, preferCache: !force }),
    loadReader('papers', { force, selectedFeed: '', paperTrack: 'creative', fastOnly: true, preferCache: !force })
  ]).then(results => {
    mark('papers', '論文を選びました');
    return {
      core: results[0].status === 'fulfilled' ? results[0].value?.items || [] : readReaderCache('papers', 'core')?.items || [],
      creative: results[1].status === 'fulfilled' ? results[1].value?.items || [] : readReaderCache('papers', 'creative')?.items || []
    };
  });

  const [newsRows, knowledgeRows, papers] = await Promise.all([newsJob, knowledgeJob, papersJob]);
  const data = buildUniverse({
    news: uniqueItems(newsRows).map(item => tagItem(item, 'news')),
    knowledge: uniqueItems(knowledgeRows).map(item => tagItem(item, 'knowledge')),
    core: uniqueItems(papers.core).map(item => tagItem(item, 'papers', 'core')),
    creative: tagCreativeRows(papers.creative)
  });

  universeMemory = { at: Date.now(), data };
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), feed: data.feed }));
  } catch {}
  onProgress({ percent: 100, label: 'おすすめを準備しました', done: ['news', 'knowledge', 'papers'] });
  return data;
}

export function warmReaderRecommendations() {
  return loadReaderUniverse(false, () => {});
}

function createLoader() {
  const wrap = el('div', { class: 'reader-modern-loader' });
  const label = el('div', { class: 'reader-modern-loader-label', text: '旬の記事を集めています' });
  const track = el('div', { class: 'reader-modern-loader-track' });
  const fill = el('div', { class: 'reader-modern-loader-fill' });
  track.append(fill);
  const steps = el('div', { class: 'reader-modern-loader-steps' });
  const map = new Map();
  [['news', 'ニュース'], ['knowledge', '知識'], ['papers', '論文']].forEach(([key, text]) => {
    const node = el('span', { text });
    map.set(key, node);
    steps.append(node);
  });
  wrap.append(el('strong', { text: 'FOR YOU' }), label, track, steps);
  return {
    node: wrap,
    update(progress = {}) {
      fill.style.width = `${Math.max(6, Math.min(100, Number(progress.percent || 0)))}%`;
      if (progress.label) label.textContent = progress.label;
      const done = new Set(progress.done || []);
      map.forEach((node, key) => node.classList.toggle('done', done.has(key)));
    }
  };
}

function manageFeeds(mode, rerender) {
  const key = mode === 'papers' ? 'paperFeeds' : mode === 'knowledge' ? 'knowledgeFeeds' : 'newsFeeds';
  const label = mode === 'papers' ? '論文' : mode === 'knowledge' ? '知識' : 'ニュース';
  const sheet = openSheet(collectionManager({
    items: state[key],
    fields: [
      { key: 'name', label: 'タブ名', placeholder: '名称' },
      { key: 'url', label: 'RSS URL', placeholder: 'https://... または /api/...' }
    ],
    onSave: draft => {
      update(key, draft);
      sheet.close();
      universeMemory = null;
      rerender(true);
    }
  }), { title: `${label}の取得先` });
}

function manageSources(rerender) {
  const wrap = el('div', { class: 'reader-source-manager' });
  wrap.append(el('p', { text: '編集したいコンテンツを選んでください。' }));
  [
    ['news', 'ニュース'],
    ['knowledge', '知識'],
    ['papers', '論文']
  ].forEach(([mode, label]) => {
    wrap.append(el('button', {
      class: 'soft-button full-button',
      type: 'button',
      text: `${label}の取得先を編集`,
      onclick: () => manageFeeds(mode, rerender)
    }));
  });
  openSheet(wrap, { title: '読む：取得先' });
}

function readerPlainText(value = '') {
  const node = document.createElement('div');
  node.innerHTML = String(value || '');
  return (node.textContent || '').replace(/\s+/g, ' ').trim();
}

function topicText(item) {
  return `${item?.titleJa || ''} ${item?.title || ''} ${item?.description || ''}`;
}

function itemMatchesTopic(item, topic) {
  if (!topic) return true;
  const group = TOPIC_GROUPS.find(([label]) => label === topic);
  if (group) return group[1].test(topicText(item));
  return topicText(item).toLocaleLowerCase('ja').includes(String(topic).toLocaleLowerCase('ja'));
}

function extractTopics(items) {
  const rows = Array.isArray(items) ? items : [];
  const scored = [];
  TOPIC_GROUPS.forEach(([label, pattern]) => {
    const count = rows.reduce((sum, item) => sum + (pattern.test(topicText(item)) ? 1 : 0), 0);
    if (count) scored.push({ label, count, priority: 2 });
  });

  const tokens = new Map();
  rows.slice(0, 120).forEach(item => {
    const title = readerPlainText(item.titleJa || item.title || '');
    const matches = title.match(/[\p{Script=Katakana}ー]{3,}|[一-龠々]{2,6}|[A-Za-z][A-Za-z0-9.+-]{2,}/gu) || [];
    [...new Set(matches)].forEach(raw => {
      const label = raw.replace(/^[・:：\-]+|[・:：\-]+$/g, '');
      const key = label.toLowerCase();
      if (label.length < 2 || label.length > 18 || TOPIC_STOP_WORDS.has(key) || /^\d+$/.test(label)) return;
      tokens.set(label, (tokens.get(label) || 0) + 1);
    });
  });
  [...tokens.entries()].filter(([, count]) => count >= 2).forEach(([label, count]) => {
    if (!scored.some(row => row.label.toLowerCase() === label.toLowerCase())) scored.push({ label, count, priority: 1 });
  });
  return scored.sort((a, b) => (b.count * b.priority) - (a.count * a.priority) || b.count - a.count).slice(0, 12).map(row => row.label);
}

function filterCatalog(items, filter) {
  if (filter === 'news') return items.filter(item => item._readerMode === 'news');
  if (filter === 'knowledge') return items.filter(item => item._readerMode === 'knowledge');
  if (filter === 'paper-core') return items.filter(item => item._readerMode === 'papers' && item._paperTrack === 'core');
  if (filter === 'paper-applied') return items.filter(item => item._readerMode === 'papers' && item._paperTrack === 'creative' && item._creativeFamily !== 'general');
  if (filter === 'paper-general') return items.filter(item => item._readerMode === 'papers' && item._paperTrack === 'creative' && item._creativeFamily === 'general');
  return items;
}

function categoryFeed(items, filter) {
  return filterCatalog(items, filter);
}

function categoryBubbleRows(catalog) {
  return [
    { label: '最新ニュース', items: catalog.filter(item => item._readerMode === 'news') },
    { label: '専門知識', items: catalog.filter(item => item._readerMode === 'knowledge') },
    { label: '製品・熱研究', items: catalog.filter(item => item._readerMode === 'papers' && item._paperTrack === 'core') },
    { label: '応用発想', items: catalog.filter(item => item._readerMode === 'papers' && item._paperTrack === 'creative' && item._creativeFamily !== 'general') },
    { label: '一般独創', items: catalog.filter(item => item._readerMode === 'papers' && item._paperTrack === 'creative' && item._creativeFamily === 'general') }
  ].filter(row => row.items.length);
}

function itemDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/公開年:\s*((?:19|20)\d{2})/i)?.[1];
  if (yearOnly && /日付精度:\s*年/i.test(description)) return yearOnly;
  return shortDate(item?.pubDate);
}

function tileMedia(item) {
  const media = el('div', { class: 'reader-modern-tile-media' });
  if (item?.image) {
    const image = el('img', { src: item.image, alt: '', loading: 'lazy', decoding: 'async' });
    image.addEventListener('error', () => media.classList.add('image-failed'), { once: true });
    media.append(image);
  }
  media.append(el('div', { class: 'reader-modern-tile-fallback' }, [
    el('span', { text: item._recommendationLabel || 'READ' }),
    el('small', { text: item.source || item.feedName || '' })
  ]));
  media.append(el('span', { class: 'reader-modern-tile-badge', text: item._recommendationLabel || '記事' }));
  return media;
}

function buildTile(item, index, { onOpen }) {
  const hero = index === 0;
  const wide = !hero && index > 0 && index % 7 === 0;
  const tall = !hero && !wide && index % 5 === 0;
  const tile = el('button', {
    class: `reader-modern-tile${hero ? ' is-hero' : ''}${wide ? ' is-wide' : ''}${tall ? ' is-tall' : ''}`,
    type: 'button',
    onclick: () => onOpen(item, tile)
  });
  const key = readerItemKey(item);
  if (transitionKey && transitionKey === key) tile.style.viewTransitionName = 'reader-shared-card';
  tile.append(tileMedia(item));
  tile.append(el('div', { class: 'reader-modern-tile-copy' }, [
    el(hero ? 'h2' : 'h3', { text: item.titleJa || item.title || '無題' }),
    el('div', { class: 'reader-modern-tile-meta', text: `${item.source || item.feedName || ''}${itemDateLabel(item) ? ` ・ ${itemDateLabel(item)}` : ''}` })
  ]));
  return tile;
}

function runSharedTransition(sourceEl, key, mutate) {
  document.querySelectorAll('[style*=\"view-transition-name\"]').forEach(node => {
    if (node !== sourceEl) node.style.removeProperty('view-transition-name');
  });
  transitionKey = key || '';
  if (sourceEl) sourceEl.style.viewTransitionName = 'reader-shared-card';
  if (typeof document.startViewTransition === 'function') {
    const transition = document.startViewTransition(() => mutate());
    transition.finished.finally(() => {
      document.querySelectorAll('[style*=\"view-transition-name\"]').forEach(node => node.style.removeProperty('view-transition-name'));
      if (transitionKey === key) transitionKey = '';
    });
    return;
  }
  mutate();
  requestAnimationFrame(() => {
    document.querySelectorAll('[style*=\"view-transition-name\"]').forEach(node => node.style.removeProperty('view-transition-name'));
    if (transitionKey === key) transitionKey = '';
  });
}

function selectedFeedColor(item) {
  const mode = item?._readerMode || 'news';
  return state.settings?.colors?.[mode] || 'var(--feature-color)';
}

function renderBento(host, universe, { enterFeed, rerender, navigate }) {
  const catalog = universe.catalog;
  let visible = categoryFeed(catalog, catalogFilter);
  if (transitionKey) {
    const selectedIndex = visible.findIndex(item => readerItemKey(item) === transitionKey);
    if (selectedIndex > 1) {
      const selected = visible[selectedIndex];
      visible = [visible[0], selected, ...visible.slice(1, selectedIndex), ...visible.slice(selectedIndex + 1)];
    }
  }
  const topics = extractTopics(catalog);

  const landing = el('div', { class: 'reader-modern-bento' });
  const heroHead = el('div', { class: 'reader-modern-bento-head' }, [
    el('div', {}, [
      el('span', { class: 'reader-modern-kicker', text: 'DISCOVER' }),
      el('h1', { text: 'ピックアップ' }),
      el('p', { text: '気になるものだけ、軽く拾う。' })
    ]),
    el('button', {
      class: 'reader-modern-feed-return',
      type: 'button',
      text: 'おすすめ',
      onclick: () => { activeTopic = ''; enterFeed(universe.feed, Math.min(recommendationIndex, Math.max(0, universe.feed.length - 1)), null); }
    })
  ]);
  landing.append(heroHead);

  const filterRail = el('div', { class: 'reader-modern-filter-rail' });
  FILTERS.forEach(row => filterRail.append(el('button', {
    class: `reader-modern-filter${catalogFilter === row.value ? ' is-active' : ''}`,
    type: 'button',
    text: row.label,
    onclick: () => {
      catalogFilter = row.value;
      renderBento(host, universe, { enterFeed, rerender, navigate });
    }
  })));
  landing.append(filterRail);

  const bubbles = el('div', { class: 'reader-modern-bubbles' });
  categoryBubbleRows(catalog).forEach(row => bubbles.append(el('button', {
    class: 'reader-modern-bubble is-category',
    type: 'button',
    text: `${row.label} ${row.items.length}`,
    onclick: event => { activeTopic = ''; enterFeed(row.items, 0, event.currentTarget); }
  })));
  topics.forEach(topic => {
    const rows = catalog.filter(item => itemMatchesTopic(item, topic));
    if (!rows.length) return;
    bubbles.append(el('button', {
      class: 'reader-modern-bubble',
      type: 'button',
      text: `#${topic}`,
      onclick: event => {
        activeTopic = topic;
        enterFeed(rows, 0, event.currentTarget);
      }
    }));
  });
  landing.append(bubbles);

  const grid = el('div', { class: 'reader-modern-grid' });
  if (!visible.length) {
    grid.append(el('div', { class: 'empty', text: 'このカテゴリの記事はまだありません' }));
  } else {
    visible.forEach((item, index) => grid.append(buildTile(item, index, {
      onOpen: (selected, tile) => {
        activeTopic = '';
        const selectedIndex = visible.findIndex(row => readerItemKey(row) === readerItemKey(selected));
        enterFeed(visible, Math.max(0, selectedIndex), tile);
      }
    })));
  }
  landing.append(grid);
  host.replaceChildren(landing);
}

export async function renderReader(root, { navigate, refresh = false }) {
  focusHandle?.destroy?.();
  focusHandle = null;

  const firstEntry = !readerSessionStarted;
  readerSessionStarted = true;
  if (firstEntry) {
    view = 'feed';
    recommendationIndex = 0;
    activeTopic = '';
    catalogFilter = 'all';
  }

  const screen = el('section', { class: 'screen reader-screen reader-screen-modern' });
  const chrome = el('div', { class: 'reader-modern-chrome' });
  const host = el('div', { class: 'reader-modern-host' });
  screen.append(chrome, host);
  root.replaceChildren(screen);

  const rerender = (force = false) => {
    universeMemory = force ? null : universeMemory;
    renderReader(root, { navigate, refresh: force });
  };

  const loader = createLoader();
  host.replaceChildren(loader.node);

  let universe;
  try {
    universe = await loadReaderUniverse(refresh, progress => loader.update(progress));
  } catch (error) {
    host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
    return;
  }

  const enterFeed = (items, index = 0, sourceEl = null) => {
    const rows = uniqueItems(items);
    if (!rows.length) return;
    const selected = rows[Math.max(0, Math.min(index, rows.length - 1))];
    runSharedTransition(sourceEl, readerItemKey(selected), () => {
      view = 'feed';
      recommendationIndex = Math.max(0, Math.min(index, rows.length - 1));
      renderFeed(rows);
    });
  };

  const renderChrome = () => {
    chrome.replaceChildren();
    if (view === 'feed') return;
    chrome.append(topbar('読む', {
      subtitle: 'Bento / トピックから探す',
      actions: [
        { label: '＋', title: '取得先', onClick: () => manageSources(rerender) },
        { label: '↻', title: '更新', onClick: () => rerender(true) },
        { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
      ]
    }));
  };

  const openBento = ({ item, card } = {}) => {
    catalogFilter = 'all';
    const key = readerItemKey(item || universe.feed[recommendationIndex]);
    runSharedTransition(card, key, () => {
      view = 'bento';
      document.body.classList.remove('reader-immersive');
      screen.classList.remove('is-feed');
      screen.classList.add('is-bento');
      renderChrome();
      renderBento(host, universe, { enterFeed, rerender, navigate });
    });
  };

  const renderFeed = rows => {
    focusHandle?.destroy?.();
    focusHandle = null;
    view = 'feed';
    document.body.classList.add('reader-immersive');
    screen.classList.add('is-feed');
    screen.classList.remove('is-bento');
    renderChrome();
    host.style.setProperty('--reader-card-accent', selectedFeedColor(rows[recommendationIndex]));

    focusHandle = mountFocus(host, {
      items: rows,
      initialIndex: recommendationIndex,
      label: activeTopic ? `#${activeTopic}` : 'おすすめ',
      onList: openBento,
      onIndexChange: (index, item) => {
        recommendationIndex = index;
        host.style.setProperty('--reader-card-accent', selectedFeedColor(item));
        try {
          const mode = item?._readerMode || 'news';
          const track = item?._paperTrack || 'core';
          const key = `pdv2:read:${mode === 'papers' ? `papers:${track}` : mode}`;
          const read = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
          read.add(item.id);
          localStorage.setItem(key, JSON.stringify([...read].slice(-1500)));
        } catch {}
      },
      sharedKey: transitionKey || readerItemKey(rows[recommendationIndex])
    });
  };

  if (view === 'bento') {
    document.body.classList.remove('reader-immersive');
    screen.classList.add('is-bento');
    renderChrome();
    renderBento(host, universe, { enterFeed, rerender, navigate });
  } else {
    const rows = activeTopic
      ? universe.catalog.filter(item => itemMatchesTopic(item, activeTopic))
      : universe.feed;
    if (!rows.length) {
      activeTopic = '';
      renderFeed(universe.feed);
    } else {
      renderFeed(rows);
    }
  }
}
