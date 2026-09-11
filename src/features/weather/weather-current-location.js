const LOCATION_KEY = 'pdv2:weatherCurrentLocation:v1';
const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const GSI_MUNI_URL = 'https://maps.gsi.go.jp/js/muni.js';
const POSITION_TIMEOUT = 12000;
const POSITION_SETTLE_MS = 2500;
const GOOD_ACCURACY_METERS = 120;
const MAX_POSITION_AGE = 30 * 1000;
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
    accuracy: Number.isFinite(Number(raw.accuracy)) ? Number(raw.accuracy) : null,
    positionTimestamp: Number(raw.positionTimestamp || 0),
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

function positionAccuracy(position) {
  const value = Number(position?.coords?.accuracy);
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

function positionIsFresh(position) {
  const timestamp = Number(position?.timestamp || 0);
  if (!timestamp) return true;
  return Date.now() - timestamp <= MAX_POSITION_AGE;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('この端末では現在地を取得できません'));
      return;
    }

    let watchId = null;
    let hardTimer = null;
    let settleTimer = null;
    let best = null;
    let finished = false;

    const cleanup = () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (hardTimer) clearTimeout(hardTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };
    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (best) resolve(best);
      else reject(error || new Error('現在地を取得できませんでした'));
    };
    const remember = position => {
      if (!position || !positionIsFresh(position)) return;
      if (!best || positionAccuracy(position) < positionAccuracy(best)) best = position;

      if (positionAccuracy(best) <= GOOD_ACCURACY_METERS) {
        finish();
        return;
      }

      if (!settleTimer) {
        settleTimer = setTimeout(() => finish(), POSITION_SETTLE_MS);
      }
    };

    watchId = navigator.geolocation.watchPosition(
      remember,
      error => {
        if (best) finish();
        else finish(error);
      },
      { enableHighAccuracy: true, timeout: POSITION_TIMEOUT, maximumAge: 0 }
    );
    hardTimer = setTimeout(() => finish(new Error('現在地の取得がタイムアウトしました')), POSITION_TIMEOUT + 500);
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
    const accuracy = Number.isFinite(Number(position.coords.accuracy)) ? Math.round(Number(position.coords.accuracy)) : null;
    const positionTimestamp = Number(position.timestamp || Date.now());

    let location = {
      name: canReuseResolvedName ? previous.name : '現在地',
      lat: nextCoordinates.lat,
      lon: nextCoordinates.lon,
      isCurrent: true,
      locatedAt: Date.now(),
      accuracy,
      positionTimestamp,
      ...(canReuseResolvedName ? {
        nameLat: previous.nameLat,
        nameLon: previous.nameLon,
        nameUpdatedAt: previous.nameUpdatedAt
      } : {})
    };
    saveLocation(location);
    notifyLocation(location);

    // Resolve the municipality independently from weather fetching. A coordinate change
    // immediately invalidates the old municipality name, and a successful reverse lookup
    // emits a second event so Home/Weather update only the current-location presentation.
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
