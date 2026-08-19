import { el, openSheet, showToast } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';
import { iconSvg } from '../../shared/icons.js';

const summaryCache = new Map();
let controller = null;

function stripHtml(value = '') {
  const d = document.createElement('div');
  d.innerHTML = value;
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

function errorMessage(data, status) {
  const error = String(data?.error || '').trim();
  const detail = String(data?.detail || '').trim();
  if (error && detail && error !== detail) return `${error}：${detail}`;
  return error || detail || `要約エラー (${status})`;
}

async function fetchSummary(item, { force = false } = {}) {
  const key = item.link || item.id;
  if (!force && summaryCache.has(key)) return summaryCache.get(key);

  controller?.abort();
  controller = new AbortController();

  const res = await fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item.link,
      title: item.title,
      description: stripHtml(item.description),
      source: item.source
    }),
    signal: controller.signal
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(data, res.status));

  summaryCache.set(key, data);
  while (summaryCache.size > 28) summaryCache.delete(summaryCache.keys().next().value);
  return data;
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

function renderSummary(summaryHost, summary) {
  summaryHost.replaceChildren();

  if (summary.short) {
    summaryHost.append(el('div', { class: 'summary-block' }, [
      el('h3', { text: '5秒で分かる' }),
      el('div', { class: 'summary-short', text: summary.short })
    ]));
  }

  if (summary.why) {
    summaryHost.append(el('div', { class: 'summary-block' }, [
      el('h3', { text: 'なぜ重要？' }),
      el('div', { class: 'summary-why', text: summary.why })
    ]));
  }

  const points = Array.isArray(summary.points) ? summary.points : [];
  if (points.length) {
    const ul = el('ul');
    points.forEach(point => ul.append(el('li', { text: point })));
    summaryHost.append(el('div', { class: 'summary-block' }, [
      el('h3', { text: 'ポイント' }),
      ul
    ]));
  }

  const note = summary.contentSource === 'pdf'
    ? `PDF本文から要約${summary.pdfPageCount ? `（${summary.pdfPageCount}ページ）` : ''}`
    : summary.contentSource === 'article'
      ? 'リンク先本文から要約'
      : `RSS本文から要約${summary.fallbackReason ? `（${summary.fallbackReason.slice(0, 70)}）` : ''}`;

  summaryHost.append(el('div', { class: 'source-note', text: note }));
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

/*
 * Reader専用ジェスチャー。
 * 縦方向は「通常スクロール」と競合させない。
 * - 上スワイプで次へ進めるのは、指を置いた時点ですでに最下部だった場合だけ
 * - 下スワイプで前へ戻るのは、指を置いた時点ですでに最上部だった場合だけ
 *
 * これにより、要約を読むための普通の上スワイプでは記事が切り替わらない。
 * 最下部まで読み切った後、もう一度上へスワイプした時だけ次の記事へ進む。
 */
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

    // 横方向は従来どおりタブ切替に使う。
    if (ax >= 58 && ax > ay * 1.2) {
      if (dx < 0) left?.();
      else right?.();
      return;
    }

    // 縦方向はスクロール境界から開始した操作だけを記事移動として扱う。
    if (ay < 72 || ay <= ax * 1.25) return;

    if (dy < 0 && started.bottom && atBottom(card)) {
      up?.();
      return;
    }

    if (dy > 0 && started.top && atTop(card)) {
      down?.();
    }
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
  onEnd = null,
  onIndexChange,
  onPrevFeed,
  onNextFeed,
  horizontalHint = 'RSSタブ',
  progressHost = null
}) {
  let index = Math.max(0, Math.min(initialIndex, items.length - 1));
  let detach = () => {};
  let destroyed = false;

  const render = ({ scrollToTop = false } = {}) => {
    controller?.abort();
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
        text: `${item.source || ''} ・ ${shortDate(item.pubDate)}`
      }),
      el('h2', {
        class: 'focus-title',
        text: item.titleJa || item.title
      })
    );

    if (item.titleJa) {
      body.append(el('div', { class: 'focus-original', text: item.title }));
    }

    const summaryHost = el('div', { class: 'summary-area' });
    const cached = summaryCache.get(item.link || item.id);

    if (cached) renderSummary(summaryHost, cached);
    else summaryHost.append(el('div', { class: 'summary-preview', text: 'AI要約を読み込み中…' }));

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
        onclick: () => chatSheet(item, summaryCache.get(item.link || item.id))
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
      down: () => move(-1),
      left: onNextFeed,
      right: onPrevFeed
    });

    onIndexChange?.(index, item);
    if (scrollToTop) scrollCardToStart(card);

    if (!cached) {
      fetchSummary(item)
        .then(summary => {
          if (destroyed || items[index] !== item || !summaryHost.isConnected) return;
          renderSummary(summaryHost, summary);
        })
        .catch(err => {
          if (err.name === 'AbortError' || destroyed || !summaryHost.isConnected) return;

          summaryHost.replaceChildren(el('div', { class: 'error-box' }, [
            el('div', { text: err.message }),
            el('button', {
              class: 'soft-button',
              type: 'button',
              text: '要約を再取得',
              onclick: async () => {
                try {
                  summaryHost.replaceChildren(el('div', {
                    class: 'summary-preview',
                    text: 'AI要約を再取得中…'
                  }));
                  renderSummary(summaryHost, await fetchSummary(item, { force: true }));
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
      controller?.abort();
      detach();
      progressHost?.replaceChildren();
    },
    go(i) {
      index = Math.max(0, Math.min(i, items.length - 1));
      render({ scrollToTop: true });
    }
  };
}
