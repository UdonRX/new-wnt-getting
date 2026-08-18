import { state, update } from './store.js';
import { el, clear } from '../shared/dom.js';

const NAV = [
  ['home','ホーム','<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V21h14V10.5"/><path d="M9 21v-6h6v6"/>'],
  ['weather','天気','<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13"/><path d="M8 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2"/>'],
  ['reader','読む','<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>'],
  ['media','動画','<path d="m9 7 8 5-8 5z"/><rect x="3" y="4" width="18" height="16" rx="4"/>'],
  ['twitter','SNS','<path d="M4 5h16v12H8l-4 4z"/><path d="M8 9h8M8 13h5"/>']
];

const featureColorKey = screen => {
  if (screen === 'media') return state.mediaMode;
  if (screen === 'reader') return state.readerMode;
  return screen;
};

export function applyTheme() {
  const settings = state.settings;
  const key = featureColorKey(state.screen);
  const color = settings.colors[key] || settings.colors.home;
  const root = document.documentElement;
  root.style.setProperty('--feature-color', color);
  root.style.setProperty('--edge-width', `${Number(settings.edgeWidth || 2)}px`);
  root.style.setProperty('--edge-opacity', Number(settings.edgeOpacity ?? .66));
  root.style.setProperty('--edge-opacity-pct', `${Math.round(Number(settings.edgeOpacity ?? .66) * 100)}%`);
  root.style.setProperty('--edge-glow', `${Number(settings.edgeGlow ?? 10)}px`);
  root.style.setProperty('--glass-opacity', Number(settings.glassOpacity ?? .70));
  root.style.setProperty('--glass-opacity-pct', `${Math.round(Number(settings.glassOpacity ?? .70) * 100)}%`);
  root.style.setProperty('--glass-blur', `${Number(settings.glassBlur || 28)}px`);
  document.body.classList.toggle('edge-off', !settings.edgeEnabled);
  document.body.classList.toggle('glass-off', !settings.glassEnabled);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export function renderNav(onNavigate) {
  const nav = document.getElementById('bottom-nav');
  clear(nav);
  NAV.forEach(([key,label,path]) => {
    const button = el('button', { class:`nav-item ${state.screen===key?'active':''}`, type:'button', 'aria-label':label, onclick:()=>onNavigate(key) });
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg><span>${label}</span>`;
    nav.append(button);
  });
}

export function setScreen(screen) {
  state.screen = screen;
  update('lastScreen', screen);
  applyTheme();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
