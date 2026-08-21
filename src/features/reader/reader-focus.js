import { el } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';

const summaryCache = new Map();
const summaryPromises = new Map();
const summaryProgress = new WeakMap();
const SUMMARY_STORAGE_KEY = 'reader-summary-cache-v2150';
const SUMMARY_STORAGE_LIMIT = 72;
const IMPORTANT_RE = /(?:[+＋\-−]?\d[\d,.]*(?:\.\d+)?\s*(?:%|％|倍|兆円|億円|万円|円|ドル|人|件|台|社|年|か月|ヶ月|日|時間|分|秒|nm|μm|mm|cm|km|℃|°C|GW|MW|kW|GWh|MWh|kWh|Wh|TB|GB|MB)|世界初|国内初|業界初|史上初|世界最大|国内最大|世界最小|国内最小|過去最高|過去最低|最高値|最安値|初めて|新記録|首位|No\.?\s*1|突破|倍増|半減)/giu;

function summaryTtl(mode = '') {
  return mode === 'papers' ? 14 * 24 * 60 * 60 * 1000 : 36 * 60 * 60 * 1000;
}

function readStoredSummaries() {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw || {})) {
      if (!entry?.value || !entry?.ts || entry.value?.cacheable === false) continue;
      const mode = String(entry.mode || '');
      if (now - Number(entry.ts) > summaryTtl(mode)) continue;
      summaryCache.set(key, entry.value);
    }
  } catch {}
}

function persistSummary(key, value, mode = '') {
  if (!value || value.cacheable === false) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    raw[key] = { value, ts: Date.now(), mode };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, SUMMARY_STORAGE_LIMIT);
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}
readStoredSummaries();

function stripHtml(value = '') {
  const d = document.createElement('div');
  d.innerHTML = String(value || '');
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

function plainText(value = '') {
  return stripHtml(String(value || '').replace(/\*\*/g, ''));
}

function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.4;
}

function summaryModeOf(item, fallback = '') {
  return String(item?._readerMode || fallback || '').trim();
}

function focusItemKey(item) {
  return String(item?.id || item?.link || item?.url || `${item?.source || ''}|${item?.title || ''}`);
}

function itemDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/(?:公開年|出版年):\s*(\d{4})/)?.[1];
  if (/日付精度:\s*不明/.test(description)) return '日付不明';
  if (/日付精度:\s*年/.test(description) && yearOnly) return `${yearOnly}年`;
  return shortDate(item?.pubDate);
}

function itemLabel(item, fallback = 'おすすめ') {
  if (item?._recommendationLabel) return item._recommendationLabel;
  if (item?._readerMode === 'news') return 'ニュース';
  if (item?._readerMode === 'knowledge') return '知識';
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '製品熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    if (item?._creativeFamily === 'applied') return '応用発想';
    return '独創研究';
  }
  return fallback;
}

function categoryHeaderLabel(item, fallback = 'おすすめ') {
  if (item?._readerMode === 'news') return item?.feedName ? `ニュース:${item.feedName}` : 'ニュース';
  if (item?._readerMode === 'knowledge') return item?.feedName ? `知識:${item.feedName}` : '知識';
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '論文:製品熱研究';
    if (item?._creativeFamily === 'general') return '論文:一般独創';
    if (item?._creativeFamily === 'applied') return '論文:応用発想';
    return '論文:独創研究';
  }
  return itemLabel(item, fallback);
}

function summaryKey(item, mode = '') {
  return `${item?.link || item?.id || item?.title || ''}::${summaryModeOf(item, mode) || 'auto'}::v2150`;
}

function descriptionLooksThin(item, description, mode) {
  if (mode === 'papers' || description.length < 520) return true;
  const title = plainText(item?.title).slice(0, 100).replace(/[\s、。・:：\-—|｜]/g, '');
  const desc = plainText(description).slice(0, 500).replace(/[\s、。・:：\-—|｜]/g, '');
  if (title.length < 16 || !desc) return false;
  return desc.includes(title.slice(0, Math.min(36, title.length)));
}

function summaryLines(summary) {
  const labels = ['結論/事実', '背景/特徴', '影響/展望'];
  if (Array.isArray(summary?.lines) && summary.lines.length) {
    return labels.map((label, index) => ({
      label: summary.lines[index]?.label || label,
      text: summary.lines[index]?.text || ''
    }));
  }
  const points = Array.isArray(summary?.points) ? summary.points : [];
  return [
    { label: labels[0], text: summary?.short || '' },
    { label: labels[1], text: points[0] || '' },
    { label: labels[2], text: points[1] || '' }
  ];
}

function isUsableSummary(summary) {
  const lines = summaryLines(summary).map(row => plainText(row.text)).filter(Boolean);
  if (lines.length !== 3 || lines.some(text => text.length < 7)) return false;
  if (lines.some(text => /(?:…|\.{3})\s*$/.test(text))) return false;
  const normalized = lines.map(text => text.replace(/[。、，,.!！?？\s]/g, '').toLowerCase());
  return new Set(normalized).size === 3;
}

async function fetchSummary(item, { force = false, mode = '' } = {}) {
  const activeMode = summaryModeOf(item, mode);
  const key = summaryKey(item, activeMode);
  if (!force && summaryCache.has(key)) return summaryCache.get(key);
  if (!force && summaryPromises.has(key)) return summaryPromises.get(key);

  const description = stripHtml(item?.description).slice(0, 16000);
  const request = fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item?.link,
      title: item?.title,
      description,
      source: item?.source || item?.feedName,
      category: categoryHeaderLabel(item),
      mode: activeMode,
      preferFullText: descriptionLooksThin(item, description, activeMode),
      forceJapanese: looksMostlyEnglish(`${item?.title || ''}\n${description}`),
      allowAi: true,
      fast: activeMode !== 'papers'
    })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data?.error || data?.detail || `要約エラー (${response.status})`));
    if (!isUsableSummary(data)) throw new Error('要約の品質チェックに失敗しました');
    if (data.cacheable !== false) {
      summaryCache.set(key, data);
      persistSummary(key, data, activeMode);
      while (summaryCache.size > SUMMARY_STORAGE_LIMIT) summaryCache.delete(summaryCache.keys().next().value);
    }
    return data;
  }).finally(() => {
    if (summaryPromises.get(key) === request) summaryPromises.delete(key);
  });

  summaryPromises.set(key, request);
  return request;
}

function cachedSummary(item, mode = '') {
  const value = summaryCache.get(summaryKey(item, mode));
  return isUsableSummary(value) ? value : null;
}

function gridIconSvg() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><rect x="14" y="14" width="7" height="7" rx="2"></rect></svg>`;
}

function appendHighlightedText(target, text = '', { strong = false } = {}) {
  if (!text) return;
  if (strong) {
    target.append(el('strong', { text }));
    return;
  }
  IMPORTANT_RE.lastIndex = 0;
  const matches = [...String(text).matchAll(IMPORTANT_RE)];
  if (!matches.length) {
    target.append(document.createTextNode(text));
    return;
  }
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index > cursor) target.append(document.createTextNode(text.slice(cursor, index)));
    target.append(el('strong', { class: 'reader-summary-keyword', text: match[0] }));
    cursor = index + match[0].length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

function setRichText(node, value = '') {
  if (!node) return;
  node.replaceChildren();
  const text = String(value || '');
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) appendHighlightedText(node, text.slice(last, match.index));
    appendHighlightedText(node, match[1], { strong: true });
    last = pattern.lastIndex;
  }
  if (last < text.length) appendHighlightedText(node, text.slice(last));
  if (!node.childNodes.length) node.textContent = text;
}

function renderSummaryBlock(node, summary) {
  if (!node) return;
  node.replaceChildren();
  node.classList.remove('is-loading', 'is-error');
  summaryLines(summary).forEach(line => {
    const row = el('div', { class: 'reader-story-summary-row' });
    const copy = el('div', { class: 'reader-story-summary-copy' });
    const label = el('span', { class: 'reader-story-summary-label', text: line.label || '' });
    const text = el('span', { class: 'reader-story-summary-text' });
    setRichText(text, line.text || '—');
    copy.append(label, text);
    row.append(copy);
    node.append(row);
  });
}

function sourceNameOf(item) {
  return String(item?.source || item?.feedName || 'RSS').trim() || 'RSS';
}

function faviconUrlOf(item) {
  try {
    const url = new URL(String(item?.link || item?.url || ''));
    return `${url.origin}/favicon.ico`;
  } catch { return ''; }
}

function sourceInitialOf(item) {
  const source = sourceNameOf(item).replace(/^www\./i, '');
  const words = source.match(/[A-Za-z0-9]+/g) || [];
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2).toUpperCase();
  return Array.from(source.replace(/[\s・:：]/g, ''))[0] || 'R';
}

function createSourceMark(item) {
  const mark = el('span', { class: 'reader-story-source-mark', text: sourceInitialOf(item) });
  const favicon = faviconUrlOf(item);
  if (!favicon) return mark;
  const logo = el('img', { class: 'reader-story-source-logo', src: favicon, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  logo.addEventListener('error', () => logo.remove(), { once: true });
  mark.append(logo);
  return mark;
}

function loadingMarkup() {
  const wrap = el('div', { class: 'reader-ai-progress', 'data-reader-progress': '1' });
  const top = el('div', { class: 'reader-ai-progress-top' }, [
    el('span', { class: 'reader-ai-loading-text', 'data-reader-loading-text': '1', text: '記事本文から要点を整理中' }),
    el('span', { class: 'reader-ai-progress-value', 'data-reader-progress-value': '1', text: '8%' })
  ]);
  const bar = el('span', { class: 'reader-ai-progress-bar', 'data-reader-progress-bar': '1' });
  bar.style.width = '8%';
  wrap.append(top, el('div', { class: 'reader-ai-progress-track' }, [bar]));
  return wrap;
}

function stopProgress(card) {
  const state = summaryProgress.get(card);
  if (!state) return;
  state.timers.forEach(clearTimeout);
  summaryProgress.delete(card);
}

function setProgress(card, value, text) {
  if (!card?.isConnected) return;
  const bar = card.querySelector('[data-reader-progress-bar]');
  const label = card.querySelector('[data-reader-loading-text]');
  const number = card.querySelector('[data-reader-progress-value]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (label && text) label.textContent = text;
  if (number) number.textContent = `${Math.round(value)}%`;
}

function startProgress(card) {
  if (!card?.isConnected || summaryProgress.has(card)) return;
  const steps = [[180,18,'記事情報を整理中'],[520,32,'本文を確認中'],[1050,48,'AIで要点を抽出中'],[1850,64,'3項目へ要約中'],[3000,78,'文章を自然に整えています'],[4700,89,'重要語を確認中'],[6800,94,'仕上げ中']];
  const timers = steps.map(([delay, value, text]) => setTimeout(() => setProgress(card, value, text), delay));
  summaryProgress.set(card, { timers });
}

function setCardSummary(card, item, mode, summary) {
  if (!card?.isConnected) return;
  stopProgress(card);
  const summaryNode = card.querySelector('[data-reader-summary]');
  const title = card.querySelector('[data-reader-title]');
  if (title) setRichText(title, summary?.headline || summary?.resolvedTitle || item?.titleJa || item?.title || '記事');
  if (summaryNode) renderSummaryBlock(summaryNode, summary);
  card.dataset.summaryProvider = String(summary?.provider || '');
}

function buildHero(item, index, label, onList, card) {
  const hero = el('section', { class: 'reader-story-hero', 'aria-label': '記事情報' });
  if (item?.image) {
    const image = el('img', { class: 'reader-story-hero-image', src: item.image, alt: '', loading: Math.abs(index) <= 1 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    image.addEventListener('error', () => image.remove(), { once: true });
    hero.append(image);
  }
  hero.append(el('div', { class: 'reader-story-hero-mesh', 'aria-hidden': 'true' }));
  const sourceCopy = el('div', { class: 'reader-story-source-copy' }, [
    el('strong', { class: 'reader-story-source-name', text: sourceNameOf(item) }),
    el('span', { class: 'reader-story-time', text: itemDateLabel(item) })
  ]);
  const source = el('div', { class: 'reader-story-source' }, [createSourceMark(item), sourceCopy]);
  const grid = el('button', { class: 'reader-grid-fab reader-story-grid', type: 'button', title: 'Bento一覧', 'aria-label': 'Bento一覧へ', html: gridIconSvg(), onclick: () => onList?.({ index, item, card }) });
  hero.append(
    el('div', { class: 'reader-story-hero-top' }, [source, grid]),
    el('div', { class: 'reader-story-hero-bottom' }, [el('span', { class: 'reader-story-category-badge', text: categoryHeaderLabel(item, label) })])
  );
  return hero;
}

function buildFeedCard(item, index, { label, onList, summaryMode, sharedKey }) {
  const mode = summaryModeOf(item, summaryMode);
  const card = el('section', { class: 'reader-swipe-card reader-story-card', 'data-index': String(index), 'data-key': focusItemKey(item) || String(index) });
  if (sharedKey && sharedKey === focusItemKey(item)) card.style.viewTransitionName = 'reader-shared-card';
  const summary = cachedSummary(item, mode);
  const title = el('h2', { class: 'reader-swipe-title reader-story-title', 'data-reader-title': '1' });
  setRichText(title, summary?.headline || item?.titleJa || item?.title || '無題');
  const summaryBox = el('div', { class: `reader-ai-summary reader-story-summary${summary ? '' : ' is-loading'}`, 'data-reader-summary': '1' });
  if (summary) renderSummaryBlock(summaryBox, summary); else summaryBox.append(loadingMarkup());
  const content = el('main', { class: 'reader-story-content' }, [title, summaryBox]);
  const original = el('a', { class: 'reader-story-open', href: item?.link || '#', target: '_blank', rel: 'noopener noreferrer', text: '元記事を読む ↗' });
  card.append(buildHero(item, index, label, onList, card), content, el('footer', { class: 'reader-story-actions' }, [original]));
  return card;
}

function installHorizontalSwipe(container, { onPrevFeed, onNextFeed }) {
  let start = null;
  const down = event => {
    if (event.touches?.length !== 1) return;
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY, target: event.target };
  };
  const up = event => {
    if (!start || !event.changedTouches?.length) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const target = start.target;
    start = null;
    if (target?.closest?.('a,button,input,textarea,select')) return;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (dx < 0) onNextFeed?.(); else onPrevFeed?.();
  };
  container.addEventListener('touchstart', down, { passive: true });
  container.addEventListener('touchend', up, { passive: true });
  return () => {
    container.removeEventListener('touchstart', down);
    container.removeEventListener('touchend', up);
  };
}

function loadCardSummary(card, item, mode, { force = false } = {}) {
  if (!card?.isConnected) return;
  const cached = !force ? cachedSummary(item, mode) : null;
  if (cached) {
    setCardSummary(card, item, mode, cached);
    return;
  }
  const node = card.querySelector('[data-reader-summary]');
  if (node && !node.classList.contains('is-loading')) {
    node.replaceChildren(loadingMarkup());
    node.classList.remove('is-error');
    node.classList.add('is-loading');
  }
  startProgress(card);
  fetchSummary(item, { force, mode }).then(summary => {
    if (card.isConnected) setCardSummary(card, item, mode, summary);
  }).catch(error => {
    if (!card.isConnected || !node) return;
    stopProgress(card);
    node.replaceChildren(el('span', { class: 'reader-ai-loading-text', text: '要約を取得できませんでした。タップで再試行' }));
    node.classList.remove('is-loading');
    node.classList.add('is-error');
    node.onclick = () => {
      node.onclick = null;
      node.replaceChildren(loadingMarkup());
      node.classList.remove('is-error');
      node.classList.add('is-loading');
      loadCardSummary(card, item, mode, { force: true });
    };
    console.warn('[reader-summary]', error);
  });
}

export function mountFocus(host, {
  items,
  initialIndex = 0,
  label = 'おすすめ',
  onList,
  onStart = null,
  onEnd = null,
  onIndexChange,
  onPrevFeed,
  onNextFeed,
  summaryMode = '',
  sharedKey = ''
}) {
  const rows = Array.isArray(items) ? items : [];
  let index = Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, rows.length - 1)));
  let destroyed = false;
  let activeObserver = null;

  if (!rows.length) {
    host.replaceChildren(el('div', { class: 'empty', text: '記事がありません' }));
    return { destroy() {}, go() {} };
  }

  const feed = el('div', { class: 'reader-swipe-feed', tabindex: '0' });
  const cards = rows.map((item, i) => buildFeedCard(item, i, { label, onList, summaryMode, sharedKey: sharedKey || focusItemKey(rows[index]) }));
  cards.forEach(card => feed.append(card));
  host.replaceChildren(feed);

  const setActive = next => {
    if (destroyed) return;
    const safe = Math.max(0, Math.min(next, rows.length - 1));
    index = safe;
    feed.dataset.ready = '1';
    cards.forEach((card, i) => card.classList.toggle('is-active', i === index));
    onIndexChange?.(index, rows[index]);
    // v2.15.0: 表示中の1枚だけ要約。隠れた前後カードの先読みはしない。
    loadCardSummary(cards[index], rows[index], summaryModeOf(rows[index], summaryMode));
  };

  activeObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible || visible.intersectionRatio < 0.56) return;
    setActive(Number(visible.target.dataset.index || 0));
  }, { root: feed, threshold: [0.56, 0.72, 0.9] });
  cards.forEach(card => activeObserver.observe(card));

  const detachHorizontal = installHorizontalSwipe(feed, { onPrevFeed, onNextFeed });
  requestAnimationFrame(() => {
    cards[index]?.scrollIntoView({ block: 'start', behavior: 'auto' });
    setActive(index);
  });

  const boundaryTouch = () => {
    const max = Math.max(0, feed.scrollHeight - feed.clientHeight);
    if (feed.scrollTop <= 1 && index === 0 && typeof onStart === 'function') { /* compatibility */ }
    if (feed.scrollTop >= max - 1 && index === rows.length - 1 && typeof onEnd === 'function') { /* compatibility */ }
  };
  feed.addEventListener('scrollend', boundaryTouch, { passive: true });

  return {
    destroy() {
      destroyed = true;
      activeObserver?.disconnect();
      cards.forEach(stopProgress);
      detachHorizontal();
      feed.removeEventListener('scrollend', boundaryTouch);
    },
    go(nextIndex) {
      index = Math.max(0, Math.min(Number(nextIndex) || 0, rows.length - 1));
      cards[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActive(index);
    },
    getIndex() { return index; },
    getItem() { return rows[index]; }
  };
}
