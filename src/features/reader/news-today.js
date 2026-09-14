import { el } from '../../shared/dom.js';
import { mountFocus } from './reader-focus.js';
import { readRecommendationSnapshot, refreshRecommendationSnapshot } from './reader-recommendations.js';

const STYLE_ID = 'pdv2-news-today-style';
let activeFocus = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  .news-today-screen{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
  .news-today-screen>.nt-focus-host{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;min-height:0!important;margin:0!important;padding:0!important}
  .news-today-screen .reader-swipe-feed,.news-today-screen .reader-swipe-card{height:100dvh!important;min-height:100dvh!important}
  .news-today-screen .reader-story-grid{display:none!important}
  .nt-reader-empty{height:100%;display:grid;place-items:center;padding:32px;text-align:center;color:var(--muted);background:var(--bg)}
  .nt-reader-empty strong{display:block;color:var(--text);font-size:17px}.nt-reader-empty small{display:block;margin-top:7px}.nt-reader-empty button{margin-top:18px;padding:10px 16px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);color:var(--text)}
  body:has(.news-today-screen) #bottom-nav,body:has(.news-today-screen) #edge-frame{display:none!important}
  `;
  document.head.append(style);
}
function itemTimestamp(item = {}) {
  for (const value of [item.googlePublishedTimestamp, item.publishedTimestamp, item.effectivePublishedTimestamp, item.sourcePublishedTimestamp]) {
    const n = Number(value || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const parsed = new Date(item.pubDate || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function latestItems(snapshot) {
  return [...(snapshot?.items || [])].sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
}
function ageMinutes(timestamp) {
  const value = Number(timestamp || 0);
  return Number.isFinite(value) && value > 0 ? Math.max(0, Math.round((Date.now() - value) / 60000)) : null;
}
function removeNewsBento(host) {
  host.querySelectorAll('.reader-story-grid').forEach(button => button.remove());
}

export async function renderNewsToday(root, { navigate, openId = '' }) {
  ensureStyles();
  activeFocus?.destroy?.();
  activeFocus = null;
  let disposed = false;
  let hiddenAt = 0;
  let lastForcedAt = 0;
  let snapshot = readRecommendationSnapshot();

  const screen = el('section', { class: 'screen reader-screen news-today-screen reader-focus-open reader-article-open' });
  const host = el('div', { class: 'reader-content-host nt-focus-host' });
  screen.append(host);
  root.replaceChildren(screen);

  const show = (nextSnapshot, preferredId = openId) => {
    if (disposed) return false;
    const items = latestItems(nextSnapshot);
    if (!items.length) {
      activeFocus?.destroy?.();
      activeFocus = null;
      const back = el('button', { type: 'button', text: 'ホームへ戻る', onclick: () => navigate('home', { source: 'news-empty-back' }) });
      host.replaceChildren(el('div', { class: 'nt-reader-empty' }, [el('div', {}, [
        el('strong', { text: '表示できるニュースがありません' }),
        el('small', { text: 'ニュース取得後にもう一度開いてください。' }),
        back
      ])]));
      return false;
    }
    const requested = preferredId ? items.findIndex(item => String(item?.id || '') === String(preferredId)) : -1;
    const initialIndex = requested >= 0 ? requested : 0;
    activeFocus?.destroy?.();
    activeFocus = mountFocus(host, {
      items,
      initialIndex,
      label: '最新ニュース',
      summaryMode: 'news',
      onIndexChange: () => {}
    });
    removeNewsBento(host);
    return true;
  };

  show(snapshot);
  const applySnapshot = next => {
    if (disposed || !next?.items?.length) return;
    const previousAt = Number(snapshot?.at || 0);
    const nextAt = Number(next?.at || 0);
    const previousItems = latestItems(snapshot);
    const nextItems = latestItems(next);
    const previousCount = previousItems.length;
    const nextCount = nextItems.length;
    if (nextAt && nextAt === previousAt && nextCount === previousCount) return;

    const currentIndex = Number(activeFocus?.getIndex?.() || 0);
    const currentId = String(activeFocus?.getItem?.()?.id || openId || '');
    // Preserve the current article only when the user is actually away from the first card.
    // A Home openId that pointed at the old first card must not pin the reader there after newer items arrive.
    // Opening Home's second/third card starts at index > 0, so those explicit selections are still preserved.
    const preserveCurrent = currentIndex > 0 && Boolean(currentId);
    const diagnostics = {
      previousAt,
      nextAt,
      previousCount,
      nextCount,
      previousNewestId: String(previousItems[0]?.id || ''),
      nextNewestId: String(nextItems[0]?.id || ''),
      previousNewestAgeMinutes: ageMinutes(itemTimestamp(previousItems[0])),
      nextNewestAgeMinutes: ageMinutes(itemTimestamp(nextItems[0])),
      currentIndex,
      currentId,
      requestedOpenId: String(openId || ''),
      preserveCurrent,
      movedToLatest: !preserveCurrent
    };
    console.info('[recommendations:client-apply]', diagnostics);
    globalThis.__PDV2_LAST_RECOMMENDATION_CLIENT_APPLY = { ...diagnostics, at: Date.now() };

    snapshot = next;
    show(snapshot, preserveCurrent ? currentId : '');
  };
  const onUpdated = event => applySnapshot(event.detail);
  const refresh = (force = false) => {
    if (force) {
      const now = Date.now();
      if (now - lastForcedAt < 5000) return Promise.resolve(snapshot);
      lastForcedAt = now;
    }
    return refreshRecommendationSnapshot({ force }).then(applySnapshot).catch(() => {});
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now();
      return;
    }
    const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (awayMs >= 60 * 1000) refresh(true);
  };
  const onNavigate = () => {
    disposed = true;
    activeFocus?.destroy?.();
    activeFocus = null;
    window.removeEventListener('pdv2:recommendations-updated', onUpdated);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pdv2:before-navigate', onNavigate);
  };

  window.addEventListener('pdv2:recommendations-updated', onUpdated);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  // Show cache immediately, then always force one real network refresh on entry.
  requestAnimationFrame(() => requestAnimationFrame(() => refresh(true)));
}
