import { readFile, readdir } from 'node:fs/promises';

const apiDir = new URL('../api/', import.meta.url);
const vercelPath = new URL('../vercel.json', import.meta.url);
const files = (await readdir(apiDir))
  .filter(name => /\.(?:js|mjs|cjs|ts)$/.test(name))
  .sort();

const HOBBY_FUNCTION_LIMIT = 12;
const HOBBY_BUILD_RATE_PER_HOUR = 32;
const PROJECT_FUNCTION_TARGET = 4;

console.log(`Vercel API Functions: ${files.length}/${HOBBY_FUNCTION_LIMIT} (project target <= ${PROJECT_FUNCTION_TARGET})`);
files.forEach(name => console.log(` - api/${name}`));
console.log(`Estimated full deployments before the 32-build/hour Hobby ceiling: ${files.length ? Math.floor(HOBBY_BUILD_RATE_PER_HOUR / files.length) : 'n/a'} per hour`);

let failed = false;
const fail = message => { console.error(`ERROR: ${message}`); failed = true; };

if (files.length > HOBBY_FUNCTION_LIMIT) fail(`Hobby function limit ${HOBBY_FUNCTION_LIMIT} exceeded.`);
if (files.length > PROJECT_FUNCTION_TARGET) {
  fail(`This project intentionally caps top-level Vercel Functions at ${PROJECT_FUNCTION_TARGET}. Add new API routes to an existing router and keep implementation files outside /api.`);
}

const vercel = JSON.parse(await readFile(vercelPath, 'utf8'));
const wildcard = vercel?.functions?.['api/*.mjs'];
if (wildcard?.includeFiles) fail('Heavy includeFiles is applied to every API Function. Scope it only to the Function that actually needs it.');

const aiInclude = String(vercel?.functions?.['api/ai.mjs']?.includeFiles || '');
if (aiInclude && !/pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/.test(aiInclude)) {
  fail('api/ai.mjs includeFiles no longer points only at the expected pdfjs worker.');
}
for (const route of ['api/research.mjs', 'api/feeds.mjs', 'api/youtube.mjs']) {
  if (vercel?.functions?.[route]?.includeFiles) fail(`${route} must not inherit heavy includeFiles.`);
}

const crons = Array.isArray(vercel?.crons) ? vercel.crons : [];
if (crons.length) console.warn('WARNING: Hobby cron schedules must not run more than once per day. Verify each cron schedule before deployment.');

const weatherRewrite = (vercel?.rewrites || []).find(row => row?.source === '/api/weather-rain');
if (!weatherRewrite || weatherRewrite.destination !== '/api/feeds?__route=weather-rain') {
  fail('/api/weather-rain must route through the existing feeds Function.');
}

const read = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [weatherRain, weatherSources, weatherView, mediaCss, feedsRouter, twitchPlayer] = await Promise.all([
  read('server/weather-rain.mjs'),
  read('src/features/weather/weather-sources.js'),
  read('src/features/weather/weather.js'),
  read('src/styles/v2195.css'),
  read('api/feeds.mjs'),
  read('src/features/twitch/twitch-player.js')
]);

if (/@napi-rs\/canvas|pdfjs-dist/.test(weatherRain)) fail('Weather rain processing must not pull canvas/pdfjs into the feeds Function.');
if (!weatherRain.includes("from 'node:zlib'")) fail('Weather rain tile decoding should use Node built-ins only.');
if (!/s-maxage=300/.test(weatherRain)) fail('Short-rain endpoint must keep a CDN cache to limit invocations/upstream calls.');
if (!/jma_msm/.test(weatherSources)) fail('Hourly weather must explicitly use Open-Meteo JMA MSM.');
if (!/best_match/.test(weatherSources)) fail('Current/weekly weather must explicitly use Open-Meteo Best Match.');
if (!/fetchRapidRainAlert/.test(weatherView) || !/if \(alertNode && card\.isConnected\) card\.append\(alertNode\)/.test(weatherView)) {
  fail('Heavy-rain UI must remain conditional instead of changing the normal weather layout.');
}

// v2.19.6: the landscape button must always rotate only the media stage by exactly 90 degrees.
if (!/\.youtube-inline-stage\s*\{[\s\S]*?width:\s*100dvh[\s\S]*?height:\s*100dvw[\s\S]*?rotate\(90deg\)/.test(mediaCss)) {
  fail('Landscape mode must size the stage to the swapped viewport and rotate it by 90 degrees.');
}
if (/\.youtube-landscape-viewport\s*\{[^}]*rotate\(90deg\)/s.test(mediaCss)) {
  fail('Landscape viewport/controls must stay upright; rotate only the video stage.');
}
if (/@media\s*\(orientation:\s*landscape\)[\s\S]*?\.youtube-inline-stage[\s\S]*?transform:\s*none/.test(mediaCss)) {
  fail('Landscape stage rotation must not be disabled by the physical device orientation.');
}
if (!/pdv2-landscape-ui-visible[\s\S]*youtube-landscape-controls/.test(mediaCss) && !/youtube-css-landscape\.pdv2-landscape-ui-visible[\s\S]*youtube-landscape-controls/.test(mediaCss)) {
  fail('Tap-only landscape controls must remain visible while the UI-visible state is active.');
}
if (!/landscapePrev[\s\S]*portrait[\s\S]*landscapeNext/.test(twitchPlayer)) {
  fail('Twitch landscape controls must retain previous / portrait / next actions.');
}
if (!/\['weather-rain',\s*weatherRain\]/.test(feedsRouter)) fail('feeds router is missing the weather-rain route.');

if (failed) process.exit(1);
console.log('Hobby guard: OK (4 Functions, scoped heavy dependencies, cached weather route, stage-only 90deg landscape, Twitch controls).');
