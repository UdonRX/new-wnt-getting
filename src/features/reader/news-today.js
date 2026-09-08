import { el } from '../../shared/dom.js';
import { mountFocus } from './reader-focus.js';
import { readRecommendationSnapshot, refreshRecommendationSnapshot } from './reader-recommendations.js';

const STYLE_ID = 'pdv2-news-today-style';
let activeFocus = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = `
  .news-today-screen{display:grid;gap:12px}.nt-header{position:sticky;top:calc(env(safe-area-inset-top) + 2px);z-index:24;display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:8px;min-height:50px;padding:3px 0;background:linear-gradient(var(--bg) 80%,transparent)}.nt-header button{width:44px;height:44px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line);font-size:20px}.nt-header-copy{text-align:center;min-width:0}.nt-header-copy strong{display:block;font-size:17px}.nt-header-copy small{display:block;color:var(--muted);font-size:10px;margin-top:2px}.nt-header-spacer{width:44px}
  .nt-list{display:grid;gap:20px;padding:2px 0 10px}.nt-card{width:100%;padding:0;text-align:left;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:27px;overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.08);content-visibility:auto;contain-intrinsic-size:310px}.nt-card:active{transform:scale(.994)}.nt-media{position:relative;width:100%;aspect-ratio:16/9;background:linear-gradient(145deg,color-mix(in srgb,var(--feature-color) 16%,var(--surface-2)),var(--surface-2));overflow:hidden}.nt-card:first-child .nt-media{aspect-ratio:1.5}.nt-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.nt-media-fallback{position:absolute;inset:0;display:grid;place-items:center;padding:18px;color:color-mix(in srgb,var(--feature-color) 70%,var(--text));font-size:15px;font-weight:800;text-align:center}.nt-copy{padding:14px 15px 16px}.nt-meta{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden}.nt-category{max-width:42%;overflow:hidden;text-overflow:ellipsis;color:color-mix(in srgb,var(--feature-color) 72%,var(--text));font-weight:780}.nt-source{overflow:hidden;text-overflow:ellipsis}.nt-time{margin-left:auto}.nt-title{margin:8px 0 0;font-size:19px;line-height:1.32;letter-spacing:-.02em;font-weight:790;text-wrap:pretty}.nt-card:first-child .nt-title{font-size:23px}.nt-empty{padding:42px 14px;text-align:center;color:var(--muted);border:1px solid var(--line);border-radius:24px;background:var(--surface)}.nt-refresh-note{padding:3px 2px 8px;text-align:center;color:var(--muted);font-size:9px}
  .news-today-screen.reader-focus-open{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}.news-today-screen.reader-focus-open>.nt-header{display:none}.news-today-screen.reader-focus-open>.nt-list-host{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;min-height:0!important;margin:0!important;padding:0!important}.news-today-screen.reader-focus-open .nt-list{display:none}.news-today-screen.reader-focus-open .reader-swipe-feed,.news-today-screen.reader-focus-open .reader-swipe-card{height:100dvh!important;min-height:100dvh!important}body:has(.news-today-screen.reader-focus-open) #bottom-nav,body:has(.news-today-screen.reader-focus-open) #edge-frame{display:none!important}
  @media(max-width:390px){.nt-list{gap:17px}.nt-copy{padding-inline:13px}.nt-title{font-size:18px}.nt-card:first-child .nt-title{font-size:21px}}
  `; document.head.append(style);
}
function itemTimestamp(item = {}) {
  for (const value of [item.effectivePublishedTimestamp, item.sourcePublishedTimestamp, item.publishedTimestamp]) { const n = Number(value || 0); if (Number.isFinite(n) && n > 0) return n; }
  const parsed = new Date(item.pubDate || 0).getTime(); return Number.isFinite(parsed) ? parsed : 0;
}
function relativeTime(item) {
  const stamp = itemTimestamp(item); if (!stamp) return '';
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 60) return `${minutes || 1}分前`;
  const hours = Math.floor(minutes / 60); return `${hours}時間前`;
}
function categoryOf(item) { return String(item?.importance || item?._recommendationLabel || 'ニュース').replace(/ニュース$/, '') || 'ニュース'; }
function renderList(host, snapshot, open) {
  const items = snapshot?.items || [];
  if (!items.length) { host.innerHTML = '<div class="nt-empty">保存済みの12時間ニュースがありません。<br><small>取得に成功するとここへ保存されます。</small></div>'; return; }
  const list = el('div', { class: 'nt-list' });
  items.forEach((item, index) => {
    const card = el('button', { class: 'nt-card', type: 'button', 'aria-label': `${item.title || 'ニュース'}を開く` });
    const media = el('div', { class: 'nt-media' }), fallback = el('div', { class: 'nt-media-fallback', text: item.source || categoryOf(item) });
    if (item.image) {
      const image = el('img', { src: item.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      image.addEventListener('error', () => { image.remove(); if (!fallback.isConnected) media.append(fallback); }, { once: true }); media.append(image);
    } else media.append(fallback);
    const copy = el('div', { class: 'nt-copy' });
    copy.innerHTML = `<div class="nt-meta"><span class="nt-category">${categoryOf(item)}</span><span class="nt-source"></span><span class="nt-time">${relativeTime(item)}</span></div><h2 class="nt-title"></h2>`;
    copy.querySelector('.nt-source').textContent = item.source || '';
    copy.querySelector('.nt-title').textContent = item.title || '無題';
    card.append(media, copy); card.onclick = () => open(item, index, items); list.append(card);
  });
  host.replaceChildren(list, el('div', { class: 'nt-refresh-note', text: snapshot.stale ? '保存済みニュースを表示中。更新は裏で行います。' : '12時間以内のおすすめニュース' }));
}

export async function renderNewsToday(root, { navigate, openId = '' }) {
  ensureStyles(); activeFocus?.destroy?.(); activeFocus = null;
  let disposed = false, snapshot = readRecommendationSnapshot();
  const screen = el('section', { class: 'screen reader-screen news-today-screen' });
  const header = el('div', { class: 'nt-header' });
  header.innerHTML = `<button type="button" aria-label="ホームへ戻る">‹</button><div class="nt-header-copy"><strong>ニュース</strong><small>${snapshot?.items?.length || 0}件・12時間以内</small></div><span class="nt-header-spacer"></span>`;
  header.querySelector('button').onclick = () => navigate('home', { source: 'news-today-back' });
  const host = el('div', { class: 'reader-content-host nt-list-host' }); screen.append(header, host); root.replaceChildren(screen);
  const open = (item, index, items) => {
    if (disposed) return;
    screen.classList.add('reader-focus-open', 'reader-article-open'); window.scrollTo({ top: 0, behavior: 'auto' }); activeFocus?.destroy?.();
    activeFocus = mountFocus(host, {
      items, initialIndex: index, label: '12時間以内', summaryMode: 'news',
      onList: () => { activeFocus?.destroy?.(); activeFocus = null; screen.classList.remove('reader-focus-open', 'reader-article-open'); snapshot = readRecommendationSnapshot() || snapshot; renderList(host, snapshot, open); },
      onIndexChange: () => {}
    });
  };
  renderList(host, snapshot, open);
  if (openId && snapshot?.items?.length) {
    const index = snapshot.items.findIndex(item => String(item.id) === String(openId));
    // Paint the requested article detail before this renderer resolves. AI summary work remains asynchronous.
    if (index >= 0) open(snapshot.items[index], index, snapshot.items);
  }
  const applySnapshot = next => {
    if (disposed || !next?.items?.length) return; snapshot = next;
    const small = header.querySelector('small'); if (small) small.textContent = `${next.items.length}件・12時間以内`;
    if (!screen.classList.contains('reader-focus-open')) renderList(host, snapshot, open);
  };
  const onUpdated = event => applySnapshot(event.detail);
  const refresh = () => refreshRecommendationSnapshot().then(applySnapshot).catch(() => {});
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  const onNavigate = () => { disposed = true; activeFocus?.destroy?.(); activeFocus = null; window.removeEventListener('pdv2:recommendations-updated', onUpdated); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pdv2:before-navigate', onNavigate); };
  window.addEventListener('pdv2:recommendations-updated', onUpdated); document.addEventListener('visibilitychange', onVisible); window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  requestAnimationFrame(() => requestAnimationFrame(refresh));
}
