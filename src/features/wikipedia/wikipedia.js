import { el, openSheet, showToast } from '../../shared/dom.js';
import { topbar, segmented } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';

const DAILY_KEY = 'pdv2:wikipediaDaily:v213';
const ARTICLE_PREFIX = 'pdv2:wikipediaArticle:v2131:';
const SETTINGS_KEY = 'pdv2:wikipediaReaderSettings';
const DEFAULT_SETTINGS = { writing: 'vertical', fontSize: 19, lineHeight: 1.85, theme: 'warm' };
let articleGeneration = 0;

window.addEventListener('pdv2:before-navigate', event => {
  if (event?.detail?.screen === 'wikipedia') return;
  articleGeneration += 1;
  document.documentElement.classList.remove('wiki-reading');
});

function dayJst() { return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function readJson(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function settings() { return { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_KEY, {}) || {}) }; }

async function loadDaily(force = false) {
  const cached = readJson(DAILY_KEY);
  if (!force && cached?.date === dayJst() && cached?.items?.length) return cached;
  const response = await fetch('/api/wikipedia?mode=daily', { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Wikipedia取得エラー (${response.status})`);
  saveJson(DAILY_KEY, data);
  return data;
}

async function loadArticle(title) {
  const key = `${ARTICLE_PREFIX}${title}`;
  const cached = readJson(key);
  if (cached?.blocks?.length && Date.now() - Number(cached.at || 0) < 7 * 24 * 60 * 60 * 1000) return cached;
  const response = await fetch(`/api/wikipedia?mode=article&title=${encodeURIComponent(title)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Wikipedia本文取得エラー (${response.status})`);
  const result = { ...data, at: Date.now() };
  saveJson(key, result);
  return result;
}

/*
 * v2.14.2
 * Wikipedia reader pagination is based on the REAL rendered viewport instead of
 * a guessed character count. Every page starts exactly where the previous page
 * ended, so no character can be dropped or duplicated at a page boundary.
 */
function blockText(block) {
  if (!block) return '';
  if (block.type === 'heading') return `◆ ${block.text}\n\n`;
  if (block.type === 'list') return `・${block.text}\n`;
  return `${block.text}\n\n`;
}

function articleText(blocks) {
  const text = (blocks || []).map(blockText).join('');
  return text || '本文を表示できませんでした。';
}

function waitLayoutFrames() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function renderReaderText(node, text, vertical) {
  appendReadableVerticalText(node, text, vertical);
}

function measurementFits(node) {
  const tolerance = 1.5;
  return node.scrollHeight <= node.clientHeight + tolerance &&
    node.scrollWidth <= node.clientWidth + tolerance;
}

function chooseNaturalBreak(chars, start, maximumEnd) {
  const span = maximumEnd - start;
  if (span < 20) return maximumEnd;

  // Natural punctuation is preferred only near the measured edge. We never
  // delete the skipped characters: the next page starts at the exact cut index.
  const minEnd = start + Math.floor(span * .94);
  for (let i = maximumEnd; i > minEnd; i -= 1) {
    const ch = chars[i - 1];
    if (ch === '\n' || /[。！？!?；;]/.test(ch)) return i;
  }
  for (let i = maximumEnd; i > minEnd; i -= 1) {
    const ch = chars[i - 1];
    if (/[、，,・）】」』〉》\s]/.test(ch)) return i;
  }
  return maximumEnd;
}

function paginateMeasured(text, measureNode, vertical) {
  const chars = Array.from(String(text || ''));
  if (!chars.length) return ['本文を表示できませんでした。'];

  const pages = [];
  let start = 0;

  while (start < chars.length) {
    let low = start + 1;
    let high = chars.length;
    let best = start;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      renderReaderText(measureNode, chars.slice(start, middle).join(''), vertical);
      if (measurementFits(measureNode)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    // Extremely large fonts can theoretically make even one glyph overflow.
    // Advancing by one character avoids an infinite loop while preserving text.
    if (best <= start) best = Math.min(chars.length, start + 1);

    let end = best < chars.length ? chooseNaturalBreak(chars, start, best) : best;
    if (end <= start) end = best;

    pages.push(chars.slice(start, end).join(''));
    start = end;
  }

  measureNode.replaceChildren();
  return pages.length ? pages : ['本文を表示できませんでした。'];
}

function settingsSheet(current, onChange) {
  const wrap = el('div', { class: 'wiki-settings-sheet' });
  const addRange = (label, key, min, max, step, suffix) => {
    const value = el('span', { class: 'wiki-setting-value', text: `${current[key]}${suffix}` });
    const input = el('input', { type: 'range', min, max, step, value: current[key] });
    input.addEventListener('input', () => {
      current[key] = Number(input.value);
      value.textContent = `${current[key]}${suffix}`;
      onChange({ ...current });
    });
    wrap.append(el('label', { class: 'wiki-setting-row' }, [el('span', { text: label }), value, input]));
  };
  wrap.append(el('div', { class: 'wiki-setting-label', text: '組み方向' }));
  wrap.append(segmented([
    { value: 'vertical', label: '縦書き' }, { value: 'horizontal', label: '横書き' }
  ], current.writing, value => { current.writing = value; onChange({ ...current }); }));
  addRange('文字サイズ', 'fontSize', 15, 27, .5, 'px');
  addRange('行間', 'lineHeight', 1.35, 2.5, .05, '');
  wrap.append(el('div', { class: 'wiki-setting-label', text: '背景' }));
  wrap.append(segmented([
    { value: 'warm', label: '暖色' }, { value: 'dark', label: '黒' }, { value: 'paper', label: '白' }
  ], current.theme, value => { current.theme = value; onChange({ ...current }); }));
  return openSheet(wrap, { title: '読書表示' });
}

function appendReadableVerticalText(node, text, vertical) {
  node.replaceChildren();
  if (!vertical) {
    node.textContent = text;
    return;
  }

  const parts = String(text || '').split(/([0-9０-９]{1,4})/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^[0-9０-９]{1,2}$/.test(part)) {
      node.append(el('span', { class: 'wiki-tcy', text: part }));
    } else if (/^[0-9０-９]{3,4}$/.test(part)) {
      node.append(el('span', { class: 'wiki-upright-number', text: part }));
    } else {
      node.append(document.createTextNode(part));
    }
  }
}

function showReader(root, articleMeta, article, backToList) {
  articleGeneration += 1;
  const generation = articleGeneration;
  document.documentElement.classList.add('wiki-reading');

  let s = settings();
  let pages = ['本文を画面に合わせています…'];
  let pageIndex = 0;
  let animating = false;
  let hideTimer = null;
  let resizeTimer = null;
  let paginationSerial = 0;
  let disposed = false;

  const shell = el('section', { class: `wiki-reader wiki-theme-${s.theme}` });
  const controls = el('div', { class: 'wiki-reader-controls' });
  const close = el('button', { class: 'wiki-reader-control', type: 'button', text: '✕', 'aria-label': '記事一覧へ戻る' });
  const listButton = el('button', { class: 'wiki-reader-control wiki-list-button', type: 'button', text: '10選' });
  const title = el('div', { class: 'wiki-reader-title', text: articleMeta.title });
  const aa = el('button', { class: 'wiki-reader-control', type: 'button', text: 'Aa', onclick: () => settingsSheet({ ...s }, next => applySettings(next)) });
  controls.append(close, listButton, title, aa);

  const stage = el('div', { class: 'wiki-reader-stage' });
  const page = el('article', { class: 'wiki-page' });
  const measurePage = el('article', { class: 'wiki-page wiki-page-measure', 'aria-hidden': 'true' });
  const edgeLeft = el('button', { class: 'wiki-edge wiki-edge-left', type: 'button', 'aria-label': '次のページ' });
  const edgeRight = el('button', { class: 'wiki-edge wiki-edge-right', type: 'button', 'aria-label': '前のページ' });
  const centerTap = el('button', { class: 'wiki-center-tap', type: 'button', 'aria-label': '操作ボタンを表示' });
  stage.append(page, measurePage, edgeLeft, edgeRight, centerTap);

  const progress = el('div', { class: 'wiki-reader-progress' });
  const progressFill = el('div', { class: 'wiki-reader-progress-fill' });
  const progressText = el('span', { class: 'wiki-reader-progress-text' });
  progress.append(progressFill, progressText);
  const source = el('a', { class: 'wiki-source-link', href: article.url || articleMeta.url, target: '_blank', rel: 'noopener noreferrer', text: '出典: Wikipedia ↗' });
  controls.append(source);
  shell.append(controls, stage, progress);
  root.replaceChildren(shell);

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    controls.classList.remove('hidden');
    hideTimer = setTimeout(() => controls.classList.add('hidden'), 2600);
  };

  const configurePage = (node, vertical, entryClass = '') => {
    node.className = `wiki-page ${vertical ? 'vertical' : 'horizontal'}${node === measurePage ? ' wiki-page-measure' : ''}${entryClass ? ` ${entryClass}` : ''}`;
    node.style.setProperty('--wiki-font-size', `${s.fontSize}px`);
    node.style.setProperty('--wiki-line-height', String(s.lineHeight));
  };

  const paint = (entryClass = '') => {
    if (disposed || generation !== articleGeneration) return;
    shell.className = `wiki-reader wiki-theme-${s.theme}`;
    const vertical = s.writing === 'vertical';
    configurePage(page, vertical, entryClass);
    renderReaderText(page, pages[pageIndex] || '', vertical);
    const count = Math.max(1, pages.length);
    progressFill.style.width = `${((pageIndex + 1) / count) * 100}%`;
    progressText.textContent = `${pageIndex + 1} / ${count}`;
  };

  const repaginate = async ({ ratio = null } = {}) => {
    if (disposed || generation !== articleGeneration) return;
    const serial = ++paginationSerial;
    const vertical = s.writing === 'vertical';
    const keepRatio = ratio == null
      ? (pages.length > 1 ? pageIndex / (pages.length - 1) : 0)
      : ratio;

    shell.className = `wiki-reader wiki-theme-${s.theme}`;
    configurePage(measurePage, vertical);
    await waitLayoutFrames();

    // The measurement page has exactly the same bounds, font size, line height,
    // writing mode and number styling as the visible page.
    const nextPages = paginateMeasured(articleText(article.blocks), measurePage, vertical);
    if (disposed || serial !== paginationSerial || generation !== articleGeneration) return;

    pages = nextPages;
    pageIndex = Math.max(0, Math.min(
      pages.length - 1,
      Math.round(keepRatio * Math.max(0, pages.length - 1))
    ));
    paint();
  };

  const applySettings = next => {
    const ratio = pages.length > 1 ? pageIndex / (pages.length - 1) : 0;
    s = { ...s, ...next };
    saveJson(SETTINGS_KEY, s);
    paint();
    repaginate({ ratio }).catch(() => {});
    scheduleHide();
  };

  const go = delta => {
    if (animating) return;
    const next = pageIndex + delta;
    if (next < 0) { showToast('最初のページです'); return; }
    if (next >= pages.length) { showToast('読み終わりました ✓'); scheduleHide(); return; }
    animating = true;
    page.classList.add(delta > 0 ? 'wiki-page-leave-next' : 'wiki-page-leave-prev');
    setTimeout(() => {
      if (disposed) return;
      pageIndex = next;
      paint(delta > 0 ? 'wiki-page-enter-next' : 'wiki-page-enter-prev');
      setTimeout(() => {
        page.classList.remove('wiki-page-enter-next', 'wiki-page-enter-prev');
        animating = false;
      }, 230);
    }, 130);
  };

  const horizontalNextFlow = () =>
    s.writing === 'horizontal' || window.matchMedia?.('(orientation: landscape)')?.matches;

  edgeLeft.onclick = () => go(horizontalNextFlow() ? -1 : 1);
  edgeRight.onclick = () => go(horizontalNextFlow() ? 1 : -1);
  centerTap.onclick = () => controls.classList.contains('hidden') ? scheduleHide() : controls.classList.add('hidden');

  const scheduleRepaginate = () => {
    if (disposed) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => repaginate().catch(() => {}), 140);
  };

  const cleanupReader = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(hideTimer);
    clearTimeout(resizeTimer);
    paginationSerial += 1;
    window.removeEventListener('resize', scheduleRepaginate);
    window.visualViewport?.removeEventListener('resize', scheduleRepaginate);
    window.removeEventListener('pdv2:before-navigate', cleanupReader);
  };

  const leaveReader = () => {
    cleanupReader();
    backToList();
  };

  close.onclick = leaveReader;
  listButton.onclick = leaveReader;
  window.addEventListener('resize', scheduleRepaginate, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleRepaginate, { passive: true });
  window.addEventListener('pdv2:before-navigate', cleanupReader);

  let sx = 0, sy = 0;
  let edgeBackCandidate = false;

  stage.addEventListener('touchstart', event => {
    if (event.touches?.length !== 1) return;
    sx = event.touches[0].clientX;
    sy = event.touches[0].clientY;
    edgeBackCandidate = sx <= Math.max(24, Number(window.visualViewport?.offsetLeft || 0) + 24);
  }, { passive: true });

  stage.addEventListener('touchend', event => {
    const t = event.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const horizontalGesture = Math.abs(dx) > Math.abs(dy) * 1.25;

    if (edgeBackCandidate && dx >= 72 && horizontalGesture) {
      edgeBackCandidate = false;
      leaveReader();
      return;
    }
    edgeBackCandidate = false;

    if (Math.abs(dx) > 54 && horizontalGesture) {
      go(horizontalNextFlow() ? (dx < 0 ? 1 : -1) : (dx > 0 ? 1 : -1));
    }
  }, { passive: true });

  stage.addEventListener('touchcancel', () => { edgeBackCandidate = false; }, { passive: true });

  paint();
  scheduleHide();
  repaginate({ ratio: 0 }).catch(error => {
    console.error('[wikipedia] pagination failed', error);
    if (!disposed) showToast('本文レイアウトを調整できませんでした');
  });
}

export async function renderWikipedia(root, { navigate, refresh = false, initialFilter = 'today' } = {}) {
  articleGeneration += 1;
  document.documentElement.classList.remove('wiki-reading');

  const TAB_ORDER = ['today', 'classic', 'deep', 'trivia'];
  let filter = TAB_ORDER.includes(initialFilter) ? initialFilter : 'today';
  let data = null;
  let sx = 0;
  let sy = 0;
  let suppressClickUntil = 0;

  const screen = el('section', { class: 'screen wikipedia-screen' });
  screen.append(topbar('Wikipedia', {
    subtitle: '今日の出来事と読み物',
    actions: [
      { label: '↻', title: '記事候補を再取得', onClick: () => renderWikipedia(root, { navigate, refresh: true, initialFilter: filter }) },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  }));

  const categoryHost = el('div', { class: 'wiki-category-tabs' });
  const host = el('div', { class: 'wiki-daily-list' });
  screen.append(categoryHost, host);
  root.replaceChildren(screen);

  host.replaceChildren(el('div', { class: 'card wiki-loading-card' }, [
    el('strong', { text: 'Wikipediaから記事を選んでいます…' }),
    el('div', { class: 'wiki-loading-line' })
  ]));

  const tabs = [
    { value: 'today', label: '今日の出来事' },
    { value: 'classic', label: '王道' },
    { value: 'deep', label: '考察' },
    { value: 'trivia', label: '雑学' }
  ];

  const centerActiveTab = () => {
    requestAnimationFrame(() => {
      const active = categoryHost.querySelector('button.active, [aria-selected="true"]');
      active?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  };

  const setFilter = next => {
    if (!TAB_ORDER.includes(next)) return;
    filter = next;
    draw();
    centerActiveTab();
  };

  const openArticle = async item => {
    const loading = el('section', { class: 'wiki-reader-loading' }, [
      el('strong', { text: item.title }),
      el('div', { class: 'wiki-reader-loading-bar' }, [el('div', { class: 'wiki-reader-loading-fill' })]),
      el('span', { text: '本文だけを整えています…' })
    ]);
    root.replaceChildren(loading);
    try {
      const article = await loadArticle(item.title);
      showReader(root, item, article, () => renderWikipedia(root, { navigate, initialFilter: filter }));
    } catch (error) {
      showToast(error.message);
      renderWikipedia(root, { navigate, initialFilter: filter });
    }
  };

  const draw = () => {
    if (!data) return;
    categoryHost.replaceChildren(segmented(tabs, filter, setFilter));

    const items = (data.items || []).filter(item => item.kind === filter).slice(0, 10);
    host.replaceChildren();

    if (!items.length) {
      host.append(el('div', { class: 'empty wiki-empty-category', text:
        filter === 'today'
          ? `${data.dateLabel || '今日'}の「できごと」から表示できる記事が見つかりませんでした`
          : '今日は表示できる記事がありません'
      }));
      return;
    }

    items.forEach((item, index) => {
      const card = el('button', {
        class: `wiki-daily-card wiki-daily-${item.kind}${item.thumbnail ? ' has-image' : ''}`,
        type: 'button'
      });

      const copy = el('div', { class: 'wiki-daily-copy' }, [
        el('div', { class: `wiki-category-badge wiki-${item.kind}`, text: item.category }),
        el('strong', { class: 'wiki-daily-title', text: item.title }),
        el('div', { class: 'wiki-daily-reason', text: item.reason }),
        el('p', { class: 'wiki-daily-extract', text: item.extract || '' }),
        el('span', { class: 'wiki-daily-index', text: String(index + 1).padStart(2, '0') })
      ]);
      card.append(copy);

      if (item.thumbnail) {
        card.append(el('img', {
          class: 'wiki-daily-thumb',
          src: item.thumbnail,
          alt: '',
          loading: 'lazy',
          decoding: 'async'
        }));
      }

      card.onclick = () => {
        if (Date.now() < suppressClickUntil) return;
        openArticle(item);
      };
      host.append(card);
    });
  };

  host.addEventListener('touchstart', event => {
    if (event.touches?.length !== 1) return;
    sx = event.touches[0].clientX;
    sy = event.touches[0].clientY;
  }, { passive: true });

  host.addEventListener('touchend', event => {
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    const dx = touch.clientX - sx;
    const dy = touch.clientY - sy;
    if (Math.abs(dx) < 58 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;

    const current = TAB_ORDER.indexOf(filter);
    const nextIndex = dx < 0 ? current + 1 : current - 1;
    if (nextIndex < 0 || nextIndex >= TAB_ORDER.length) return;

    suppressClickUntil = Date.now() + 420;
    setFilter(TAB_ORDER[nextIndex]);
  }, { passive: true });

  host.addEventListener('click', event => {
    if (Date.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  try {
    data = await loadDaily(refresh);
    draw();
    centerActiveTab();
  } catch (error) {
    host.replaceChildren(el('div', { class: 'error-box', text: error.message }));
  }
}
