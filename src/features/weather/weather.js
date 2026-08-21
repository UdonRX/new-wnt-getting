import { state, update } from '../../app/store.js';
import { el, openSheet, showToast } from '../../shared/dom.js';
import { topbar, segmented, centerScrollItem, installShrinkingHeader } from '../../shared/components.js';
import { iconSvg as appIconSvg } from '../../shared/icons.js';
import { attachSwipe } from '../../shared/gestures.js';
import { fetchHourlyJmaModel, fetchOfficialJma, parseOfficialForecast, geocodeJapan } from './weather-api.js';
import { iconSvg, weatherVisual } from './weather-icons.js';

const PERIODS = ['today', 'tomorrow', 'week'];
let mode = localStorage.getItem('pdv2:weatherMode') || 'today';
if (!PERIODS.includes(mode)) mode = 'today';
let selectedIndex = Number(localStorage.getItem('pdv2:weatherIndex') || 0);

function saveMode(next) {
  mode = PERIODS.includes(next) ? next : 'today';
  localStorage.setItem('pdv2:weatherMode', mode);
}

function compactWeatherText(raw, fallback = 'くもり') {
  const original = String(raw || '')
    .replace(/[\s　]+/g, '')
    .replace(/くもり/g, '曇り')
    .replace(/所により/g, '')
    .replace(/朝晩|昼前|昼過ぎ|夕方|夜遅く|夜|朝|昼/g, '');

  if (!original) return fallback;

  const kinds = '(?:晴れ|曇り|雨|雪|雷雨|みぞれ)';

  const after = original.match(new RegExp(`(${kinds}).*?(?:後|のち).*?(${kinds})`));
  if (after) return `${after[1]}のち${after[2]}`;

  const temporary = original.match(new RegExp(`(${kinds}).*?一時.*?(${kinds})`));
  if (temporary) return `一時${temporary[2]}`;

  const sometimes = original.match(new RegExp(`(${kinds}).*?時々.*?(${kinds})`));
  if (sometimes) return `時々${sometimes[2]}`;

  const found = [...original.matchAll(new RegExp(kinds, 'g'))].map(match => match[0]);
  if (found.length >= 2) return `${found[0]}・${found[1]}`;
  if (found.length === 1) return found[0];
  return fallback;
}

function pointFrom(data) {
  const h = data.hourly || {};
  const times = h.time || [];
  const now = Date.now();
  const found = times.findIndex(time => new Date(time).getTime() >= now - 30 * 60 * 1000);
  const start = Math.max(0, found < 0 ? 0 : found);
  const next = Array.from({ length: 12 }, (_, n) => start + n).filter(index => index < times.length);

  const rainy = next.find(index => Number(h.precipitation?.[index] || 0) >= 0.2);
  if (rainy != null) {
    return {
      icon: 'umbrella',
      text: `${new Date(times[rainy]).getHours()}時ごろから雨の可能性。傘があると安心です。`
    };
  }

  const temps = next.map(index => Number(h.temperature_2m?.[index])).filter(Number.isFinite);
  if (temps.length > 1) {
    const delta = temps.at(-1) - temps[0];
    if (delta <= -4) return { icon: 'down', text: `このあと約${Math.abs(Math.round(delta))}℃下がる予想です。` };
    if (delta >= 4) return { icon: 'up', text: `このあと約${Math.round(delta)}℃上がる予想です。` };
  }

  const windy = next.find(index => Number(h.wind_speed_10m?.[index] || 0) >= 25);
  if (windy != null) {
    return { icon: 'wind', text: `${new Date(times[windy]).getHours()}時ごろ風が強まる予想です。` };
  }

  return { icon: 'check', text: 'しばらく大きな天気の変化はなさそうです。' };
}

function hourlyCards(data, wantedMode) {
  const h = data.hourly || {};
  const times = h.time || [];
  const now = new Date();
  let indexes = [];

  if (wantedMode === 'today') {
    indexes = times
      .map((time, index) => [new Date(time), index])
      .filter(([date]) => date.toDateString() === now.toDateString() && date >= new Date(now.getTime() - 30 * 60 * 1000))
      .map(([, index]) => index);
  } else {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    indexes = times
      .map((time, index) => [new Date(time), index])
      .filter(([date]) => date.toDateString() === tomorrow.toDateString())
      .map(([, index]) => index);
  }

  const strip = el('div', { class: 'hourly-strip' });
  indexes.forEach(index => {
    const visual = weatherVisual(h.weather_code?.[index]);
    const precipitation = Number(h.precipitation?.[index] || 0);
    const card = el('div', { class: 'hour-card' });
    card.innerHTML = `
      <div class="time">${new Date(times[index]).getHours()}時</div>
      <div class="wx">${iconSvg(visual.icon, { size: 27 })}</div>
      <strong>${Math.round(Number(h.temperature_2m?.[index] || 0))}°</strong>
      <div class="rain">${precipitation > 0 ? `${precipitation.toFixed(1)}mm` : ''}</div>
    `;
    strip.append(card);
  });

  return strip;
}

function weekRows(data, official) {
  const daily = data.daily || {};
  const grid = el('div', { class: 'daily-grid' });

  (daily.time || []).slice(0, 7).forEach((date, index) => {
    const officialDay = official.find(row => row.date === date);
    const visual = weatherVisual(daily.weather_code?.[index]);

    // 気象庁の短期予報に文章がある日はそれを短縮。
    // 週間側は固定文字列を使わず、日別 weather_code の実予報へフォールバック。
    const label = compactWeatherText(officialDay?.weather, visual.label);
    const dt = new Date(`${date}T00:00:00`);
    const row = el('div', { class: 'daily-row' });

    row.innerHTML = `
      <strong>${dt.toLocaleDateString('ja-JP', { weekday: 'short' })}</strong>
      <div class="daily-weather">
        <span class="daily-weather-icon">${iconSvg(visual.icon, { size: 24 })}</span>
        <span>${label}</span>
      </div>
      <div class="daily-temp">
        <span class="temp-high">${Math.round(daily.temperature_2m_max?.[index] ?? 0)}°</span>
        <span class="temp-low">${Math.round(daily.temperature_2m_min?.[index] ?? 0)}°</span>
      </div>
    `;
    grid.append(row);
  });

  return grid;
}

function centerActiveChip(container) {
  const active = container?.querySelector('.chip.active');
  if (active) centerScrollItem(container, active, { behavior: 'smooth' });
}

function openLocationManager(onDone) {
  const wrap = el('div');
  let sheet;
  const draft = state.weatherLocations.map(location => ({ ...location }));

  const render = () => {
    wrap.replaceChildren();

    draft.forEach((location, index) => {
      const row = el('div', { class: 'sheet-row' });
      row.append(
        el('span', { text: location.name }),
        el('div', { class: 'inline-actions' }, [
          el('button', {
            class: 'soft-button', type: 'button', text: '↑',
            onclick: () => {
              if (index > 0) {
                [draft[index - 1], draft[index]] = [draft[index], draft[index - 1]];
                render();
              }
            }
          }),
          el('button', {
            class: 'soft-button', type: 'button', text: '↓',
            onclick: () => {
              if (index < draft.length - 1) {
                [draft[index + 1], draft[index]] = [draft[index], draft[index + 1]];
                render();
              }
            }
          }),
          el('button', {
            class: 'soft-button', type: 'button', text: '削除',
            onclick: () => { draft.splice(index, 1); render(); }
          })
        ])
      );
      wrap.append(row);
    });

    wrap.append(el('button', {
      class: 'soft-button full-button',
      type: 'button',
      text: '地域を追加',
      onclick: () => {
        sheet?.close();
        openLocationAdd(onDone);
      }
    }));

    wrap.append(el('button', {
      class: 'primary-button full-button',
      type: 'button',
      text: '保存',
      onclick: () => {
        update('weatherLocations', draft);
        selectedIndex = Math.min(selectedIndex, Math.max(0, draft.length - 1));
        localStorage.setItem('pdv2:weatherIndex', String(selectedIndex));
        sheet?.close();
        onDone();
      }
    }));
  };

  render();
  sheet = openSheet(wrap, { title: '天気の地域' });
}

function attachPullDownDismiss(sheetRef) {
  const sheet = sheetRef?.sheet;
  if (!sheet) return () => {};
  let startY = 0;
  let startX = 0;
  let pulling = false;

  const reset = () => {
    sheet.style.transition = 'transform .18s ease';
    sheet.style.transform = '';
    setTimeout(() => { if (sheet.isConnected) sheet.style.transition = ''; }, 190);
  };

  const onStart = event => {
    if (event.touches?.length !== 1) return;
    const touch = event.touches[0];
    const rect = sheet.getBoundingClientRect();
    // シート上端（ハンドル〜タイトル付近）から始めた下スワイプだけを対象にする。
    if (touch.clientY - rect.top > 96) return;
    startY = touch.clientY;
    startX = touch.clientX;
    pulling = true;
    sheet.style.transition = 'none';
  };

  const onMove = event => {
    if (!pulling || event.touches?.length !== 1) return;
    const touch = event.touches[0];
    const dy = touch.clientY - startY;
    const dx = touch.clientX - startX;
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy) * .9) return;
    if (event.cancelable) event.preventDefault();
    sheet.style.transform = `translateY(${Math.min(150, dy * .72)}px)`;
  };

  const onEnd = event => {
    if (!pulling) return;
    pulling = false;
    const touch = event.changedTouches?.[0];
    const dy = touch ? touch.clientY - startY : 0;
    const dx = touch ? touch.clientX - startX : 0;
    if (dy >= 82 && Math.abs(dy) > Math.abs(dx)) {
      sheet.style.transition = 'transform .16s ease';
      sheet.style.transform = 'translateY(110%)';
      setTimeout(() => sheetRef.close(), 140);
      return;
    }
    reset();
  };

  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchmove', onMove, { passive: false });
  sheet.addEventListener('touchend', onEnd, { passive: true });
  sheet.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    sheet.removeEventListener('touchstart', onStart);
    sheet.removeEventListener('touchmove', onMove);
    sheet.removeEventListener('touchend', onEnd);
    sheet.removeEventListener('touchcancel', onEnd);
  };
}

function openLocationAdd(onDone) {
  const wrap = el('div');
  let sheet;

  const field = el('div', { class: 'field' });
  field.append(el('label', { text: '都道府県・市区町村' }));
  const input = el('input', { placeholder: '例：香川、高松、京都市' });
  field.append(input);
  wrap.append(field);

  const results = el('div', { class: 'list' });
  wrap.append(results);

  wrap.append(el('button', {
    class: 'primary-button full-button',
    type: 'button',
    text: '検索',
    onclick: async () => {
      results.innerHTML = '<div class="loading">検索中...</div>';
      try {
        const found = await geocodeJapan(input.value.trim());
        results.replaceChildren();

        found.forEach(place => results.append(el('button', {
          class: 'list-item',
          type: 'button',
          html: `<div class="list-item-title">${place.displayName}</div><div class="list-meta">${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}</div>`,
          onclick: () => {
            const next = [
              ...state.weatherLocations,
              {
                name: place.displayName.split(' / ')[0],
                lat: place.lat,
                lon: place.lon,
                jmaCode: place.jmaCode
              }
            ];
            update('weatherLocations', next);
            selectedIndex = next.length - 1;
            localStorage.setItem('pdv2:weatherIndex', String(selectedIndex));
            sheet?.close();
            showToast('地域を追加しました');
            onDone();
          }
        })));

        if (!found.length) {
          results.append(el('div', { class: 'empty', text: '地域が見つかりませんでした' }));
        }
      } catch (err) {
        results.innerHTML = `<div class="error-box">${err.message}</div>`;
      }
    }
  }));

  sheet = openSheet(wrap, { title: '地域を追加' });
}


export async function renderWeather(root, { navigate, refresh = false }) {
  if (selectedIndex >= state.weatherLocations.length) selectedIndex = 0;
  if (selectedIndex < 0) selectedIndex = 0;

  const location = state.weatherLocations[selectedIndex];
  const screen = el('section', { class: 'screen weather-screen' });

  const headerBar = topbar('天気', {
    subtitle: '',
    actions: [
      { html: appIconSvg('plus', { size: 20 }), title: '地域', onClick: () => openLocationManager(() => renderWeather(root, { navigate, refresh: true })) },
      { html: appIconSvg('refresh', { size: 20 }), title: '更新', onClick: () => renderWeather(root, { navigate, refresh: true }) },
      { html: appIconSvg('settings', { size: 20 }), title: '設定', onClick: () => navigate('settings') }
    ]
  });

  const shrinkHeader = el('div', { class: 'weather-shrink-header shrink-header' }, [headerBar]);

  if (!location) {
    screen.append(shrinkHeader, el('div', { class: 'empty', text: '地域を追加してください' }));
    root.replaceChildren(screen);
    installShrinkingHeader(shrinkHeader, { threshold: 34 });
    return;
  }

  const locTabs = el('div', { class: 'chips weather-location-chips weather-location-tabs' });

  const selectLocation = (index, { refreshData = false } = {}) => {
    const count = state.weatherLocations.length;
    if (!count) return;
    const next = Math.max(0, Math.min(count - 1, index));
    if (next === selectedIndex && !refreshData) return;
    selectedIndex = next;
    localStorage.setItem('pdv2:weatherIndex', String(next));
    renderWeather(root, { navigate, refresh: refreshData });
  };

  state.weatherLocations.forEach((item, index) => {
    locTabs.append(el('button', {
      class: `chip ${index === selectedIndex ? 'active' : ''}`,
      type: 'button',
      text: item.name,
      onclick: () => selectLocation(index)
    }));
  });

  shrinkHeader.append(locTabs);
  screen.append(
    shrinkHeader,
    el('div', { class: 'card', html: '<div class="loading">天気を読み込み中...</div>' })
  );
  root.replaceChildren(screen);
  centerActiveChip(locTabs);
  installShrinkingHeader(shrinkHeader, { threshold: 44 });

  const cacheKey = `pdv2:weatherCache:${location.lat},${location.lon}`;
  let model;
  let officialData;

  if (!refresh) {
    try {
      const cache = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cache && Date.now() - cache.at < 30 * 60 * 1000) {
        model = cache.model;
        officialData = cache.officialData;
      }
    } catch {}
  }

  try {
    if (!model) {
      [model, officialData] = await Promise.all([
        fetchHourlyJmaModel(location),
        fetchOfficialJma(location.jmaCode).catch(() => null)
      ]);
      localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), model, officialData }));
    }

    const official = parseOfficialForecast(officialData);
    const current = model.current || {};
    const visual = weatherVisual(current.weather_code);
    const point = pointFrom(model);

    const card = el('div', { class: 'card weather-now' });
    const currentSwipe = el('div', { class: 'weather-current-swipe' });
    currentSwipe.innerHTML = `
      <div class="weather-location">${location.name}</div>
      <div class="weather-main-icon">${iconSvg(visual.icon, { size: 52 })}</div>
      <div class="weather-temp">${Math.round(Number(current.temperature_2m || 0))}°</div>
      <div class="weather-desc">${visual.label}</div>
      <div class="weather-feels">体感 ${Math.round(Number(current.apparent_temperature || 0))}° ・ 湿度 ${Math.round(Number(current.relative_humidity_2m || 0))}% ・ 風 ${Math.round(Number(current.wind_speed_10m || 0))}km/h</div>
    `;
    card.append(currentSwipe);
    card.append(el('div', {
      class: 'weather-point',
      html: `<span class="weather-point-icon">${iconSvg(point.icon, { size: 20 })}</span><span>${point.text}</span>`
    }));

    if (state.weatherLocations.length > 1) {
      attachSwipe(currentSwipe, {
        left: () => selectLocation((selectedIndex + 1) % state.weatherLocations.length),
        right: () => selectLocation((selectedIndex - 1 + state.weatherLocations.length) % state.weatherLocations.length),
        threshold: 54
      });
    }

    const tabsHost = el('div', { class: 'weather-period-tabs' });
    const detail = el('div', { class: 'weather-period-detail' });

    const changePeriod = nextMode => {
      saveMode(nextMode);
      renderMode();
    };

    const cyclePeriod = delta => {
      const index = PERIODS.indexOf(mode);
      const next = Math.max(0, Math.min(PERIODS.length - 1, index + delta));
      if (next !== index) changePeriod(PERIODS[next]);
    };

    const renderMode = () => {
      tabsHost.replaceChildren(segmented([
        { value: 'today', label: '今日' },
        { value: 'tomorrow', label: '明日' },
        { value: 'week', label: '週間' }
      ], mode, changePeriod));

      detail.replaceChildren();
      if (mode === 'week') {
        detail.append(weekRows(model, official));
      } else {
        detail.append(el('div', { class: 'section-title' }, [
          el('h2', { text: '1時間ごとの予報' }),
          el('small', { text: '横にスクロール' })
        ]));
        detail.append(hourlyCards(model, mode));
      }
    };

    renderMode();
    attachSwipe(tabsHost, {
      left: () => cyclePeriod(1),
      right: () => cyclePeriod(-1),
      threshold: 42
    });

    screen.replaceChildren(shrinkHeader, card, tabsHost, detail);
    root.replaceChildren(screen);
    centerActiveChip(locTabs);
  } catch (err) {
    screen.replaceChildren(shrinkHeader, el('div', { class: 'error-box', text: err.message }));
    root.replaceChildren(screen);
    centerActiveChip(locTabs);
  }
}