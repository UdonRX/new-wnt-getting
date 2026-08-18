const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cloudSun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M3 3l1.4 1.4M11.6 4.4 13 3"/><path d="M7 19h11a4 4 0 0 0 .2-8 5.5 5.5 0 0 0-10.5 2A3.5 3.5 0 0 0 7 19Z"/>',
  cloud: '<path d="M5.5 18h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 18Z"/>',
  fog: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="M4 18h16M6 21h12"/>',
  drizzle: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="M8 18h.01M12 20h.01M16 18h.01"/>',
  rain: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="m8 18-1 3M13 18l-1 3M18 18l-1 3"/>',
  shower: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="m8 18-1 3M13 18l-1 3M18 18l-1 3"/><path d="M3 5h2M4 4v2"/>',
  snow: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="M7 18h.01M12 20h.01M17 18h.01M9 22h.01M15 22h.01"/>',
  thunder: '<path d="M5.5 14h12a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.3 1.4A3.5 3.5 0 0 0 5.5 14Z"/><path d="m13 15.5-3 4h3l-2 3.5 5-5h-3l2-2.5"/>',
  umbrella: '<path d="M4 12a8 8 0 0 1 16 0Z"/><path d="M12 12v6.5a2.5 2.5 0 0 0 5 0"/>',
  down: '<path d="M12 4v15M6.5 13.5 12 19l5.5-5.5"/>',
  up: '<path d="M12 20V5M6.5 10.5 12 5l5.5 5.5"/>',
  wind: '<path d="M3 8h10.5a2.5 2.5 0 1 0-2.3-3.5M3 12h15a2.5 2.5 0 1 1-2.3 3.5M3 16h7"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};

export function iconSvg(name, { size = 24, className = '' } = {}) {
  const body = PATHS[name] || PATHS.cloud;
  return `<svg class="weather-glyph ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" ${STROKE}>${body}</svg>`;
}

export function weatherVisual(code) {
  const c = Number(code);
  if (c === 0) return { icon: 'sun', label: '快晴' };
  if (c <= 2) return { icon: 'cloudSun', label: '晴れ' };
  if (c === 3) return { icon: 'cloud', label: 'くもり' };
  if ([45, 48].includes(c)) return { icon: 'fog', label: '霧' };
  if (c >= 51 && c <= 57) return { icon: 'drizzle', label: '小雨' };
  if (c >= 61 && c <= 67) return { icon: 'rain', label: '雨' };
  if (c >= 71 && c <= 77) return { icon: 'snow', label: '雪' };
  if (c >= 80 && c <= 82) return { icon: 'shower', label: 'にわか雨' };
  if (c >= 85 && c <= 86) return { icon: 'snow', label: '雪' };
  if (c >= 95) return { icon: 'thunder', label: '雷雨' };
  return { icon: 'cloud', label: 'くもり' };
}
