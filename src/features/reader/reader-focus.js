import { el, openSheet, showToast } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';

const summaryCache = new Map();
const summaryPromises = new Map();
const AI_BUDGET_KEY = 'pdv2:summaryAiBudget:v2143';
const AI_DAILY_LIMIT = 16;

function aiTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function takeAiBudget() {
  try {
    const day = aiTodayKey();
    const row = JSON.parse(localStorage.getItem(AI_BUDGET_KEY) || 'null');
    const count = row?.day === day ? Number(row.count || 0) : 0;
    if (count >= AI_DAILY_LIMIT) return false;
    localStorage.setItem(AI_BUDGET_KEY, JSON.stringify({ day, count: count + 1 }));
    return true;
  } catch {
    return true;
  }
}

function stripHtml(value = '') {
  const d = document.createElement('div');
  d.innerHTML = String(value || '');
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
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

function summaryKey(item, mode = '') {
  return `${item?.link || item?.id || item?.title || ''}::${summaryModeOf(item, mode) || 'auto'}::v2143`;
}

function errorMessage(data, status) {
  const error = String(data?.error || '').trim();
  const detail = String(data?.detail || '').trim();
  if (error && detail && error !== detail) return `${error}：${detail}`;
  return error || detail || `要約エラー (${status})`;
}

async function fetchSummary(item, { force = false, mode = '' } = {}) {
  const activeMode = summaryModeOf(item, mode);
  const key = summaryKey(item, activeMode);
  if (!force && summaryCache.has(key)) return summaryCache.get(key);
  if (!force && summaryPromises.has(key)) return summaryPromises.get(key);

  const description = stripHtml(item?.description).slice(0, 14000);
  const truncatedTitle = /(?:…|\.\.\.)[^。！？!?]{0,12}$/.test(String(item?.title || '').trim());
  const forceJapanese = looksMostlyEnglish(`${item?.title || ''}\n${description}`);
  // v2.14.3の縦スワイプでは、表示された記事はカテゴリを問わずAI短縮要約を作る。
  // 先読みは現在位置の前後だけに限定し、無駄なAPI呼び出しはIntersectionObserver側で抑える。
  const allowAi = true;

  const request = fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item?.link,
      title: item?.title,
      description,
      source: item?.source,
      mode: activeMode,
      preferFullText: activeMode === 'papers' || activeMode === 'news' || truncatedTitle,
      forceJapanese,
      allowAi,
      fast: activeMode !== 'papers'
    })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorMessage(data, response.status));
    summaryCache.set(key, data);
    while (summaryCache.size > 72) summaryCache.delete(summaryCache.keys().next().value);
    return data;
  }).finally(() => {
    if (summaryPromises.get(key) === request) summaryPromises.delete(key);
  });

  summaryPromises.set(key, request);
  return request;
}

function cachedSummary(item, mode = '') {
  return summaryCache.get(summaryKey(item, mode));
}

function prefetchSummary(item, mode = '') {
  if (!item) return;
  const key = summaryKey(item, mode);
  if (summaryCache.has(key) || summaryPromises.has(key)) return;
  fetchSummary(item, { mode }).catch(() => {});
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
    if (item?._paperTrack === 'core') return '製品・熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    if (item?._creativeFamily === 'applied') return '応用発想';
    return '独創研究';
  }
  return fallback;
}

function gridIconSvg() {
  return `
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8">
      <rect x="3" y="3" width="7" height="7" rx="2"></rect>
      <rect x="14" y="3" width="7" height="7" rx="2"></rect>
      <rect x="3" y="14" width="7" height="7" rx="2"></rect>
      <rect x="14" y="14" width="7" height="7" rx="2"></rect>
    </svg>`;
}

function renderSummarySheet(item, summary, mode) {
  const wrap = el('div', { class: 'reader-detail-sheet' });
  const heading = el('div', { class: 'reader-detail-heading' }, [
    el('span', { class: 'reader-feed-badge', text: itemLabel(item) }),
    el('h3', { text: summary?.resolvedTitle || item?.titleJa || item?.title || '記事' }),
    el('p', { text: `${item?.source || item?.feedName || ''}${itemDateLabel(item) ? ` ・ ${itemDateLabel(item)}` : ''}` })
  ]);
  wrap.append(heading);

  if (summary?.short) {
    wrap.append(el('section', { class: 'reader-detail-section' }, [
      el('strong', { text: 'ひとことで' }),
      el('p', { text: summary.short })
    ]));
  }

  const points = Array.isArray(summary?.points) ? summary.points : [];
  if (points.length) {
    const list = el('ul', { class: 'reader-detail-points' });
    points.forEach(point => list.append(el('li', { text: point })));
    wrap.append(el('section', { class: 'reader-detail-section' }, [
      el('strong', { text: '要点' }),
      list
    ]));
  }

  const actions = el('div', { class: 'reader-detail-actions' });
  actions.append(el('a', {
    class: 'soft-button',
    href: item?.link || '#',
    target: '_blank',
    rel: 'noopener noreferrer',
    text: '原文を開く'
  }));
  actions.append(el('button', {
    class: 'soft-button',
    type: 'button',
    text: 'AIに質問',
    onclick: () => chatSheet(item, summary, mode)
  }));
  wrap.append(actions);
  openSheet(wrap, { title: '記事の詳細' });
}

function chatSheet(item, summary, mode) {
  const wrap = el('div');
  const history = [];
  const log = el('div', { class: 'chat-log' });
  const field = el('div', { class: 'field' });
  field.append(el('label', { text: 'この記事について質問' }));
  const input = el('textarea', { rows: '3', placeholder: '例：重要なポイントをもう少し詳しく' });
  field.append(input);
  const send = el('button', { class: 'primary-button full-button', type: 'button', text: '送信' });

  send.onclick = async () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    log.append(el('div', { class: 'chat-user', text: q }));
    send.disabled = true;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item?.link,
          title: item?.title,
          description: stripHtml(item?.description),
          question: q,
          history,
          summary: summary?.points || [],
          mode: summaryModeOf(item, mode)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      const answer = data.answer || data.text || '';
      log.append(el('div', { class: 'chat-ai', text: answer }));
      history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
    } catch (error) {
      log.append(el('div', { class: 'error-box', text: error.message }));
    } finally {
      send.disabled = false;
    }
  };

  wrap.append(log, field, send);
  openSheet(wrap, { title: 'AIに質問' });
}

function setCardSummary(card, item, mode, summary) {
  if (!card?.isConnected) return;
  const summaryText = card.querySelector('[data-reader-summary]');
  const detailButton = card.querySelector('[data-reader-detail]');
  const title = card.querySelector('[data-reader-title]');
  if (summaryText) {
    summaryText.textContent = summary?.short || '要約を取得できませんでした。';
    summaryText.classList.remove('is-loading');
  }
  if (title && !item?.titleJa && summary?.resolvedTitle && summary.resolvedTitle !== item.title) {
    item.title = summary.resolvedTitle;
    title.textContent = summary.resolvedTitle;
  }
  if (detailButton) detailButton.onclick = () => renderSummarySheet(item, summary, mode);
}

function buildFeedCard(item, index, { label, onList, summaryMode, sharedKey }) {
  const mode = summaryModeOf(item, summaryMode);
  const card = el('section', {
    class: 'reader-swipe-card',
    'data-index': String(index),
    'data-key': focusItemKey(item) || String(index)
  });
  if (sharedKey && sharedKey === focusItemKey(item)) {
    card.style.viewTransitionName = 'reader-shared-card';
  }

  const media = el('div', { class: 'reader-swipe-media' });
  if (item?.image) {
    const image = el('img', {
      class: 'reader-swipe-image',
      src: item.image,
      alt: '',
      loading: Math.abs(index) <= 1 ? 'eager' : 'lazy',
      decoding: 'async'
    });
    image.addEventListener('error', () => media.classList.add('image-failed'), { once: true });
    media.append(image);
  }
  media.append(el('div', { class: 'reader-swipe-fallback', text: itemLabel(item, label) }));
  media.append(el('div', { class: 'reader-swipe-shade' }));

  const top = el('div', { class: 'reader-swipe-top' });
  const meta = el('div', { class: 'reader-swipe-meta' }, [
    el('span', { class: 'reader-feed-badge', text: itemLabel(item, label) }),
    el('span', { class: 'reader-feed-source', text: item?.source || item?.feedName || '' }),
    el('span', { class: 'reader-feed-time', text: itemDateLabel(item) })
  ]);
  const grid = el('button', {
    class: 'reader-grid-fab',
    type: 'button',
    title: 'Bento一覧',
    'aria-label': 'Bento一覧',
    html: gridIconSvg(),
    onclick: () => onList?.({ index, item, card })
  });
  top.append(meta, grid);

  const copy = el('div', { class: 'reader-swipe-copy' });
  const title = el('h2', {
    class: 'reader-swipe-title',
    'data-reader-title': '1',
    text: item?.titleJa || item?.title || '無題'
  });
  const summary = cachedSummary(item, mode);
  const summaryText = el('p', {
    class: `reader-swipe-summary${summary ? '' : ' is-loading'}`,
    'data-reader-summary': '1',
    text: summary?.short || 'AI要約を準備しています…'
  });
  const actions = el('div', { class: 'reader-swipe-actions' });
  const detail = el('button', {
    class: 'reader-feed-action',
    type: 'button',
    'data-reader-detail': '1',
    text: '要点'
  });
  if (summary) detail.onclick = () => renderSummarySheet(item, summary, mode);
  const original = el('a', {
    class: 'reader-feed-action',
    href: item?.link || '#',
    target: '_blank',
    rel: 'noopener noreferrer',
    text: '原文'
  });
  actions.append(detail, original);
  copy.append(title, summaryText, actions);

  const position = el('div', { class: 'reader-swipe-position', text: `${index + 1}` });
  card.append(media, top, copy, position);
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
    if (dx < 0) onNextFeed?.();
    else onPrevFeed?.();
  };
  container.addEventListener('touchstart', down, { passive: true });
  container.addEventListener('touchend', up, { passive: true });
  return () => {
    container.removeEventListener('touchstart', down);
    container.removeEventListener('touchend', up);
  };
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
  let observer = null;
  let activeObserver = null;

  if (!rows.length) {
    host.replaceChildren(el('div', { class: 'empty', text: '記事がありません' }));
    return { destroy() {}, go() {} };
  }

  const feed = el('div', { class: 'reader-swipe-feed', tabindex: '0' });
  const cards = rows.map((item, i) => buildFeedCard(item, i, {
    label,
    onList,
    summaryMode,
    sharedKey: sharedKey || focusItemKey(rows[index])
  }));
  cards.forEach(card => feed.append(card));
  host.replaceChildren(feed);

  const setActive = next => {
    const safe = Math.max(0, Math.min(next, rows.length - 1));
    if (safe === index && feed.dataset.ready === '1') return;
    index = safe;
    feed.dataset.ready = '1';
    cards.forEach((card, i) => card.classList.toggle('is-active', i === index));
    onIndexChange?.(index, rows[index]);
    prefetchSummary(rows[index], summaryMode);
    prefetchSummary(rows[index + 1], summaryMode);
    prefetchSummary(rows[index - 1], summaryMode);
  };

  observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.18) return;
      const card = entry.target;
      const i = Number(card.dataset.index || 0);
      const item = rows[i];
      const mode = summaryModeOf(item, summaryMode);
      const cached = cachedSummary(item, mode);
      if (cached) {
        setCardSummary(card, item, mode, cached);
        return;
      }
      fetchSummary(item, { mode })
        .then(summary => {
          if (!destroyed) setCardSummary(card, item, mode, summary);
        })
        .catch(error => {
          if (destroyed || !card.isConnected) return;
          const node = card.querySelector('[data-reader-summary]');
          if (node) {
            node.textContent = '要約を取得できませんでした。タップして再試行できます。';
            node.classList.remove('is-loading');
            node.onclick = () => {
              node.textContent = 'AI要約を再取得しています…';
              node.classList.add('is-loading');
              fetchSummary(item, { force: true, mode })
                .then(summary => setCardSummary(card, item, mode, summary))
                .catch(err => showToast(err.message || '要約を取得できませんでした'));
            };
          }
        });
    });
  }, { root: feed, rootMargin: '95% 0px 95% 0px', threshold: [0.18] });
  cards.forEach(card => observer.observe(card));

  activeObserver = new IntersectionObserver(entries => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
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
    if (feed.scrollTop <= 1 && index === 0 && typeof onStart === 'function') {
      // Keep the callback available for older flows, but do not fire on normal arrival.
    }
    if (feed.scrollTop >= max - 1 && index === rows.length - 1 && typeof onEnd === 'function') {
      // Same as above: native snap stops naturally on the last item.
    }
  };
  feed.addEventListener('scrollend', boundaryTouch, { passive: true });

  return {
    destroy() {
      destroyed = true;
      observer?.disconnect();
      activeObserver?.disconnect();
      detachHorizontal();
      feed.removeEventListener('scrollend', boundaryTouch);
    },
    go(nextIndex) {
      index = Math.max(0, Math.min(Number(nextIndex) || 0, rows.length - 1));
      cards[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActive(index);
    },
    getIndex() {
      return index;
    },
    getItem() {
      return rows[index];
    }
  };
}
