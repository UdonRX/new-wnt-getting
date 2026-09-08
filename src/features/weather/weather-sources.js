const OPEN_METEO_JMA = 'https://api.open-meteo.com/v1/jma';
const JMA_AMEDAS_TABLE = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
const JMA_AMEDAS_LATEST = 'https://www.jma.go.jp/bosai/amedas/data/latest_time.txt';
const JMA_AMEDAS_POINT = 'https://www.jma.go.jp/bosai/amedas/data/point';
const MAX_LOCAL_STATION_KM = 45;
let amedasTablePromise = null;

function locationParams(url, location) {
  url.searchParams.set('latitude', String(location.lat));
  url.searchParams.set('longitude', String(location.lon));
  url.searchParams.set('timezone', 'Asia/Tokyo');
}

async function getJson(url, label, refresh = false) {
  const response = await fetch(url, { cache: refresh ? 'no-store' : 'default' });
  if (!response.ok) throw new Error(`${label}の取得に失敗しました (${response.status})`);
  return response.json();
}

async function getText(url, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label}の取得に失敗しました (${response.status})`);
  return response.text();
}

function stationCoordinate(parts) {
  if (!Array.isArray(parts) || parts.length < 2) return NaN;
  return Number(parts[0]) + Number(parts[1]) / 60;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = value => Number(value) * Math.PI / 180;
  const a1 = toRad(lat1), a2 = toRad(lat2);
  const dLat = a2 - a1, dLon = toRad(lon2) - toRad(lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestStation(table, location, predicate) {
  let best = null;
  for (const [code, info] of Object.entries(table || {})) {
    if (!predicate(info || {})) continue;
    const lat = stationCoordinate(info.lat), lon = stationCoordinate(info.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distance = distanceKm(location.lat, location.lon, lat, lon);
    if (!best || distance < best.distanceKm) best = { code, info, lat, lon, distanceKm: distance };
  }
  return best;
}

function loadAmedasTable() {
  if (!amedasTablePromise) {
    amedasTablePromise = getJson(new URL(JMA_AMEDAS_TABLE), '気象庁アメダス観測所', false)
      .catch(error => {
        amedasTablePromise = null;
        throw error;
      });
  }
  return amedasTablePromise;
}

function pointBucket(latestTimeText) {
  const match = String(latestTimeText || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/);
  if (!match) return '';
  const hour = Math.floor(Number(match[4]) / 3) * 3;
  return `${match[1]}${match[2]}${match[3]}_${String(hour).padStart(2, '0')}`;
}

function observedValue(entry) {
  if (!Array.isArray(entry) || entry.length < 1) return null;
  const value = Number(entry[0]), quality = Number(entry[1]);
  if (!Number.isFinite(value)) return null;
  if (Number.isFinite(quality) && quality > 1) return null;
  return value;
}

function latestObserved(rows, key) {
  const entries = Object.entries(rows || {}).sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  for (const [, row] of entries) {
    const value = observedValue(row?.[key]);
    if (value != null) return value;
  }
  return null;
}

async function fetchStationPoint(station, bucket) {
  if (!station?.code || !bucket) return null;
  const url = new URL(`${JMA_AMEDAS_POINT}/${station.code}/${bucket}.json`);
  url.searchParams.set('__time__', String(Math.floor(Date.now() / 60000)));
  try {
    const rows = await getJson(url, `気象庁アメダス ${station.info?.kjName || station.code}`, true);
    return { station, rows };
  } catch {
    return null;
  }
}

function wmoFromAmedasWeather(value) {
  const code = Number(value);
  const map = {
    0: 0,
    1: 3,
    2: 45,
    3: 45,
    4: 51,
    5: 53,
    6: 56,
    7: 61,
    8: 66,
    9: 67,
    10: 71,
    11: 77,
    12: 71,
    13: 80,
    14: 85,
    15: 96,
    16: 95
  };
  return Number.isFinite(map[code]) ? map[code] : null;
}

function apparentTemperature(temp, humidity, windKmh) {
  if (![temp, humidity, windKmh].every(Number.isFinite)) return null;
  const windMs = Math.max(0, windKmh / 3.6);
  const vaporPressure = (humidity / 100) * 6.105 * Math.exp((17.27 * temp) / (237.7 + temp));
  const apparent = temp + 0.33 * vaporPressure - 0.70 * windMs - 4;
  return Number.isFinite(apparent) ? apparent : null;
}

async function fetchJmaObservation(location) {
  const [table, latestTimeText] = await Promise.all([
    loadAmedasTable(),
    getText(`${JMA_AMEDAS_LATEST}?__time__=${Math.floor(Date.now() / 1000)}`, '気象庁アメダス最新時刻')
  ]);
  const bucket = pointBucket(latestTimeText);
  if (!bucket) return null;

  const measurementStation = nearestStation(table, location, info => {
    const elems = String(info?.elems || '');
    return elems[0] === '1' && (elems[1] === '1' || elems[3] === '1');
  });
  const conditionStation = nearestStation(table, location, info => {
    const elems = String(info?.elems || '');
    return elems[0] === '1' && elems[6] === '1' && elems[7] === '1';
  });

  if (!measurementStation || measurementStation.distanceKm > MAX_LOCAL_STATION_KM) return null;
  const stations = [measurementStation];
  if (conditionStation && conditionStation.code !== measurementStation.code && conditionStation.distanceKm <= MAX_LOCAL_STATION_KM) {
    stations.push(conditionStation);
  }
  const records = (await Promise.all(stations.map(station => fetchStationPoint(station, bucket)))).filter(Boolean);
  if (!records.length) return null;

  const measurement = records.find(record => record.station.code === measurementStation.code) || records[0];
  const condition = conditionStation
    ? records.find(record => record.station.code === conditionStation.code) || measurement
    : measurement;

  const temp = latestObserved(measurement.rows, 'temp') ?? latestObserved(condition.rows, 'temp');
  const windMs = latestObserved(measurement.rows, 'wind') ?? latestObserved(condition.rows, 'wind');
  const windKmh = Number.isFinite(windMs) ? windMs * 3.6 : null;
  const humidity = latestObserved(condition.rows, 'humidity') ?? latestObserved(measurement.rows, 'humidity');
  const precipitation10m = latestObserved(measurement.rows, 'precipitation10m');
  const snow1h = latestObserved(measurement.rows, 'snow1h') ?? latestObserved(condition.rows, 'snow1h');
  const observedWeather = latestObserved(condition.rows, 'weather');

  let weatherCode = wmoFromAmedasWeather(observedWeather);
  if (Number.isFinite(snow1h) && snow1h > 0 && Number.isFinite(temp) && temp <= 2.5) weatherCode = 71;
  else if (Number.isFinite(precipitation10m) && precipitation10m > 0) weatherCode = 61;

  return {
    temp,
    humidity,
    windKmh,
    weatherCode,
    apparent: apparentTemperature(temp, humidity, windKmh),
    observedAt: String(latestTimeText || '').trim(),
    station: measurement.station.info?.kjName || measurement.station.code,
    stationDistanceKm: Math.round(measurement.station.distanceKm * 10) / 10,
    conditionStation: condition.station.info?.kjName || condition.station.code
  };
}

export async function fetchWeatherBundle(location, { refresh = false } = {}) {
  const jmaUrl = new URL(OPEN_METEO_JMA);
  locationParams(jmaUrl, location);
  jmaUrl.searchParams.set('forecast_days', '7');
  jmaUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
  jmaUrl.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
  jmaUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum');

  const [jma, observation] = await Promise.all([
    getJson(jmaUrl, 'JMA MSM/GSM予報', refresh),
    fetchJmaObservation(location).catch(error => {
      console.warn('[jma-amedas]', error?.message || error);
      return null;
    })
  ]);

  const current = { ...(jma.current || {}) };
  if (observation) {
    if (Number.isFinite(observation.temp)) current.temperature_2m = observation.temp;
    if (Number.isFinite(observation.humidity)) current.relative_humidity_2m = observation.humidity;
    if (Number.isFinite(observation.windKmh)) current.wind_speed_10m = observation.windKmh;
    if (Number.isFinite(observation.weatherCode)) current.weather_code = observation.weatherCode;
    if (Number.isFinite(observation.apparent)) current.apparent_temperature = observation.apparent;
  }

  return {
    ...jma,
    current,
    sources: {
      hourly: 'jma-msm-gsm',
      current: observation ? 'jma-amedas-observation' : 'jma-msm-gsm',
      weekly: 'jma-msm-gsm',
      observation: observation || null
    }
  };
}

export async function fetchRapidRainAlert(location, { refresh = false } = {}) {
  const params = new URLSearchParams({
    lat: Number(location.lat).toFixed(4),
    lon: Number(location.lon).toFixed(4)
  });
  const response = await fetch(`/api/weather-rain?${params}`, { cache: refresh ? 'no-store' : 'default' });
  if (!response.ok) throw new Error(`短時間降水予報の取得に失敗しました (${response.status})`);
  const data = await response.json();
  if (!data?.alert) return null;
  return { ...data.alert, yahooAvailable: Boolean(data?.sources?.yahoo?.available) };
}
