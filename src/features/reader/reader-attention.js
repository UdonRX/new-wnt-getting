const PAPER_DISCOVERY_KEY = 'pdv2:paperDiscovery:v1';
const KNOWLEDGE_TREND_KEY = 'pdv2:knowledgeTrend:v1';
const KNOWLEDGE_TREND_TTL = 30 * 60 * 1000;
const MAX_DISCOVERY_KEYS = 1600;
const MAX_TREND_ITEMS = 90;
const GOOGLE_TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=JP';

const KNOWLEDGE_IMPORTANCE_RE = /AI|人工知能|半導体|量子|ロボット|自動化|製造|生産|センサ|電池|エネルギー|材料|新技術|研究|開発|サイバー|通信|データセンター|宇宙|モビリティ|熱|断熱|省エネ|innovation|semiconductor|robot|manufactur|sensor|battery|energy|material|research/i;
const PAPER_NOVELTY_RE = /新規|新しい|初めて|世界初|独創|提案|発見|革新|novel|novelty|new approach|first|unexpected|discovery|propose[ds]?/i;
const PAPER_RIGOR_RE = /実験|測定|検証|モデル|シミュレーション|解析|最適化|比較|評価|experiment|measurement|validation|model|simulation|mechanism|optimization|characteri[sz]ation|benchmark/i;
const PAPER_CROSS_RE = /異分野|融合|横断|転用|応用|組み合わせ|interdisciplinary|cross[- ]disciplinary|cross[- ]domain|transfer|integration|hybrid|bio[- ]?inspired|biomimetic/i;
const PAPER_PRACTICAL_RE = /実装|試作|実証|現場|製造|省エネ|高効率|低コスト|改善|prototype|demonstrat|implementation|manufactur|energy efficien|low[- ]cost|improv/i;

function readJson(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function text(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalizeTitle(value = '') {
  return text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function numberField(description = '', label = '') {
  const match = String(description || '').match(new RegExp(`${label}\\s*[:：]\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i'));
  const value = Number(match?.[1] || 0);
  return Number.isFinite(value) ? value : 0;
}
function itemTime(item) {
  const explicit = new Date(item?.publishedAt || item?.pubDate || 0).getTime();
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 0;
}
function ageDays(time, now = Date.now()) {
  return time > 0 ? Math.max(0, (now - time) / 86400000) : Number.POSITIVE_INFINITY;
}
function sourceName(item) { return text(item?.feedName || item?.source || 'その他') || 'その他'; }
function doiOf(item) {
  const direct = text(item?.doi || '');
  if (direct) return direct.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  const found = String(item?.description || '').match(/\bDOI\s*[:：]\s*(10\.\d{4,9}\/[^\s｜<>]+)/i)?.[1] || '';
  return found.replace(/[.,;、。]+$/g, '').toLowerCase();
}
function paperKey(item) {
  const doi = doiOf(item);
  if (doi) return `doi:${doi}`;
  const title = normalizeTitle(item?.title || item?.titleJa || '');
  return title ? `title:${title}` : `id:${text(item?.id || item?.link || '')}`;
}
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function bigrams(value = '') {
  const normalized = normalizeTitle(value);
  const set = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) set.add(normalized.slice(index, index + 2));
  return { normalized, set };
}
function trendMatchScore(title = '', trendTitle = '') {
  const a = bigrams(title);
  const b = bigrams(trendTitle);
  if (!a.normalized || !b.normalized) return 0;
  if (b.normalized.length >= 3 && (a.normalized.includes(b.normalized) || b.normalized.includes(a.normalized))) return 22;
  if (!a.set.size || !b.set.size) return 0;
  let same = 0;
  for (const token of a.set) if (b.set.has(token)) same += 1;
  const similarity = (2 * same) / (a.set.size + b.set.size);
  return similarity >= 0.45 ? 16 : similarity >= 0.28 ? 9 : 0;
}
function parseTrendTitles(xml = '') {
  try {
    const document = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
    if (document.querySelector('parsererror')) return [];
    return [...document.querySelectorAll('item > title')].map(node => text(node.textContent)).filter(Boolean).slice(0, 40);
  } catch { return []; }
}

export function isPaperLike(item) {
  const hay = `${sourceName(item)} ${item?.description || ''}`;
  return /カテゴリ\s*[:：]\s*論文・研究|J-STAGE|CiNii|Semantic Scholar|PLOS|PubMed|PMC|CORE|IEEE|独創研究|独創区分/i.test(hay);
}

export function stampPaperItems(items = []) {
  const now = Date.now();
  const stored = readJson(PAPER_DISCOVERY_KEY, {});
  const map = stored && typeof stored === 'object' ? { ...stored } : {};
  let changed = false;
  const rows = (Array.isArray(items) ? items : []).map(item => {
    const key = paperKey(item);
    const incoming = new Date(item?.discoveredAt || 0).getTime();
    const remembered = Number(map[key] || 0);
    const discoveredMs = Number.isFinite(incoming) && incoming > 0 ? incoming : remembered > 0 ? remembered : now;
    if (key && !remembered) { map[key] = discoveredMs; changed = true; }
    const publishedMs = itemTime(item);
    const publishedAt = publishedMs ? new Date(publishedMs).toISOString() : '';
    const discoveredAt = new Date(discoveredMs).toISOString();
    return { ...item, publishedAt, discoveredAt };
  });
  if (changed) {
    const entries = Object.entries(map).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).slice(0, MAX_DISCOVERY_KEYS);
    writeJson(PAPER_DISCOVERY_KEY, Object.fromEntries(entries));
  }
  return rows;
}

export function paperAttention(item, { unread = true, now = Date.now() } = {}) {
  const description = String(item?.description || '');
  const hay = `${item?.title || ''} ${description}`;
  const discovered = new Date(item?.discoveredAt || 0).getTime();
  const discoveredDays = ageDays(Number.isFinite(discovered) ? discovered : 0, now);
  const publishedDays = ageDays(itemTime(item), now);

  const discovery = discoveredDays <= 1 ? 18 : discoveredDays <= 3 ? 14 : discoveredDays <= 7 ? 9 : discoveredDays <= 14 ? 5 : 0;
  const freshness = publishedDays <= 7 ? 10 : publishedDays <= 30 ? 7 : publishedDays <= 180 ? 4 : 1;
  const relevanceRaw = Math.max(numberField(description, '関連度'), numberField(description, '有用度'));
  const creativeRaw = numberField(description, '独創性スコア');
  const relevance = relevanceRaw ? clamp(relevanceRaw / 100 * 18, 0, 18) : 6;
  const citations = numberField(description, '被引用数');
  const influence = Math.min(10, Math.log2(1 + Math.max(0, citations)) * 2.2);
  const novelty = PAPER_NOVELTY_RE.test(hay) ? 9 : creativeRaw > 0 ? Math.min(9, creativeRaw * 0.35) : 0;
  const rigor = PAPER_RIGOR_RE.test(hay) ? 8 : numberField(description, '検証性スコア') > 0 ? 6 : 0;
  const transfer = (PAPER_CROSS_RE.test(hay) ? 4 : 0) + (PAPER_PRACTICAL_RE.test(hay) ? 4 : 0);
  const abstractChars = text(description.replace(/(?:掲載誌|著者|DOI|検索語|情報提供元|関連度|有用度|選別理由|取得方式)\s*[:：][^｜\n]*/gi, ' ')).length;
  const information = Math.min(9, (abstractChars >= 220 ? 5 : abstractChars >= 100 ? 3 : 0) + (/公開PDF|Open Access|OA\b|PDF/i.test(description) ? 2 : 0) + (doiOf(item) ? 2 : 0));
  const unreadBonus = unread ? 8 : 0;
  const total = clamp(discovery + freshness + relevance + influence + novelty + rigor + transfer + information + unreadBonus);
  return {
    total: Math.round(total * 10) / 10,
    discovery, freshness, relevance: Math.round(relevance * 10) / 10,
    influence: Math.round(influence * 10) / 10, novelty, rigor, transfer, information, unread: unreadBonus
  };
}

export function rankPaperAttention(items = [], readSet = new Set()) {
  return stampPaperItems(items)
    .filter(isPaperLike)
    .map(item => {
      const score = paperAttention(item, { unread: !readSet.has(String(item?.id || '')) });
      return { ...item, _paperAttentionScore: score.total, _paperAttentionBreakdown: score };
    })
    .sort((a, b) => Number(b._paperAttentionScore || 0) - Number(a._paperAttentionScore || 0) || itemTime(b) - itemTime(a));
}

export function pickHomePaper(items = [], readSet = new Set(), preferredId = '') {
  const ranked = rankPaperAttention(items, readSet);
  const unread = ranked.filter(item => !readSet.has(String(item?.id || '')));
  const now = Date.now();
  const recentDiscovery = unread.filter(item => ageDays(new Date(item.discoveredAt || 0).getTime(), now) <= 7);
  const recentPublished = unread.filter(item => ageDays(itemTime(item), now) <= 14);
  const pool = recentDiscovery.length ? recentDiscovery : recentPublished.length ? recentPublished : unread.length ? unread : ranked;
  const best = pool[0] || null;
  const preferred = preferredId ? pool.find(item => String(item?.id || '') === String(preferredId)) : null;
  if (preferred && best && Number(preferred._paperAttentionScore || 0) >= Number(best._paperAttentionScore || 0) - 5) return preferred;
  return best;
}

function trendCache() {
  const raw = readJson(KNOWLEDGE_TREND_KEY, null);
  if (!raw?.scores || typeof raw.scores !== 'object') return { at: 0, scores: {} };
  return raw;
}
export function knowledgeTrendScores() { return trendCache().scores || {}; }

export async function refreshKnowledgeTrendScores(items = [], { force = false } = {}) {
  const cached = trendCache();
  if (!force && cached.at && Date.now() - Number(cached.at) < KNOWLEDGE_TREND_TTL) return cached.scores || {};
  const rows = (Array.isArray(items) ? items : [])
    .filter(item => item?.id && item?.title)
    .sort((a, b) => itemTime(b) - itemTime(a))
    .slice(0, MAX_TREND_ITEMS);
  if (!rows.length) return cached.scores || {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`/api/rss?url=${encodeURIComponent(GOOGLE_TRENDS_RSS)}&timeout=5000`, {
      signal: controller.signal,
      cache: 'default',
      headers: { Accept: 'application/rss+xml,application/xml,text/xml,*/*;q=.2' }
    });
    if (!response.ok) throw new Error(`Google Trends RSS ${response.status}`);
    const trends = parseTrendTitles(await response.text());
    if (!trends.length) throw new Error('Google Trends RSS returned no rows');

    const scores = { ...(cached.scores || {}) };
    const stampedAt = Date.now();
    rows.forEach(item => {
      let bestScore = 0;
      let bestMatch = '';
      for (const trend of trends) {
        const score = trendMatchScore(item.title, trend);
        if (score > bestScore) { bestScore = score; bestMatch = trend; }
        if (bestScore === 22) break;
      }
      scores[String(item.id)] = { trendScore: bestScore, trendMatch: bestMatch, at: stampedAt };
    });
    writeJson(KNOWLEDGE_TREND_KEY, { at: stampedAt, scores });
    console.info('[knowledge-trends]', { cache: 'miss', registeredItems: rows.length, trends: trends.length, matched: rows.filter(item => Number(scores[String(item.id)]?.trendScore || 0) > 0).length });
    return scores;
  } catch (error) {
    console.warn('[knowledge-trends]', { cache: cached.at ? 'stale' : 'unavailable', registeredItems: rows.length, error: error?.message || String(error) });
    return cached.scores || {};
  } finally {
    clearTimeout(timer);
  }
}

export function knowledgeAttention(item, readSet = new Set(), scores = knowledgeTrendScores(), now = Date.now()) {
  const trend = scores?.[String(item?.id || '')] || {};
  const trendPoints = clamp(Number(trend.trendScore || 0) / 22 * 40, 0, 40);
  const days = ageDays(itemTime(item), now);
  const freshness = days <= 0.5 ? 30 : days <= 1 ? 27 : days <= 3 ? 22 : days <= 7 ? 14 : days <= 14 ? 7 : 2;
  const hay = `${item?.title || ''} ${item?.description || ''}`;
  const importance = KNOWLEDGE_IMPORTANCE_RE.test(hay) ? 20 : 8;
  const unread = readSet.has(String(item?.id || '')) ? 0 : 10;
  return {
    total: Math.round(clamp(trendPoints + freshness + importance + unread) * 10) / 10,
    trend: Math.round(trendPoints * 10) / 10,
    freshness,
    importance,
    unread,
    trendMatch: text(trend.trendMatch)
  };
}

export function rankKnowledgeAttention(items = [], readSet = new Set(), scores = knowledgeTrendScores()) {
  const ranked = (Array.isArray(items) ? items : []).map(item => {
    const score = knowledgeAttention(item, readSet, scores);
    return { ...item, _knowledgeAttentionScore: score.total, _knowledgeAttentionBreakdown: score };
  }).sort((a, b) => Number(b._knowledgeAttentionScore || 0) - Number(a._knowledgeAttentionScore || 0) || itemTime(b) - itemTime(a));

  const buckets = new Map();
  ranked.forEach(item => {
    const source = sourceName(item);
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(item);
  });
  const out = [];
  const active = [...buckets.values()];
  let added = true;
  while (added) {
    added = false;
    active.forEach(bucket => {
      const item = bucket.shift();
      if (!item) return;
      out.push(item);
      added = true;
    });
  }
  return out;
}

export function pickHomeKnowledge(items = [], readSet = new Set(), preferredId = '', scores = knowledgeTrendScores()) {
  const ranked = rankKnowledgeAttention(items, readSet, scores);
  const unread = ranked.filter(item => !readSet.has(String(item?.id || '')));
  const pool = unread.length ? unread : ranked;
  const best = pool[0] || null;
  const preferred = preferredId ? pool.find(item => String(item?.id || '') === String(preferredId)) : null;
  if (preferred && best && Number(preferred._knowledgeAttentionScore || 0) >= Number(best._knowledgeAttentionScore || 0) - 5) return preferred;
  return best;
}
