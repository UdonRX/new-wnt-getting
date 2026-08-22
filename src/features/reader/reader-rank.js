const SOURCE_BONUS = [
  /日経|Reuters|BBC|J-STAGE|PubMed|PMC|PLOS|Semantic Scholar/i,
  /ITmedia|MONOist|EE Times|Impress/i
];
const IMPACT = /発表|決定|開始|導入|新工場|新製品|新技術|規制|法案|選挙|事故|災害|決算|買収|提携|AI|半導体|製造|自動化|省エネ|断熱|炊飯|thermal|insulat|rice|cooker/i;
const CREATIVE_SIGNAL = /独創研究軸|独創性スコア|acoustic|wettability|contact angle|capillary|porous media|microstructure|rheology|volatile|aroma release|thermal effusivity|haptic|human factors|cognitive ergonomics|biomimetic|bio-inspired|digital twin|sensor fusion|音響|濡れ性|毛細管|微細構造|香気|熱浸透率|認知人間工学|生物模倣|デジタルツイン/i;
const RIGOR_SIGNAL = /実験|測定|検証|モデル|シミュレーション|解析|最適化|試作|比較|評価|experiment|measurement|validation|model|simulation|mechanism|optimization|characteri[sz]ation|prototype|benchmark/i;
const PAPER_NOVELTY_SIGNAL = /新規|新しい|初めて|世界初|意外|予想外|独創|提案|発見|novel|novelty|new approach|first|unexpected|counterintuitive|discovery|propose[ds]?/i;
const PAPER_CROSS_SIGNAL = /異分野|融合|横断|転用|応用|組み合わせ|interdisciplinary|cross[- ]disciplinary|cross[- ]domain|transfer|analogy|integration|hybrid|bio[- ]?inspired|biomimetic/i;
const PAPER_PRACTICAL_SIGNAL = /実装|試作|プロトタイプ|実証|現場|製造|省エネ|高効率|低コスト|改善|prototype|demonstrat|implementation|manufactur|energy efficien|low[- ]cost|improv/i;
const TWELVE_HOUR_WINDOW = 12 * 60 * 60 * 1000;

function isPaperMode(mode) { return String(mode || '').startsWith('papers'); }
function paperInterestScore(item) {
  const hay = `${item?.title || ''} ${item?.description || ''}`;
  let score = 0;
  if (PAPER_NOVELTY_SIGNAL.test(hay)) score += 28;
  if (RIGOR_SIGNAL.test(hay)) score += 20;
  if (PAPER_CROSS_SIGNAL.test(hay)) score += 18;
  if (PAPER_PRACTICAL_SIGNAL.test(hay)) score += 12;
  if (CREATIVE_SIGNAL.test(hay)) score += 18;
  const embedded = Number(String(item?.description || '').match(/独創性スコア:\s*([0-9.]+)/)?.[1] || 0);
  if (Number.isFinite(embedded) && embedded > 0) score += Math.min(24, embedded * 0.6);
  if (/なぜ|どうして|どのよう|比較|機構|メカニズム|効果|影響|why|how|versus|vs\.?|mechanism|effect|impact/i.test(item?.title || '')) score += 7;
  return score;
}
function recencyScore(date) {
  const time = new Date(date || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 0;
  const hours = Math.max(0, (Date.now() - time) / 3600000);
  return Math.max(0, 30 - hours * 1.2);
}
function itemTime(item) { const time = new Date(item?.pubDate || 0).getTime(); return Number.isFinite(time) ? time : 0; }
function itemKey(item) { return String(item?.id || item?.link || item?.url || `${item?.feedName || item?.source || ''}|${item?.title || ''}`); }
function acquisitionSource(item) { return String(item?.feedName || item?.source || 'その他').trim() || 'その他'; }

export function heuristicRank(items, mode, unreadSet = new Set()) {
  const paper = isPaperMode(mode);
  return (Array.isArray(items) ? items : []).map(item => {
    const freshness = recencyScore(item.pubDate);
    let score = paper ? freshness * 0.18 : freshness;
    const hay = `${item.title || ''} ${item.description || ''}`;
    if (IMPACT.test(hay)) score += paper ? 8 : 18;
    if (SOURCE_BONUS[0].test(item.source || '')) score += paper ? 8 : 14;
    else if (SOURCE_BONUS[1].test(item.source || '')) score += paper ? 5 : 8;
    if (!unreadSet.has(item.id)) score += paper ? 5 : 8;
    if (paper) { score += paperInterestScore(item); if (/pdf/i.test(item.description || '')) score += 6; }
    return { item, score };
  }).sort((a, b) => b.score - a.score || itemTime(b.item) - itemTime(a.item));
}

function interleaveBuckets(buckets) {
  const active = buckets.filter(bucket => bucket?.rows?.length).map(bucket => ({ ...bucket, cursor: 0 })).sort((a, b) => b.latest - a.latest || a.order - b.order || a.name.localeCompare(b.name, 'ja'));
  const out = []; const seen = new Set(); let added = true;
  while (added) {
    added = false;
    for (const bucket of active) {
      while (bucket.cursor < bucket.rows.length) {
        const item = bucket.rows[bucket.cursor++]; const key = itemKey(item);
        if (key && seen.has(key)) continue; if (key) seen.add(key); out.push(item); added = true; break;
      }
    }
  }
  return out;
}

/*
 * News / Knowledge recommendation freshness rule:
 * - If at least one fetched item was published within the last 12 hours, only
 *   those <=12h items are eligible for recommendation.
 * - Only when there are zero <=12h items do we fall back to the previous
 *   36h / 72h source-balancing behavior.
 * This file only selects fetched items; AI-summary generation is untouched.
 */
export function chooseBalancedRecentRecommendations(items, mode = 'news', unreadSet = new Set(), aiRanking = []) {
  const activeMode = mode === 'knowledge' ? 'knowledge' : 'news';
  const allRows = heuristicRank(items, activeMode, unreadSet);
  if (!allRows.length) return [];
  const now = Date.now();
  const twelveHourRows = allRows.filter(row => { const time = itemTime(row.item); return time > 0 && now - time <= TWELVE_HOUR_WINDOW; });
  const strictTwelveHour = twelveHourRows.length > 0;
  const rows = strictTwelveHour ? twelveHourRows : allRows;

  const aiOrder = new Map(); const aiScore = new Map();
  (Array.isArray(aiRanking) ? aiRanking : []).forEach((row, index) => { const id = String(row?.id || ''); if (!id || aiOrder.has(id)) return; aiOrder.set(id, index); aiScore.set(id, Number(row?.score) || 0); });
  const groups = new Map();
  rows.forEach((row, originalOrder) => {
    const source = acquisitionSource(row.item); if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push({ ...row, originalOrder, aiIndex: aiOrder.has(String(row.item?.id || '')) ? aiOrder.get(String(row.item.id)) : Number.MAX_SAFE_INTEGER, aiScore: aiScore.get(String(row.item?.id || '')) || 0 });
  });

  const PRIMARY_WINDOW = 36 * 60 * 60 * 1000;
  const FALLBACK_WINDOW = 72 * 60 * 60 * 1000;
  const ABSOLUTE_QUALITY = 22;
  const TOP_GAP = 11;
  const buckets = []; let groupOrder = 0;

  for (const [name, sourceRows] of groups.entries()) {
    const sorted = [...sourceRows].sort((a, b) => {
      const aAi = Number.isFinite(a.aiIndex) && a.aiIndex !== Number.MAX_SAFE_INTEGER;
      const bAi = Number.isFinite(b.aiIndex) && b.aiIndex !== Number.MAX_SAFE_INTEGER;
      if (aAi !== bAi) return aAi ? -1 : 1;
      if (aAi && bAi && a.aiIndex !== b.aiIndex) return a.aiIndex - b.aiIndex;
      return b.score - a.score || itemTime(b.item) - itemTime(a.item) || a.originalOrder - b.originalOrder;
    });

    let recent;
    if (strictTwelveHour) recent = sorted;
    else {
      recent = sorted.filter(row => { const time = itemTime(row.item); return time > 0 && now - time <= PRIMARY_WINDOW; });
      if (!recent.length) recent = sorted.filter(row => { const time = itemTime(row.item); return time > 0 && now - time <= FALLBACK_WINDOW; }).slice(0, 1);
    }
    if (!recent.length) continue;

    const topScore = Math.max(...recent.map(row => row.score));
    const relativeThreshold = Math.max(ABSOLUTE_QUALITY, topScore - TOP_GAP);
    const qualified = recent.filter((row, index) => index === 0 || row.aiIndex !== Number.MAX_SAFE_INTEGER || row.score >= relativeThreshold);
    if (!qualified.length) continue;
    buckets.push({ name, order: groupOrder++, latest: Math.max(...qualified.map(row => itemTime(row.item))), rows: qualified.map(row => row.item) });
  }
  return interleaveBuckets(buckets);
}

export function chooseBalancedNewsRecommendations(items, unreadSet = new Set(), aiRanking = []) { return chooseBalancedRecentRecommendations(items, 'news', unreadSet, aiRanking); }
export function chooseTop(items, mode, unreadSet, limit = 5, aiRanking = []) {
  if (mode === 'news' || mode === 'knowledge') return chooseBalancedRecentRecommendations(items, mode, unreadSet, aiRanking);
  const heuristic = heuristicRank(items, mode, unreadSet); const byId = new Map(items.map(item => [item.id, item])); const ordered = []; const used = new Set();
  for (const row of Array.isArray(aiRanking) ? aiRanking : []) { const item = byId.get(row?.id); if (item && !used.has(item.id)) { ordered.push({ item, score: Number(row?.score) || 0 }); used.add(item.id); } }
  for (const row of heuristic) if (!used.has(row.item.id)) { ordered.push(row); used.add(row.item.id); }
  const selected = []; const sourceCount = new Map(); const safeLimit = Math.max(0, Number(limit) || 0);
  for (const row of ordered) { const source = acquisitionSource(row.item); const count = sourceCount.get(source) || 0; if (count >= 2 && selected.length < Math.min(safeLimit, ordered.length - 1)) continue; selected.push(row.item); sourceCount.set(source, count + 1); if (selected.length >= safeLimit) break; }
  return selected;
}

export async function requestAiRank(items, mode) {
  const sample = items.slice(0, 30).map(i => ({ id: i.id, title: i.title, source: i.source, pubDate: i.pubDate, description: String(i.description || '').replace(/<[^>]*>/g, ' ').slice(0, 800) }));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch('/api/rank-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, items: sample }), signal: controller.signal });
    if (!res.ok) return null; return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}
