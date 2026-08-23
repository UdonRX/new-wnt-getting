import chat from '../server/chat.mjs';
import rankItems from '../server/rank-items.mjs';
import summary from '../server/summary.mjs';

const handlers = new Map([
  ['chat', chat],
  ['rank-items', rankItems],
  ['summary', summary]
]);

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const target = handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  try {
    return await target(req, res);
  } catch (error) {
    console.error('[api-ai-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
