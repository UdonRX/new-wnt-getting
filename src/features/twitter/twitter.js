import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, collectionManager, centerScrollItem } from '../../shared/components.js';
import { parseFeed } from '../../shared/rss.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';

let selected = Number(localStorage.getItem('pdv2:twitterIndex') || 0);
let retryTimer = null;
let renderGeneration = 0;
const WARM_TTL = 5 * 60 * 1000;
const WARM_PREFIX = 'pdv2:twitterWarm:';
const MAX_WARM_XML = 420_000;

function stopRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}
window.addEventListener('pdv2:before-navigate', stopRetry);

function feedUrl(feed) {
  if (feed.url) return feed.url;
  return `${state.settings.twitterRssBase}${feed.id}`;
}

function proxied(url, timeout = 4500) {
  if (url.startsWith('/')) return url;
  const q = new URLSearchParams({ url, timeout: String(timeout) });
  return `/api/rss?${q}`;
}

function warmKey(feed) {
  return `${WARM_PREFIX}${feed.id || feed.url || feed.name}`;
}

function readWarm(feed) {
  try {
    const cached = JSON.parse(localStorage.getItem(warmKey(feed)) || 'null');
    if (!cached?.xml || Date.now() - Number(cached.at || 0) > WARM_TTL) return '';
    return cached.xml;
  } catch {
    return '';
  }
}

function saveWarm(feed, xml) {
  if (!xml || xml.length > MAX_WARM_XML) return;
  try {
    localStorage.setItem(warmKey(feed), JSON.stringify({ at: Date.now(), xml }));
  } catch {}
}

async function fetchXml(feed, { timeout = 4500 } = {}) {
  const response = await fetch(proxied(feedUrl(feed), timeout), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Twitter RSS取得エラー (${response.status})`);
  const xml = await response.text();
  if (!xml.trim()) throw new Error('Twitter RSSが空です');
  return xml;
}

async function load(feed, { force = false } = {}) {
  if (!force) {
    const warm = readWarm(feed);
    if (warm) return parseFeed(warm, feed.name);
  }
  const xml = await fetchXml(feed, { timeout: 5000 });
  saveWarm(feed, xml);
  return parseFeed(xml, feed.name);
}

/*
 * アプリ起動時に呼ぶバックグラウンドウォームアップ。
 * Render/RSSHubのコールドスタート待ちもここで先に消化し、取得できたXMLをlocalStorageへ保存する。
 */
export async function warmTwitterFeeds({ force = false } = {}) {
  const feeds = Array.isArray(state.twitterFeeds) ? state.twitterFeeds.filter(feed => feed?.id || feed?.url) : [];
  if (!feeds.length) return [];

  const queue = feeds.slice(0, 8);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const feed = queue[cursor++];
      try {
        if (!force && readWarm(feed)) {
          results.push({ feed: feed.name, cached: true });
          continue;
        }
        // 画面表示時より長めに待ち、Renderが寝ていても起床完了まで待てるようにする。
        const xml = await fetchXml(feed, { timeout: 12000 });
        saveWarm(feed, xml);
        results.push({ feed: feed.name, ok: true });
      } catch (error) {
        results.push({ feed: feed.name, ok: false, error: String(error?.message || error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
  return results;
}

function manage(onDone) {
  let sheet;
  sheet = openSheet(collectionManager({
    items: state.twitterFeeds,
    fields: [
      { key: 'name', label: 'タブ名', placeholder: 'リスト名' },
      { key: 'id', label: 'Twitter/X リストID', placeholder: '2087...' },
      { key: 'url', label: 'RSS URL（任意）', placeholder: '空ならRSSHubを使用' }
    ],
    onSave: draft => {
      update('twitterFeeds', draft);
      sheet.close();
      selected = 0;
      onDone();
      warmTwitterFeeds({ force: true }).catch(() => {});
    }
  }), { title: 'Twitterリスト編集' });
}

function isTwitterUrl(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function cleanDescription(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,video').forEach(node => node.remove());
  const images = [...doc.querySelectorAll('img')]
    .map(image => image.src)
    .filter(src => /twimg\.com|pbs\.twimg/.test(src))
    .slice(0, 4);
  const links = [...doc.querySelectorAll('a[href]')]
    .map(anchor => anchor.href)
    .filter(href => /^https?:/i.test(href) && !isTwitterUrl(href));
  doc.querySelectorAll('img').forEach(node => node.remove());
  return {
    text: (doc.body.textContent || '').replace(/\s+/g, ' ').trim(),
    images,
    links: [...new Set(links)]
  };
}

function isRetweet(item, clean) {
  const text = `${clean?.text || ''} ${item?.title || ''}`.trim();
  return /^RT(?:\s|:|@)/i.test(text);
}

function appendLinkified(container, text) {
  const regex = /(https?:\/\/[^\s<]+)/gi;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
    const url = match[0].replace(/[),.!?。、「」]+$/, '');
    const suffix = match[0].slice(url.length);
    const anchor = el('a', { class: 'tweet-inline-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url });
    anchor.addEventListener('click', event => event.stopPropagation());
    container.append(anchor);
    if (suffix) container.append(document.createTextNode(suffix));
    last = match.index + match[0].length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function tweetCard(item) {
  const clean = cleanDescription(item.description);
  if (isRetweet(item, clean)) return null;
  const card = el('article', { class: 'tweet-card' });
  const text = el('div', { class: 'tweet-text' });
  appendLinkified(text, clean.text || item.title || '');
  card.append(text);

  if (clean.images.length) {
    const grid = el('div', { class: `tweet-images count-${Math.min(4, clean.images.length)}` });
    clean.images.forEach((src, index) => {
      const button = el('button', { class: 'tweet-image-button', type: 'button', 'aria-label': '画像を拡大' });
      button.append(el('img', { src, alt: '投稿画像', loading: 'lazy', decoding: 'async' }));
      button.onclick = () => openImageViewer(clean.images, index);
      grid.append(button);
    });
    card.append(grid);
  }

  const extra = [...new Set(clean.links)].filter(url => !clean.text.includes(url));
  if (extra.length) {
    const links = el('div', { class: 'tweet-external-links' });
    extra.forEach(url => links.append(el('a', { class: 'tweet-external-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url })));
    card.append(links);
  }

  card.append(el('div', { class: 'tweet-footer' }, [
    el('span', { class: 'media-meta', text: shortDate(item.pubDate) }),
    el('a', { class: 'tweet-open-x', href: item.link, target: '_blank', rel: 'noopener noreferrer', text: 'Xで開く ↗' })
  ]));
  return card;
}

export async function renderTwitter(root, { navigate, refresh = false }) {
  stopRetry();
  const generation = ++renderGeneration;
  if (selected >= state.twitterFeeds.length) selected = 0;
  const feed = state.twitterFeeds[selected];
  const screen = el('section', { class: 'screen' });

  screen.append(topbar('SNS', {
    subtitle: 'Twitter / X リスト',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manage(() => renderTwitter(root, { navigate, refresh: true })) },
      { label: '↻', title: '更新', onClick: () => renderTwitter(root, { navigate, refresh: true }) },
      { label: '⚙︎', title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  if (!feed) {
    screen.append(el('div', { class: 'empty', text: 'Twitter/Xリストを追加してください' }));
    root.replaceChildren(screen);
    return;
  }

  const chips = el('div', { class: 'chips twitter-list-chips' });
  state.twitterFeeds.forEach((item, index) => chips.append(el('button', {
    class: `chip ${index === selected ? 'active' : ''}`,
    type: 'button',
    text: item.name,
    onclick: () => {
      localStorage.setItem(`pdv2:twitterScroll:${selected}`, String(window.scrollY));
      selected = index;
      localStorage.setItem('pdv2:twitterIndex', String(index));
      renderTwitter(root, { navigate });
    }
  })));
  screen.append(chips);

  const host = el('div', { class: 'twitter-feed-host' });
  screen.append(host);
  root.replaceChildren(screen);
  const active = chips.querySelector('.chip.active');
  if (active) centerScrollItem(chips, active);

  const draw = items => {
    if (generation !== renderGeneration) return;
    const cards = (items || []).map(tweetCard).filter(Boolean);
    host.replaceChildren(...(cards.length ? cards : [el('div', { class: 'empty', text: '表示できる投稿がありません' })]));
    requestAnimationFrame(() => window.scrollTo({
      top: Number(localStorage.getItem(`pdv2:twitterScroll:${selected}`) || 0),
      behavior: 'auto'
    }));
  };

  try {
    const warm = !refresh ? readWarm(feed) : '';
    if (warm) {
      draw(parseFeed(warm, feed.name));
      // キャッシュを即表示しつつ、裏で新しいRSSへ更新。
      fetchXml(feed, { timeout: 7000 }).then(xml => {
        saveWarm(feed, xml);
        if (generation === renderGeneration) draw(parseFeed(xml, feed.name));
      }).catch(() => {});
      return;
    }

    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: 'SNSを読み込み中…' }),
      el('span', { text: '起動時のバックグラウンド取得が未完了の場合だけ待ちます' })
    ]));
    const items = await load(feed, { force: refresh });
    if (items.length) {
      draw(items);
      return;
    }
    throw new Error('RSSが空です');
  } catch (err) {
    if (generation !== renderGeneration) return;
    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: 'SNSフィードを再確認しています' }),
      el('span', { text: `${err.message} / 5秒後に1回だけ再試行します` })
    ]));
    retryTimer = setTimeout(async () => {
      if (generation !== renderGeneration) return;
      try {
        const xml = await fetchXml(feed, { timeout: 12000 });
        saveWarm(feed, xml);
        draw(parseFeed(xml, feed.name));
      } catch (error) {
        if (generation === renderGeneration) host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
      }
    }, 5000);
  }
}
