import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { todayLabel } from '../../shared/time.js';

function parseCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function changedCount(mode, lastVisit) {
  const cache = parseCache(`pdv2:readerCache:${mode}`);
  return (cache?.items || []).filter(i => new Date(i.pubDate).getTime() > lastVisit).length;
}

function paperChangedCounts(lastVisit) {
  const result = { core: 0, creative: 0, applied: 0, general: 0, total: 0 };
  const seen = new Set();
  for (const track of ['core', 'creative']) {
    let cache = parseCache(`pdv2:readerCache:papers:${track}`);
    if (!cache && track === 'core') cache = parseCache('pdv2:readerCache:papers');
    for (const item of cache?.items || []) {
      const id = item.id || item.link || item.title;
      if (!id || seen.has(id)) continue;
      if (new Date(item.pubDate).getTime() <= lastVisit) continue;
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
    onclick: () => navigate(screen, options)
  });
  button.style.setProperty('--tile-color', color);
  button.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px"><span style="font-size:24px">${icon}</span><span class="tile-dot" style="background:${color};box-shadow:0 0 12px ${color}"></span></div><div><strong>${value}</strong><div>${label}</div><small>${detail}</small></div>`;
  return button;
}

export async function renderHome(root, { navigate }) {
  const lastVisit = Number(localStorage.getItem('pdv2:lastVisitMs') || 0);
  const now = Date.now();
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'おはよう' : hour < 18 ? 'こんにちは' : 'こんばんは';
  const yt = parseCache('pdv2:youtubeCache');
  const tw = parseCache('pdv2:twitchCache');
  const live = (tw?.rows || []).filter(x => x.live?.isLive).length;
  const youtubeNew = (yt?.rows || []).flatMap(x => x.items || []).filter(x => new Date(x.publishedAt).getTime() > lastVisit).length;
  const papers = paperChangedCounts(lastVisit);

  const creativeParts = [];
  if (papers.general) creativeParts.push(`一般 +${papers.general}`);
  if (papers.applied) creativeParts.push(`応用 +${papers.applied}`);
  if (papers.core) creativeParts.push(`製品 +${papers.core}`);
  const paperDetail = creativeParts.length
    ? creativeParts.join(' / ')
    : '製品・熱 ＋ 応用発想 ＋ 一般独創';

  const screen = el('section', { class: 'screen' });
  screen.append(topbar('ホーム', {
    subtitle: todayLabel(),
    actions: [{ label: '⚙︎', title: '設定', onClick: () => navigate('settings') }]
  }));

  const hero = el('div', { class: 'home-hero' });
  hero.append(
    el('div', { class: 'home-greeting', text: greeting }),
    el('div', { class: 'home-copy', text: '前回から変わったところだけ、すぐ確認できます。' })
  );

  const grid = el('div', { class: 'change-grid' });
  const colors = state.settings.colors;
  grid.append(
    tile('☁️', '天気', '確認', '1時間予報・今日のポイント', 'weather', navigate, colors.weather),
    tile('📰', 'ニュース', changedCount('news', lastVisit) ? `+${changedCount('news', lastVisit)}` : '開く', 'いま押さえる5件', 'reader', navigate, colors.news || colors.reader, { readerMode: 'news' }),
    tile('📚', '知識', changedCount('knowledge', lastVisit) ? `+${changedCount('knowledge', lastVisit)}` : '開く', 'いま読む5件', 'reader', navigate, colors.knowledge || colors.reader, { readerMode: 'knowledge' }),
    tile('📄', '論文', papers.total ? `+${papers.total}` : '開く', paperDetail, 'reader', navigate, colors.papers || colors.reader, { readerMode: 'papers', paperTrack: state.paperTrack || 'core' }),
    tile('▶️', 'YouTube', youtubeNew ? `+${youtubeNew}` : '開く', '動画・Shorts・LIVE', 'media', navigate, colors.youtube, { mediaMode: 'youtube' }),
    tile('🔴', 'Twitch', live ? `${live} LIVE` : '確認', '配信中・アーカイブ', 'media', navigate, colors.twitch, { mediaMode: 'twitch' }),
    tile('💬', 'SNS', '開く', 'Twitter / X リスト', 'twitter', navigate, colors.twitter)
  );

  hero.append(grid);
  screen.append(hero);
  root.replaceChildren(screen);
  localStorage.setItem('pdv2:lastVisitMs', String(now));
}
