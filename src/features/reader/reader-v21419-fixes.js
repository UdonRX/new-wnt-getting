/*
 * Personal Dashboard v2.14.19
 * Reader recommendation presentation patch.
 *
 * - Reader modern implementation already enters the mixed recommendation feed on first entry.
 * - Removes old "5件" copy left in Home/legacy Reader markup.
 * - Rebuilds recommendation-card metadata from Reader caches so the upper ~30% shows:
 *     TAB / SOURCE / UPDATED
 * - Does not change registered feeds or article data.
 */

const BUILD = '21419';
const CARD_SELECTOR = '.reader-story-card';
const PATCHED = 'data-v21419-meta';

const COPY_REPLACEMENTS = new Map([
  ['いま押さえる5件', '新着からおすすめ'],
  ['今押さえる5件', '新着からおすすめ'],
  ['いま読む5件', '新着からおすすめ'],
  ['今読む5件', '新着からおすすめ'],
  ['おすすめ5件・全記事', 'おすすめ・全記事'],
  ['おすすめ5件・全記事', 'おすすめ・全記事'],
  ['注目5件と全記事', 'おすすめ・全記事'],
  ['注目5件・全記事', 'おすすめ・全記事']
]);

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
      let tab = mode === 'knowledge' ? '知識' : mode === 'news' ? 'ニュース' : '論文';
      if (mode === 'papers') tab = track === 'creative' ? creativeFamily(item) : '製品・熱研究';
      map.set(id, { item, mode, track, tab });
    });
  };
  add('pdv2:readerCache:news', 'news');
  add('pdv2:readerCache:knowledge', 'knowledge');
  add('pdv2:readerCache:papers:core', 'papers', 'core');
  add('pdv2:readerCache:papers:creative', 'papers', 'creative');
  // 旧キャッシュとの互換
  add('pdv2:readerCache:papers', 'papers', 'core');
  return map;
}

function formatUpdated(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '更新日時不明';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  } catch {
    return date.toLocaleString('ja-JP');
  }
}

function fallbackMeta(card) {
  const old = card.querySelector('.reader-story-header');
  const category = old?.querySelector('.reader-story-category-badge')?.textContent?.trim() || 'おすすめ';
  const source = old?.querySelector('.reader-story-source-name')?.textContent?.trim() || '配信元';
  const updated = old?.querySelector('.reader-story-time')?.textContent?.trim() || '更新日時不明';
  return { tab: category.replace(/^論文:/, ''), source, updated };
}

function field(label, value, className = '') {
  const row = document.createElement('div');
  row.className = `reader-v21419-meta-field ${className}`.trim();
  const key = document.createElement('span');
  key.className = 'reader-v21419-meta-key';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = 'reader-v21419-meta-value';
  val.textContent = value || '—';
  row.append(key, val);
  return row;
}

function patchCard(card, index) {
  if (!(card instanceof HTMLElement) || card.hasAttribute(PATCHED)) return;

  const data = index.get(String(card.dataset.key || ''));
  const fallback = fallbackMeta(card);
  const item = data?.item;
  const tab = item?.feedName || data?.tab || fallback.tab;
  const source = item?.source || fallback.source || item?.feedName || '配信元';
  const updated = item?.pubDate ? formatUpdated(item.pubDate) : fallback.updated;

  const panel = document.createElement('section');
  panel.className = 'reader-v21419-meta-panel';
  panel.setAttribute('aria-label', '記事情報');

  const top = document.createElement('div');
  top.className = 'reader-v21419-meta-top';
  top.append(field('TAB', tab, 'is-tab'));

  // 既存の「記事一覧」ボタンはイベントリスナーごと移動する。
  const grid = card.querySelector('.reader-story-grid');
  if (grid) top.append(grid);

  const details = document.createElement('div');
  details.className = 'reader-v21419-meta-details';
  details.append(
    field('SOURCE', source, 'is-source'),
    field('UPDATED', updated, 'is-updated')
  );

  panel.append(top, details);
  card.prepend(panel);
  card.setAttribute(PATCHED, BUILD);
}

function replaceLegacyFiveCopy(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  targets.forEach(node => {
    let text = node.nodeValue || '';
    let next = text;
    COPY_REPLACEMENTS.forEach((to, from) => { next = next.split(from).join(to); });
    // 文章中に残った「今押さえる/今読む 5件」も固定5件表現だけ落とす。
    next = next
      .replace(/今押さえる\s*5件/g, '新着からおすすめ')
      .replace(/今読む\s*5件/g, '新着からおすすめ')
      .replace(/いま押さえる\s*5件/g, '新着からおすすめ')
      .replace(/いま読む\s*5件/g, '新着からおすすめ');
    if (next !== text) node.nodeValue = next;
  });
}

let scheduled = false;
function apply() {
  scheduled = false;
  replaceLegacyFiveCopy();
  const index = readerIndex();
  document.querySelectorAll(CARD_SELECTOR).forEach(card => patchCard(card, index));
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
window.addEventListener('pdv2:booted', schedule);
window.addEventListener('pdv2:before-navigate', schedule);
schedule();
