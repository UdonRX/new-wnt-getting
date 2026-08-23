import creativePapersFeed from '../server/creative-papers-feed.mjs';
import papersFeed from '../server/papers-feed.mjs';
import wikipedia from '../server/wikipedia.mjs';

const handlers = new Map([
  ['creative-papers-feed', creativePapersFeed],
  ['papers-feed', papersFeed],
  ['wikipedia', wikipedia]
]);

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const target = handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  try {
    return await target(req, res);
  } catch (error) {
    console.error('[api-research-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
