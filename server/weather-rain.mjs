import { inflateSync } from 'node:zlib';

const YAHOO_ENDPOINT = 'https://map.yahooapis.jp/weather/V1/place';
const JMA_TARGET_TIMES = 'https://www.jma.go.jp/bosai/jmatile/data/rasrf/targetTimes.json';
const JMA_TILE_BASE = 'https://www.jma.go.jp/bosai/jmatile/data/rasrf';
const JMA_ZOOM = 10;
const HEAVY_RAIN_MM = 20;
const HOUR_MS = 60 * 60 * 1000;

function first(value) { return Array.isArray(value) ? value[0] : value; }
function numberParam(value, min, max) {
  const number = Number(first(value));
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
function parseJmaTime(value = '') {
  const text = String(value || '');
  if (!/^\d{14}$/.test(text)) return null;
  const date = new Date(Date.UTC(
    Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)),
    Number(text.slice(8, 10)), Number(text.slice(10, 12)), Number(text.slice(12, 14))
  ));
  return Number.isFinite(date.getTime()) ? date : null;
}
function parseYahooTime(value = '') {
  const text = String(value || '');
  if (!/^\d{12}$/.test(text)) return null;
  const iso = `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}T${text.slice(8,10)}:${text.slice(10,12)}:00+09:00`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}
function severityFor(mm = 0) {
  if (mm >= 80) return '猛烈な雨';
  if (mm >= 50) return '非常に激しい雨';
  if (mm >= 30) return '激しい雨';
  if (mm >= 20) return '強い雨';
  return '雨';
}
function compactEvent({ source, at, rainfall, peakRainfall = rainfall, peakAt = at, horizon }) {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || rainfall < HEAVY_RAIN_MM) return null;
  const minutesUntil = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000));
  return {
    source,
    at: at.toISOString(),
    rainfall: Math.round(Number(rainfall) * 10) / 10,
    peakRainfall: Math.round(Number(peakRainfall) * 10) / 10,
    peakAt: peakAt instanceof Date && Number.isFinite(peakAt.getTime()) ? peakAt.toISOString() : at.toISOString(),
    severity: severityFor(peakRainfall),
    minutesUntil,
    horizon
  };
}

async function fetchYahooRain(lat, lon) {
  const appId = String(process.env.YAHOO_WEATHER_APP_ID || process.env.YAHOO_APP_ID || '').trim();
  if (!appId) return { available: false, reason: 'app-id-missing', rows: [], event: null };

  const url = new URL(YAHOO_ENDPOINT);
  url.searchParams.set('appid', appId);
  url.searchParams.set('coordinates', `${lon.toFixed(6)},${lat.toFixed(6)}`);
  url.searchParams.set('output', 'json');
  url.searchParams.set('past', '0');
  url.searchParams.set('interval', '5');

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PersonalDashboardWeather/1.0' },
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error(`Yahoo Weather HTTP ${response.status}`);
  const data = await response.json();
  const weather = data?.Feature?.[0]?.Property?.WeatherList?.Weather;
  const rows = (Array.isArray(weather) ? weather : []).map(row => ({
    type: String(row?.Type || ''),
    at: parseYahooTime(row?.Date),
    rainfall: Math.max(0, Number(row?.Rainfall || 0))
  })).filter(row => row.at && ['observation', 'forecast'].includes(row.type));

  const forecast = rows.filter(row => row.type === 'forecast');
  const heavy = forecast.filter(row => row.rainfall >= HEAVY_RAIN_MM).sort((a, b) => a.at - b.at)[0] || null;
  const max = forecast.reduce((best, row) => row.rainfall > best.rainfall ? row : best, { rainfall: 0, at: null });
  return {
    available: true,
    rows: rows.map(row => ({ type: row.type, at: row.at.toISOString(), rainfall: row.rainfall })),
    maxRainfall: max.rainfall,
    event: heavy ? compactEvent({ source: 'yahoo', at: heavy.at, rainfall: heavy.rainfall, peakRainfall: max.rainfall, peakAt: max.at, horizon: '0-60m' }) : null
  };
}

function tilePoint(lat, lon, zoom = JMA_ZOOM) {
  const n = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = ((lon + 180) / 360) * n;
  const rad = clampedLat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
  const tileX = Math.max(0, Math.min(n - 1, Math.floor(x)));
  const tileY = Math.max(0, Math.min(n - 1, Math.floor(y)));
  return {
    tileX,
    tileY,
    pixelX: Math.max(0, Math.min(255, Math.floor((x - tileX) * 256))),
    pixelY: Math.max(0, Math.min(255, Math.floor((y - tileY) * 256)))
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngPixel(buffer, x, y) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('JMA tile is not PNG');
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, transparency = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('JMA PNG chunk truncated');
    const chunk = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') transparency = chunk;
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !idat.length) throw new Error('Unsupported JMA PNG format');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 || colorType === 3 ? 1 : 0;
  if (!channels) throw new Error(`Unsupported JMA PNG color type ${colorType}`);
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (rowBytes + 1) * height) throw new Error('JMA PNG data truncated');
  let previous = Buffer.alloc(rowBytes);
  let current = Buffer.alloc(rowBytes);
  for (let row = 0; row <= y && row < height; row += 1) {
    const rowStart = row * (rowBytes + 1);
    const filter = raw[rowStart];
    const source = raw.subarray(rowStart + 1, rowStart + 1 + rowBytes);
    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i] || 0;
      const upperLeft = i >= channels ? previous[i - channels] || 0 : 0;
      let value = source[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported JMA PNG filter ${filter}`);
      current[i] = value & 255;
    }
    if (row === y) break;
    const swap = previous; previous = current; current = swap; current.fill(0);
  }
  const index = Math.max(0, Math.min(width - 1, x)) * channels;
  if (colorType === 6) return [current[index], current[index + 1], current[index + 2], current[index + 3]];
  if (colorType === 2) return [current[index], current[index + 1], current[index + 2], 255];
  if (colorType === 4) return [current[index], current[index], current[index], current[index + 1]];
  if (colorType === 0) return [current[index], current[index], current[index], 255];
  const paletteIndex = current[index];
  const p = paletteIndex * 3;
  if (!palette || p + 2 >= palette.length) return [0, 0, 0, 0];
  return [palette[p], palette[p + 1], palette[p + 2], transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255];
}

const RAIN_COLORS = [
  { rgb: [242, 242, 255], mm: 0 }, { rgb: [160, 210, 255], mm: 1 }, { rgb: [33, 140, 255], mm: 5 },
  { rgb: [0, 65, 255], mm: 10 }, { rgb: [0, 66, 255], mm: 10 }, { rgb: [250, 245, 0], mm: 20 },
  { rgb: [255, 153, 0], mm: 30 }, { rgb: [255, 153, 1], mm: 30 }, { rgb: [255, 40, 0], mm: 50 },
  { rgb: [254, 40, 3], mm: 50 }, { rgb: [180, 0, 104], mm: 80 }, { rgb: [181, 1, 103], mm: 80 },
  { rgb: [108, 0, 120], mm: 110 }, { rgb: [80, 0, 46], mm: 110 }
];
function rainfallFromPixel([r, g, b, a]) {
  if (a < 16) return 0;
  let best = { distance: Number.POSITIVE_INFINITY, mm: 0 };
  for (const row of RAIN_COLORS) {
    const distance = (r - row.rgb[0]) ** 2 + (g - row.rgb[1]) ** 2 + (b - row.rgb[2]) ** 2;
    if (distance < best.distance) best = { distance, mm: row.mm };
  }
  return best.distance <= 900 ? best.mm : 0;
}

async function jmaTargetTimes() {
  const slot = Math.floor(Date.now() / (10 * 60 * 1000));
  const response = await fetch(`${JMA_TARGET_TIMES}?_=${slot}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`JMA targetTimes HTTP ${response.status}`);
  const rows = await response.json();
  const now = Date.now();
  const minTime = now + 55 * 60 * 1000;
  const maxTime = now + 6.25 * HOUR_MS;
  const byValid = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row?.elements) || !row.elements.includes('rasrf')) continue;
    const valid = parseJmaTime(row.validtime);
    const base = parseJmaTime(row.basetime);
    if (!valid || !base || valid.getTime() < minTime || valid.getTime() > maxTime) continue;
    const previous = byValid.get(row.validtime);
    if (!previous || String(row.basetime) > String(previous.basetime)) byValid.set(row.validtime, row);
  }
  return [...byValid.values()].sort((a, b) => String(a.validtime).localeCompare(String(b.validtime))).slice(0, 6);
}

async function fetchJmaRain(lat, lon) {
  const targets = await jmaTargetTimes();
  if (!targets.length) return { available: false, reason: 'no-target-times', rows: [], event: null };
  const point = tilePoint(lat, lon);
  const settled = await Promise.allSettled(targets.map(async target => {
    const member = String(target.member || 'none');
    const url = `${JMA_TILE_BASE}/${target.basetime}/${member}/${target.validtime}/surf/rasrf/${JMA_ZOOM}/${point.tileX}/${point.tileY}.png`;
    const response = await fetch(url, { headers: { Accept: 'image/png' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`JMA tile HTTP ${response.status}`);
    const pixel = pngPixel(Buffer.from(await response.arrayBuffer()), point.pixelX, point.pixelY);
    return { at: parseJmaTime(target.validtime), rainfall: rainfallFromPixel(pixel) };
  }));
  const rows = settled.filter(row => row.status === 'fulfilled' && row.value?.at).map(row => row.value).sort((a, b) => a.at - b.at);
  if (!rows.length) throw new Error('JMA rainfall tiles unavailable');
  const heavy = rows.filter(row => row.rainfall >= HEAVY_RAIN_MM)[0] || null;
  const max = rows.reduce((best, row) => row.rainfall > best.rainfall ? row : best, { rainfall: 0, at: null });
  return {
    available: true,
    rows: rows.map(row => ({ at: row.at.toISOString(), rainfall: row.rainfall })),
    maxRainfall: max.rainfall,
    event: heavy ? compactEvent({ source: 'jma-short', at: heavy.at, rainfall: heavy.rainfall, peakRainfall: max.rainfall, peakAt: max.at, horizon: '1-6h' }) : null
  };
}

function chooseAlert(yahoo, jma) {
  const candidates = [yahoo?.event, jma?.event].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at));
  const firstEvent = candidates[0] || null;
  if (!firstEvent) return null;
  const peakRainfall = Math.max(Number(firstEvent.peakRainfall || firstEvent.rainfall || 0), Number(firstEvent.rainfall || 0));
  const minutes = Math.max(0, Number(firstEvent.minutesUntil || 0));
  const timing = minutes < 60 ? `${Math.max(5, Math.round(minutes / 5) * 5)}分後ごろ` : `約${Math.max(1, Math.round(minutes / 60))}時間後`;
  const amount = firstEvent.source === 'jma-short' ? `${Math.round(peakRainfall)}mm/h以上` : `最大${Math.round(peakRainfall)}mm/h`;
  return { ...firstEvent, peakRainfall, severity: severityFor(peakRainfall), text: `${timing}から${severityFor(peakRainfall)}のおそれ。${amount}の予報です。` };
}

export default async function weatherRain(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const lat = numberParam(req.query?.lat, -90, 90);
  const lon = numberParam(req.query?.lon, -180, 180);
  if (lat == null || lon == null) return res.status(400).json({ error: 'lat/lon are required' });

  const [yahooResult, jmaResult] = await Promise.allSettled([fetchYahooRain(lat, lon), fetchJmaRain(lat, lon)]);
  const yahoo = yahooResult.status === 'fulfilled' ? yahooResult.value : { available: false, reason: 'upstream-error', rows: [], event: null };
  const jma = jmaResult.status === 'fulfilled' ? jmaResult.value : { available: false, reason: 'upstream-error', rows: [], event: null };
  if (yahooResult.status === 'rejected') console.warn('[weather-rain] Yahoo unavailable', String(yahooResult.reason?.message || yahooResult.reason).slice(0, 240));
  if (jmaResult.status === 'rejected') console.warn('[weather-rain] JMA short forecast unavailable', String(jmaResult.reason?.message || jmaResult.reason).slice(0, 240));

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  return res.status(200).json({
    ok: yahoo.available || jma.available,
    generatedAt: new Date().toISOString(),
    alert: chooseAlert(yahoo, jma),
    sources: {
      yahoo: { available: yahoo.available, maxRainfall: Number(yahoo.maxRainfall || 0), event: yahoo.event || null },
      jmaShort: { available: jma.available, maxRainfall: Number(jma.maxRainfall || 0), event: jma.event || null }
    }
  });
}
