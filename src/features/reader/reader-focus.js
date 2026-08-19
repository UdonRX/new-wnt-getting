import { el, openSheet, showToast } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';
import { iconSvg } from '../../shared/icons.js';

const summaryCache = new Map();
const summaryPromises = new Map();
const SUMMARY_STORAGE_KEY = 'pdv2:summaryCache:v210';
const AI_BUDGET_KEY = 'pdv2:summaryAiBudget:v210';
const AI_DAILY_LIMIT = 12;
const AI_LAST_REQUEST_KEY = 'pdv2:summaryAiLastRequest:v210';
const AI_MIN_INTERVAL_MS = 5000;
const GEMINI_BLOCK_KEY = 'pdv2:geminiSummaryBlockedUntil';

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadPersistentSummaries() {
  try {
    const rows = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '[]');
    const now = Date.now();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.key || !row?.summary) continue;
      const ttl = row.summary.provider === 'gemini' ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
      if (now - Number(row.at || 0) > ttl) continue;
      summaryCache.set(row.key, row.summary);
    }
  } catch {}
}

function savePersistentSummary(key, summary) {
  if (!key || !summary) return;
  try {
    let rows = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '[]');
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter(row => row?.key !== key);
    rows.unshift({ key, at: Date.now(), summary });
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(rows.slice(0, 90)));
  } catch {}
}

function aiBudget() {
  try {
    const value = JSON.parse(localStorage.getItem(AI_BUDGET_KEY) || 'null');
    if (value?.day === todayKey()) return Math.max(0, Number(value.count || 0));
  } catch {}
  return 0;
}

function incrementAiBudget() {
  localStorage.setItem(AI_BUDGET_KEY, JSON.stringify({ day: todayKey(), count: aiBudget() + 1 }));
  localStorage.setItem(AI_LAST_REQUEST_KEY, String(Date.now()));
}

function canUseAiSummary() {
  const now = Date.now();
  const blockedUntil = Number(localStorage.getItem(GEMINI_BLOCK_KEY) || 0);
  const lastRequest = Number(localStorage.getItem(AI_LAST_REQUEST_KEY) || 0);
  return now >= blockedUntil && aiBudget() < AI_DAILY_LIMIT && now - lastRequest >= AI_MIN_INTERVAL_MS;
}

loadPersistentSummaries();

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
  if (!key) throw new Error('記事IDがありません');

  if (!force && summaryCache.has(key)) return summaryCache.get(key);
  if (!force && summaryPromises.has(key)) return summaryPromises.get(key);

  const allowAi = canUseAiSummary();
  const request = fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: item.link,
      title: item.title,
      description: stripHtml(item.description).slice(0, 6200),
      source: item.source,
      fast: true,
      allowAi
    })
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(data, res.status));

    if (data.provider === 'gemini') incrementAiBudget();
    if (data.fallbackReason === 'quota') {
      // 同じ画面操作で429を連発しない。30分はローカル要約へ直行。
      localStorage.setItem(GEMINI_BLOCK_KEY, String(Date.now() + 30 * 60 * 1000));
    } else if (data.fallbackReason && data.fallbackReason !== 'client-budget') {
      // API一時障害/キー設定中でも記事ごとに失敗リクエストを連打しない。
      localStorage.setItem(GEMINI_BLOCK_KEY, String(Date.now() + 5 * 60 * 1000));
    }

    summaryCache.set(key, data);
    savePersistentSummary(key, data);
    while (summaryCache.size > 90) summaryCache.delete(summaryCache.keys().next().value);
    return data;
  }).finally(() => {
    if (summaryPromises.get(key) === request) summaryPromises.delete(key);
  });

  summaryPromises.set(key, request);
  return request;
}

/*
 * V2.10: 自動先読みで無料Gemini枠を消費しない。
 * 次の記事に既存キャッシュがあればMapへ戻すだけにする。
 */
function prefetchSummary(item) {
  if (!item) return;
  const key = item.link || item.id;
  if (!key || summaryCache.has(key)) return;
  // ネットワーク呼び出しはしない。実際に記事を開いた時だけ要約する。
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
      const raw = String(err?.message || '');
      const message = /quota|rate.?limit|resource_exhausted|too many requests/i.test(raw)
        ? 'AI質問は現在利用上限です。記事の要約はそのまま読めます。'
        : raw;
      log.append(el('div', { class: 'error-box', text: message }));
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
  const label = el('div', { class: 'summary-loading-label', text: '要約を準備中…' });
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
    // 実通信の進捗率は取得できないため、待ち時間に合わせて95%まで滑らかに進める。
    const value = Math.min(95, 8 + 87 * (1 - Math.exp(-sec / 3.0)));
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

function renderSummary(summaryHost, summary, item = null) {
  summaryHost.replaceChildren();

  if (summary.short) {
    summaryHost.append(el('div', { class: 'summary-block summary-block-compact' }, [
      el('h3', { text: 'ひとことで' }),
      el('div', { class: 'summary-short', text: summary.short })
    ]));
  }

  const points = Array.isArray(summary.points) ? summary.points.slice(0, 2) : [];
  if (points.length) {
    const ul = el('ul', { class: 'summary-points-compact' });
    points.forEach(point => ul.append(el('li', { text: point })));
    summaryHost.append(el('div', { class: 'summary-block summary-block-compact' }, [
      el('h3', { text: '要点' }),
      ul
    ]));
  }

  const noteParts = [];
  if (item?._recommendationLabel) noteParts.push(item._recommendationLabel);
  noteParts.push(summary.provider === 'gemini' ? 'AI要約' : 'RSS本文・抄録から高速要約');
  summaryHost.append(el('div', {
    class: 'source-note',
    text: noteParts.join(' ・ ')
  }));
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
  onStart = null,
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

    if (item.titleJa) {
      body.append(el('div', { class: 'focus-original', text: item.title }));
    }

    const summaryHost = el('div', { class: 'summary-area' });
    const cached = summaryCache.get(item.link || item.id);
    let loader = null;

    if (cached) renderSummary(summaryHost, cached, item);
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
      fetchSummary(item)
        .then(summary => {
          loader?.finish();
          if (destroyed || items[index] !== item || !summaryHost.isConnected) return;
          renderSummary(summaryHost, summary, item);
          // 次の記事はユーザーが今の記事を読んでいる間に先読みする。
          prefetchSummary(items[index + 1]);
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
                  const retrySummary = await fetchSummary(item, { force: true });
                  retryLoader.finish();
                  renderSummary(summaryHost, retrySummary, item);
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
      progressHost?.replaceChildren();
    },
    go(i) {
      index = Math.max(0, Math.min(i, items.length - 1));
      render({ scrollToTop: true });
    }
  };
}
