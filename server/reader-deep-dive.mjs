import { getCache } from '@vercel/functions';

const TAVILY_URL = 'https://api.tavily.com/search';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const FREE_TIMEOUT_MS = 1100;
const TAVILY_TIMEOUT_MS = 1250;
const LOG = '[READER_DEEP_DIVE_DEBUG]';
const lanes = ['timeline', 'perspectives', 'future'];
const blocked = ['x.com','twitter.com','facebook.com','instagram.com','tiktok.com','reddit.com','youtube.com','youtu.be'];
const memory = new Map();
const flight = new Map();

const clean = (v = '', n = 1200) => String(v || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (v = '', n = 76) => { const a = Array.from(clean(v, n + 24)); return a.length <= n ? a.join('') : `${a.slice(0, n - 1).join('')}…`; };
const safeUrl = (v = '') => { try { const u = new URL(String(v || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
const host = (v = '') => { try { return new URL(v).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const norm = (v = '') => clean(v, 1800).toLowerCase().normalize('NFKC').replace(/[\s。、，,.!！?？:：;；"'“”‘’「」『』（）()【】\[\]<>・･＝=\-—–_]/g, '');
const traceId = () => `dd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const log = (event, id, data = {}) => { try { console.log(`${LOG} ${JSON.stringify({ event, traceId: id, ts: new Date().toISOString(), ...data })}`); } catch {} };
const errorInfo = e => ({ name: clean(e?.name || 'Error', 60), message: clean(e?.message || String(e), 400), status: Number(e?.statusCode || 0) || undefined });

function hash(value = '') {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function decodeXml(value = '') {
  return String(value)
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0))
    .trim();
}
function xmlValue(block, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(block || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
}
function stripHtml(value = '') { return clean(decodeXml(String(value).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')), 1400); }
function itemBlocks(xml = '') { return String(xml).match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []; }

function baseTitle(title = '') {
  return clean(title, 260)
    .replace(/\s+(?:-|–|—|｜|\|)\s+[^｜|]{2,40}\s*$/, '')
    .replace(/[「『“"]([^」』”"]{8,60})[」』”"]/g, (all, q) => /受け止め|思う|考え|述べ|話し|語り|謝罪|批判|コメント|発言/.test(q) ? ' ' : all)
    .replace(/\s+/g, ' ')
    .trim();
}
function subjectTerms(b) {
  const text = `${baseTitle(b.title)} ${clean(b.summary, 360)}`;
  const stop = /^(?:速報|最新|発表|明らか|ニュース|記事|今回|これ|それ|について|として|による|する|した|される|された|へ|を|が|は|の|と|に|で)$/i;
  const tokens = text
    .replace(/[「」『』“”"'（）()【】\[\]<>]/g, ' ')
    .split(/[\s　、。・:：｜|／/\-—]+/)
    .map(x => x.trim())
    .filter(x => Array.from(x).length >= 2 && Array.from(x).length <= 30 && !stop.test(x));
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const k = norm(token);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(token);
    if (out.length >= 7) break;
  }
  return out;
}
function subjectQuery(b) {
  const terms = subjectTerms(b);
  return clean(terms.join(' ') || baseTitle(b.title) || b.title, 150);
}
function eventKey(b) {
  const terms = subjectTerms(b).slice(0, 5).map(norm).filter(Boolean).sort();
  return hash(terms.join('|') || norm(baseTitle(b.title) || b.articleId));
}
function detectLanguage(v = '') {
  const x = clean(v, 600), ja = (x.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length, en = (x.match(/[A-Za-z]/g) || []).length;
  return ja >= 4 && ja >= en * .35 ? 'ja' : 'en';
}
function relevant(row, terms) {
  if (!row?.url || !row?.title) return false;
  const blob = norm(`${row.title} ${row.content}`);
  let hits = 0;
  for (const term of terms) if (blob.includes(norm(term))) hits += 1;
  return hits >= Math.min(2, Math.max(1, terms.length)) || Number(row.score || 0) >= .55;
}
function dedupe(rows = []) {
  const seen = new Set();
  return rows.filter(row => {
    const k = safeUrl(row?.url).replace(/[?#].*$/, '') || norm(row?.title);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function normalizeDate(v = '') {
  const d = new Date(String(v || ''));
  if (Number.isFinite(d.getTime()) && d.getTime() > 0) return d;
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:00Z`);
  return new Date(0);
}
function dateLabel(v = '') {
  const d = normalizeDate(v);
  if (!d.getTime()) return '';
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function actor(row) {
  const direct = clean(row?.source, 34);
  if (direct) return clip(direct, 28);
  const head = clean(row?.title, 110).split(/[|｜:：—–-]/)[0].trim();
  return clip(head && head.length <= 34 ? head : host(row?.url).split('.')[0], 28);
}
function stance(v = '') {
  return /(懸念|慎重|課題|問題|リスク|批判|反対|懐疑|concern|risk|critic|caution|oppose|skeptic)/i.test(v) ? '慎重'
    : /(歓迎|支持|期待|推進|成長|評価|賛成|support|welcome|growth|positive|approve)/i.test(v) ? '推進'
    : '中立';
}
function tag(v = '') {
  return /法改正|legislation/i.test(v) ? '法改正' : /新技術|technology|prototype|新製品/i.test(v) ? '新技術' : /買収|acqui/i.test(v) ? '買収' : /投資|investment|funding/i.test(v) ? '投資' : /提携|partnership|alliance/i.test(v) ? '提携' : /規制|regulat/i.test(v) ? '規制' : /決算|earnings|results/i.test(v) ? '決算' : /発表|announce|launch/i.test(v) ? '発表' : '転換点';
}
function sentence(row, n = 78) { return clip(clean(row?.content || row?.title, 900) || row?.title, n); }

function buildLane(lane, rows = []) {
  const o = { timeline: [], perspectives: [], regionGap: [], future: [], nextWatch: [] };
  if (lane === 'timeline') {
    const seen = new Set();
    o.timeline = [...rows]
      .sort((a, b) => normalizeDate(a.publishedDate) - normalizeDate(b.publishedDate))
      .map(row => {
        const date = dateLabel(row.publishedDate);
        const text = sentence(row, 88);
        const k = `${date}:${norm(text).slice(0, 64)}`;
        if (!date || !text || seen.has(k)) return null;
        seen.add(k);
        return { date, tag: tag(`${row.title} ${row.content}`), text, metric: '', quote: '', sourceUrl: row.url };
      })
      .filter(Boolean)
      .slice(0, 4);
  }
  if (lane === 'perspectives') {
    const views = [];
    const seenHosts = new Set();
    for (const row of rows) {
      const h = host(row.url);
      if (!h || seenHosts.has(h)) continue;
      seenHosts.add(h);
      views.push({ stance: stance(`${row.title} ${row.content}`), actor: actor(row), text: sentence(row, 82), sourceUrl: row.url });
      if (views.length >= 3) break;
    }
    if (views.length) o.perspectives = [{ issue: '主な見方・論点', views }];
  }
  if (lane === 'future') {
    const factRe = /(予定|決定|開催|施行|発売|開始|導入|実施|承認|計画|scheduled|will\s|launch|approval|plan|next)/i;
    const expertRe = /(専門家|アナリスト|予測|見通し|見解|forecast|analyst|expects?|outlook|estimate)/i;
    const scenarioRe = /(場合|なら|可能性|条件|could|may|might|if\s)/i;
    for (const row of rows) {
      const blob = `${row.title} ${row.content}`;
      const fact = factRe.test(blob), expert = expertRe.test(blob), scenario = scenarioRe.test(blob);
      if (!fact && !expert && !scenario) continue;
      const type = fact ? 'fact' : expert ? 'expert' : 'scenario';
      o.future.push({ type, timeframe: '短期', actor: type === 'fact' ? '' : actor(row), text: sentence(row, 86), impactMarket: 'unknown', impactLife: 'unknown', sourceUrl: row.url });
      const d = dateLabel(row.publishedDate);
      if (d && fact) o.nextWatch.push({ date: d, event: sentence(row, 66), sourceUrl: row.url });
      if (o.future.length >= 3 && o.nextWatch.length >= 2) break;
    }
    o.future = o.future.slice(0, 3);
    o.nextWatch = o.nextWatch.slice(0, 2);
  }
  return o;
}
function laneCount(lane, data = {}) {
  if (lane === 'timeline') return data.timeline?.length || 0;
  if (lane === 'perspectives') return data.perspectives?.reduce((n, x) => n + (x?.views?.length || 0), 0) || 0;
  return (data.future?.length || 0) + (data.nextWatch?.length || 0);
}
function enough(lane, data) {
  return lane === 'timeline' ? laneCount(lane, data) >= 2 : lane === 'perspectives' ? laneCount(lane, data) >= 2 : laneCount(lane, data) >= 1;
}

async function runtimeGet(key) {
  try { return await getCache().get(key); }
  catch (e) { console.warn(`${LOG} runtime_cache_get_failed`, clean(e?.message || e, 180)); return null; }
}
async function runtimeSet(key, value, tagName, ttl = CACHE_TTL_SECONDS) {
  try { await getCache().set(key, value, { ttl, tags: tagName ? [tagName] : undefined }); }
  catch (e) { console.warn(`${LOG} runtime_cache_set_failed`, clean(e?.message || e, 180)); }
}
function memoryGet(key) {
  const row = memory.get(key);
  if (!row || Date.now() - row.at > CACHE_TTL_MS) { memory.delete(key); return null; }
  return row.value;
}
function memorySet(key, value) {
  memory.set(key, { at: Date.now(), value });
  while (memory.size > 96) memory.delete(memory.keys().next().value);
}
async function cached(key) {
  const local = memoryGet(key);
  if (local) return { value: local, cache: 'memory' };
  const remote = await runtimeGet(key);
  if (remote) { memorySet(key, remote); return { value: remote, cache: 'runtime' }; }
  return null;
}

async function fetchText(url, timeoutMs = FREE_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: '*/*', 'User-Agent': 'new-wnt-getting/reader-deep-dive-v7' }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}
function parseGoogleNews(xml = '') {
  return itemBlocks(xml).map(block => {
    const source = stripHtml(xmlValue(block, 'source')) || 'Google News';
    const titleRaw = stripHtml(xmlValue(block, 'title'));
    const title = source ? titleRaw.replace(new RegExp(`\\s+-\\s+${String(source).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'i'), '').trim() || titleRaw : titleRaw;
    const url = safeUrl(stripHtml(xmlValue(block, 'link')));
    const publishedDate = stripHtml(xmlValue(block, 'pubDate'));
    const description = stripHtml(xmlValue(block, 'description'));
    return title && url ? { title, url, content: description || title, publishedDate, source, score: .7 } : null;
  }).filter(Boolean);
}
async function googleLane(query, lane) {
  const suffix = lane === 'timeline' ? '経緯 過去 背景' : lane === 'perspectives' ? '反応 評価 専門家 懸念' : '今後 予定 見通し 日程';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} ${suffix}`)}&hl=ja&gl=JP&ceid=JP:ja`;
  const xml = await fetchText(url, FREE_TIMEOUT_MS);
  return parseGoogleNews(xml).slice(0, 16);
}
async function gdelt(query) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=35&format=json&sort=HybridRel&timespan=1y`;
  const text = await fetchText(url, FREE_TIMEOUT_MS);
  const data = JSON.parse(text);
  return (Array.isArray(data?.articles) ? data.articles : []).map((x, i) => ({
    title: clean(x?.title, 220), url: safeUrl(x?.url), content: clean(x?.title, 820), publishedDate: clean(x?.seendate || x?.date, 50), source: clean(x?.domain, 80), score: Math.max(.3, .65 - i * .01)
  })).filter(x => x.title && x.url);
}
async function freeBundle(b, id) {
  const ek = eventKey(b), cacheKey = `reader-deep-dive:free:v7:${ek}`;
  const hit = await cached(cacheKey);
  if (hit) { log('free_cache_hit', id, { eventKey: ek, cache: hit.cache }); return { ...hit.value, cache: hit.cache }; }
  if (flight.has(cacheKey)) return flight.get(cacheKey);
  const promise = (async () => {
    const query = subjectQuery(b), terms = subjectTerms(b);
    const jobs = await Promise.allSettled([googleLane(query, 'timeline'), googleLane(query, 'perspectives'), googleLane(query, 'future'), gdelt(query)]);
    const past = jobs[0].status === 'fulfilled' ? jobs[0].value : [];
    const views = jobs[1].status === 'fulfilled' ? jobs[1].value : [];
    const future = jobs[2].status === 'fulfilled' ? jobs[2].value : [];
    const gd = jobs[3].status === 'fulfilled' ? jobs[3].value : [];
    const filter = rows => dedupe([...rows, ...gd].filter(row => relevant(row, terms))).slice(0, 18);
    const value = { eventKey: ek, query, at: Date.now(), evidence: { timeline: filter(past), perspectives: filter(views), future: filter(future) }, sourceMode: 'google-news+gdelt' };
    memorySet(cacheKey, value);
    await runtimeSet(cacheKey, value, `reader-deep-dive-${ek}`);
    log('free_complete', id, { eventKey: ek, query, timeline: value.evidence.timeline.length, perspectives: value.evidence.perspectives.length, future: value.evidence.future.length, failures: jobs.filter(x => x.status === 'rejected').length });
    return value;
  })().finally(() => flight.delete(cacheKey));
  flight.set(cacheKey, promise);
  return promise;
}

async function tavilyFallback(b, id) {
  const ek = eventKey(b), cacheKey = `reader-deep-dive:tavily:v7:${ek}`;
  const hit = await cached(cacheKey);
  if (hit) { log('tavily_cache_hit', id, { eventKey: ek, cache: hit.cache, count: hit.value?.rows?.length || 0 }); return { ...hit.value, cache: hit.cache }; }
  if (flight.has(cacheKey)) return flight.get(cacheKey);
  const promise = (async () => {
    const api = clean(process.env.TAVILY_API_KEY, 300);
    if (!api) return { eventKey: ek, rows: [], at: Date.now(), unavailable: 'missing-key' };
    const query = clean(`${subjectQuery(b)} 背景 経緯 過去 反応 評価 専門家 今後 予定 見通し`, 220);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TAVILY_TIMEOUT_MS);
    const started = Date.now();
    try {
      log('tavily_start', id, { eventKey: ek, query, timeoutMs: TAVILY_TIMEOUT_MS });
      const r = await fetch(TAVILY_URL, { method: 'POST', headers: { Authorization: `Bearer ${api}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, search_depth: 'basic', max_results: 8, topic: 'general', include_answer: false, include_raw_content: false, include_images: false, safe_search: true, exclude_domains: blocked }), signal: ac.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data?.detail?.error || data?.detail || `Tavily HTTP ${r.status}`); e.statusCode = r.status; throw e; }
      const terms = subjectTerms(b);
      const rows = dedupe((Array.isArray(data?.results) ? data.results : []).map(x => ({ title: clean(x?.title, 220), url: safeUrl(x?.url), content: clean(x?.content, 900), publishedDate: clean(x?.published_date || x?.publishedDate, 50), source: host(x?.url), score: Number(x?.score || 0) })).filter(x => x.title && x.url && x.content && relevant(x, terms))).slice(0, 8);
      const value = { eventKey: ek, rows, at: Date.now(), sourceMode: 'tavily-fallback-v7' };
      memorySet(cacheKey, value);
      await runtimeSet(cacheKey, value, `reader-deep-dive-${ek}`);
      log('tavily_success', id, { eventKey: ek, elapsedMs: Date.now() - started, count: rows.length });
      return value;
    } catch (e) {
      const value = { eventKey: ek, rows: [], at: Date.now(), unavailable: e?.name === 'AbortError' ? 'timeout' : 'error' };
      memorySet(cacheKey, value);
      // Short negative cache prevents repeated quota use when Tavily is temporarily unavailable.
      await runtimeSet(cacheKey, value, `reader-deep-dive-${ek}`, 15 * 60);
      log('tavily_error', id, { eventKey: ek, elapsedMs: Date.now() - started, error: errorInfo(e), negativeCacheSeconds: 900 });
      return value;
    } finally { clearTimeout(timer); }
  })().finally(() => flight.delete(cacheKey));
  flight.set(cacheKey, promise);
  return promise;
}

function responseFor(b, lane, free, tavily = null) {
  const freeRows = free?.evidence?.[lane] || [];
  const fallbackRows = Array.isArray(tavily?.rows) ? tavily.rows : [];
  const rows = dedupe([...freeRows, ...fallbackRows]);
  const built = buildLane(lane, rows);
  return {
    articleId: b.articleId,
    lane,
    phase: 'search',
    generatedAt: Date.now(),
    ...built,
    evidence: [],
    sourceCount: new Set(rows.map(x => host(x.url)).filter(Boolean)).size,
    sourceLanguage: b.sourceLanguage,
    queryMode: 'free-first-shared-event-cache-v7',
    sourceMode: fallbackRows.length ? 'google-news+gdelt+tavily-fallback' : 'google-news+gdelt',
    eventKey: free?.eventKey || eventKey(b),
    tavilyUsed: Boolean(fallbackRows.length),
    tavilyFallbackAvailable: Boolean(process.env.TAVILY_API_KEY),
    freeEvidenceCount: freeRows.length,
    fallbackEvidenceCount: fallbackRows.length
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const phase = raw.phase === 'enrich' ? 'enrich' : 'search';
  const title = clean(raw.title, 260), lane = lanes.includes(String(raw.lane || '')) ? String(raw.lane) : '';
  if (!title || !lane) return res.status(400).json({ error: !title ? 'title is required' : 'lane is required' });
  const sourceLanguage = raw.sourceLanguage === 'ja' || raw.sourceLanguage === 'en' ? raw.sourceLanguage : detectLanguage(title);
  const b = { articleId: clean(raw.articleId || raw.url || title, 700), title, source: clean(raw.source, 120), category: clean(raw.category, 120), url: safeUrl(raw.url), summary: clean(raw.summary, 700), sourceLanguage };
  const id = traceId();
  log('request_received', id, { phase, lane, articleId: b.articleId, title: b.title, sourceLanguage, eventKey: eventKey(b), hasTavilyKey: Boolean(process.env.TAVILY_API_KEY) });

  if (phase === 'enrich') {
    // Search responses are already structured from grounded Google News/GDELT/Tavily evidence.
    // Returning a no-op keeps older clients compatible without adding Gemini latency.
    return res.status(200).json({ articleId: b.articleId, lane, phase: 'enrich', enriched: false, evidence: [], timeline: raw.timeline || [], perspectives: raw.perspectives || [], regionGap: raw.regionGap || [], future: raw.future || [], nextWatch: raw.nextWatch || [] });
  }

  try {
    const free = await freeBundle(b, id);
    let out = responseFor(b, lane, free, null);
    if (!enough(lane, out)) {
      const fallback = await tavilyFallback(b, id);
      out = responseFor(b, lane, free, fallback);
    }
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('X-Reader-Deep-Dive-Mode', out.sourceMode);
    res.setHeader('X-Reader-Deep-Dive-Event', out.eventKey);
    res.setHeader('X-Reader-Deep-Dive-Tavily', out.tavilyUsed ? 'used' : 'not-used');
    log('request_complete', id, { lane, eventKey: out.eventKey, sourceMode: out.sourceMode, tavilyUsed: out.tavilyUsed, count: laneCount(lane, out), sourceCount: out.sourceCount });
    return res.status(200).json(out);
  } catch (e) {
    const status = Number(e?.statusCode || (e?.name === 'AbortError' ? 504 : 500));
    log('request_error', id, { lane, status, error: errorInfo(e) });
    return res.status(status).json({ error: status === 504 ? '深掘り情報の取得が時間内に完了しませんでした' : '深掘り情報を取得できませんでした' });
  }
}
