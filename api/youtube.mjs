import youtubeFeed from '../server/youtube-feed.mjs';
import youtubeDiscovery from '../server/youtube-discovery.mjs';

export default async function handler(req, res) {
  try {
    const action=String(req.query?.action||req.body?.action||'').trim();
    if(action) return await youtubeDiscovery(req,res);
    return await youtubeFeed(req, res);
  } catch (error) {
    console.error('[api-youtube-router]', { name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
