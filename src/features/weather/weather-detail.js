import { state, update } from '../../app/store.js';
import { el, openSheet, showToast } from '../../shared/dom.js';
import { attachSwipe } from '../../shared/gestures.js';
import { geocodeJapan } from './weather-api.js';
import { fetchWeatherBundle } from './weather-sources.js';
import {
  readCurrentWeatherLocation,
  readWeatherCache,
  refreshCurrentWeatherLocation,
  weatherCacheKey,
  weatherLocationsWithCurrent
} from './weather-current-location.js';
import { currentHeroHtml, currentHoursHtml, weatherKind, weekHtml } from './weather-detail-view.js';

const WEATHER_TTL = 10 * 60 * 1000;
const PAGE_KEY = 'pdv2:weatherDetailPage:v1';

function dotsHtml(count, index) {
  return `<div class="wd-dots" aria-label="地点 ${index + 1}/${count}">${Array.from({ length: count }, (_, i) => `<span class="${i === index ? 'active' : ''}"></span>`).join('')}</div>`;
}

function cacheIsFresh(cache) {
  return Boolean(cache?.model && Date.now() - Number(cache.at || 0) < WEATHER_TTL);
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

  const search = async () => {
    results.innerHTML = '<div class="loading">検索中...</div>';
    try {
      const found = await geocodeJapan(input.value.trim());
      results.replaceChildren();

      found.forEach(place => {
        const button = el('button', { class: 'list-item', type: 'button' });
        button.append(
          el('div', { class: 'list-item-title', text: place.displayName }),
          el('div', { class: 'list-meta', text: `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}` })
        );
        button.onclick = () => {
          const added = {
            name: place.displayName.split(' / ')[0],
            lat: place.lat,
            lon: place.lon,
            jmaCode: place.jmaCode
          };
          const next = [...(state.weatherLocations || []), added];
          update('weatherLocations', next);
          sheet?.close();
          showToast('地域を追加しました');
          onDone?.(added);
        };
        results.append(button);
      });

      if (!found.length) results.append(el('div', { class: 'empty', text: '地域が見つかりませんでした' }));
    } catch (error) {
      results.replaceChildren(el('div', { class: 'error-box', text: error?.message || '地域を検索できませんでした' }));
    }
  };

  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search();
  });
  wrap.append(el('button', { class: 'primary-button full-button', type: 'button', text: '検索', onclick: search }));
  sheet = openSheet(wrap, { title: '地域を追加' });
}

export async function renderWeatherDetail(root, { navigate }) {
  let disposed = false;
  let pageIndex = Math.max(0, Number(localStorage.getItem(PAGE_KEY) || 0));
  let refreshingKey = '';

  const screen = el('section', { class: 'screen weather-detail-screen' });

  const pages = () => weatherLocationsWithCurrent(state.weatherLocations || []);

  const pageAt = () => {
    const list = pages();
    if (pageIndex >= list.length) pageIndex = Math.max(0, list.length - 1);
    return { list, location: list[pageIndex] };
  };

  const syncLegacyIndex = location => {
    if (location?.isCurrent) return;
    const index = (state.weatherLocations || []).findIndex(item => Number(item.lat) === Number(location.lat) && Number(item.lon) === Number(location.lon));
    if (index >= 0) {
      try { localStorage.setItem('pdv2:weatherIndex', String(index)); } catch {}
    }
  };

  const setPage = next => {
    const list = pages();
    if (!list.length) return;
    pageIndex = (next + list.length) % list.length;
    try { localStorage.setItem(PAGE_KEY, String(pageIndex)); } catch {}
    syncLegacyIndex(list[pageIndex]);
    render();
  };

  const refreshLocation = async (location, force = false) => {
    if (disposed) return;
    if (location?.isCurrent && (force || location?.pending)) {
      await refreshCurrentWeatherLocation({ refreshWeather: true });
      if (!disposed) render();
      return;
    }
    const key = weatherCacheKey(location);
    if (!key || refreshingKey === key) return;
    const existing = readWeatherCache(location);
    if (!force && cacheIsFresh(existing)) return;
    refreshingKey = key;
    try {
      const model = await fetchWeatherBundle(location, { refresh: force });
      const payload = { at: Date.now(), model };
      try { localStorage.setItem(key, JSON.stringify(payload)); } catch {}
      window.dispatchEvent(new CustomEvent('pdv2:weather-cache-updated', { detail: { key, location, model, at: payload.at } }));
      if (!disposed) render();
    } catch (error) {
      console.warn('[weather-detail]', error?.message || error);
    } finally {
      refreshingKey = '';
    }
  };

  const attachLocationSwipe = node => {
    const list = pages();
    if (list.length <= 1) return;
    attachSwipe(node, {
      left: () => setPage(pageIndex + 1),
      right: () => setPage(pageIndex - 1),
      threshold: 48
    });
  };

  const render = () => {
    if (disposed) return;
    const { list, location } = pageAt();
    const cache = readWeatherCache(location);
    const model = cache?.model || null;
    screen.dataset.wx = model ? weatherKind(model) : 'cloudy';
    screen.replaceChildren();

    const tools = el('div', { class: 'wd-tools' });
    const manage = el('button', { type: 'button', class: 'wd-tool-button', 'aria-label': '地域を追加', text: '＋' });
    const refresh = el('button', { type: 'button', class: 'wd-tool-button', 'aria-label': '天気を更新', text: '↻' });
    manage.onclick = () => openLocationAdd(() => {
      pageIndex = Math.max(0, pages().length - 1);
      try { localStorage.setItem(PAGE_KEY, String(pageIndex)); } catch {}
      render();
    });
    refresh.onclick = () => refreshLocation(location, true);
    tools.append(manage, refresh);

    const hero = el('section', { class: 'wd-hero', html: currentHeroHtml(location, model) });
    attachLocationSwipe(hero);

    screen.append(tools, hero);

    if (!model) {
      const wait = el('div', { class: 'wd-loading-flat', text: location?.pending ? '現在地を取得中…' : '保存済み予報を確認中…' });
      const dots = el('div', { class: 'wd-dot-host', html: dotsHtml(list.length, pageIndex) });
      screen.append(wait, dots);
      root.replaceChildren(screen);
      requestAnimationFrame(() => refreshLocation(location, false));
      return;
    }

    const hourly = el('section', { class: 'wd-flat-section wd-now-hours', html: currentHoursHtml(model) });
    const weekly = el('section', { class: 'wd-flat-section wd-week-forecast', html: weekHtml(model) });
    attachLocationSwipe(weekly);
    const dots = el('div', { class: 'wd-dot-host', html: dotsHtml(list.length, pageIndex) });
    screen.append(hourly, weekly, dots);
    root.replaceChildren(screen);

    if (!cacheIsFresh(cache)) requestAnimationFrame(() => refreshLocation(location, false));
  };

  const onCurrent = () => {
    if (disposed) return;
    if (pageIndex === 0 || !readCurrentWeatherLocation()) pageIndex = 0;
    render();
  };
  const onWeather = event => {
    if (disposed) return;
    const { location } = pageAt();
    const key = weatherCacheKey(location);
    if (!event?.detail?.key || event.detail.key === key) render();
  };
  const onNavigate = () => {
    disposed = true;
    window.removeEventListener('pdv2:current-location-updated', onCurrent);
    window.removeEventListener('pdv2:weather-cache-updated', onWeather);
    window.removeEventListener('pdv2:before-navigate', onNavigate);
  };

  window.addEventListener('pdv2:current-location-updated', onCurrent);
  window.addEventListener('pdv2:weather-cache-updated', onWeather);
  window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  render();
}
