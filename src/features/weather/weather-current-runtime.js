import { readCurrentWeatherLocation, refreshCurrentWeatherLocation } from './weather-current-location.js';

let running = false;
let lastRun = 0;

function schedule(force = false) {
  if (running) return;
  const cached = readCurrentWeatherLocation();
  const fresh = cached?.locatedAt && Date.now() - cached.locatedAt < 10 * 60 * 1000;
  if (!force && fresh && Date.now() - lastRun < 10 * 60 * 1000) return;
  const run = async () => {
    running = true;
    lastRun = Date.now();
    try { await refreshCurrentWeatherLocation({ refreshWeather: true }); }
    finally { running = false; }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 80);
}

if (document.documentElement.dataset.pdv2Booted === '1') schedule(false);
else window.addEventListener('pdv2:booted', () => schedule(false), { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRun > 15 * 60 * 1000) schedule(true);
}, { passive: true });
