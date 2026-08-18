import jsdomPackage from 'jsdom';
const { JSDOM } = jsdomPackage;

const MAX_BYTES = 2 * 1024 * 1024;

function text(node, selectors) {
  for (const selector of selectors) {
    const el = node.querySelector(selector);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return '';
}

function linkOf(node) {
  const atomAlternate = Array.from(node.querySelectorAll('link')).find(el => {
    const rel = String(el.getAttribute('rel') || '').toLowerCase();
    return !rel || rel === 'alternate';
  });
  return atomAlternate?.getAttribute('href') || text(node, ['link', 'guid']) || '';
}

function safeDate(value) {
  const d = new Date(value || '');
  return Number.isFinite(d.getTime()) ? d : new Date(0);
}

async function readLimited(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return await response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) throw new Error('RSSが大きすぎます');
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => { merged.set(chunk, offset); offset += chunk.byteLength; });
  return new TextDecoder('utf-8').decode(merged);
}

export async function fetchRssSource(source) {
  const response = await fetch(source.url, {
    headers: {
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
      'User-Agent': 'PersonalDashboardRSS/1.0'
    },
    signal: AbortSignal.timeout(12_000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);

  const xml = await readLimited(response);
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;
  if (doc.querySelector('parsererror')) throw new Error(`${source.name}: XML parse error`);

  const nodes = Array.from(doc.querySelectorAll('item, entry'));
  return nodes.slice(0, source.maxItems || 40).map(node => {
    const title = text(node, ['title']) || '無題';
    const link = linkOf(node);
    const rawDate = text(node, ['pubDate', 'published', 'updated', 'dc\\:date', 'date']);
    const description = text(node, ['description', 'summary', 'content', 'content\\:encoded']) || title;
    const author = text(node, ['dc\\:creator', 'creator', 'author > name', 'author']) || source.name;
    return {
      title,
      link,
      pubDate: safeDate(rawDate),
      description,
      author,
      sourceName: source.name
    };
  }).filter(item => item.link && item.title);
}

export async function mergeRssSources(sources, { limit = 80 } = {}) {
  const settled = await Promise.allSettled(sources.map(fetchRssSource));
  const errors = [];
  const merged = [];

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') merged.push(...result.value);
    else errors.push(`${sources[index]?.name || 'source'}: ${result.reason?.message || 'failed'}`);
  });

  const seen = new Set();
  const deduped = merged.filter(item => {
    const key = (item.link || '').replace(/[?#].*$/, '') || item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  return { items: deduped.slice(0, limit), errors };
}

export function rssXml(title, description, items) {
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${esc(title)}</title>
<link>https://example.invalid/</link>
<description>${esc(description)}</description>
${items.map(item => `<item>
<title>${esc(item.title)}</title>
<link>${esc(item.link)}</link>
<guid isPermaLink="true">${esc(item.link)}</guid>
<pubDate>${esc(item.pubDate instanceof Date ? item.pubDate.toUTCString() : new Date(item.pubDate).toUTCString())}</pubDate>
<author>${esc(item.author || item.sourceName || '')}</author>
<category>${esc(item.sourceName || '')}</category>
<description>${esc(item.description || item.title)}</description>
</item>`).join('\n')}
</channel>
</rss>`;
}
