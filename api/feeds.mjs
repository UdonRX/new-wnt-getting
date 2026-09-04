import newsFeed from '../server/news-feed.mjs';
import recommendations from '../server/recommendations.mjs';
import rss from '../server/rss.mjs';
import twitchEventsub from '../server/twitch-eventsub.mjs';
import twitchFeed from '../server/twitch-feed.mjs';
import weatherRain from '../server/weather-rain.mjs';
import xHistory, { isXHistoryRequest } from '../server/x-history.mjs';

const handlers = new Map([
  ['news-feed', newsFeed],
  ['recommendations', recommendations],
  ['rss', rss],
  ['twitch-eventsub', twitchEventsub],
  ['twitch-feed', twitchFeed],
  ['weather-rain', weatherRain],
  ['x-history', xHistory]
]);

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  // Keep the public X URL unchanged. Only this one fixed RSS source is served from Redis history first.
  const target = route === 'rss' && isXHistoryRequest(req) ? xHistory : handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  try {
    return await target(req, res);
  } catch (error) {
    console.error('[api-feeds-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
