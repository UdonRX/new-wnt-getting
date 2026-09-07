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

function dayKey(date) {
  return date.toLocaleDateString('en-CA');
}

function hourlyRows(model, date, { fromNow = false, limit = 10 } = {}) {
  const h = model?.hourly || {}, times = h.time || [], wanted = dayKey(date), now = Date.now(), rows = [];
  for (let i = 0; i < times.length && rows.length < limit; i += 1) {
    if (String(times[i]).slice(0, 10) !== wanted) continue;
    const stamp = new Date(times[i]).getTime();
    if (fromNow && stamp < now - 30 * 60 * 1000) continue;
    const temp = Number(h.temperature_2m?.[i]);
    if (!Number.isFinite(temp)) continue;
    rows.push({ time: times[i], temp, code: h.weather_code?.[i], rain: Number(h.precipitation?.[i] || 0) });
  }
  return rows;
}

function hourStrip(rows) {
  if (!rows.length) return '<div class="wd-empty-line">時間別予報がありません</div>';
  return `<div class="wd-hour-strip">${rows.map(row => {
    const visual = weatherVisual(row.code), hour = new Date(row.time).getHours();
    return `<div class="wd-hour"><small>${hour}時</small><span>${iconSvg(visual.icon, { size: 38 })}</span><strong>${Math.round(row.temp)}°</strong><em>${row.rain >= .1 ? `${row.rain.toFixed(1)}mm` : ''}</em></div>`;
  }).join('')}</div>`;
}

export function currentHoursHtml(model) {
  const now = new Date();
  return hourStrip(hourlyRows(model, now, { fromNow: true, limit: 10 }));
}

export function nextDaysHtml(model) {
  const base = new Date(); base.setHours(12, 0, 0, 0);
  const blocks = [];
  for (let offset = 1; offset <= 2; offset += 1) {
    const date = new Date(base); date.setDate(base.getDate() + offset);
    const label = offset === 1 ? '明日' : '明後日';
    blocks.push(`<section class="wd-flat-section"><div class="wd-flat-label">${label}</div>${hourStrip(hourlyRows(model, date, { limit: 8 }))}</section>`);
  }
  return blocks.join('');
}

export function weekHtml(model) {
  const d = model?.daily || {}, times = (d.time || []).slice(0, 7);
  if (!times.length) return '<div class="wd-empty-line">週間予報がありません</div>';
  return `<div class="wd-week-list">${times.map((time, index) => {
    const date = new Date(`${time}T00:00:00`), visual = weatherVisual(d.weather_code?.[index]);
    const hi = Number(d.temperature_2m_max?.[index]), lo = Number(d.temperature_2m_min?.[index]);
    return `<div class="wd-week-row"><strong>${date.toLocaleDateString('ja-JP', { weekday: 'short' })}</strong><span>${iconSvg(visual.icon, { size: 38 })}</span><small>${visual.label}</small><em>${Number.isFinite(lo) ? Math.round(lo) : '—'}°</em><b>${Number.isFinite(hi) ? Math.round(hi) : '—'}°</b></div>`;
  }).join('')}</div>`;
}
