import { iconSvg, weatherVisual } from './weather-icons.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function weatherKind(model) {
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 18) return 'night';
  const code = Number(model?.current?.weather_code);
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if (code <= 2) return 'sunny';
  return 'cloudy';
}

function todayIndex(model) {
  const key = new Date().toLocaleDateString('en-CA');
  return (model?.daily?.time || []).findIndex(value => String(value) === key);
}

export function weatherSentence(model) {
  const h = model?.hourly || {}, times = h.time || [], now = Date.now();
  let start = times.findIndex(time => new Date(time).getTime() >= now - 30 * 60 * 1000);
  if (start < 0) start = 0;
  const indexes = Array.from({ length: 10 }, (_, n) => start + n).filter(i => i < times.length);
  const rainy = indexes.find(i => Number(h.precipitation?.[i] || 0) >= 0.3);
  if (rainy != null) {
    const hour = new Date(times[rainy]).getHours();
    return rainy === indexes[0] ? 'いま雨が降っています。この先もしばらく雨が続く見込みです。' : `${hour}時ごろから雨の可能性があります。外出時は傘があると安心です。`;
  }
  const temps = indexes.map(i => Number(h.temperature_2m?.[i])).filter(Number.isFinite);
  if (temps.length > 2) {
    const delta = temps.at(-1) - temps[0];
    if (delta <= -4) return `この先は天気が大きく崩れにくく、気温は約${Math.abs(Math.round(delta))}℃下がる見込みです。`;
    if (delta >= 4) return `この先は天気が大きく崩れにくく、気温は約${Math.round(delta)}℃上がる見込みです。`;
  }
  const label = weatherVisual(model?.current?.weather_code).label;
  return `現在は${label}です。この先もしばらく大きな天気の変化はなさそうです。`;
}

export function currentHeroHtml(location, model) {
  if (!model) {
    return `<div class="wd-place">${esc(location?.name || '現在地')}</div><div class="wd-current-row"><div class="wd-current-icon wd-current-placeholder">${iconSvg('cloud', { size: 78 })}</div><div class="wd-temp-block"><strong>—°</strong><small>体感 —°</small></div></div><p class="wd-summary">${location?.pending ? '現在地を取得しています。保存済みの地点は左右スワイプですぐ確認できます。' : '保存済みの予報がありません。裏側で更新しています。'}</p>`;
  }
  const current = model.current || {}, visual = weatherVisual(current.weather_code);
  const temp = Number(current.temperature_2m), feels = Number(current.apparent_temperature);
  return `<div class="wd-place">${esc(location?.name || '天気')}</div><div class="wd-current-row"><div class="wd-current-icon">${iconSvg(visual.icon, { size: 88 })}</div><div class="wd-temp-block"><strong>${Number.isFinite(temp) ? Math.round(temp) : '—'}°</strong><small>体感 ${Number.isFinite(feels) ? Math.round(feels) : '—'}°</small></div></div><p class="wd-summary">${esc(weatherSentence(model))}</p>${metricsHtml(model)}`;
}

function metricsHtml(model) {
  const c = model?.current || {}, d = model?.daily || {}, index = todayIndex(model);
  const rows = [
    ['湿度', Number.isFinite(Number(c.relative_humidity_2m)) ? `${Math.round(Number(c.relative_humidity_2m))}%` : '—'],
    ['風', Number.isFinite(Number(c.wind_speed_10m)) ? `${Math.round(Number(c.wind_speed_10m))} km/h` : '—'],
    ['最高', Number.isFinite(Number(d.temperature_2m_max?.[index])) ? `${Math.round(Number(d.temperature_2m_max[index]))}°` : '—'],
    ['最低', Number.isFinite(Number(d.temperature_2m_min?.[index])) ? `${Math.round(Number(d.temperature_2m_min[index]))}°` : '—']
  ];
  return `<div class="wd-metrics-flat">${rows.map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>`;
}

function weatherGlyph(code) {
  const c = Number(code);
  if (c <= 2) return '☀︎';
  if (c === 3) return '☁︎';
  if ([45, 48].includes(c)) return '≋';
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) return '❄︎';
  if (c >= 95) return '⚡︎';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return '☂︎';
  return '☁︎';
}

function threeDayRows(model) {
  const h = model?.hourly || {}, times = h.time || [];
  const now = Date.now();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() + 2);
  const rows = [];
  for (let i = 0; i < times.length; i += 1) {
    const stamp = new Date(times[i]).getTime();
    if (!Number.isFinite(stamp) || stamp < now - 30 * 60 * 1000 || stamp > end.getTime()) continue;
    const temp = Number(h.temperature_2m?.[i]);
    if (!Number.isFinite(temp)) continue;
    rows.push({ time: times[i], temp, code: h.weather_code?.[i], rain: Math.max(0, Number(h.precipitation?.[i] || 0)) });
  }
  return rows;
}

function graphHtml(rows) {
  if (rows.length < 2) return '<div class="wd-graph-empty">時間別予報がありません</div>';
  const step = 50;
  const width = Math.max(344, 32 + (rows.length - 1) * step);
  const high = Math.max(...rows.map(row => row.temp));
  const low = Math.min(...rows.map(row => row.temp));
  const range = Math.max(5, high - low);
  const points = rows.map((row, i) => ({ ...row, x: 16 + i * step, y: 46 + (high - row.temp) / range * 60 }));
  const line = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const labels = points.map((point, index) => {
    const date = new Date(point.time);
    const hour = date.getHours();
    const timeLabel = hour === 0 || index === 0 ? `${date.getMonth() + 1}/${date.getDate()} ${hour}時` : `${hour}時`;
    return `<text class="wd-glyph" x="${point.x}" y="${point.y - 14}">${weatherGlyph(point.code)}</text><circle cx="${point.x}" cy="${point.y}" r="2.4"/><text class="wd-temp-label" x="${point.x}" y="${point.y + 17}">${Math.round(point.temp)}°</text><text class="wd-time-label" x="${point.x}" y="148">${timeLabel}</text>${point.rain >= .1 ? `<text class="wd-rain-label" x="${point.x}" y="164">${point.rain.toFixed(1)}mm</text>` : ''}`;
  }).join('');
  return `<div class="wd-graph wd-graph-scroll" aria-label="今日から明後日までの時間別の気温・天気・降水量"><svg viewBox="0 0 ${width} 170" width="${width}" height="170" preserveAspectRatio="xMinYMid meet"><polyline points="${line}"/>${labels}</svg></div>`;
}

export function currentHoursHtml(model) {
  return graphHtml(threeDayRows(model));
}

export function weekHtml(model) {
  const d = model?.daily || {};
  const days = (d.time || []).slice(0, 7).map((time, index) => ({
    time,
    high: Number(d.temperature_2m_max?.[index]),
    low: Number(d.temperature_2m_min?.[index]),
    code: d.weather_code?.[index]
  })).filter(row => Number.isFinite(row.high) && Number.isFinite(row.low));
  if (!days.length) return '<div class="wd-graph-empty">週間予報がありません</div>';
  const globalHigh = Math.max(...days.map(row => row.high));
  const globalLow = Math.min(...days.map(row => row.low));
  const range = Math.max(5, globalHigh - globalLow);
  const columns = days.map(row => {
    const date = new Date(`${row.time}T00:00:00`);
    const top = 8 + (globalHigh - row.high) / range * 80;
    const bottom = 8 + (globalHigh - row.low) / range * 80;
    const height = Math.max(18, bottom - top);
    return `<div class="wd-week-day"><div class="wd-week-date">${date.getMonth() + 1}/${date.getDate()}</div><div class="wd-week-high">${Math.round(row.high)}°</div><div class="wd-week-axis"><span class="wd-week-range" style="top:${top.toFixed(1)}%;height:${height.toFixed(1)}%"></span><span class="wd-week-glyph" style="top:${((top + bottom) / 2).toFixed(1)}%">${weatherGlyph(row.code)}</span></div><div class="wd-week-low">${Math.round(row.low)}°</div></div>`;
  }).join('');
  return `<div class="wd-week-card"><div class="wd-week-grid" aria-label="1週間の最高・最低気温と天気">${columns}</div></div>`;
}
