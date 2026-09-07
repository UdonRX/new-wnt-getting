import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { todayLabel } from '../../shared/time.js';

const WEATHER_TTL = 10 * 60 * 1000;
const STYLE_ID = 'pdv2-home-weather-today-style';
let cleanupHome = () => {};

function parseCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function changedCount(mode, lastVisit) {
  return (parseCache(`pdv2:readerCache:${mode}`)?.items || [])
    .filter(item => new Date(item.pubDate).getTime() > lastVisit).length;
}

function paperChangedCounts(lastVisit) {
  const result = { core: 0, applied: 0, general: 0, total: 0 };
  const seen = new Set();
  for (const track of ['core', 'creative']) {
    let cache = parseCache(`pdv2:readerCache:papers:${track}`);
    if (!cache && track === 'core') cache = parseCache('pdv2:readerCache:papers');
    for (const item of cache?.items || []) {
      const id = item.id || item.link || item.title;
      if (!id || seen.has(id) || new Date(item.pubDate).getTime() <= lastVisit) continue;
      seen.add(id); result.total += 1;
      if (track === 'core') result.core += 1;
      else {
        const description = String(item.description || '');
        if (/独創区分:\s*[^\n]*一般独創/i.test(description)) result.general += 1;
        if (/独創区分:\s*[^\n]*応用発想/i.test(description) || !/独創区分:/i.test(description)) result.applied += 1;
      }
    }
  }
  return result;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #app-main:has(.home-screen){background:radial-gradient(100% 40% at 10% 0,color-mix(in srgb,var(--home-accent) 14%,transparent),transparent 72%),var(--bg)}
    .home-screen{--home-accent:#8398aa;--home-accent2:#b1bcc5;--home-deep:#22303a;display:grid;gap:20px}
    .home-screen[data-wx="sunny"]{--home-accent:#ff9c77;--home-accent2:#ffc18f;--home-deep:#44261f}
    .home-screen[data-wx="cloudy"]{--home-accent:#8398aa;--home-accent2:#b1bcc5;--home-deep:#22303a}
    .home-screen[data-wx="rain"]{--home-accent:#4e9bdb;--home-accent2:#76c4e9;--home-deep:#14334d}
    .home-screen[data-wx="snow"]{--home-accent:#a9d5e6;--home-accent2:#d8eef5;--home-deep:#274454}
    .home-screen[data-wx="night"]{--home-accent:#5669bd;--home-accent2:#7868bf;--home-deep:#181c43}
    .home-today{display:grid;gap:20px}.home-card-group{display:grid;gap:11px}
    .home-weather-card{width:100%;min-height:254px;padding:19px 17px 14px;border:1px solid color-mix(in srgb,var(--home-accent2) 26%,var(--line));border-radius:30px;text-align:left;color:#f8fbff;background:radial-gradient(80% 105% at 90% -10%,color-mix(in srgb,var(--home-accent2) 48%,transparent),transparent 66%),linear-gradient(145deg,color-mix(in srgb,var(--home-accent) 68%,var(--home-deep)),var(--home-deep));box-shadow:0 14px 36px rgba(0,0,0,.14);overflow:hidden;contain:paint;cursor:pointer}
    .home-weather-card:active,.home-screen .change-tile:active{transform:scale(.992)}
    .home-weather-top{display:flex;justify-content:space-between;align-items:start;gap:12px}.home-weather-location{font-size:15px;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.home-weather-desc{display:flex;align-items:center;gap:6px;margin-top:6px;color:rgba(255,255,255,.72);font-size:12px;font-weight:650}.home-weather-glyph{font-size:20px;line-height:1}
    .home-weather-current{text-align:right;flex:0 0 auto}.home-weather-current strong{display:block;font-size:49px;font-weight:310;line-height:.92;letter-spacing:-.07em;font-variant-numeric:tabular-nums}.home-weather-current small{display:block;margin-top:7px;color:rgba(255,255,255,.7);font-size:11px;font-weight:650}
    .home-weather-hint{height:18px;margin:11px 0 0;color:rgba(255,255,255,.88);font-size:12px;font-weight:720}.home-weather-chart{margin-top:0}.home-weather-chart svg{display:block;width:100%;height:124px;overflow:visible}.home-weather-line{fill:none;stroke:rgba(255,255,255,.78);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.home-weather-dot{fill:#fff}.home-weather-chart text{fill:rgba(255,255,255,.64);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;text-anchor:middle}.home-weather-chart .wx{fill:#fff;font-size:15px}.home-weather-chart .temp{fill:#fff;font-size:9px;font-weight:750}.home-weather-chart .time{font-size:8px}.home-weather-chart .rain{fill:#d9f3ff;font-size:7px;font-weight:750}.home-weather-more{text-align:right;color:rgba(255,255,255,.58);font-size:10px;font-weight:650}
    .home-weather-empty{display:grid;align-content:center;min-height:154px}.home-weather-empty strong{font-size:17px}.home-weather-empty span{margin-top:5px;color:rgba(255,255,255,.62);font-size:11px}
    .home-screen .change-grid{grid-template-columns:1fr;gap:11px;margin:0}.home-screen .change-tile{--tile-color:var(--home-accent);min-height:88px;padding:14px 15px;display:grid;grid-template-columns:42px minmax(0,1fr) 18px;align-items:center;gap:12px;border-radius:24px;background:linear-gradient(135deg,color-mix(in srgb,var(--home-accent) 9%,var(--surface)),color-mix(in srgb,var(--tile-color) 4%,var(--surface)));contain:content}.home-screen .change-tile-head{width:42px;height:42px;display:grid;place-items:center;border-radius:14px;background:color-mix(in srgb,var(--tile-color) 12%,var(--surface-2));color:color-mix(in srgb,var(--tile-color) 76%,var(--text))}.home-screen .change-tile-copy{min-width:0}.home-screen .change-tile-label{color:var(--muted);font-size:10px;font-weight:750}.home-screen .change-tile strong{display:block;margin-top:2px;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.home-screen .change-tile small{display:block;margin-top:2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.home-tile-arrow{color:color-mix(in srgb,var(--home-accent) 48%,var(--muted));font-size:25px;text-align:right}
    @media(max-width:390px){.home-screen,.home-today{gap:17px}.home-weather-card{min-height:246px;padding-inline:15px}.home-weather-current strong{font-size:45px}}
  `;
  document.head.append(style);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wx(code) {
  const c = Number(code);
  if (c === 0) return ['☀︎', '快晴', 'sunny'];
  if (c <= 2) return ['☀︎', '晴れ', 'sunny'];
  if (c === 3) return ['☁︎', 'くもり', 'cloudy'];
  if ([45, 48].includes(c)) return ['≋', '霧', 'cloudy'];
  if (c >= 51 && c <= 67) return ['☂︎', c <= 57 ? '小雨' : '雨', 'rain'];
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) return ['❄︎', '雪', 'snow'];
  if (c >= 80 && c <= 82) return ['☂︎', 'にわか雨', 'rain'];
  if (c >= 95) return ['⚡︎', '雷雨', 'rain'];
  return ['☁︎', 'くもり', 'cloudy'];
}

function weatherContext() {
  const locations = state.weatherLocations || [];
  if (!locations.length) return {};
  const stored = Number(localStorage.getItem('pdv2:weatherIndex') || 0);
  const index = Number.isFinite(stored) ? Math.max(0, Math.min(locations.length - 1, stored)) : 0;
  const location = locations[index];
  return { location, key: `pdv2:weatherCache:multi-source:${location.lat},${location.lon}` };
}

function hours(model, limit = 8) {
  const h = model?.hourly || {}, times = h.time || [], now = Date.now();
  let start = times.findIndex(time => new Date(time).getTime() >= now - 30 * 60 * 1000);
  if (start < 0) start = 0;
  const rows = [];
  for (let i = start; i < times.length && rows.length < limit; i += 1) {
    const temp = Number(h.temperature_2m?.[i]); if (!Number.isFinite(temp)) continue;
    rows.push({ time: times[i], temp, rain: Math.max(0, Number(h.precipitation?.[i] || 0)), code: h.weather_code?.[i] });
  }
  return rows;
}

function graph(rows) {
  if (rows.length < 2) return '';
  const width = 320, low = Math.min(...rows.map(r => r.temp)), high = Math.max(...rows.map(r => r.temp)), range = Math.max(4, high - low);
  const pts = rows.map((row, i) => ({ ...row, x: i / (rows.length - 1) * width, y: 36 + (high - row.temp) / range * 38 }));
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const nodes = pts.map(p => {
    const [glyph] = wx(p.code), hour = new Date(p.time).getHours();
    return `<text class="wx" x="${p.x}" y="${p.y - 9}">${glyph}</text><circle class="home-weather-dot" cx="${p.x}" cy="${p.y}" r="1.7"/><text class="temp" x="${p.x}" y="${p.y + 13}">${Math.round(p.temp)}°</text><text class="time" x="${p.x}" y="108">${hour}時</text>${p.rain >= .1 ? `<text class="rain" x="${p.x}" y="120">${p.rain.toFixed(1)}mm</text>` : ''}`;
  }).join('');
  return `<div class="home-weather-chart"><svg viewBox="0 0 ${width} 124" preserveAspectRatio="xMidYMid meet" aria-label="数時間先までの気温と天気"><polyline class="home-weather-line" points="${line}"/>${nodes}</svg></div>`;
}

function weatherSignature(location, model) {
  const c = model?.current || {};
  return JSON.stringify([location?.name, c.temperature_2m, c.apparent_temperature, c.weather_code, ...hours(model).flatMap(r => [r.time, r.temp, r.rain, r.code])]);
}

function paintWeather(card, screen, location, model) {
  const signature = weatherSignature(location, model);
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  const c = model?.current || {}, temp = Number(c.temperature_2m), feels = Number(c.apparent_temperature), [glyph, label, kind] = wx(c.weather_code), rows = hours(model);
  screen.dataset.wx = (new Date().getHours() < 6 || new Date().getHours() >= 18) ? 'night' : kind;
  const rainy = rows.find(r => r.rain >= .2);
  const hint = rainy ? (rainy === rows[0] ? 'この先も雨' : `${new Date(rainy.time).getHours()}時ごろから雨`) : '';
  card.innerHTML = `<div class="home-weather-top"><div><div class="home-weather-location">${esc(location?.name || '天気')}</div><div class="home-weather-desc"><span class="home-weather-glyph">${glyph}</span>${label}</div></div><div class="home-weather-current"><strong>${Number.isFinite(temp) ? `${Math.round(temp)}°` : '—°'}</strong><small>${Number.isFinite(feels) ? `体感 ${Math.round(feels)}°` : '体感 —°'}</small></div></div><div class="home-weather-hint">${esc(hint)}</div>${graph(rows)}<div class="home-weather-more">天気を詳しく ›</div>`;
}

function weatherPlaceholder(card, screen, location) {
  screen.dataset.wx = 'cloudy'; card.dataset.signature = 'empty';
  card.innerHTML = `<div class="home-weather-top"><div><div class="home-weather-location">${esc(location?.name || '天気')}</div><div class="home-weather-desc"><span class="home-weather-glyph">☁︎</span>保存済み予報なし</div></div><div class="home-weather-current"><strong>—°</strong><small>体感 —°</small></div></div><div class="home-weather-empty"><strong>予報を更新中</strong><span>ホームはこのまま使えます</span></div><div class="home-weather-more">天気を詳しく ›</div>`;
}

function tile(icon, label, value, detail, screen, navigate, color, options = {}) {
  const button = el('button', { class: 'change-tile', type: 'button', 'aria-label': `${label}を開く`, onclick: () => navigate(screen, options) });
  button.style.setProperty('--tile-color', color);
  const head = el('div', { class: 'change-tile-head' }); head.innerHTML = `<span class="change-tile-icon">${iconSvg(icon, { size: 22 })}</span>`;
  const copy = el('div', { class: 'change-tile-copy' });
  copy.append(el('div', { class: 'change-tile-label', text: label }), el('strong', { text: value }), el('small', { text: detail }));
  button.append(head, copy, el('span', { class: 'home-tile-arrow', text: '›', 'aria-hidden': 'true' }));
  return button;
}

function afterPaint(callback) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 900 }); else setTimeout(callback, 40);
  }));
}

export async function renderHome(root, { navigate, refresh = false }) {
  const started = performance.now(); cleanupHome(); ensureStyles();
  const lastVisit = Number(localStorage.getItem('pdv2:lastVisitMs') || 0), now = Date.now();
  const yt = parseCache('pdv2:youtubeCache'), tw = parseCache('pdv2:twitchCache');
  const live = (tw?.rows || []).filter(row => row.live?.isLive).length;
  const youtubeNew = (yt?.rows || []).flatMap(row => row.items || []).filter(item => new Date(item.publishedAt).getTime() > lastVisit).length;
  const newsNew = changedCount('news', lastVisit), knowledgeNew = changedCount('knowledge', lastVisit), papers = paperChangedCounts(lastVisit);
  const paperParts = []; if (papers.core) paperParts.push(`製品・熱 ${papers.core}件`); if (papers.applied) paperParts.push(`応用 ${papers.applied}件`); if (papers.general) paperParts.push(`一般 ${papers.general}件`);

  const screen = el('section', { class: 'screen home-screen', 'data-wx': 'cloudy' });
  const header = topbar('ホーム', { subtitle: todayLabel(), actions: [
    { html: iconSvg('plus', { size: 20 }), title: '追加・編集', onClick: () => navigate('settings') },
    { html: iconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
  ] });
  header.classList.add('shrink-header', 'home-shrink-header'); screen.append(header);

  const { location, key } = weatherContext(), cached = key ? parseCache(key) : null;
  const weatherCard = el('button', { class: 'home-weather-card', type: 'button', 'aria-label': '天気を開く', onclick: () => navigate('weather') });
  if (cached?.model) paintWeather(weatherCard, screen, location, cached.model); else weatherPlaceholder(weatherCard, screen, location);

  const colors = state.settings.colors, groupA = el('div', { class: 'change-grid home-card-group' }), groupB = el('div', { class: 'change-grid home-card-group' });
  groupA.append(
    tile('news', 'ニュース', newsNew ? `新着 ${newsNew}件` : '注目ニュース', '記事一覧', 'reader', navigate, colors.news || colors.reader, { readerMode: 'news' }),
    tile('knowledge', '知識', knowledgeNew ? `新着 ${knowledgeNew}件` : 'おすすめ記事', '記事一覧', 'reader', navigate, colors.knowledge || colors.reader, { readerMode: 'knowledge' }),
    tile('papers', '論文', papers.total ? `新着 ${papers.total}件` : '注目論文', paperParts.length ? paperParts.join(' / ') : '製品・熱・応用発想・一般独創', 'reader', navigate, colors.papers || colors.reader, { readerMode: 'papers', paperTrack: state.paperTrack || 'core' })
  );
  groupB.append(
    tile('wikipedia', 'Wikipedia', '今日の10本', '王道・考察・雑学を縦書きで', 'wikipedia', navigate, colors.wikipedia || '#c89b5b'),
    tile('youtube', 'YouTube', youtubeNew ? `新着 ${youtubeNew}件` : '新着動画', '動画・Shorts・LIVE', 'media', navigate, colors.youtube, { mediaMode: 'youtube' }),
    tile('twitch', 'Twitch', live ? `${live}件 配信中` : 'アーカイブ', 'LIVE・アーカイブ', 'media', navigate, colors.twitch, { mediaMode: 'twitch' }),
    tile('twitter', 'SNS', '最新ポスト', 'X・Instagram', 'twitter', navigate, colors.twitter)
  );
  const stack = el('div', { class: 'home-today' }, [weatherCard, groupA, groupB]); screen.append(stack);
  root.replaceChildren(screen); installShrinkingHeader(header, { threshold: 34 }); localStorage.setItem('pdv2:lastVisitMs', String(now));
  window.__PDV2_HOME_METRIC = { domMs: Math.round((performance.now() - started) * 10) / 10, cacheHit: Boolean(cached?.model), at: Date.now() };

  let disposed = false, updating = false, hiddenAt = 0;
  const updateWeather = async (force = false) => {
    if (disposed || updating || !location || !key) return;
    const latest = parseCache(key), fresh = latest?.model && Date.now() - Number(latest.at || 0) < WEATHER_TTL;
    if (!force && fresh) { if (weatherCard.isConnected) paintWeather(weatherCard, screen, location, latest.model); return; }
    updating = true;
    try {
      const { fetchWeatherBundle } = await import('../weather/weather-sources.js');
      const model = await fetchWeatherBundle(location, { refresh: force });
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), model })); } catch {}
      if (!disposed && weatherCard.isConnected) paintWeather(weatherCard, screen, location, model);
    } catch (error) {
      console.warn('[home-weather] background refresh unavailable', String(error?.message || error).slice(0, 220));
    } finally { updating = false; }
  };
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  afterPaint(() => updateWeather(Boolean(refresh || nav?.type === 'reload')));
  const onVisibility = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= 60 * 1000) { hiddenAt = 0; afterPaint(() => updateWeather(false)); }
  };
  document.addEventListener('visibilitychange', onVisibility, { passive: true });
  cleanupHome = () => { disposed = true; document.removeEventListener('visibilitychange', onVisibility); };
}
