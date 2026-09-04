import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { todayLabel } from '../../shared/time.js';

function parseCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function changedCount(mode, lastVisit) {
  const cache = parseCache(`pdv2:readerCache:${mode}`);
  return (cache?.items || []).filter(item => new Date(item.pubDate).getTime() > lastVisit).length;
}

function paperChangedCounts(lastVisit) {
  const result = { core: 0, creative: 0, applied: 0, general: 0, total: 0 };
  const seen = new Set();
  for (const track of ['core', 'creative']) {
    let cache = parseCache(`pdv2:readerCache:papers:${track}`);
    if (!cache && track === 'core') cache = parseCache('pdv2:readerCache:papers');
    for (const item of cache?.items || []) {
      const id = item.id || item.link || item.title;
      if (!id || seen.has(id) || new Date(item.pubDate).getTime() <= lastVisit) continue;
      seen.add(id);
      result[track] += 1;
      result.total += 1;
      if (track === 'creative') {
        const description = String(item.description || '');
        const isGeneral = /独創区分:\s*[^\n]*一般独創/i.test(description);
        const isApplied = /独創区分:\s*[^\n]*応用発想/i.test(description) || !/独創区分:/i.test(description);
        if (isGeneral) result.general += 1;
        if (isApplied) result.applied += 1;
      }
    }
  }
  return result;
}

function tile(icon, label, value, detail, screen, navigate, color, options = {}) {
  const button = el('button', {
    class: 'change-tile',
    type: 'button',
    'aria-label': `${label}を開く`,
    onclick: () => navigate(screen, options)
  });
  button.style.setProperty('--tile-color', color);
  const head = el('div', { class: 'change-tile-head' });
  head.innerHTML = `<span class="change-tile-icon">${iconSvg(icon, { size: 22 })}</span>`;
  const copy = el('div', { class: 'change-tile-copy' });
  copy.append(
    el('div', { class: 'change-tile-label', text: label }),
    el('strong', { text: value }),
    el('small', { text: detail })
  );
  button.append(head, copy);
  return button;
}

export async function renderHome(root, { navigate }) {
  const lastVisit = Number(localStorage.getItem('pdv2:lastVisitMs') || 0);
  const now = Date.now();
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'おはよう' : hour < 18 ? 'こんにちは' : 'こんばんは';

  const yt = parseCache('pdv2:youtubeCache');
  const tw = parseCache('pdv2:twitchCache');
  const live = (tw?.rows || []).filter(row => row.live?.isLive).length;
  const youtubeNew = (yt?.rows || []).flatMap(row => row.items || [])
    .filter(item => new Date(item.publishedAt).getTime() > lastVisit).length;
  const newsNew = changedCount('news', lastVisit);
  const knowledgeNew = changedCount('knowledge', lastVisit);
  const papers = paperChangedCounts(lastVisit);

  const paperParts = [];
  if (papers.core) paperParts.push(`製品・熱 ${papers.core}件`);
  if (papers.applied) paperParts.push(`応用 ${papers.applied}件`);
  if (papers.general) paperParts.push(`一般 ${papers.general}件`);
  const paperDetail = paperParts.length ? paperParts.join(' / ') : '製品・熱・応用発想・一般独創';

  const screen = el('section', { class: 'screen home-screen' });
  const header = topbar('ホーム', {
    subtitle: todayLabel(),
    actions: [
      { html: iconSvg('plus', { size: 20 }), title: '追加・編集', onClick: () => navigate('settings') },
      { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  });
  header.classList.add('shrink-header', 'home-shrink-header');
  screen.append(header);

  const hero = el('div', { class: 'home-hero' });
  hero.append(
    el('div', { class: 'home-greeting', text: greeting }),
    el('div', { class: 'home-copy', text: '気になる情報を、すぐに確認できます。' })
  );

  const colors = state.settings.colors;
  const grid = el('div', { class: 'change-grid' });
  grid.append(
    tile('weather', '天気', '今日の予報', '現在・時間別・週間', 'weather', navigate, colors.weather),
    tile('news', 'ニュース', newsNew ? `新着 ${newsNew}件` : '注目ニュース', '記事一覧', 'reader', navigate, colors.news || colors.reader, { readerMode: 'news' }),
    tile('knowledge', '知識', knowledgeNew ? `新着 ${knowledgeNew}件` : 'おすすめ記事', '記事一覧', 'reader', navigate, colors.knowledge || colors.reader, { readerMode: 'knowledge' }),
    tile('papers', '論文', papers.total ? `新着 ${papers.total}件` : '注目論文', paperDetail, 'reader', navigate, colors.papers || colors.reader, { readerMode: 'papers', paperTrack: state.paperTrack || 'core' }),
    tile('wikipedia', 'Wikipedia', '今日の10本', '王道・考察・雑学を縦書きで', 'wikipedia', navigate, colors.wikipedia || '#c89b5b'),
    tile('youtube', 'YouTube', youtubeNew ? `新着 ${youtubeNew}件` : '新着動画', '動画・Shorts・LIVE', 'media', navigate, colors.youtube, { mediaMode: 'youtube' }),
    tile('twitch', 'Twitch', live ? `${live}件 配信中` : 'アーカイブ', 'LIVE・アーカイブ', 'media', navigate, colors.twitch, { mediaMode: 'twitch' }),
    tile('twitter', 'X', '最新ポスト', 'タイムライン', 'twitter', navigate, colors.twitter)
  );
  hero.append(grid);
  screen.append(hero);
  root.replaceChildren(screen);
  installShrinkingHeader(header, { threshold: 34 });
  localStorage.setItem('pdv2:lastVisitMs', String(now));
}
