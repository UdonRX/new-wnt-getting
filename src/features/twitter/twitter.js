import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, collectionManager, centerScrollItem } from '../../shared/components.js';
import { parseFeed } from '../../shared/rss.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { iconSvg } from '../../shared/icons.js';

let selected = Number(localStorage.getItem('pdv2:twitterIndex') || 0);
let renderGeneration = 0;

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const WARM_PREFIX = 'pdv2:twitterWarm:';
const MAX_WARM_XML = 420_000;
const warmJobs = new Map();
let warmActive = 0;
const warmWaiters = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function readWarmRecord(feed) {
  try {
    const cached = JSON.parse(localStorage.getItem(warmKey(feed)) || 'null');
    if (!cached?.xml) return null;
    return { at: Number(cached.at || 0), xml: cached.xml };
  } catch {
    return null;
  }
}

function readWarm(feed) {
  const cached = readWarmRecord(feed);
  if (!cached?.xml) return '';
  if (Date.now() - cached.at >= AUTO_REFRESH_MS) return '';
  return cached.xml;
}

function autoRefreshDue(feed) {
  const cached = readWarmRecord(feed);
  return !cached?.xml || Date.now() - cached.at >= AUTO_REFRESH_MS;
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

async function withWarmSlot(worker) {
  if (warmActive >= 2) await new Promise(resolve => warmWaiters.push(resolve));
  warmActive += 1;
  try {
    return await worker();
  } finally {
    warmActive = Math.max(0, warmActive - 1);
    warmWaiters.shift()?.();
  }
}

async function warmFeedUntilSuccess(feed, { force = false } = {}) {
  if (!force && !autoRefreshDue(feed)) {
    return { feed: feed.name, cached: true, skipped: true };
  }

  while (true) {
    try {
      const xml = await withWarmSlot(() => fetchXml(feed, { timeout: 12000 }));
      saveWarm(feed, xml);
      return { feed: feed.name, ok: true };
    } catch (error) {
      console.warn('[twitter-warm-retry]', feed.name, error?.message || error);
      await sleep(5000);
    }
  }
}

function warmJobFor(feed, options = {}) {
  const key = warmKey(feed);
  const existing = warmJobs.get(key);
  if (existing) return existing;

  const job = warmFeedUntilSuccess(feed, options).finally(() => {
    if (warmJobs.get(key) === job) warmJobs.delete(key);
  });
  warmJobs.set(key, job);
  return job;
}

export async function warmTwitterFeeds({ force = false } = {}) {
  const feeds = Array.isArray(state.twitterFeeds)
    ? state.twitterFeeds.filter(feed => feed?.id || feed?.url)
    : [];
  if (!feeds.length) return [];

  const targets = force
    ? feeds.slice(0, 8)
    : feeds.slice(0, 8).filter(autoRefreshDue);

  if (!targets.length) return [];
  return Promise.all(targets.map(feed => warmJobFor(feed, { force })));
}

function attachPullToRefresh(screen, indicator, onRefresh) {
  let startY = null;
  let startX = null;
  let distance = 0;
  let tracking = false;
  let refreshing = false;
  const trigger = 82;

  const scrollTop = () => Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));

  const reset = () => {
    startY = null;
    startX = null;
    distance = 0;
    tracking = false;
    indicator.classList.remove('pulling', 'ready');
    indicator.style.setProperty('--pull', '0px');
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = '下に引いて更新';
  };

  const onTouchStart = event => {
    if (refreshing || event.touches.length !== 1 || scrollTop() > 1) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    distance = 0;
    tracking = true;
  };

  const onTouchMove = event => {
    if (!tracking || refreshing || startY == null || event.touches.length !== 1) return;
    const raw = event.touches[0].clientY - startY;
    const dx = startX == null ? 0 : event.touches[0].clientX - startX;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(raw) * 1.15) {
      reset();
      return;
    }
    if (raw <= 0 || scrollTop() > 1) {
      reset();
      return;
    }

    distance = raw;
    const visual = Math.min(64, raw * 0.48);
    indicator.classList.add('pulling');
    indicator.classList.toggle('ready', raw >= trigger);
    indicator.style.setProperty('--pull', `${visual}px`);
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = raw >= trigger ? '指を離して更新' : '下に引いて更新';
    if (raw > 8 && event.cancelable) event.preventDefault();
  };

  const onTouchEnd = () => {
    if (!tracking || refreshing) return;
    const shouldRefresh = distance >= trigger && scrollTop() <= 1;
    if (!shouldRefresh) {
      reset();
      return;
    }

    refreshing = true;
    tracking = false;
    indicator.classList.remove('ready');
    indicator.classList.add('pulling', 'refreshing');
    indicator.style.setProperty('--pull', '48px');
    const label = indicator.querySelector('.twitter-pull-label');
    if (label) label.textContent = '更新中…';

    Promise.resolve(onRefresh()).finally(() => {
      refreshing = false;
      indicator.classList.remove('refreshing');
      reset();
    });
  };

  screen.addEventListener('touchstart', onTouchStart, { passive: true });
  screen.addEventListener('touchmove', onTouchMove, { passive: false });
  screen.addEventListener('touchend', onTouchEnd, { passive: true });
  screen.addEventListener('touchcancel', reset, { passive: true });

  return () => {
    screen.removeEventListener('touchstart', onTouchStart);
    screen.removeEventListener('touchmove', onTouchMove);
    screen.removeEventListener('touchend', onTouchEnd);
    screen.removeEventListener('touchcancel', reset);
  };
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

function normalizeTweetImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    if (!/^https?:$/.test(url.protocol)) return '';

    // pbs.twimg.com はRSS側で small/thumb が返ることがあるため、表示時だけ高解像度へ。
    if (url.hostname === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      if (url.searchParams.has('name')) url.searchParams.set('name', 'large');
    }
    return url.href;
  } catch {
    return '';
  }
}

function cleanDescription(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,video').forEach(node => node.remove());

  const images = [...doc.querySelectorAll('img')]
    .flatMap(image => [
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-original'),
      image.getAttribute('data-lazy-src')
    ])
    .map(normalizeTweetImageUrl)
    .filter(Boolean)
    .filter(src => /twimg\.com|pbs\.twimg|twitter\.com/i.test(src));

  const links = [...doc.querySelectorAll('a[href]')]
    .map(anchor => anchor.href)
    .filter(href => /^https?:/i.test(href) && !isTwitterUrl(href));

  doc.querySelectorAll('img').forEach(node => node.remove());
  return {
    text: (doc.body.textContent || '').replace(/\s+/g, ' ').trim(),
    images: [...new Set(images)].slice(0, 4),
    links: [...new Set(links)]
  };
}

function tweetImages(item, clean) {
  const candidates = [
    ...(Array.isArray(item?.images) ? item.images : []),
    item?.image,
    ...(Array.isArray(clean?.images) ? clean.images : [])
  ];

  const seen = new Set();
  const images = [];
  for (const candidate of candidates) {
    const url = normalizeTweetImageUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push(url);
    if (images.length >= 4) break;
  }
  return images;
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

function tweetAuthor(item, clean) {
  const direct = String(item?.author || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  if (direct) return direct;
  const candidates = [String(item?.title || ''), String(clean?.text || '')];
  for (const value of candidates) {
    const match = value.match(/^\s*([^:：]{1,50}?(?:\s*\(@[A-Za-z0-9_]+\)|\s+@[A-Za-z0-9_]+))\s*[:：]/);
    if (match?.[1]) return match[1].trim();
    const handle = value.match(/^\s*(@[A-Za-z0-9_]{1,20})\b/);
    if (handle?.[1]) return handle[1];
  }
  return item?.feedName || item?.source || 'Twitter / X';
}

function tweetCard(item) {
  // v2.14.8: 本文あり投稿でもRSSの元HTML/Media要素から画像を必ず統合する。
  const clean = cleanDescription(item.rawDescription || item.description);
  const images = tweetImages(item, clean);
  if (isRetweet(item, clean)) return null;

  const card = el('article', { class: 'tweet-card' });
  const author = tweetAuthor(item, clean);
  card.append(el('div', { class: 'tweet-author-row' }, [
    el('div', { class: 'tweet-author-avatar', text: String(author).replace(/^@/, '').slice(0, 1).toUpperCase() || 'X' }),
    el('strong', { class: 'tweet-author-name', text: author })
  ]));

  const rawTitle = String(item?.title || '').trim();
  const titleIsPlaceholder = /^(?:無題|untitled|no\s*title|\(no\s*title\))$/i.test(rawTitle);
  const displayText = clean.text || (!images.length && !titleIsPlaceholder ? rawTitle : '');

  if (displayText) {
    const text = el('div', { class: 'tweet-text' });
    appendLinkified(text, displayText);
    card.append(text);
  } else if (images.length) {
    card.classList.add('tweet-card-photo-only');
  }

  if (images.length) {
    const grid = el('div', { class: `tweet-images count-${Math.min(4, images.length)}` });
    images.forEach((src, index) => {
      const button = el('button', { class: 'tweet-image-button', type: 'button', 'aria-label': '画像を拡大' });
      button.append(el('img', { src, alt: '投稿画像', loading: 'lazy', decoding: 'async' }));
      button.onclick = () => openImageViewer(images, index);
      grid.append(button);
    });
    card.append(grid);
  }

  const extra = [...new Set(clean.links)].filter(url => !clean.text.includes(url));
  if (extra.length) {
    const links = el('div', { class: 'tweet-external-links' });
    extra.forEach(url => links.append(el('a', {
      class: 'tweet-external-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url
    })));
    card.append(links);
  }

  card.append(el('div', { class: 'tweet-footer' }, [
    el('span', { class: 'media-meta', text: shortDate(item.pubDate) }),
    el('a', { class: 'tweet-open-x', href: item.link, target: '_blank', rel: 'noopener noreferrer', text: 'Xで開く ↗' })
  ]));
  return card;
}

export async function renderTwitter(root, { navigate, refresh = false }) {
  const generation = ++renderGeneration;
  if (selected >= state.twitterFeeds.length) selected = 0;
  const feed = state.twitterFeeds[selected];
  const screen = el('section', { class: 'screen' });

  screen.append(topbar('SNS', {
    subtitle: 'Twitter / X リスト',
    actions: [
      { label: '＋', title: '追加/編集', onClick: () => manage(() => renderTwitter(root, { navigate, refresh: true })) },
      { label: '↻', title: '更新', onClick: () => renderTwitter(root, { navigate, refresh: true }) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
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

  const pullIndicator = el('div', { class: 'twitter-pull-refresh', 'aria-hidden': 'true' }, [
    el('span', { class: 'twitter-pull-spinner', text: '↻' }),
    el('span', { class: 'twitter-pull-label', text: '下に引いて更新' })
  ]);
  const host = el('div', { class: 'twitter-feed-host' });
  screen.append(pullIndicator, host);
  root.replaceChildren(screen);

  const active = chips.querySelector('.chip.active');
  if (active) centerScrollItem(chips, active, { behavior: 'auto' });

  attachPullToRefresh(screen, pullIndicator, () => {
    localStorage.setItem(`pdv2:twitterScroll:${selected}`, '0');
    return renderTwitter(root, { navigate, refresh: true });
  });

  const draw = items => {
    if (generation !== renderGeneration) return;
    const cards = (items || []).map(tweetCard).filter(Boolean);
    host.replaceChildren(...(cards.length
      ? cards
      : [el('div', { class: 'empty', text: '表示できる投稿がありません' })]));
    requestAnimationFrame(() => window.scrollTo({
      top: Number(localStorage.getItem(`pdv2:twitterScroll:${selected}`) || 0),
      behavior: 'auto'
    }));
  };

  try {
    const cached = !refresh ? readWarmRecord(feed) : null;

    if (cached?.xml) {
      draw(parseFeed(cached.xml, feed.name));

      if (!autoRefreshDue(feed)) return;

      warmJobFor(feed, { force: false }).then(() => {
        if (generation !== renderGeneration) return;
        const fresh = readWarmRecord(feed);
        if (fresh?.xml) draw(parseFeed(fresh.xml, feed.name));
      }).catch(() => {});
      return;
    }

    host.replaceChildren(el('div', { class: 'twitter-wake-status' }, [
      el('strong', { text: refresh ? 'SNSを更新しています…' : 'SNSを読み込み中…' }),
      el('span', { text: '取得できない場合は5秒空けて再確認します' })
    ]));

    await warmJobFor(feed, { force: refresh });
    if (generation !== renderGeneration) return;

    const fresh = readWarmRecord(feed);
    if (!fresh?.xml) throw new Error('RSSが空です');
    draw(parseFeed(fresh.xml, feed.name));
  } catch (err) {
    if (generation !== renderGeneration) return;
    host.replaceChildren(el('div', { class: 'error-box', text: err.message }));
  }
}
