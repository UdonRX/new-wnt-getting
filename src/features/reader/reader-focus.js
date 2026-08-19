import { el, openSheet, showToast } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';
import { iconSvg } from '../../shared/icons.js';

const summaryCache = new Map();
const summaryPromises = new Map();
const AI_BUDGET_KEY = 'pdv2:summaryAiBudget:v2131';
const AI_DAILY_LIMIT = 12;

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
  d.innerHTML = value;
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
  return `${item?.link || item?.id || item?.title || ''}::${summaryModeOf(item, mode) || 'auto'}::v2131`;
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

  const description = stripHtml(item.description).slice(0, 7000);
  const forceJapanese = looksMostlyEnglish(`${item.title || ''}\n${description}`);
  // 論文PDFと英語翻訳は必ずAI。通常の日本語ニュース/知識は従来同様に日次予算内だけAI。
  const allowAi = activeMode === 'papers' || forceJapanese || takeAiBudget();
  const request = fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item.link,
      title: item.title,
      description,
      source: item.source,
      mode: activeMode,
      // 論文だけはリンク先本文を取りに行き、PDFならPDF本文を優先する。
      preferFullText: activeMode === 'papers',
      // おすすめに英語記事が混ざっても要約だけは必ず日本語にする。
      forceJapanese,
      allowAi,
      fast: activeMode !== 'papers'
    })
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(data, res.status));
    summaryCache.set(key, data);
    while (summaryCache.size > 48) summaryCache.delete(summaryCache.keys().next().value);
    return data;
  }).finally(() => {
    if (summaryPromises.get(key) === request) summaryPromises.delete(key);
  });

  summaryPromises.set(key, request);
  return request;
}

function prefetchSummary(item, { mode = '' } = {}) {
  if (!item) return;
  const key = summaryKey(item, mode);
  if (!key || summaryCache.has(key) || summaryPromises.has(key)) return;
  fetchSummary(item, { mode }).catch(() => {});
}

function cachedSummary(item, mode = '') {
  return summaryCache.get(summaryKey(item, mode));
}

function chatSheet(item, summary) {
  const wrap = el('div');
  const history = [];
  const log = el('div', { class: 'chat-log' });
  const field = el('div', { class: 'field' });
  field.append(el('label', { text: 'この記事について質問' }));

  const input = el('textarea', {
    rows: '3',
    placeholder: '例：この研究を製品開発へ応用すると？'
  });
  field.append(input);

  const send = el('button', {
    class: 'primary-button full-button',
    type: 'button',
    text: '送信'
  });

  send.onclick = async () => {
    const q = input.value.trim();
    if (!q) return;

    input.value = '';
    log.append(el('div', { class: 'chat-user', text: q }));
    send.disabled = true;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.link,
          title: item.title,
          description: stripHtml(item.description),
          question: q,
          history,
          summary: summary?.points || []
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorMessage(data, res.status));

      const answer = data.answer || data.text || '';
      log.append(el('div', { class: 'chat-ai', text: answer }));
      history.push(
        { role: 'user', content: q },
        { role: 'assistant', content: answer }
      );
    } catch (err) {
      log.append(el('div', { class: 'error-box', text: err.message }));
    } finally {
      send.disabled = false;
    }
  };

  wrap.append(log, field, send);
  openSheet(wrap, { title: 'AIに質問' });
}

function renderProgress(progressHost, { label, index, total, onList }) {
  if (!progressHost) return;

  const progress = el('div', { class: 'focus-progress focus-progress-sticky' });
  const title = el('strong', { text: label });
  const track = el('div', { class: 'progress-track' }, [
    el('div', {
      class: 'progress-fill',
      style: `width:${total ? ((index + 1) / total) * 100 : 0}%`
    })
  ]);
  const count = el('span', {
    class: 'focus-progress-count',
    text: `${index + 1} / ${total}`
  });
  const list = el('button', {
    class: 'focus-list-button',
    type: 'button',
    title: '記事一覧',
    'aria-label': '記事一覧',
    html: iconSvg('list', { size: 17 }),
    onclick: onList
  });

  progress.append(title, track, count, list);
  progressHost.replaceChildren(progress);
}

function createSummaryLoader() {
  const box = el('div', { class: 'summary-loading-box' });
  const label = el('div', { class: 'summary-loading-label', text: 'AI要約を作成中…' });
  const track = el('div', { class: 'summary-loading-track' });
  const fill = el('div', { class: 'summary-loading-fill' });
  const percent = el('span', { class: 'summary-loading-percent', text: '8%' });
  track.append(fill);
  box.append(label, track, percent);

  const startedAt = performance.now();
  let raf = 0;
  let stopped = false;
  const tick = now => {
    if (stopped || !box.isConnected) return;
    const sec = Math.max(0, (now - startedAt) / 1000);
    // 通信の実進捗は取れないため95%までは疑似進捗。色は現在タブ色をCSSで使う。
    const value = Math.min(95, 8 + 87 * (1 - Math.exp(-sec / 3.2)));
    fill.style.width = `${value}%`;
    percent.textContent = `${Math.round(value)}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    node: box,
    finish() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      fill.style.width = '100%';
      percent.textContent = '100%';
    },
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    }
  };
}

function paperDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/(?:公開年|出版年):\s*(\d{4})/);
  if (/日付精度:\s*不明/.test(description)) return '日付不明';
  if (/日付精度:\s*年/.test(description) && yearOnly) return `${yearOnly[1]}年`;
  return shortDate(item?.pubDate);
}

function renderSummary(summaryHost, summary) {
  summaryHost.replaceChildren();

  if (summary.short) {
    summaryHost.append(el('div', { class: 'summary-block summary-block-compact' }, [
      el('h3', { text: 'ひとことで' }),
      el('div', { class: 'summary-short', text: summary.short })
    ]));
  }

  const points = Array.isArray(summary.points) ? summary.points.slice(0, 3) : [];
  if (points.length) {
    const ul = el('ul', { class: 'summary-points-compact' });
    points.forEach(point => ul.append(el('li', { text: point })));
    summaryHost.append(el('div', { class: 'summary-block summary-block-compact' }, [
      el('h3', { text: '要点' }),
      ul
    ]));
  }

  const sourceText = summary.contentSource === 'pdf'
    ? `PDF本文から要約${summary.pdfPageCount ? `（${summary.pdfPageCount}ページ）` : ''}`
    : summary.contentSource === 'article'
      ? 'リンク先本文から要約'
      : summary.fastPath === 'rss-abstract-fast'
        ? 'RSS本文・抄録から高速要約'
        : 'AI要約';
  summaryHost.append(el('div', { class: 'source-note', text: sourceText }));
}

function isDocumentScroller(scroller) {
  return scroller === document.scrollingElement ||
    scroller === document.documentElement ||
    scroller === document.body;
}

function getScroller(node) {
  let current = node?.parentElement;

  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const overflowY = style.overflowY || '';
    if (/(auto|scroll)/.test(overflowY) && current.scrollHeight > current.clientHeight + 4) {
      return current;
    }
    current = current.parentElement;
  }

  return document.scrollingElement || document.documentElement;
}

function getScrollMetrics(node) {
  const scroller = getScroller(node);

  if (isDocumentScroller(scroller)) {
    const top = Math.max(0, window.scrollY || scroller.scrollTop || 0);
    const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
    const max = Math.max(0, scroller.scrollHeight - viewport);
    return { scroller, top, max, document: true };
  }

  return {
    scroller,
    top: Math.max(0, scroller.scrollTop),
    max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    document: false
  };
}

function atTop(node, tolerance = 10) {
  return getScrollMetrics(node).top <= tolerance;
}

function atBottom(node, tolerance = 18) {
  const { top, max } = getScrollMetrics(node);
  return max <= tolerance || top >= max - tolerance;
}

function interactiveTarget(target) {
  return Boolean(target?.closest?.('a,button,input,textarea,select,[contenteditable="true"]'));
}

function attachFocusGesture(card, { up, down, left, right }) {
  let start = null;

  const onTouchStart = event => {
    if (event.touches.length !== 1) {
      start = null;
      return;
    }

    const touch = event.touches[0];
    start = {
      x: touch.clientX,
      y: touch.clientY,
      top: atTop(card),
      bottom: atBottom(card),
      interactive: interactiveTarget(event.target)
    };
  };

  const onTouchEnd = event => {
    if (!start || !event.changedTouches?.length) {
      start = null;
      return;
    }

    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const started = start;
    start = null;

    if (started.interactive) return;

    if (ax >= 58 && ax > ay * 1.2) {
      if (dx < 0) left?.();
      else right?.();
      return;
    }

    if (ay < 72 || ay <= ax * 1.25) return;

    if (dy < 0 && started.bottom && atBottom(card)) {
      up?.();
      return;
    }

    if (dy > 0 && started.top && atTop(card)) down?.();
  };

  const onTouchCancel = () => { start = null; };

  card.addEventListener('touchstart', onTouchStart, { passive: true });
  card.addEventListener('touchend', onTouchEnd, { passive: true });
  card.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return () => {
    card.removeEventListener('touchstart', onTouchStart);
    card.removeEventListener('touchend', onTouchEnd);
    card.removeEventListener('touchcancel', onTouchCancel);
  };
}

function scrollCardToStart(card) {
  requestAnimationFrame(() => {
    if (!card?.isConnected) return;

    const sticky = document.querySelector('.reader-sticky-context');
    const offset = (sticky?.getBoundingClientRect().height || 0) + 8;
    const metrics = getScrollMetrics(card);

    if (metrics.document) {
      const top = Math.max(0, (window.scrollY || 0) + card.getBoundingClientRect().top - offset);
      window.scrollTo({ top, behavior: 'auto' });
      return;
    }

    const scrollerRect = metrics.scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const top = metrics.scroller.scrollTop + (cardRect.top - scrollerRect.top) - offset;
    metrics.scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
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
  horizontalHint = 'RSSタブ',
  progressHost = null,
  summaryMode = ''
}) {
  let index = Math.max(0, Math.min(initialIndex, items.length - 1));
  let detach = () => {};
  let destroyed = false;

  const render = ({ scrollToTop = false } = {}) => {
    const item = items[index];

    if (!item) {
      host.innerHTML = '<div class="empty">記事がありません</div>';
      progressHost?.replaceChildren();
      return;
    }

    renderProgress(progressHost, {
      label,
      index,
      total: items.length,
      onList
    });

    const card = el('article', { class: 'card focus-card reader-focus-scroll-safe' });
    const body = el('div');

    body.append(
      el('div', {
        class: 'focus-source',
        text: `${item._recommendationLabel ? `${item._recommendationLabel} ・ ` : ''}${item.source || ''} ・ ${paperDateLabel(item)}`
      }),
      el('h2', {
        class: 'focus-title',
        text: item.titleJa || item.title
      })
    );

    if (item.titleJa) body.append(el('div', { class: 'focus-original', text: item.title }));

    const summaryHost = el('div', { class: 'summary-area' });
    const cached = cachedSummary(item, summaryMode);
    let loader = null;

    if (cached) renderSummary(summaryHost, cached);
    else {
      loader = createSummaryLoader();
      summaryHost.append(loader.node);
    }

    body.append(summaryHost);

    const actions = el('div', { class: 'focus-actions' });
    actions.append(
      el('button', {
        class: 'soft-button',
        type: 'button',
        text: '≡ 一覧',
        onclick: onList
      }),
      el('button', {
        class: 'soft-button',
        type: 'button',
        text: 'AIに質問',
        onclick: () => chatSheet(item, cachedSummary(item, summaryMode))
      }),
      el('a', {
        class: 'soft-button',
        href: item.link || '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: '原文'
      })
    );

    const nextText = index >= items.length - 1 && onEnd ? '記事一覧' : '次の記事';
    const prevText = index <= 0 ? '最初の記事' : '前の記事';

    card.append(
      body,
      actions,
      el('div', {
        class: 'swipe-hint reader-boundary-hint',
        text: `末尾でもう一度 ↑ ${nextText}　先頭で ↓ ${prevText}　←→ ${horizontalHint}`
      })
    );

    host.replaceChildren(card);
    detach();
    detach = attachFocusGesture(card, {
      up: () => move(1),
      down: () => {
        if (index === 0 && typeof onStart === 'function') onStart();
        else move(-1);
      },
      left: onNextFeed,
      right: onPrevFeed
    });

    onIndexChange?.(index, item);
    if (scrollToTop) scrollCardToStart(card);

    if (!cached) {
      fetchSummary(item, { mode: summaryMode })
        .then(summary => {
          loader?.finish();
          if (destroyed || items[index] !== item || !summaryHost.isConnected) return;
          renderSummary(summaryHost, summary);
          prefetchSummary(items[index + 1], { mode: summaryMode });
        })
        .catch(err => {
          loader?.stop();
          if (destroyed || !summaryHost.isConnected) return;

          summaryHost.replaceChildren(el('div', { class: 'error-box' }, [
            el('div', { text: err.message }),
            el('button', {
              class: 'soft-button',
              type: 'button',
              text: '要約を再取得',
              onclick: async () => {
                try {
                  const retryLoader = createSummaryLoader();
                  summaryHost.replaceChildren(retryLoader.node);
                  const retrySummary = await fetchSummary(item, { force: true, mode: summaryMode });
                  retryLoader.finish();
                  renderSummary(summaryHost, retrySummary);
                } catch (retryError) {
                  summaryHost.replaceChildren(el('div', {
                    class: 'error-box',
                    text: retryError.message
                  }));
                }
              }
            })
          ]));
        });
    }
  };

  const move = delta => {
    const next = index + delta;

    if (next < 0) {
      showToast('最初の記事です');
      return;
    }

    if (next >= items.length) {
      if (typeof onEnd === 'function') {
        onEnd();
        return;
      }
      showToast(`${label}はここまで ✓`);
      return;
    }

    index = next;
    render({ scrollToTop: true });
  };

  render();

  return {
    destroy() {
      destroyed = true;
      detach();
    },
    go(nextIndex) {
      index = Math.max(0, Math.min(Number(nextIndex) || 0, items.length - 1));
      render({ scrollToTop: true });
    }
  };
}
