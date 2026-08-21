/*
 * Personal Dashboard v2.14.20
 * Reader recommendation card visual refresh.
 *
 * Recommendation cards only:
 * - Upper ~30% becomes a light visual hero with source logo/monogram,
 *   category badge, update time and the existing Bento button.
 * - Lower area keeps the title + three AI summary rows as mini cards.
 * - Important numbers / standout phrases are emphasized locally, without
 *   another AI request.
 * - The original article action is moved into a dedicated bottom footer.
 */

const BUILD = '21420';
const CARD_SELECTOR = '.reader-story-card';
const PATCHED = 'data-v21420-card';
const HIGHLIGHT_SOURCE = 'data-v21420-highlight-source';

function itemKey(item) {
  return String(item?.id || item?.link || item?.url || `${item?.source || ''}|${item?.title || ''}`);
}

function parseCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function creativeFamily(item) {
  const text = `${item?.title || ''}\n${item?.description || ''}`;
  if (/独創区分:\s*[^\n]*一般独創/i.test(text) || /一般独創/i.test(text)) return '一般独創';
  if (/独創区分:\s*[^\n]*応用発想/i.test(text) || /応用発想/i.test(text)) return '応用発想';
  return '独創研究';
}

function readerIndex() {
  const map = new Map();
  const add = (key, mode, track = '') => {
    const rows = parseCache(key)?.items || [];
    rows.forEach(item => {
      const id = itemKey(item);
      if (!id || map.has(id)) return;
      let family = mode === 'knowledge' ? '知識' : mode === 'news' ? 'ニュース' : '論文';
      if (mode === 'papers') family = track === 'creative' ? creativeFamily(item) : '製品・熱研究';
      map.set(id, { item, mode, track, family });
    });
  };
  add('pdv2:readerCache:news', 'news');
  add('pdv2:readerCache:knowledge', 'knowledge');
  add('pdv2:readerCache:papers:core', 'papers', 'core');
  add('pdv2:readerCache:papers:creative', 'papers', 'creative');
  add('pdv2:readerCache:papers', 'papers', 'core');
  return map;
}

function formatUpdated(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '更新日時不明';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return date.toLocaleString('ja-JP');
  }
}

function fallbackMeta(card) {
  const old = card.querySelector('.reader-story-header');
  return {
    category: old?.querySelector('.reader-story-category-badge')?.textContent?.trim() || 'おすすめ',
    source: old?.querySelector('.reader-story-source-name')?.textContent?.trim() || '配信元',
    updated: old?.querySelector('.reader-story-time')?.textContent?.trim() || '更新日時不明',
    logo: old?.querySelector('img') || null
  };
}

function categoryLabel(data, item, fallback) {
  const feed = String(item?.feedName || '').trim();
  if (data?.mode === 'papers') {
    const family = data.family || '論文';
    return `論文:${family.replace(/・/g, '')}`;
  }
  if (data?.mode === 'knowledge') return feed ? `知識:${feed}` : '知識';
  if (data?.mode === 'news') return feed ? `ニュース:${feed}` : 'ニュース';
  return fallback.category || 'おすすめ';
}

function sourceInitials(source) {
  const text = String(source || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'R';
  const asciiWords = text.match(/[A-Za-z0-9]+/g) || [];
  if (asciiWords.length >= 2) return `${asciiWords[0][0]}${asciiWords[1][0]}`.toUpperCase();
  if (asciiWords.length === 1 && asciiWords[0].length >= 2) return asciiWords[0].slice(0, 2).toUpperCase();
  return Array.from(text.replace(/[\s・:：]/g, '')).slice(0, 1).join('') || 'R';
}

function createLogo(source, originalImage) {
  const wrap = document.createElement('div');
  wrap.className = 'reader-v21420-source-logo';

  if (originalImage instanceof HTMLImageElement && (originalImage.currentSrc || originalImage.src)) {
    const img = originalImage.cloneNode(true);
    img.removeAttribute('width');
    img.removeAttribute('height');
    img.className = 'reader-v21420-source-logo-image';
    img.alt = '';
    img.loading = 'eager';
    img.addEventListener('error', () => {
      img.remove();
      wrap.dataset.fallback = sourceInitials(source);
    }, { once: true });
    wrap.append(img);
  } else {
    wrap.dataset.fallback = sourceInitials(source);
  }
  return wrap;
}

function createHero(card, data) {
  const fallback = fallbackMeta(card);
  const item = data?.item;
  const source = item?.source || fallback.source || item?.feedName || '配信元';
  const updated = item?.pubDate ? formatUpdated(item.pubDate) : fallback.updated;
  const category = categoryLabel(data, item, fallback);

  const hero = document.createElement('section');
  hero.className = 'reader-v21420-hero';
  hero.setAttribute('aria-label', '記事情報');

  const mesh = document.createElement('div');
  mesh.className = 'reader-v21420-mesh';
  mesh.setAttribute('aria-hidden', 'true');

  const top = document.createElement('div');
  top.className = 'reader-v21420-hero-top';

  const identity = document.createElement('div');
  identity.className = 'reader-v21420-source-identity';
  identity.append(createLogo(source, fallback.logo));

  const sourceText = document.createElement('div');
  sourceText.className = 'reader-v21420-source-text';

  const sourceName = document.createElement('div');
  sourceName.className = 'reader-v21420-source-name';
  sourceName.textContent = source;

  const time = document.createElement('div');
  time.className = 'reader-v21420-updated';
  time.textContent = updated;

  sourceText.append(sourceName, time);
  identity.append(sourceText);
  top.append(identity);

  const badge = document.createElement('div');
  badge.className = 'reader-v21420-category-badge';
  badge.textContent = category;

  hero.append(mesh, top, badge);
  return hero;
}

function ensureBento(card, hero) {
  const grid = card.querySelector('.reader-story-grid');
  const top = hero?.querySelector('.reader-v21420-hero-top');
  if (!grid || !top || grid.parentElement === top) return;
  top.append(grid);
}

function ensureFooter(card) {
  let footer = card.querySelector(':scope > .reader-v21420-action-footer');
  if (!footer) {
    footer = document.createElement('footer');
    footer.className = 'reader-v21420-action-footer';
    card.append(footer);
  }

  const open = card.querySelector('.reader-story-open');
  if (open && open.parentElement !== footer) footer.append(open);
  if (open) {
    open.classList.add('reader-v21420-open');
    if (!open.dataset.v21420Label) {
      open.dataset.v21420Label = '1';
      open.textContent = '元記事を読む ↗';
    }
  }
}

const IMPORTANT_RE = /(?:[+＋\-−]?\d[\d,.]*(?:\.\d+)?\s*(?:%|％|倍|兆円|億円|万円|円|ドル|人|件|台|社|年|か月|ヶ月|日|時間|分|秒|nm|μm|mm|cm|km|℃|°C|GW|MW|kW|GWh|MWh|kWh|Wh|TB|GB|MB)|世界初|国内初|業界初|史上初|世界最大|国内最大|世界最小|国内最小|過去最高|過去最低|最高値|最安値|初めて|新記録|首位|No\.?\s*1|突破|倍増|半減)/giu;

function highlightSummary(node) {
  if (!(node instanceof HTMLElement)) return;
  const plain = String(node.textContent || '').replace(/\s+/g, ' ').trim();
  if (!plain) return;
  if (node.getAttribute(HIGHLIGHT_SOURCE) === plain && node.querySelector('.reader-v21420-keyword')) return;

  IMPORTANT_RE.lastIndex = 0;
  const matches = [...plain.matchAll(IMPORTANT_RE)];
  if (!matches.length) {
    node.setAttribute(HIGHLIGHT_SOURCE, plain);
    return;
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  matches.forEach(match => {
    const index = match.index ?? 0;
    if (index > cursor) fragment.append(document.createTextNode(plain.slice(cursor, index)));
    const strong = document.createElement('strong');
    strong.className = 'reader-v21420-keyword';
    strong.textContent = match[0];
    fragment.append(strong);
    cursor = index + match[0].length;
  });
  if (cursor < plain.length) fragment.append(document.createTextNode(plain.slice(cursor)));

  node.replaceChildren(fragment);
  node.setAttribute(HIGHLIGHT_SOURCE, plain);
}

function patchCard(card, index) {
  if (!(card instanceof HTMLElement)) return;
  const data = index.get(String(card.dataset.key || ''));

  let hero = card.querySelector(':scope > .reader-v21420-hero');
  if (!hero) {
    hero = createHero(card, data);
    card.prepend(hero);
  }

  // v2.14.19 patch can move the Bento button after this patch ran.
  // Always reclaim it into the v2.14.20 hero.
  ensureBento(card, hero);
  ensureFooter(card);

  card.querySelectorAll('.reader-story-summary-text').forEach(highlightSummary);
  card.setAttribute(PATCHED, BUILD);
}

let scheduled = false;
function apply() {
  scheduled = false;
  const index = readerIndex();
  document.querySelectorAll(CARD_SELECTOR).forEach(card => patchCard(card, index));
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

window.addEventListener('pdv2:booted', schedule);
window.addEventListener('pdv2:before-navigate', schedule);
schedule();
