const GOOGLE_NEWS_URL = 'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja';
const GOOGLE_TRENDS_URL = 'https://trends.google.com/trending/rss?geo=JP';
const RECOMMENDATION_TTL_MS = 10 * 60 * 1000;
const TRENDS_TTL_MS = 15 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2600;
const GDELT_TIMEOUT_MS = 2200;
const GDELT_CHECK_COUNT = 4;
const MAX_GOOGLE_NEWS = 20;
const MAX_RECOMMENDATIONS = 10;

let recommendationCache = { at: 0, payload: null };
let trendsCache = { at: 0, rows: null };

const IMPORTANT_RULES = [
  { category: '災害', score: 34, re: /地震|津波|台風|豪雨|大雨|洪水|土砂|噴火|竜巻|避難|特別警報|災害|山火事|停電/i },
  { category: '戦争・国際', score: 32, re: /戦争|侵攻|攻撃|空爆|ミサイル|停戦|軍事|武力|紛争|制裁|首脳会談|国連|NATO|ウクライナ|ロシア|中国|台湾|北朝鮮|中東|イスラエル|ガザ|イラン/i },
  { category: '政治', score: 29, re: /首相|総理|内閣|国会|衆院|参院|選挙|与党|野党|法案|法律|規制|閣議|大臣|知事|政権|政治/i },
  { category: '経済', score: 27, re: /日銀|金利|利上げ|利下げ|円安|円高|為替|株価|GDP|物価|インフレ|景気|関税|雇用|失業|倒産|決算|買収|経済/i },
  { category: '重大事故', score: 31, re: /墜落|衝突|爆発|火災|死者|死亡|負傷者|列車事故|航空事故|重大事故|事故/i },
  { category: '大規模障害', score: 30, re: /大規模障害|通信障害|システム障害|サービス停止|障害発生|サイバー攻撃|ランサムウェア|情報流出|広域停電/i },
  { category: '社会', score: 20, re: /感染症|新型ウイルス|医療|食品|回収|リコール|教育|少子化|社会保障|最高裁|判決/i },
  { category: '技術', score: 16, re: /AI|人工知能|半導体|量子|宇宙|ロケット|原発|エネルギー|新技術|サイバー/i }
];
const SOFT_NEWS_RE = /芸能|俳優|女優|アイドル|タレント|歌手|ドラマ|映画|アニメ|漫画|結婚|熱愛|不倫|離婚|スポーツ|野球|サッカー|Jリーグ|プロ野球|大谷|ドジャース|試合|勝利|敗戦|ゴール|得点|移籍/i;
const LOW_VALUE_RE = /占い|ランキング|まとめ|コラム|レビュー|キャンペーン|セール|プレゼント|新商品発売|新メニュー/i;

function requestId() {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowMs() { return Date.now(); }
function fresh(cache, ttl) { return Boolean(cache?.payload || cache?.rows) && nowMs() - Number(cache.at || 0) < ttl; }
function escapeRegExp(value = '') { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
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
  const safe = escapeRegExp(tag);
  const match = String(block || '').match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}
function stripHtml(value = '') {
  return decodeXml(String(value).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function itemBlocks(xml = '') { return String(xml).match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []; }
function stableId(value = '') {
  let hash = 2166136261;
  for (const ch of String(value)) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `gn-${(hash >>> 0).toString(36)}`;
}
function cleanGoogleTitle(title = '', source = '') {
  const text = stripHtml(title);
  if (!source) return text;
  const suffix = new RegExp(`\\s+-\\s+${escapeRegExp(source)}\\s*$`, 'i');
  return text.replace(suffix, '').trim() || text;
}

export function parseGoogleNews(xml = '') {
  return itemBlocks(xml).slice(0, MAX_GOOGLE_NEWS).map((block, index) => {
    const source = stripHtml(xmlValue(block, 'source')) || 'Google News';
    const title = cleanGoogleTitle(xmlValue(block, 'title'), source);
    const link = stripHtml(xmlValue(block, 'link'));
    const pubDate = stripHtml(xmlValue(block, 'pubDate'));
    const description = stripHtml(xmlValue(block, 'description')).slice(0, 1600);
    if (!title || !link) return null;
    return {
      id: stableId(link || `${title}|${pubDate}`), title, link, description,
      source, feedName: 'Google News', pubDate,
      publishedTimestamp: Number.isFinite(new Date(pubDate).getTime()) ? new Date(pubDate).getTime() : 0,
      googleRank: index + 1
    };
  }).filter(Boolean);
}

export function parseGoogleTrends(xml = '') {
  return itemBlocks(xml).map(block => ({
    title: stripHtml(xmlValue(block, 'title')),
    traffic: stripHtml(xmlValue(block, 'ht:approx_traffic')),
    pubDate: stripHtml(xmlValue(block, 'pubDate'))
  })).filter(row => row.title).slice(0, 40);
}

function normalize(value = '') {
  return String(value).toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}
function bigrams(value = '') {
  const text = normalize(value);
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  const aa = bigrams(a), bb = bigrams(b);
  if (!aa.size || !bb.size) return 0;
  let same = 0;
  for (const token of aa) if (bb.has(token)) same += 1;
  return (2 * same) / (aa.size + bb.size);
}
function trendScore(title, trends) {
  const nTitle = normalize(title);
  let best = 0;
  let match = '';
  for (const trend of Array.isArray(trends) ? trends : []) {
    const nTrend = normalize(trend.title);
    if (nTrend.length >= 3 && (nTitle.includes(nTrend) || nTrend.includes(nTitle))) {
      return { score: 22, match: trend.title };
    }
    const sim = similarity(title, trend.title);
    const score = sim >= 0.45 ? 16 : sim >= 0.28 ? 9 : 0;
    if (score > best) { best = score; match = trend.title; }
  }
  return { score: best, match: best ? match : '' };
}
function importanceScore(item) {
  const hay = `${item.title || ''} ${item.description || ''}`;
  let best = { category: '一般', score: 6 };
  for (const rule of IMPORTANT_RULES) if (rule.re.test(hay) && rule.score > best.score) best = { category: rule.category, score: rule.score };
  if (LOW_VALUE_RE.test(hay)) best.score -= 8;
  return best;
}
function topRankScore(rank) { return Math.max(4, 34 - (Math.max(1, Number(rank) || 1) - 1) * 1.55); }

export function preliminaryScore(items, trends) {
  return (Array.isArray(items) ? items : []).map(item => {
    const trend = trendScore(item.title, trends);
    const importance = importanceScore(item);
    const soft = SOFT_NEWS_RE.test(`${item.title || ''} ${item.description || ''}`) && importance.score < 25;
    const score = topRankScore(item.googleRank) + trend.score + importance.score - (soft ? 10 : 0);
    return { ...item, trendMatch: trend.match, trendScore: trend.score, importanceCategory: importance.category, importanceScore: importance.score, soft, preliminaryScore: score, gdeltIndependentSources: 0, score };
  }).sort((a, b) => b.preliminaryScore - a.preliminaryScore || a.googleRank - b.googleRank);
}

function gdeltQuery(title = '') {
  return stripHtml(title).replace(/[\[\]{}()"'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110);
}
function domainOf(article) {
  const direct = String(article?.domain || '').replace(/^www\./i, '').toLowerCase();
  if (direct) return direct;
  try { return new URL(String(article?.url || '')).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}
function independentSourceCount(json) {
  const domains = new Set((Array.isArray(json?.articles) ? json.articles : []).map(domainOf).filter(Boolean));
  domains.delete('news.google.com');
  return domains.size;
}
async function fetchWithTimeout(url, { timeoutMs, accept = '*/*' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || GOOGLE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: accept, 'User-Agent': 'new-wnt-getting/1.0 (+recommendation-selector)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await response.text(), elapsedMs: Date.now() - started };
  } finally { clearTimeout(timer); }
}
async function getTrends({ refresh = false } = {}) {
  if (!refresh && fresh(trendsCache, TRENDS_TTL_MS)) return { rows: trendsCache.rows, cache: 'hit', elapsedMs: 0 };
  const result = await fetchWithTimeout(GOOGLE_TRENDS_URL, { timeoutMs: GOOGLE_TIMEOUT_MS, accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' });
  const rows = parseGoogleTrends(result.text);
  if (!rows.length) throw new Error('Google Trends returned no rows');
  trendsCache = { at: nowMs(), rows };
  return { rows, cache: 'miss', elapsedMs: result.elapsedMs };
}
async function checkGdelt(item) {
  const query = gdeltQuery(item.title);
  if (!query) return { ok: true, count: 0, elapsedMs: 0 };
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&format=json&sort=HybridRel&timespan=24h`;
  try {
    const result = await fetchWithTimeout(url, { timeoutMs: GDELT_TIMEOUT_MS, accept: 'application/json,text/plain,*/*' });
    const json = JSON.parse(result.text);
    return { ok: true, count: independentSourceCount(json), elapsedMs: result.elapsedMs };
  } catch (error) {
    return { ok: false, count: 0, elapsedMs: 0, error: error?.message || String(error) };
  }
}

export function finalizeSelection(rows) {
  const sorted = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => b.score - a.score || a.googleRank - b.googleRank);
  const chosen = [];
  let softCount = 0;
  for (const row of sorted) {
    if (row.soft && softCount >= 3) continue;
    chosen.push(row);
    if (row.soft) softCount += 1;
    if (chosen.length >= MAX_RECOMMENDATIONS) break;
  }
  return chosen.map(row => ({
    id: row.id, title: row.title, link: row.link, description: row.description, source: row.source,
    feedName: row.feedName, pubDate: row.pubDate, publishedTimestamp: row.publishedTimestamp,
    _readerMode: 'news', _recommendationLabel: '重要・話題ニュース'
  }));
}

async function buildRecommendations({ refresh = false, debug = false, id = requestId() } = {}) {
  const started = Date.now();
  const stage = {};
  const [newsResult, trendResult] = await Promise.all([
    fetchWithTimeout(GOOGLE_NEWS_URL, { timeoutMs: GOOGLE_TIMEOUT_MS, accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }),
    getTrends({ refresh })
  ]);
  stage.googleNewsMs = newsResult.elapsedMs;
  stage.googleTrendsMs = trendResult.elapsedMs;
  stage.googleTrendsCache = trendResult.cache;

  const news = parseGoogleNews(newsResult.text);
  if (news.length < 5) throw Object.assign(new Error(`Google News candidates too few: ${news.length}`), { stage: 'google-news' });
  let ranked = preliminaryScore(news, trendResult.rows);
  const gdeltTargets = ranked.slice(0, Math.min(GDELT_CHECK_COUNT, ranked.length));
  const gdeltStarted = Date.now();
  const gdeltResults = await Promise.all(gdeltTargets.map(checkGdelt));
  stage.gdeltMs = Date.now() - gdeltStarted;
  stage.gdeltChecked = gdeltTargets.length;
  stage.gdeltSucceeded = gdeltResults.filter(row => row.ok).length;
  if (gdeltTargets.length && !stage.gdeltSucceeded) throw Object.assign(new Error('GDELT unavailable for all checked candidates'), { stage: 'gdelt' });

  const gdeltById = new Map(gdeltTargets.map((item, index) => [item.id, gdeltResults[index]]));
  ranked = ranked.map(row => {
    const gdelt = gdeltById.get(row.id);
    const independent = gdelt?.ok ? gdelt.count : 0;
    const gdeltScore = Math.min(24, independent * 4);
    return { ...row, gdeltIndependentSources: independent, gdeltScore, score: row.preliminaryScore + gdeltScore };
  }).sort((a, b) => b.score - a.score || a.googleRank - b.googleRank);

  const items = finalizeSelection(ranked);
  if (!items.length) throw Object.assign(new Error('No recommendations after ranking'), { stage: 'ranking' });
  const diagnostics = {
    requestId: id, strategy: 'google-news-trends-gdelt-v1', totalMs: Date.now() - started,
    candidates: news.length, trends: trendResult.rows.length, ...stage,
    ranking: ranked.slice(0, 12).map(row => ({
      id: row.id, title: row.title, source: row.source, googleRank: row.googleRank,
      topScore: Number(topRankScore(row.googleRank).toFixed(1)), trendMatch: row.trendMatch,
      trendScore: row.trendScore, importance: row.importanceCategory, importanceScore: row.importanceScore,
      gdeltIndependentSources: row.gdeltIndependentSources, gdeltScore: row.gdeltScore || 0,
      soft: row.soft, totalScore: Number(row.score.toFixed(1))
    }))
  };
  if (debug) console.log('[recommendations:debug]', diagnostics);
  return { items, diagnostics };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const debug = String(req.query?.debug || '') === '1';
  const refresh = String(req.query?.refresh || '') === '1';
  const id = requestId();
  res.setHeader('X-Recommendation-Strategy', 'google-news-trends-gdelt-v1');
  res.setHeader('X-Recommendation-Request-Id', id);

  if (!debug && !refresh && fresh(recommendationCache, RECOMMENDATION_TTL_MS)) {
    res.setHeader('X-Recommendation-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ strategy: 'google-news-trends-gdelt-v1', cached: true, items: recommendationCache.payload.items });
  }

  res.setHeader('X-Recommendation-Cache', 'MISS');
  res.setHeader('Cache-Control', debug || refresh ? 'no-store' : 'public, max-age=0, s-maxage=600, stale-while-revalidate=1200');
  console.log('[recommendations:start]', { requestId: id, debug, refresh });
  try {
    const payload = await buildRecommendations({ refresh, debug, id });
    recommendationCache = { at: nowMs(), payload };
    console.log('[recommendations:success]', {
      requestId: id, items: payload.items.length, candidates: payload.diagnostics.candidates,
      trends: payload.diagnostics.trends, gdeltChecked: payload.diagnostics.gdeltChecked,
      elapsedMs: payload.diagnostics.totalMs
    });
    return res.status(200).json({
      strategy: 'google-news-trends-gdelt-v1', cached: false, items: payload.items,
      ...(debug ? { diagnostics: payload.diagnostics } : {})
    });
  } catch (error) {
    const stage = error?.stage || (String(error?.message || '').includes('Trends') ? 'google-trends' : 'upstream');
    console.error('[recommendations:fallback-required]', { requestId: id, stage, name: error?.name, message: error?.message || String(error) });
    return res.status(503).json({
      error: 'Cross-source recommendation unavailable', fallbackRequired: true,
      strategy: 'google-news-trends-gdelt-v1', requestId: id, stage,
      ...(debug ? { detail: error?.message || String(error) } : {})
    });
  }
}
