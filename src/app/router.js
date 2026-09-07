import { state, update } from './store.js';
import { el, clear } from '../shared/dom.js';
import { iconPath } from '../shared/icons.js';

const NAV = [
  ['home', 'ホーム', 'home'],
  ['weather', '天気', 'weather'],
  ['reader', '読む', 'reader'],
  ['media', '動画', 'media'],
  ['twitter', 'SNS', 'sns'],
  ['wikipedia', 'Wiki', 'wikipedia']
];
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
  const root = document.documentElement;
  root.style.setProperty('--feature-color', color);
  root.style.setProperty('--edge-width', `${Number(settings.edgeWidth || 1.5)}px`);
  root.style.setProperty('--edge-opacity', Number(settings.edgeOpacity ?? .38));
  root.style.setProperty('--edge-opacity-pct', `${Math.round(Number(settings.edgeOpacity ?? .38) * 100)}%`);
  root.style.setProperty('--edge-glow', `${Number(settings.edgeGlow ?? 4)}px`);
  document.body.classList.toggle('edge-off', !settings.edgeEnabled);
  applyWeatherShellTheme(root.dataset.appWeather || 'cloudy');
}

export function renderNav(onNavigate) {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  clear(nav);
  const hidden = state.screen === 'home' || document.body.classList.contains('pdv2-hero-detail');
  nav.hidden = hidden;
  nav.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  document.body.classList.toggle('pdv2-home-fullscreen', state.screen === 'home');
  if (hidden) return;
  NAV.forEach(([key, label, icon]) => {
    const button = el('button', {
      class: `nav-item ${state.screen === key ? 'active' : ''}`,
      type: 'button',
      'aria-label': label,
      onclick: () => onNavigate(key, { source: 'bottom-nav' })
    });
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPath(icon)}</svg><span>${label}</span>`;
    nav.append(button);
  });
}

export function setScreen(screen) {
  state.screen = screen;
  update('lastScreen', screen);
  applyTheme();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
