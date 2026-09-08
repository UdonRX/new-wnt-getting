import {
  readCurrentWeatherLocation,
  refreshCurrentWeatherLocation,
  refreshCurrentWeatherLocationName
} from './weather-current-location.js';

let running = false;

function schedule() {
  if (running) return;
  const cached = readCurrentWeatherLocation();

  // Once a valid position has been saved, do not ask Safari for location again
  // automatically. Reuse it immediately and resolve its visible place name in
  // the background. A fresh position can still be requested explicitly from
  // the Weather screen's refresh action.
  if (cached) {
    if (!cached.name || cached.name === '現在地') {
      refreshCurrentWeatherLocationName(cached).catch(() => {});
    }
    return;
  }

  const run = async () => {
    if (running || readCurrentWeatherLocation()) return;
    running = true;
    try { await refreshCurrentWeatherLocation({ refreshWeather: true }); }
    finally { running = false; }
  };

  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 80);
}

if (document.documentElement.dataset.pdv2Booted === '1') schedule();
else window.addEventListener('pdv2:booted', schedule, { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const cached = readCurrentWeatherLocation();
  if (cached && (!cached.name || cached.name === '現在地')) {
    refreshCurrentWeatherLocationName(cached).catch(() => {});
  }
}, { passive: true });
