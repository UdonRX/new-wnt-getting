import chat from '../server/chat.mjs';
import rankItems from '../server/rank-items.mjs';
import summary from '../server/reader-summary.mjs';

const handlers = new Map([
  ['chat', chat],
  ['rank-items', rankItems],
  ['summary', summary]
]);

function rawBody(req) {
  if (typeof req?.body === 'string') {
    try { return JSON.parse(req.body); }
    catch { return {}; }
  }
  return req?.body && typeof req.body === 'object' ? req.body : {};
}

function installReaderSourceRecovery(req, route) {
  if (route !== 'summary' || req.method !== 'POST') return;
  const body = rawBody(req);
  const recovery = String(body?.readerSourceRecovery || '').trim();
  const preferFullText = body?.preferFullText === true || String(body?.preferFullText || '').toLowerCase() === 'true';
  if (!recovery || !preferFullText) return;

  // Google News / EE Times recovery is explicitly requesting the publisher article.
  // Keep it out of Reader's RSS-fast path so a short RSS description cannot be
  // accepted before the full-text extractor gets a chance to run.
  req.body = {
    ...body,
    mode: 'reader-source-recovery',
    fast: false,
    rssOnly: false,
    preferFullText: true
  };
  console.info('[summary-source-recovery-router]', {
    articleId: String(body?.articleId || '').slice(0, 180),
    recovery,
    source: String(body?.source || body?.feedName || '').slice(0, 120)
  });
}

export default async function handler(req, res) {
  const route = String(req.query?.__route || '').trim();
  const target = handlers.get(route);
  if (!target) return res.status(404).json({ error: 'Unknown API route', route });

  installReaderSourceRecovery(req, route);

  try {
    return await target(req, res);
  } catch (error) {
    console.error('[api-ai-router]', { route, name: error?.name, message: error?.message || String(error) });
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'API request failed' });
  }
}
