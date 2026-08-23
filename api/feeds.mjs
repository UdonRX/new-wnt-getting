import newsFeed from '../server/news-feed.mjs';
import rss from '../server/rss.mjs';
import twitchEventsub from '../server/twitch-eventsub.mjs';
import twitchFeed from '../server/twitch-feed.mjs';
import weatherRain from '../server/weather-rain.mjs';

const handlers = new Map([
  ['news-feed', newsFeed],
  ['rss', rss],
  ['twitch-eventsub', twitchEventsub],
  ['twitch-feed', twitchFeed],
  ['weather-rain', weatherRain]
]);

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const target = handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  try {
    return await target(req, res);
  } catch (error) {
    console.error('[api-feeds-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
