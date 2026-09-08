import { state, update } from './store.js';

const WEATHER_META = {
  sunny: '#5b382e',
  cloudy: '#35414a',
  rain: '#23435e',
  snow: '#49616c',
  night: '#20254f'
};
const WEATHER_KINDS = new Set(Object.keys(WEATHER_META));

const featureColorKey = screen => {
  if (screen === 'media') return state.mediaMode;
  if (screen === 'reader') return state.readerMode;
  return screen;
};

export function applyWeatherShellTheme(kind = 'cloudy') {
  const next = WEATHER_KINDS.has(String(kind)) ? String(kind) : 'cloudy';
  const root = document.documentElement;
  if (root.dataset.appWeather !== next) root.dataset.appWeather = next;
  document.body?.setAttribute('data-app-weather', next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', WEATHER_META[next]);
  return next;
}

export function applyTheme() {
  const settings = state.settings;
  const key = featureColorKey(state.screen);
  const color = settings.colors[key] || settings.colors.home;
  document.documentElement.style.setProperty('--feature-color', color);
  applyWeatherShellTheme(document.documentElement.dataset.appWeather || 'cloudy');
}

export function setScreen(screen) {
  state.screen = screen;
  update('lastScreen', screen);
  document.body.classList.toggle('pdv2-home-fullscreen', screen === 'home');
  applyTheme();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
