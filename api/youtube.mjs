import youtubeFeed from '../server/youtube-feed.mjs';

export default async function handler(req, res) {
  try {
    return await youtubeFeed(req, res);
  } catch (error) {
    console.error('[api-youtube-router]', { name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
