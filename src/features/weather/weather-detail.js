import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';

const STYLE_ID = 'pdv2-weather-detail-style';
const graphHtmlCache = new Map();
const weekHtmlCache = new Map();

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
function themeKind(model) {
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 18) return 'night';
  return wx(model?.current?.weather_code)[2];
}
function weatherContext() {
  const locations = state.weatherLocations || [];
  if (!locations.length) return {};
  const stored = Number(localStorage.getItem('pdv2:weatherIndex') || 0);
  const index = Number.isFinite(stored) ? Math.max(0, Math.min(locations.length - 1, stored)) : 0;
  const location = locations[index];
  const key = `pdv2:weatherCache:multi-source:${location.lat},${location.lon}`;
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
  return { locations, index, location, key, cache };
}
function dayKey(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function rowsForDay(model, date, currentDay = false) {
  const h = model?.hourly || {}, times = h.time || [], wanted = dayKey(date), now = Date.now(), rows = [];
  for (let i = 0; i < times.length; i += 1) {
    if (String(times[i]).slice(0, 10) !== wanted) continue;
    const stamp = new Date(times[i]).getTime();
    if (currentDay && stamp < now - 30 * 60 * 1000) continue;
    const temp = Number(h.temperature_2m?.[i]); if (!Number.isFinite(temp)) continue;
    rows.push({ time: times[i], temp, rain: Math.max(0, Number(h.precipitation?.[i] || 0)), code: h.weather_code?.[i] });
  }
  if (rows.length <= 10) return rows;
  const desired = 9, selected = [];
  for (let n = 0; n < desired; n += 1) {
    const idx = Math.round(n * (rows.length - 1) / (desired - 1));
    if (!selected.includes(rows[idx])) selected.push(rows[idx]);
  }
  return selected;
}
function graphHtml(rows, cacheKey) {
  if (graphHtmlCache.has(cacheKey)) return graphHtmlCache.get(cacheKey);
  if (rows.length < 2) return '<div class="wd-graph-empty">時間別予報がありません</div>';
  const width = 344, high = Math.max(...rows.map(r => r.temp)), low = Math.min(...rows.map(r => r.temp)), range = Math.max(5, high - low);
  const pts = rows.map((row, i) => ({ ...row, x: 16 + i / (rows.length - 1) * (width - 32), y: 48 + (high - row.temp) / range * 62 }));
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const nodes = pts.map(p => {
    const [glyph] = wx(p.code), hour = new Date(p.time).getHours();
    return `<text class="wd-glyph" x="${p.x}" y="${p.y - 14}">${glyph}</text><circle cx="${p.x}" cy="${p.y}" r="2.4"/><text class="wd-temp-label" x="${p.x}" y="${p.y + 17}">${Math.round(p.temp)}°</text><text class="wd-time-label" x="${p.x}" y="148">${hour}時</text>${p.rain >= .1 ? `<text class="wd-rain-label" x="${p.x}" y="164">${p.rain.toFixed(1)}mm</text>` : ''}`;
  }).join('');
  const html = `<div class="wd-graph"><svg viewBox="0 0 ${width} 170" preserveAspectRatio="xMidYMid meet" aria-label="時間別の気温と天気"><polyline points="${line}"/>${nodes}</svg></div>`;
  graphHtmlCache.set(cacheKey, html); return html;
}
function currentHourly(model) {
  const h = model?.hourly || {}, times = h.time || [], now = Date.now();
  let best = -1, delta = Infinity;
  times.forEach((time, i) => { const d = Math.abs(new Date(time).getTime() - now); if (d < delta) { delta = d; best = i; } });
  return best < 0 ? {} : { rain: Number(h.precipitation?.[best] || 0), wind: Number(h.wind_speed_10m?.[best] || 0) };
}
function todayDailyIndex(model) {
  const target = dayKey(new Date());
  return (model?.daily?.time || []).findIndex(value => String(value) === target);
}
function metricsHtml(model) {
  const c = model?.current || {}, daily = model?.daily || {}, index = todayDailyIndex(model), hourly = currentHourly(model), rows = [];
  if (Number.isFinite(Number(hourly.rain))) rows.push(['☂︎', '降水', `${Number(hourly.rain).toFixed(1)} mm`]);
  if (Number.isFinite(Number(c.relative_humidity_2m))) rows.push(['◌', '湿度', `${Math.round(Number(c.relative_humidity_2m))}%`]);
  if (Number.isFinite(Number(c.wind_speed_10m))) rows.push(['↝', '風', `${Math.round(Number(c.wind_speed_10m))} km/h`]);
  const hi = Number(daily.temperature_2m_max?.[index]), lo = Number(daily.temperature_2m_min?.[index]);
  if (Number.isFinite(hi) || Number.isFinite(lo)) rows.push(['↕', '最高 / 最低', `${Number.isFinite(hi) ? Math.round(hi) : '—'}° / ${Number.isFinite(lo) ? Math.round(lo) : '—'}°`]);
  return rows.map(([icon, label, value]) => `<div class="wd-metric"><span>${icon}</span><small>${label}</small><strong>${value}</strong></div>`).join('');
}
function weekHtml(model, cacheKey) {
  if (weekHtmlCache.has(cacheKey)) return weekHtmlCache.get(cacheKey);
  const d = model?.daily || {}, days = (d.time || []).slice(0, 7).map((time, i) => ({
    time, high: Number(d.temperature_2m_max?.[i]), low: Number(d.temperature_2m_min?.[i]), code: d.weather_code?.[i]
  })).filter(row => Number.isFinite(row.high) && Number.isFinite(row.low));
  if (!days.length) return '<div class="wd-graph-empty">週間予報がありません</div>';
  const globalHigh = Math.max(...days.map(row => row.high)), globalLow = Math.min(...days.map(row => row.low)), range = Math.max(5, globalHigh - globalLow);
  const cols = days.map(row => {
    const date = new Date(`${row.time}T00:00:00`), top = 8 + (globalHigh - row.high) / range * 80, bottom = 8 + (globalHigh - row.low) / range * 80;
    const [glyph] = wx(row.code), height = Math.max(18, bottom - top);
    return `<div class="wd-week-day"><div class="wd-week-date">${date.getMonth()+1}/${date.getDate()}</div><div class="wd-week-high">${Math.round(row.high)}°</div><div class="wd-week-axis"><span class="wd-week-range" style="top:${top.toFixed(1)}%;height:${height.toFixed(1)}%"></span><span class="wd-week-glyph" style="top:${((top+bottom)/2).toFixed(1)}%">${glyph}</span></div><div class="wd-week-low">${Math.round(row.low)}°</div></div>`;
  }).join('');
  const html = `<div class="wd-week-grid">${cols}</div>`; weekHtmlCache.set(cacheKey, html); return html;
}
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = `
  .weather-detail-screen{--wd-accent:#8398aa;--wd-accent2:#b1bcc5;--wd-deep:#22303a;display:grid;gap:14px;padding-bottom:8px}
  .weather-detail-screen[data-wx="sunny"]{--wd-accent:#ff9c77;--wd-accent2:#ffc18f;--wd-deep:#44261f}.weather-detail-screen[data-wx="cloudy"]{--wd-accent:#8398aa;--wd-accent2:#b1bcc5;--wd-deep:#22303a}.weather-detail-screen[data-wx="rain"]{--wd-accent:#4e9bdb;--wd-accent2:#76c4e9;--wd-deep:#14334d}.weather-detail-screen[data-wx="snow"]{--wd-accent:#a9d5e6;--wd-accent2:#d8eef5;--wd-deep:#274454}.weather-detail-screen[data-wx="night"]{--wd-accent:#5669bd;--wd-accent2:#7868bf;--wd-deep:#181c43}
  #app-main:has(.weather-detail-screen){background:radial-gradient(100% 42% at 14% 0,color-mix(in srgb,var(--wd-accent) 14%,transparent),transparent 72%),var(--bg)}
  .wd-header{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:8px;min-height:48px}.wd-header button{width:44px;height:44px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line);font-size:20px}.wd-header-copy{text-align:center;min-width:0}.wd-header-copy strong{display:block;font-size:16px}.wd-header-copy small{display:block;color:var(--muted);font-size:10px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wd-location-rail{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:0 1px 2px}.wd-location-rail::-webkit-scrollbar{display:none}.wd-location-rail button{flex:0 0 auto;min-height:34px;padding:0 12px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:700}.wd-location-rail button.active{background:color-mix(in srgb,var(--wd-accent) 24%,var(--surface));color:var(--text);border-color:color-mix(in srgb,var(--wd-accent) 45%,var(--line))}
  .wd-current{border-radius:30px;padding:20px 17px 16px;color:#fff;background:radial-gradient(86% 105% at 92% -8%,color-mix(in srgb,var(--wd-accent2) 48%,transparent),transparent 66%),linear-gradient(145deg,color-mix(in srgb,var(--wd-accent) 68%,var(--wd-deep)),var(--wd-deep));box-shadow:0 14px 36px rgba(0,0,0,.14)}.wd-current-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}.wd-current-icon{font-size:52px;line-height:1}.wd-current-label{margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,.76)}.wd-current-temp{text-align:right}.wd-current-temp strong{display:block;font-size:64px;font-weight:260;line-height:.9;letter-spacing:-.07em}.wd-current-temp small{display:block;margin-top:8px;color:rgba(255,255,255,.72);font-size:12px;font-weight:650}.wd-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:18px}.wd-metric{min-width:0;padding:11px 12px;border:1px solid rgba(255,255,255,.11);border-radius:16px;background:rgba(255,255,255,.075);display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:center}.wd-metric>span{grid-row:1/3;font-size:18px}.wd-metric small{font-size:9px;color:rgba(255,255,255,.6)}.wd-metric strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wd-forecast{border-radius:28px;background:color-mix(in srgb,var(--wd-accent) 7%,var(--surface));border:1px solid color-mix(in srgb,var(--wd-accent) 18%,var(--line));overflow:hidden}.wd-section-title{padding:15px 16px 4px;display:flex;align-items:center;justify-content:space-between;gap:12px}.wd-section-title strong{font-size:15px}.wd-section-title small{color:var(--muted);font-size:10px}.wd-day-pager{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}.wd-day-pager::-webkit-scrollbar{display:none}.wd-day-page{flex:0 0 100%;min-width:100%;scroll-snap-align:start;padding:4px 10px 10px}.wd-day-label{padding:4px 8px 0;color:var(--muted);font-size:11px;font-weight:750}.wd-graph{min-height:178px;padding:2px 0 0}.wd-graph svg{display:block;width:100%;height:178px;overflow:visible}.wd-graph polyline{fill:none;stroke:color-mix(in srgb,var(--wd-accent) 72%,var(--text));stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.wd-graph circle{fill:var(--text)}.wd-graph text{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;text-anchor:middle}.wd-glyph{fill:var(--text);font-size:15px}.wd-temp-label{fill:var(--text);font-size:9px;font-weight:760}.wd-time-label{fill:var(--muted);font-size:8px}.wd-rain-label{fill:#68bff0;font-size:7px;font-weight:760}.wd-graph-empty{padding:48px 16px;text-align:center;color:var(--muted);font-size:12px}
  .wd-week-host{padding:8px 10px 16px}.wd-week-grid{display:grid;grid-template-columns:repeat(7,minmax(41px,1fr));gap:3px;overflow-x:auto;scrollbar-width:none}.wd-week-grid::-webkit-scrollbar{display:none}.wd-week-day{min-width:41px;text-align:center;display:grid;grid-template-rows:auto auto 104px auto;gap:4px}.wd-week-date{font-size:8px;color:var(--muted)}.wd-week-high,.wd-week-low{font-size:9px;font-weight:760}.wd-week-axis{position:relative}.wd-week-range{position:absolute;left:50%;width:5px;transform:translateX(-50%);border-radius:999px;background:linear-gradient(var(--wd-accent2),var(--wd-accent))}.wd-week-range:before,.wd-week-range:after{content:'';position:absolute;left:50%;width:8px;height:8px;transform:translate(-50%,-50%);border-radius:50%;background:var(--text)}.wd-week-range:before{top:0}.wd-week-range:after{top:100%}.wd-week-glyph{position:absolute;left:50%;transform:translate(-50%,-50%);font-size:15px;z-index:2;background:var(--surface);border-radius:50%;padding:1px}
  .wd-mode-switch{position:sticky;z-index:14;bottom:calc(var(--nav-height) + env(safe-area-inset-bottom) + 8px);justify-self:center;display:flex;gap:7px;padding:6px;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--surface-solid) 92%,transparent);box-shadow:0 8px 28px rgba(0,0,0,.18);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.wd-mode-switch button{width:48px;height:40px;display:grid;place-items:center;border-radius:999px;background:transparent;color:var(--muted)}.wd-mode-switch button.active{width:58px;background:color-mix(in srgb,var(--wd-accent) 22%,var(--surface-2));color:var(--text)}.wd-mode-switch svg{width:24px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
  .wd-shared-enter{opacity:.08;transition:opacity 260ms ease}.pdv2-weather-shared-overlay{position:fixed;z-index:260;pointer-events:none;transform-origin:0 0;will-change:transform,opacity;overflow:hidden;color:#fff}.pdv2-weather-shared-overlay svg{display:block;width:100%;height:100%}
  @media(max-width:390px){.wd-current-temp strong{font-size:58px}.wd-metric{padding-inline:10px}.wd-week-grid{gap:1px}}
  `; document.head.append(style);
}
function modeIcon(kind) {
  return kind === 'days'
    ? '<svg viewBox="0 0 28 22" aria-hidden="true"><path d="M4 5v12M14 3v16M24 6v10"/></svg>'
    : '<svg viewBox="0 0 30 22" aria-hidden="true"><path d="M3 17V8M7 17V5M11 17V10M15 17V3M19 17V7M23 17V4M27 17V9"/></svg>';
}
function finishSharedTransition(target) {
  const data = window.__PDV2_HOME_WEATHER_TRANSITION; window.__PDV2_HOME_WEATHER_TRANSITION = null;
  if (!data?.overlay?.isConnected || !target?.isConnected || Date.now() - Number(data.at || 0) > 1600) { data?.overlay?.remove?.(); return; }
  const from = data.rect, to = target.getBoundingClientRect(); if (!from?.width || !from?.height || !to.width || !to.height) { data.overlay.remove(); return; }
  target.classList.add('wd-shared-enter');
  const dx = to.left - from.left, dy = to.top - from.top, sx = to.width / from.width, sy = to.height / from.height;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    data.overlay.style.transition = 'transform 340ms cubic-bezier(.2,.78,.2,1), opacity 280ms ease';
    data.overlay.style.transform = `translate3d(${dx}px,${dy}px,0) scale(${sx},${sy})`; data.overlay.style.opacity = '0'; target.style.opacity = '1';
    setTimeout(() => { data.overlay?.remove(); target.classList.remove('wd-shared-enter'); target.style.opacity = ''; }, 370);
  }));
}

export async function renderWeatherDetail(root, { navigate }) {
  ensureStyles();
  let mode = 'days', disposed = false, transitionFinished = false;
  const screen = el('section', { class: 'screen weather-detail-screen' });
  const render = () => {
    const ctx = weatherContext(), model = ctx.cache?.model || null, stamp = Number(ctx.cache?.at || 0);
    screen.dataset.wx = model ? themeKind(model) : 'cloudy';
    screen.replaceChildren();
    const header = el('div', { class: 'wd-header' });
    header.innerHTML = `<button type="button" aria-label="ホームへ戻る">‹</button><div class="wd-header-copy"><strong>天気</strong><small>${esc(ctx.location?.name || '')}</small></div><button type="button" aria-label="地域と更新">＋</button>`;
    header.children[0].onclick = () => navigate('home', { source: 'weather-detail-back' });
    header.children[2].onclick = () => navigate('weather', { source: 'weather-detail-manage' });
    screen.append(header);
    if (ctx.locations?.length > 1) {
      const rail = el('div', { class: 'wd-location-rail' });
      ctx.locations.forEach((location, index) => rail.append(el('button', { class: index === ctx.index ? 'active' : '', type: 'button', text: location.name, onclick: () => { localStorage.setItem('pdv2:weatherIndex', String(index)); render(); } })));
      screen.append(rail);
    }
    if (!model) {
      screen.append(el('div', { class: 'wd-current', html: `<div class="wd-current-main"><div><div class="wd-current-icon">☁︎</div><div class="wd-current-label">保存済み予報なし</div></div><div class="wd-current-temp"><strong>—°</strong><small>体感 —°</small></div></div><div class="wd-metrics"><div class="wd-metric"><span>↻</span><small>状態</small><strong>更新待ち</strong></div></div>` }), el('div', { class: 'wd-forecast', html: '<div class="wd-graph-empty">ホームのバックグラウンド更新結果を待っています。画面表示は通信を待ちません。</div>' }));
      root.replaceChildren(screen); return;
    }
    const c = model.current || {}, [glyph, label] = wx(c.weather_code), temp = Number(c.temperature_2m), feels = Number(c.apparent_temperature);
    const current = el('div', { class: 'wd-current', html: `<div class="wd-current-main"><div><div class="wd-current-icon">${glyph}</div><div class="wd-current-label">${label}</div></div><div class="wd-current-temp"><strong>${Number.isFinite(temp) ? Math.round(temp) : '—'}°</strong><small>体感 ${Number.isFinite(feels) ? Math.round(feels) : '—'}°</small></div></div><div class="wd-metrics">${metricsHtml(model)}</div>` });
    screen.append(current);
    const forecast = el('div', { class: 'wd-forecast' });
    const title = el('div', { class: 'wd-section-title', html: `<strong>${mode === 'days' ? '時間変化' : '1週間の気温幅'}</strong><small>${mode === 'days' ? '横にスワイプ' : '最高 ↕ 最低'}</small>` });
    const content = el('div'); forecast.append(title, content); screen.append(forecast);
    if (mode === 'days') {
      const pager = el('div', { class: 'wd-day-pager' });
      const base = new Date(); base.setHours(12, 0, 0, 0);
      ['今日', '明日', '明後日'].forEach((name, offset) => {
        const date = new Date(base); date.setDate(base.getDate() + offset);
        const rows = rowsForDay(model, date, offset === 0), key = `${ctx.key}|${stamp}|${dayKey(date)}`;
        const page = el('div', { class: 'wd-day-page', html: `<div class="wd-day-label">${name}</div>${graphHtml(rows, key)}` }); pager.append(page);
      });
      content.append(pager);
      if (!transitionFinished) { transitionFinished = true; requestAnimationFrame(() => finishSharedTransition(pager.querySelector('.wd-graph'))); }
    } else {
      content.className = 'wd-week-host'; content.innerHTML = weekHtml(model, `${ctx.key}|${stamp}|week`);
    }
    const toggle = el('div', { class: 'wd-mode-switch' });
    const daysButton = el('button', { class: mode === 'days' ? 'active' : '', type: 'button', 'aria-label': '3日間', html: modeIcon('days'), onclick: () => { if (mode !== 'days') { mode = 'days'; render(); } } });
    const weekButton = el('button', { class: mode === 'week' ? 'active' : '', type: 'button', 'aria-label': '1週間', html: modeIcon('week'), onclick: () => { if (mode !== 'week') { mode = 'week'; render(); } } });
    toggle.append(daysButton, weekButton); screen.append(toggle); root.replaceChildren(screen);
  };
  const onWeather = event => { if (disposed) return; const ctx = weatherContext(); if (event?.detail?.key && event.detail.key !== ctx.key) return; render(); };
  const onNavigate = () => { disposed = true; window.removeEventListener('pdv2:weather-cache-updated', onWeather); window.removeEventListener('pdv2:before-navigate', onNavigate); window.__PDV2_HOME_WEATHER_TRANSITION?.overlay?.remove?.(); window.__PDV2_HOME_WEATHER_TRANSITION = null; };
  window.addEventListener('pdv2:weather-cache-updated', onWeather); window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  render();
}