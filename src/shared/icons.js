const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V21h14V10.5"/><path d="M9 21v-6h6v6"/>',
  weather: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13"/><path d="M8 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2"/>',
  reader: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  news: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  knowledge: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z"/>',
  papers: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  media: '<path d="m9 7 8 5-8 5z"/><rect x="3" y="4" width="18" height="16" rx="4"/>',
  youtube: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/>',
  twitch: '<path d="M5 3h16v11l-5 5h-4l-3 3v-3H5z"/><path d="M10 8v5M16 8v5"/>',
  twitter: '<path style="fill:currentColor;stroke:none" d="M21.2 6.1c-.7.3-1.4.5-2.2.6.8-.5 1.4-1.2 1.7-2-.8.5-1.7.8-2.6 1A3.7 3.7 0 0 0 11.7 8c0 .3 0 .6.1.9-3.1-.2-5.9-1.7-7.8-4-.4.6-.6 1.3-.6 2.1 0 1.4.7 2.7 1.8 3.4-.6 0-1.2-.2-1.7-.5v.1c0 2 1.4 3.6 3.3 4-.3.1-.7.2-1.1.2-.3 0-.5 0-.8-.1.5 1.6 2 2.8 3.8 2.8A7.5 7.5 0 0 1 4 18.5c-.3 0-.6 0-.9-.1A10.5 10.5 0 0 0 8.8 20c6.8 0 10.6-5.7 10.6-10.6v-.5c.7-.5 1.3-1.1 1.8-1.8z"/>',
  wikipedia: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z"/><path d="m7.5 7 1.5 8 3-6 3 6 1.5-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.1 6.2L4 8M5.8 15A7 7 0 0 0 17.9 17.8L20 16"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'
};

export function iconPath(name) {
  return PATHS[name] || PATHS.reader;
}

export function iconSvg(name, { size = 22, className = '', strokeWidth = 1.8 } = {}) {
  return `<svg class="app-icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${iconPath(name)}</svg>`;
}
