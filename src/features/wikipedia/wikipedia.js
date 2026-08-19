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
 * v2.13.1
 * ページ境界で文字を単純切断しない。
 * まず文単位へ分け、1文だけが長すぎる時に限って読点などで分割する。
 * trim()でページ境界の文字を落とさないよう、本文は最後まで同じ順序で連結する。
 */
function sentenceUnits(text) {
  const value = String(text || '');
  if (!value) return [];

  try {
    if (typeof Intl?.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter('ja', { granularity: 'sentence' });
      const rows = [...segmenter.segment(value)].map(row => row.segment).filter(Boolean);
      if (rows.length) return rows;
    }
  } catch {}

  const rows = value.match(/[^。！？!?\n]+[。！？!?]?[ \t]*|\n+/g);
  return rows?.length ? rows : [value];
}

function splitLongUnit(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return [value];

  const out = [];
  let offset = 0;
  while (offset < value.length) {
    const remaining = value.length - offset;
    if (remaining <= limit) {
      out.push(value.slice(offset));
      break;
    }

    const windowText = value.slice(offset, offset + limit + 1);
    const minCut = Math.floor(limit * .62);
    let cut = -1;

    for (const mark of ['。', '！', '？', '!', '?', '；', ';', '、', '，', ',', ' ']) {
      const at = windowText.lastIndexOf(mark, limit);
      if (at >= minCut) cut = Math.max(cut, at + 1);
    }
    if (cut < minCut) cut = limit;

    out.push(value.slice(offset, offset + cut));
    offset += cut;
  }
  return out;
}

function blockText(block) {
  if (!block) return '';
  if (block.type === 'heading') return `◆ ${block.text}\n\n`;
  if (block.type === 'list') return `・${block.text}\n`;
  return `${block.text}\n\n`;
}

function paginate(blocks, s) {
  const base = s.writing === 'vertical' ? 610 : 860;
  const target = Math.max(260, Math.min(1050,
    Math.round(base * Math.pow(19 / Number(s.fontSize || 19), 1.45) * (1.85 / Number(s.lineHeight || 1.85)))
  ));

  const units = [];
  for (const block of blocks || []) {
    const text = blockText(block);
    for (const sentence of sentenceUnits(text)) {
      units.push(...splitLongUnit(sentence, Math.max(180, target - 70)));
    }
  }

  const pages = [];
  let page = '';

  for (const unit of units) {
    // 文が入るなら同じページに載せる。入らない時は文の手前で改ページする。
    if (page && page.length + unit.length > target) {
      pages.push(page);
      page = '';
    }

    // 1 unit 自体がtargetより大きいケースも文字を落とさず処理。
    if (unit.length > target) {
      const pieces = splitLongUnit(unit, target);
      for (const piece of pieces) {
        if (page && page.length + piece.length > target) {
          pages.push(page);
          page = '';
        }
        page += piece;
      }
    } else {
      page += unit;
    }
  }

  if (page) pages.push(page);
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
  let pages = paginate(article.blocks, s);
  let pageIndex = 0;
  let animating = false;
  let hideTimer = null;

  const shell = el('section', { class: `wiki-reader wiki-theme-${s.theme}` });
  const controls = el('div', { class: 'wiki-reader-controls' });
  const close = el('button', { class: 'wiki-reader-control', type: 'button', text: '✕', 'aria-label': '記事一覧へ戻る', onclick: backToList });
  const listButton = el('button', { class: 'wiki-reader-control wiki-list-button', type: 'button', text: '10選', onclick: backToList });
  const title = el('div', { class: 'wiki-reader-title', text: articleMeta.title });
  const aa = el('button', { class: 'wiki-reader-control', type: 'button', text: 'Aa', onclick: () => settingsSheet({ ...s }, next => applySettings(next)) });
  controls.append(close, listButton, title, aa);

  const stage = el('div', { class: 'wiki-reader-stage' });
  const page = el('article', { class: 'wiki-page' });
  const edgeLeft = el('button', { class: 'wiki-edge wiki-edge-left', type: 'button', 'aria-label': '次のページ' });
  const edgeRight = el('button', { class: 'wiki-edge wiki-edge-right', type: 'button', 'aria-label': '前のページ' });
  const centerTap = el('button', { class: 'wiki-center-tap', type: 'button', 'aria-label': '操作ボタンを表示' });
  stage.append(page, edgeLeft, edgeRight, centerTap);

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

  const paint = (entryClass = '') => {
    if (generation !== articleGeneration) return;
    shell.className = `wiki-reader wiki-theme-${s.theme}`;
    const vertical = s.writing === 'vertical';
    page.className = `wiki-page ${vertical ? 'vertical' : 'horizontal'} ${entryClass}`.trim();
    page.style.setProperty('--wiki-font-size', `${s.fontSize}px`);
    page.style.setProperty('--wiki-line-height', String(s.lineHeight));
    appendReadableVerticalText(page, pages[pageIndex] || '', vertical);
    progressFill.style.width = `${((pageIndex + 1) / pages.length) * 100}%`;
    progressText.textContent = `${pageIndex + 1} / ${pages.length}`;
  };

  const applySettings = next => {
    const ratio = pages.length > 1 ? pageIndex / (pages.length - 1) : 0;
    s = { ...s, ...next };
    saveJson(SETTINGS_KEY, s);
    pages = paginate(article.blocks, s);
    pageIndex = Math.max(0, Math.min(pages.length - 1, Math.round(ratio * Math.max(0, pages.length - 1))));
    paint();
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

  let sx = 0, sy = 0;
  let edgeBackCandidate = false;

  stage.addEventListener('touchstart', event => {
    if (event.touches?.length !== 1) return;
    sx = event.touches[0].clientX;
    sy = event.touches[0].clientY;
    // iPhoneの「画面左端から戻る」に近い判定。通常のページめくりと競合させない。
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
      backToList();
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
