import {
  readCurrentWeatherLocation,
  refreshCurrentWeatherLocation,
  refreshCurrentWeatherLocationName
} from './weather-current-location.js';

const LOCATION_REFRESH_AGE = 10 * 60 * 1000;
let running = false;

function locationIsStale(location) {
  if (!location) return true;
  const locatedAt = Number(location.locatedAt || 0);
  return !locatedAt || Date.now() - locatedAt >= LOCATION_REFRESH_AGE;
}

async function runRefresh() {
  if (running) return;
  running = true;
  try { await refreshCurrentWeatherLocation({ refreshWeather: true }); }
  finally { running = false; }
}

function schedule() {
  if (running) return;
  const cached = readCurrentWeatherLocation();

  // Keep cached current weather/location instant, but refresh stale coordinates
  // in the background so the left-most Weather page and Home weather follow
  // the device's actual current location after the user moves.
  if (cached && (!cached.name || cached.name === '現在地')) {
    refreshCurrentWeatherLocationName(cached).catch(() => {});
  }
  if (!locationIsStale(cached)) return;

  const run = () => runRefresh().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 80);
}

if (document.documentElement.dataset.pdv2Booted === '1') schedule();
else window.addEventListener('pdv2:booted', schedule, { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  schedule();
}, { passive: true });
