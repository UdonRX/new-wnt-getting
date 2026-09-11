const LOCATION_KEY = 'pdv2:weatherCurrentLocation:v1';
const LOCATION_MAX_AGE = 10 * 60 * 1000;
const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const GSI_MUNI_URL = 'https://maps.gsi.go.jp/js/muni.js';
let municipalityNamesPromise = null;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function normalizeMunicipalityName(value = '') {
  return String(value || '').replace(/[\s　]+/g, '').trim();
}

function sameCoordinates(a, b) {
  if (!a || !b) return false;
  return Number(a.lat) === Number(b.lat) && Number(a.lon) === Number(b.lon);
}

function nameMatchesCoordinates(location) {
  if (!location) return false;
  if (!Number.isFinite(Number(location.nameLat)) || !Number.isFinite(Number(location.nameLon))) return false;
  return Number(location.nameLat) === Number(location.lat) && Number(location.nameLon) === Number(location.lon);
}

async function loadMunicipalityNames() {
  if (!municipalityNamesPromise) {
    municipalityNamesPromise = fetch(GSI_MUNI_URL, { cache: 'force-cache' })
      .then(async response => {
        if (!response.ok) throw new Error('市区町村名を取得できませんでした');
        const text = await response.text();
        const map = new Map();
        const pattern = /GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']+)'/g;
        let match;
        while ((match = pattern.exec(text))) {
          const parts = String(match[2] || '').split(',');
          const name = normalizeMunicipalityName(parts.at(-1) || '');
          if (!name) continue;
          map.set(match[1], name);
          map.set(String(Number(match[1])), name);
        }
        return map;
      })
      .catch(error => {
        municipalityNamesPromise = null;
        throw error;
      });
  }
  return municipalityNamesPromise;
}

async function reverseCurrentPlaceName(lat, lon) {
  try {
    const url = new URL(GSI_REVERSE_URL);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return '';
    const data = await response.json();
    const municipalityCode = String(data?.results?.muniCd || '').trim();
    const district = normalizeMunicipalityName(data?.results?.lv01Nm || '');
    if (municipalityCode) {
      try {
        const names = await loadMunicipalityNames();
        const municipality = names.get(municipalityCode) || names.get(String(Number(municipalityCode))) || '';
        if (municipality) return municipality;
      } catch {}
    }
    return district;
  } catch {
    return '';
  }
}

function saveLocation(location) {
  try { localStorage.setItem(LOCATION_KEY, JSON.stringify(location)); } catch {}
}

function notifyLocation(location) {
  window.dispatchEvent(new CustomEvent('pdv2:current-location-updated', { detail: { location } }));
}

export function weatherCacheKey(location) {
  if (!Number.isFinite(Number(location?.lat)) || !Number.isFinite(Number(location?.lon))) return '';
  return `pdv2:weatherCache:multi-source:${Number(location.lat)},${Number(location.lon)}`;
}

export function readCurrentWeatherLocation() {
  const raw = readJson(LOCATION_KEY);
  if (!raw || !Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lon))) return null;
  return {
    name: String(raw.name || '現在地'),
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    isCurrent: true,
    locatedAt: Number(raw.locatedAt || 0),
    nameLat: Number.isFinite(Number(raw.nameLat)) ? Number(raw.nameLat) : null,
    nameLon: Number.isFinite(Number(raw.nameLon)) ? Number(raw.nameLon) : null,
    nameUpdatedAt: Number(raw.nameUpdatedAt || 0)
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

export async function refreshCurrentWeatherLocationName(location = readCurrentWeatherLocation()) {
  if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lon))) return location || null;
  const name = await reverseCurrentPlaceName(location.lat, location.lon);
  if (!name) return location;

  const latest = readCurrentWeatherLocation();
  if (!latest || !sameCoordinates(latest, location)) return latest || location;

  const named = {
    ...latest,
    name,
    nameLat: Number(latest.lat),
    nameLon: Number(latest.lon),
    nameUpdatedAt: Date.now()
  };
  const changed = named.name !== latest.name || !nameMatchesCoordinates(latest);
  saveLocation(named);
  if (changed) notifyLocation(named);
  return named;
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
    const previous = readCurrentWeatherLocation();
    const position = await getPosition();
    const nextCoordinates = {
      lat: Number(position.coords.latitude.toFixed(5)),
      lon: Number(position.coords.longitude.toFixed(5))
    };
    const coordinatesChanged = !sameCoordinates(previous, nextCoordinates);
    const canReuseResolvedName = !coordinatesChanged && previous?.name && previous.name !== '現在地' && nameMatchesCoordinates(previous);

    let location = {
      name: canReuseResolvedName ? previous.name : '現在地',
      lat: nextCoordinates.lat,
      lon: nextCoordinates.lon,
      isCurrent: true,
      locatedAt: Date.now(),
      ...(canReuseResolvedName ? {
        nameLat: previous.nameLat,
        nameLon: previous.nameLon,
        nameUpdatedAt: previous.nameUpdatedAt
      } : {})
    };
    saveLocation(location);
    notifyLocation(location);

    // Resolve the municipality independently from weather fetching. This repairs legacy
    // cached locations whose coordinates were refreshed while an old place name remained.
    // A successful lookup emits another location event, so Home/Weather can replace only
    // the current-location presentation without waiting for the weather request.
    refreshCurrentWeatherLocationName(location)
      .then(named => { if (named) location = named; })
      .catch(() => {});

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
