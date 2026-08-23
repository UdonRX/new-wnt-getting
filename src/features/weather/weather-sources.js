const OPEN_METEO_JMA = 'https://api.open-meteo.com/v1/jma';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

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

export async function fetchWeatherBundle(location, { refresh = false } = {}) {
  const hourlyUrl = new URL(OPEN_METEO_JMA);
  locationParams(hourlyUrl, location);
  hourlyUrl.searchParams.set('models', 'jma_msm');
  hourlyUrl.searchParams.set('forecast_hours', '96');
  hourlyUrl.searchParams.set('hourly', 'temperature_2m,precipitation,weather_code,wind_speed_10m');

  const bestMatchUrl = new URL(OPEN_METEO_FORECAST);
  locationParams(bestMatchUrl, location);
  bestMatchUrl.searchParams.set('models', 'best_match');
  bestMatchUrl.searchParams.set('forecast_days', '7');
  bestMatchUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
  bestMatchUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum');

  const [hourly, bestMatch] = await Promise.all([
    getJson(hourlyUrl, 'JMA MSM 1時間予報', refresh),
    getJson(bestMatchUrl, 'Open-Meteo現在・週間予報', refresh)
  ]);

  return {
    ...hourly,
    current: bestMatch.current || {},
    current_units: bestMatch.current_units || {},
    daily: bestMatch.daily || {},
    daily_units: bestMatch.daily_units || {},
    sources: {
      hourly: 'open-meteo-jma-msm',
      current: 'open-meteo-best-match',
      weekly: 'open-meteo-best-match'
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
