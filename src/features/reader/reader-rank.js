const SOURCE_BONUS = [
  /日経|Reuters|BBC|J-STAGE|PubMed|PMC|PLOS|Semantic Scholar/i,
  /ITmedia|MONOist|EE Times|Impress/i
];

const IMPACT = /発表|決定|開始|導入|新工場|新製品|新技術|規制|法案|選挙|事故|災害|決算|買収|提携|AI|半導体|製造|自動化|省エネ|断熱|炊飯|thermal|insulat|rice|cooker/i;
const CREATIVE_SIGNAL = /独創研究軸|独創性スコア|acoustic|wettability|contact angle|capillary|porous media|microstructure|rheology|volatile|aroma release|thermal effusivity|haptic|human factors|cognitive ergonomics|biomimetic|bio-inspired|digital twin|sensor fusion|音響|濡れ性|毛細管|微細構造|香気|熱浸透率|認知人間工学|生物模倣|デジタルツイン/i;
const RIGOR_SIGNAL = /実験|測定|検証|モデル|シミュレーション|解析|最適化|experiment|measurement|validation|model|simulation|mechanism|optimization|characteri[sz]ation|prototype/i;

function isPaperMode(mode) {
  return String(mode || '').startsWith('papers');
}

function recencyScore(date) {
  const time = new Date(date || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 0;
  const hours = Math.max(0, (Date.now() - time) / 3600000);
  return Math.max(0, 30 - hours * 1.2);
}

function itemTime(item) {
  const time = new Date(item?.pubDate || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function itemKey(item) {
  return String(item?.id || item?.link || item?.url || `${item?.feedName || item?.source || ''}|${item?.title || ''}`);
}

/*
 * 「取得先」は記事内の source より、ユーザーが登録したRSS名(feedName)を優先する。
 * /api/news-feed の内部媒体名が source に入っていても、Readerで登録している
 * 「全国ニュース」等の取得先単位で公平に扱えるようにする。
 */
function acquisitionSource(item) {
  return String(item?.feedName || item?.source || 'その他').trim() || 'その他';
}

export function heuristicRank(items, mode, unreadSet = new Set()) {
  const creative = mode === 'papers-creative';
  return (Array.isArray(items) ? items : []).map(item => {
    let score = recencyScore(item.pubDate);
    const hay = `${item.title || ''} ${item.description || ''}`;

    if (IMPACT.test(hay)) score += isPaperMode(mode) ? 26 : 18;
    if (SOURCE_BONUS[0].test(item.source || '')) score += 14;
    else if (SOURCE_BONUS[1].test(item.source || '')) score += 8;
    if (!unreadSet.has(item.id)) score += 8;
    if (isPaperMode(mode) && /pdf/i.test(item.description || '')) score += 8;

    if (creative) {
      if (CREATIVE_SIGNAL.test(hay)) score += 18;
      if (RIGOR_SIGNAL.test(hay)) score += 12;
      const embedded = Number(String(item.description || '').match(/独創性スコア:\s*([0-9.]+)/)?.[1] || 0);
      score += Math.min(18, embedded * 0.45);
      score -= recencyScore(item.pubDate) * 0.35;
    }

    return { item, score };
  }).sort((a, b) => b.score - a.score || itemTime(b.item) - itemTime(a.item));
}

function interleaveBuckets(buckets) {
  const active = buckets
    .filter(bucket => bucket?.rows?.length)
    .map(bucket => ({ ...bucket, cursor: 0 }))
    .sort((a, b) => b.latest - a.latest || a.order - b.order || a.name.localeCompare(b.name, 'ja'));

  const out = [];
  const seen = new Set();
  let added = true;

  while (added) {
    added = false;
    for (const bucket of active) {
      while (bucket.cursor < bucket.rows.length) {
        const item = bucket.rows[bucket.cursor++];
        const key = itemKey(item);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(item);
        added = true;
        break;
      }
    }
  }
  return out;
}

/*
 * v2.14.18 — ニュースおすすめ
 *
 * 旧版は reader.js から limit=5 が渡されるため、取得先を均等化していても
 * 最終的に5件で打ち切られていた。
 *
 * ニュースでは limit を意図的に無視し、以下で自然に件数を決める。
 *   1. 登録RSS(feedName)ごとに候補を分ける
 *   2. 原則36時間以内の記事を対象。更新が少ない取得先は72時間以内の最新記事まで救済
 *   3. 各取得先の最上位1件は採用
 *   4. 追加記事は「AI上位」または「取得先トップに近いおすすめスコア」のものだけ採用
 *   5. 各取得先1件目→2件目→3件目…とラウンドロビン表示
 *
 * 全体件数の上限は設けない。条件を満たした分だけ表示する。
 */
export function chooseBalancedNewsRecommendations(items, unreadSet = new Set(), aiRanking = []) {
  const rows = heuristicRank(items, 'news', unreadSet);
  if (!rows.length) return [];

  const aiOrder = new Map();
  const aiScore = new Map();
  (Array.isArray(aiRanking) ? aiRanking : []).forEach((row, index) => {
    const id = String(row?.id || '');
    if (!id || aiOrder.has(id)) return;
    aiOrder.set(id, index);
    aiScore.set(id, Number(row?.score) || 0);
  });

  const groups = new Map();
  rows.forEach((row, originalOrder) => {
    const source = acquisitionSource(row.item);
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push({
      ...row,
      originalOrder,
      aiIndex: aiOrder.has(String(row.item?.id || '')) ? aiOrder.get(String(row.item.id)) : Number.MAX_SAFE_INTEGER,
      aiScore: aiScore.get(String(row.item?.id || '')) || 0
    });
  });

  const now = Date.now();
  const PRIMARY_WINDOW = 36 * 60 * 60 * 1000;
  const FALLBACK_WINDOW = 72 * 60 * 60 * 1000;
  const ABSOLUTE_QUALITY = 22;
  const TOP_GAP = 11;

  const buckets = [];
  let groupOrder = 0;

  for (const [name, sourceRows] of groups.entries()) {
    const sorted = [...sourceRows].sort((a, b) => {
      // AI上位に選ばれた記事は同じ取得先内で優先。ただしAI未評価記事も後段で残す。
      const aAi = Number.isFinite(a.aiIndex) && a.aiIndex !== Number.MAX_SAFE_INTEGER;
      const bAi = Number.isFinite(b.aiIndex) && b.aiIndex !== Number.MAX_SAFE_INTEGER;
      if (aAi !== bAi) return aAi ? -1 : 1;
      if (aAi && bAi && a.aiIndex !== b.aiIndex) return a.aiIndex - b.aiIndex;
      return b.score - a.score || itemTime(b.item) - itemTime(a.item) || a.originalOrder - b.originalOrder;
    });

    let recent = sorted.filter(row => {
      const time = itemTime(row.item);
      return time > 0 && now - time <= PRIMARY_WINDOW;
    });

    // 更新頻度の低い登録RSSも完全に消さない。ただし古すぎる記事はおすすめにしない。
    if (!recent.length) {
      recent = sorted.filter(row => {
        const time = itemTime(row.item);
        return time > 0 && now - time <= FALLBACK_WINDOW;
      }).slice(0, 1);
    }

    if (!recent.length) continue;

    const topScore = Math.max(...recent.map(row => row.score));
    const relativeThreshold = Math.max(ABSOLUTE_QUALITY, topScore - TOP_GAP);

    const qualified = recent.filter((row, index) => {
      if (index === 0) return true;
      if (row.aiIndex !== Number.MAX_SAFE_INTEGER) return true;
      return row.score >= relativeThreshold;
    });

    if (!qualified.length) continue;

    buckets.push({
      name,
      order: groupOrder++,
      latest: Math.max(...qualified.map(row => itemTime(row.item))),
      rows: qualified.map(row => row.item)
    });
  }

  return interleaveBuckets(buckets);
}

export function chooseTop(items, mode, unreadSet, limit = 5, aiRanking = []) {
  // ニュースだけはグローバル件数上限を撤廃し、登録取得先単位で公平に選別する。
  if (mode === 'news') {
    return chooseBalancedNewsRecommendations(items, unreadSet, aiRanking);
  }

  const heuristic = heuristicRank(items, mode, unreadSet);
  const byId = new Map(items.map(item => [item.id, item]));
  const ordered = [];
  const used = new Set();

  for (const row of Array.isArray(aiRanking) ? aiRanking : []) {
    const item = byId.get(row?.id);
    if (item && !used.has(item.id)) {
      ordered.push({ item, score: Number(row?.score) || 0 });
      used.add(item.id);
    }
  }
  for (const row of heuristic) {
    if (!used.has(row.item.id)) {
      ordered.push(row);
      used.add(row.item.id);
    }
  }

  const selected = [];
  const sourceCount = new Map();
  const safeLimit = Math.max(0, Number(limit) || 0);
  for (const row of ordered) {
    const source = acquisitionSource(row.item);
    const count = sourceCount.get(source) || 0;
    if (count >= 2 && selected.length < Math.min(safeLimit, ordered.length - 1)) continue;
    selected.push(row.item);
    sourceCount.set(source, count + 1);
    if (selected.length >= safeLimit) break;
  }
  return selected;
}

export async function requestAiRank(items, mode) {
  const sample = items.slice(0, 30).map(i => ({
    id: i.id,
    title: i.title,
    source: i.source,
    pubDate: i.pubDate,
    description: String(i.description || '').replace(/<[^>]*>/g, ' ').slice(0, 800)
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch('/api/rank-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, items: sample }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
