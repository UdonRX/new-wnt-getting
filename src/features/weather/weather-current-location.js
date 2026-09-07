const LOCATION_KEY = 'pdv2:weatherCurrentLocation:v1';
const LOCATION_MAX_AGE = 10 * 60 * 1000;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

export function weatherCacheKey(location) {
  if (!Number.isFinite(Number(location?.lat)) || !Number.isFinite(Number(location?.lon))) return '';
  return `pdv2:weatherCache:multi-source:${Number(location.lat)},${Number(location.lon)}`;
}

export function readCurrentWeatherLocation() {
  const raw = readJson(LOCATION_KEY);
  if (!raw || !Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lon))) return null;
  return {
    name: '現在地',
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    isCurrent: true,
    locatedAt: Number(raw.locatedAt || 0)
  };
}

export function weatherLocationsWithCurrent(savedLocations = []) {
  const current = readCurrentWeatherLocation();
  const saved = (savedLocations || []).filter(item => Number.isFinite(Number(item?.lat)) && Number.isFinite(Number(item?.lon)));
  const first = current || { name: '現在地', isCurrent: true, pending: true };
  return [first, ...saved];
}

export function readWeatherCache(location) {
  const key = weatherCacheKey(location);
  if (!key) return null;
  return readJson(key);
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('この端末では現在地を取得できません'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      error => reject(error),
      { enableHighAccuracy: false, timeout: 5500, maximumAge: LOCATION_MAX_AGE }
    );
  });
}

export async function refreshCurrentWeatherLocation({ refreshWeather = true } = {}) {
  try {
    const position = await getPosition();
    const location = {
      name: '現在地',
      lat: Number(position.coords.latitude.toFixed(5)),
      lon: Number(position.coords.longitude.toFixed(5)),
      isCurrent: true,
      locatedAt: Date.now()
    };
    try { localStorage.setItem(LOCATION_KEY, JSON.stringify(location)); } catch {}
    window.dispatchEvent(new CustomEvent('pdv2:current-location-updated', { detail: { location } }));

    if (refreshWeather) {
      const key = weatherCacheKey(location);
      try {
        const { fetchWeatherBundle } = await import('./weather-sources.js');
        const model = await fetchWeatherBundle(location, { refresh: false });
        const payload = { at: Date.now(), model };
        try { localStorage.setItem(key, JSON.stringify(payload)); } catch {}
        window.dispatchEvent(new CustomEvent('pdv2:weather-cache-updated', { detail: { key, location, model, at: payload.at } }));
      } catch (error) {
        console.warn('[current-weather]', error?.message || error);
      }
    }
    return location;
  } catch (error) {
    window.dispatchEvent(new CustomEvent('pdv2:current-location-unavailable', { detail: { message: String(error?.message || error || '') } }));
    return null;
  }
}
