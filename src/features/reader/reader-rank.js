const SOURCE_BONUS = [
  /日経|Reuters|BBC|J-STAGE|PubMed|PMC|PLOS|Semantic Scholar/i,
  /ITmedia|MONOist|EE Times|Impress/i
];

const IMPACT = /発表|決定|開始|導入|新工場|新製品|新技術|規制|法案|選挙|事故|災害|決算|買収|提携|AI|半導体|製造|自動化|省エネ|断熱|炊飯|thermal|insulat|rice|cooker/i;
const CREATIVE_SIGNAL = /独創研究軸|独創性スコア|acoustic|wettability|contact angle|capillary|porous media|microstructure|rheology|volatile|aroma release|thermal effusivity|haptic|human factors|cognitive ergonomics|biomimetic|bio-inspired|digital twin|sensor fusion|音響|濡れ性|毛細管|微細構造|香気|熱浸透率|認知人間工学|生物模倣|デジタルツイン/i;
const GENERAL_CREATIVE_SIGNAL = /一般独創|tribology|psychophysics|crossmodal|multisensory|origami|kirigami|metamaterial|architected material|collective behavior|crowd dynamics|network science|causal inference|natural experiment|computational imaging|low-cost sensor|coffee-ring|droplet evaporation|human-ai|ai advice|automation bias|cascading failure|network resilience|摩擦|心理物理|錯覚|折り紙|切り紙|メタマテリアル|群集|ネットワーク科学|因果推論|自然実験|低コストセンサ|液滴蒸発|連鎖故障|レジリエンス/i;
const RIGOR_SIGNAL = /実験|測定|検証|モデル|シミュレーション|解析|最適化|experiment|measurement|validation|model|simulation|mechanism|optimization|characteri[sz]ation|prototype/i;

function isPaperMode(mode) {
  return String(mode || '').startsWith('papers');
}

function recencyScore(date) {
  const hours = Math.max(0, (Date.now() - new Date(date).getTime()) / 3600000);
  return Math.max(0, 30 - hours * 1.2);
}

export function heuristicRank(items, mode, unreadSet = new Set()) {
  const creative = String(mode || '').startsWith('papers-creative');
  const generalCreative = mode === 'papers-creative-general';
  const allCreative = mode === 'papers-creative-all';
  return items.map(item => {
    let score = recencyScore(item.pubDate);
    const hay = `${item.title} ${item.description}`;

    if (IMPACT.test(hay)) score += isPaperMode(mode) ? 26 : 18;
    if (SOURCE_BONUS[0].test(item.source)) score += 14;
    else if (SOURCE_BONUS[1].test(item.source)) score += 8;
    if (!unreadSet.has(item.id)) score += 8;
    if (isPaperMode(mode) && /pdf/i.test(item.description)) score += 8;

    if (creative) {
      if (CREATIVE_SIGNAL.test(hay)) score += 16;
      if (RIGOR_SIGNAL.test(hay)) score += generalCreative ? 18 : 12;
      if (GENERAL_CREATIVE_SIGNAL.test(hay)) score += generalCreative || allCreative ? 18 : 6;
      const embedded = Number(String(item.description || '').match(/独創性スコア:\s*([0-9.]+)/)?.[1] || 0);
      score += Math.min(20, embedded * (generalCreative ? 0.55 : 0.45));
      // 独創研究では単なる新しさより、検証性と異分野接続を優先する。
      score -= recencyScore(item.pubDate) * (generalCreative ? 0.5 : 0.35);
      if (generalCreative && !/独創区分:\s*[^\n]*一般独創/i.test(hay)) score -= 40;
    }

    return { item, score };
  }).sort((a, b) => b.score - a.score);
}

export function chooseTop(items, mode, unreadSet, limit = 5, aiRanking = []) {
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
  for (const row of ordered) {
    const source = row.item.source || 'その他';
    const count = sourceCount.get(source) || 0;
    if (count >= 2 && selected.length < Math.min(limit, ordered.length - 1)) continue;
    selected.push(row.item);
    sourceCount.set(source, count + 1);
    if (selected.length >= limit) break;
  }

  // 「独創研究・すべて」は応用発想だけ/一般独創だけに偏らないよう、候補があれば最低1件ずつ混ぜる。
  if (mode === 'papers-creative-all' && selected.length >= 2) {
    const familyOf = item => /独創区分:\s*[^\n]*一般独創/i.test(String(item.description || '')) ? 'general' : 'applied';
    const selectedFamilies = new Set(selected.map(familyOf));
    for (const missing of ['general','applied']) {
      if (selectedFamilies.has(missing)) continue;
      const replacement = ordered.find(row => familyOf(row.item) === missing && !selected.some(item => item.id === row.item.id))?.item;
      if (replacement) {
        selected[selected.length - 1] = replacement;
        selectedFamilies.add(missing);
      }
    }
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
