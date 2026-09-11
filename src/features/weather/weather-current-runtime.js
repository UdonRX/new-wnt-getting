import {
  readCurrentWeatherLocation,
  refreshCurrentWeatherLocation,
  refreshCurrentWeatherLocationName
} from './weather-current-location.js';

const FOREGROUND_REFRESH_MIN_INTERVAL = 30 * 1000;
let running = false;
let lastRefreshStartedAt = 0;

async function runRefresh() {
  if (running) return;
  running = true;
  lastRefreshStartedAt = Date.now();
  try { await refreshCurrentWeatherLocation({ refreshWeather: true }); }
  finally { running = false; }
}

function schedule({ force = false } = {}) {
  if (running) return;
  const cached = readCurrentWeatherLocation();

  // Keep cached weather/location instant, while repairing an unresolved municipality
  // name independently from the fresh iPhone coordinate request.
  if (cached && (!cached.name || cached.name === '現在地')) {
    refreshCurrentWeatherLocationName(cached).catch(() => {});
  }

  // Boot always asks iPhone for a non-cached fix. Foreground resumes do the same after a
  // short guard interval so quick visibility flickers do not repeatedly wake GPS.
  if (!force && Date.now() - lastRefreshStartedAt < FOREGROUND_REFRESH_MIN_INTERVAL) return;

  const run = () => runRefresh().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 80);
}

if (document.documentElement.dataset.pdv2Booted === '1') schedule({ force: true });
else window.addEventListener('pdv2:booted', () => schedule({ force: true }), { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  schedule();
}, { passive: true });

window.addEventListener('pageshow', () => schedule(), { passive: true });
