import { rssXml } from './rss-merge.mjs';
import { collectTechnologySourceCandidates, TECHNOLOGY_SOURCE_CATALOG } from './technology-source-collectors.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const CACHE_TTL = 30 * 60 * 1000;
const REQUIRED_SOURCE_TYPES = ['特許情報', 'プレスリリース', '専門Webメディア', 'クラウドファンディング', '研究機関PR'];
const memoryCache = { at: 0, xml: '', items: [], meta: null };

// 技術リサーチは「製品技術の探索」だけでなく、生産技術者が明日の現場で使える情報を最優先する。
const PRODUCTION_ENGINEERING_RE = /(生産技術|製造技術|生産性|生産効率|現場改善|工程改善|工程設計|工程管理|工数|省人化|省力化|自動化|自働化|標準作業|作業標準|標準工数|IE\b|industrial\s*engineering|ラインバランス|line\s*balanc|タクト|takt|cycle\s*time|サイクルタイム|セル生産|コンベア生産|一個流し|多品種少量|変種変量|段取り|SMED|ボトルネック|仕掛|WIP|かんばん|kanban|アンドン|andon|MES\b|製造DX|スマートファクトリ|工場DX)/i;
const QCD_RE = /(QCD|品質向上|品質改善|品質管理|品質保証|不良率|不良低減|不良削減|歩留まり|直行率|FPY|first\s*pass\s*yield|工程能力|CpK?|手直し|再加工|ポカヨケ|poka[ -]?yoke|検査|外観検査|測定|コスト削減|原価低減|材料ロス|廃棄|納期|リードタイム|delivery|quality|cost)/i;
const UTILIZATION_TRACE_RE = /(OEE|設備総合効率|設備効率|稼働率|可動率|稼動率|停止時間|チョコ停|微停止|故障|設備停止|設備保全|予防保全|予知保全|TPM|MTBF|MTTR|トレーサビリティ|traceability|4M\b|ロット追跡|lot\s*trace|履歴管理|工程履歴|検査履歴|部品情報|製造実績|設備データ|稼働データ)/i;
const PRACTICAL_RE = /(導入事例|改善事例|活用事例|事例|算出方法|計算方法|計算式|算出|計算|方法|手順|進め方|KPI|指標|効果|削減|短縮|向上|改善率|見える化|可視化|ダッシュボード|実践|現場で|before\s*after|ケーススタディ|case\s*study)/i;
const CROSS_INDUSTRY_RE = /(自動車|自動車部品|automotive|半導体|semiconductor|電子部品|EMS\b|食品工場|食品製造|food\s*factory|医薬|製薬|pharma|化学工場|物流|logistics|倉庫|航空|aerospace|機械加工|金属加工|射出成形|樹脂成形|組立工場|包装|packaging)/i;
const PRODUCT_CORE_RE = /(炊飯|米飯|rice\s*cook|rice\s*cooker|真空断熱|vacuum\s*(?:insulation|flask|bottle)|魔法瓶|thermos|電気ケトル|kettle|電気ポット|water\s*(?:boiler|warmer)|保温|保冷|heat\s*retention|temperature\s*control|温度制御|沸騰|boil|加熱|heating|thermal|断熱|insulation|phase\s*change|蓄熱|heat\s*storage)/i;
const BRAND_RE = /(タイガー魔法瓶|象印|zojirushi|panasonic|パナソニック|thermos|サーモス|iris\s*ohyama|アイリスオーヤマ|balmuda|バルミューダ|vermicular|バーミキュラ|siroca|山善|fellow|instant\s*brands|breville|de['’]?longhi|hydro\s*flask|stanley|ember)/i;
const IDEA_RE = /(異分野|着想|新素材|新構造|新技術|世界初|独自|革新|innovation|novel|material|structure|sensor|制御|control|冷却|cooling|熱回収|energy|省エネ|相変化|phase\s*change|表面|coating|porous|多孔|aerogel|エアロゲル|触覚|haptic|ergonomic|人間工学|clean|洗浄|撥水|濡れ|microfluid|流体|蒸気|steam)/i;
const BROAD_DIRECT_RE = /(製造|生産|工場|設備|工程|改善|品質|稼働|可動|トレーサ|家電|調理|厨房|キッチン|cook|cooker|cookware|appliance|bottle|flask|coffee|food|飲料|水|water|steam|蒸気|heat|thermal|temperature|温度|加熱|冷却|cooling|断熱|insulation|vacuum|真空|energy|省エネ|material|素材|sensor|センサ|control|制御|battery|電池|surface|表面|coating|洗浄|clean|安全|safety|ergonomic|人間工学)/i;
const PROMO_ONLY_RE = /(キャンペーン|セール|割引|プレゼント|ランキング|おすすめ\d+選|購入はこちら|予約販売のみ|クーポン)/i;

const TARGET_BRANDS = [
  'タイガー魔法瓶', '象印マホービン', 'パナソニック', 'サーモス', 'アイリスオーヤマ',
  'バルミューダ', 'バーミキュラ（愛知ドビー）', 'シロカ', '山善',
  'Fellow Products', 'Instant Brands', 'Breville', "De\'Longhi", 'Hydro Flask',
  'Stanley', 'Ember', 'Zojirushi America'
];

const PRODUCTION_FOCUS = [
  '設備稼働率・可動率・OEE・停止ロス・チョコ停の算出と改善',
  'セル生産・コンベア生産・タクト・サイクルタイム・ラインバランス・ボトルネック改善',
  'トレーサビリティ・4M・ロット/部品/検査履歴・MES・製造データ活用',
  '品質向上・不良率/歩留まり/直行率・工程能力・ポカヨケ・検査自動化',
  '省人化・自動化・治具・段取り短縮・標準作業・IE・工数削減',
  '予防保全・予知保全・TPM・MTBF/MTTR・設備停止時間削減',
  '異業種（自動車・半導体・食品・医薬・物流）の改善事例を家電工場へ横展開'
];

const EXTRA_WEB_MEDIA = [
  'note（生産技術・製造業の実務記事）',
  'OMRON FA / i-Automation!（OEE・トレーサビリティ・現場改善事例）',
  'KEYENCE（工場改善・検査・トレーサビリティ事例）',
  '日立ソリューションズ東日本などの製造KPI/OEE解説',
  '富士フイルムビジネスイノベーションなどの工場改善解説',
  'OJTソリューションズなどのトヨタ式現場改善解説',
  'その他、製造業の一次情報・メーカー技術ブログ・信頼できる専門媒体'
];

function clean(value = '', max = 1800) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeUrl(value = '') {
  const input = String(value || '').trim();
  const match = input.match(/https?:\/\/[^\s<>"')\]】]+/i);
  const candidate = (match?.[0] || input).replace(/[.,、。!！?？;；:：]+$/g, '').trim();
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) return '';
    if (/google\.[^/]+\/search/i.test(url.href)) return '';
    return url.href;
  } catch { return ''; }
}

function normalizeDate(value = '') {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const direct = new Date(value || '');
  if (Number.isFinite(direct.getTime())) return direct;
  return new Date(0);
}

function canonicalSourceType(value = '') {
  const text = clean(value, 120).toLowerCase().replace(/[\s・｜|:_-]+/g, '');
  if (/特許|patent|jplatpat|espacenet|epo|wipo|uspto/.test(text)) return '特許情報';
  if (/プレス|pressrelease|press|prtimes|businesswire|newswire|ニュースリリース/.test(text)) return 'プレスリリース';
  if (/クラウドファン|クラファン|crowdfund|kickstarter|indiegogo|makuake|campfire/.test(text)) return 'クラウドファンディング';
  if (/研究機関|大学|公的研究|scienceportal|researcher|researchpr|学術広報|eurekalert/.test(text)) return '研究機関PR';
  if (/専門.*メディア|webメディア|ウェブメディア|media|note|家電watch|monoist|gizmodo|omron|keyence/.test(text)) return '専門Webメディア';
  return REQUIRED_SOURCE_TYPES.find(type => type.toLowerCase().replace(/\s+/g, '') === text) || '';
}

function categoryOf(raw = {}) {
  const explicit = clean(raw.category, 80);
  if (explicit === '生産技術・QCD') return explicit;
  if (explicit === '製品技術・競合' || explicit === 'コア技術・競合') return '製品技術・競合';
  if (explicit === '異分野アイデア') return explicit;
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''} ${raw.organization || ''}`;
  if (PRODUCTION_ENGINEERING_RE.test(hay) || QCD_RE.test(hay) || UTILIZATION_TRACE_RE.test(hay)) return '生産技術・QCD';
  if (PRODUCT_CORE_RE.test(hay) || BRAND_RE.test(hay)) return '製品技術・競合';
  return '異分野アイデア';
}

function applicationIdea(raw = {}) {
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (/(OEE|設備総合効率|稼働率|可動率|チョコ停|停止時間|MTBF|MTTR)/i.test(hay)) {
    return '稼働率だけでなく停止・速度・品質ロスを分解し、設備別/工程別のKPI算出、ボトルネック特定、停止理由の標準化に使える。';
  }
  if (/(トレーサビリティ|traceability|4M\b|ロット|工程履歴|検査履歴|部品情報)/i.test(hay)) {
    return '製品のLot No.に設備・部品・作業・検査結果をひも付ける設計、異常時の影響範囲特定、原因解析の短縮へ応用できる。';
  }
  if (/(セル生産|コンベア|タクト|takt|サイクルタイム|line\s*balanc|ラインバランス|ボトルネック)/i.test(hay)) {
    return 'セル/コンベア工程のタクト差、待ち・滞留・作業者負荷を見える化し、ラインバランス改善や人員配置の検討に使える。';
  }
  if (/(不良|歩留まり|直行率|FPY|工程能力|CpK?|ポカヨケ|検査)/i.test(hay)) {
    return '不良を工程・設備・材料・条件の4Mで分解し、直行率/歩留まりのKPI化、ポカヨケや検査方法の改善につなげられる。';
  }
  if (/(省人|省力|自動化|治具|段取り|SMED|標準作業|工数)/i.test(hay)) {
    return '工数、段取り時間、手作業のばらつきを定量化し、自動化・治具化・標準作業のどこに投資するとQCD効果が高いか比較できる。';
  }
  if (/断熱|vacuum|insulation|aerogel|熱橋|輻射|radiation/i.test(hay)) return '製品性能だけでなく、断熱材・真空封止・組立・検査工程の作りやすさと品質安定性まで含めて製造条件へ展開したい。';
  if (/温度|sensor|control|制御|algorithm|推定|AI|heating|加熱/i.test(hay)) return '温度/センサーデータを工程条件監視や異常検知に転用し、品質安定化と設備停止の予兆検知へつなげられる可能性がある。';
  if (/表面|coating|撥水|濡れ|clean|洗浄|汚れ|porous|多孔/i.test(hay)) return '材料・表面処理の知見を製品性能だけでなく、付着防止、清掃工数、検査性、工程安定性の改善に横展開できる。';
  return '記事の手法を「品質・コスト・納期・安全・工数・設備停止」のKPIに置き換え、自社工程へ横展開できるかを確認したい。';
}

function normalizeItem(raw = {}, { direct = false } = {}) {
  const sourceType = canonicalSourceType(raw.sourceType || raw.source || raw.type || '');
  const sourceLabel = clean(raw.sourceLabel || raw.media || raw.publication || '', 120);
  const title = clean(raw.title || raw.project || raw.product, 240);
  const url = normalizeUrl(raw.url || raw.link || raw.sourceUrl);
  const summary = clean(raw.summary || raw.overview || raw.description || title, 700);
  const organization = clean(raw.organization || raw.company || raw.brand || raw.institution || raw.author || sourceLabel, 160);
  const application = clean(raw.application || raw.applicationPoint || raw.insight || raw.idea || applicationIdea(raw), 700);
  if (!sourceType || !sourceLabel || !title || !url || !summary || !organization || !application) return null;
  return {
    sourceType,
    sourceLabel,
    organization,
    title,
    url,
    summary,
    category: categoryOf(raw),
    application,
    pubDate: normalizeDate(raw.publishedAt || raw.pubDate || raw.date),
    image: normalizeUrl(raw.image || raw.imageUrl),
    acquisition: clean(raw.acquisition || raw.method || (direct ? '媒体直接取得' : 'Google Searchによる生産技術リサーチ'), 160)
  };
}

function itemKey(item = {}) {
  return `${item.url?.replace(/[?#].*$/, '').toLowerCase() || ''}|${String(item.title || '').toLowerCase()}`;
}

function dedupe(items = []) {
  const seen = new Set();
  return items.filter(item => {
    if (!item) return false;
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directHay(item = {}) {
  return `${item.title || ''} ${item.summary || ''} ${item.organization || ''}`;
}

function relevantDirectItem(item = {}) {
  const hay = directHay(item);
  return PRODUCTION_ENGINEERING_RE.test(hay) || QCD_RE.test(hay) || UTILIZATION_TRACE_RE.test(hay)
    || PRODUCT_CORE_RE.test(hay) || BRAND_RE.test(hay) || IDEA_RE.test(hay);
}

function broadDirectItem(item = {}) {
  return BROAD_DIRECT_RE.test(directHay(item));
}

function ageScore(item) {
  const t = normalizeDate(item.pubDate).getTime();
  if (!t) return 0;
  const age = Math.max(0, (Date.now() - t) / 86400000);
  if (age <= 14) return 6;
  if (age <= 30) return 5;
  if (age <= 90) return 4;
  if (age <= 180) return 3;
  if (age <= 365) return 2;
  if (age <= 730) return 1;
  return 0;
}

function relevanceScore(item) {
  const hay = `${item.title} ${item.summary} ${item.organization} ${item.application || ''}`;
  let score = ageScore(item);
  if (PRODUCTION_ENGINEERING_RE.test(hay)) score += 12;
  if (QCD_RE.test(hay)) score += 10;
  if (UTILIZATION_TRACE_RE.test(hay)) score += 10;
  if (PRACTICAL_RE.test(hay)) score += 8;
  if (CROSS_INDUSTRY_RE.test(hay) && (PRODUCTION_ENGINEERING_RE.test(hay) || QCD_RE.test(hay) || UTILIZATION_TRACE_RE.test(hay))) score += 4;
  if (PRODUCT_CORE_RE.test(hay)) score += 6;
  if (BRAND_RE.test(hay)) score += 3;
  if (IDEA_RE.test(hay)) score += 3;
  if (/note\.com/i.test(item.url || '') && (PRODUCTION_ENGINEERING_RE.test(hay) || QCD_RE.test(hay))) score += 3;
  if (PROMO_ONLY_RE.test(hay) && !PRACTICAL_RE.test(hay)) score -= 8;
  if (item.sourceType === 'プレスリリース' && !PRACTICAL_RE.test(hay) && !PRODUCTION_ENGINEERING_RE.test(hay)) score -= 2;
  return score;
}

function ranked(items = []) {
  return dedupe(items).sort((a, b) => relevanceScore(b) - relevanceScore(a) || normalizeDate(b.pubDate) - normalizeDate(a.pubDate));
}

function selectTen(items = []) {
  const candidates = ranked(items);
  const out = [];
  const used = new Set();
  const sourceCounts = new Map();

  const take = (predicate, target, sourceCap = 3) => {
    for (const item of candidates) {
      if (out.length >= 10 || target <= 0) break;
      if (!predicate(item)) continue;
      const key = itemKey(item);
      if (used.has(key)) continue;
      const source = String(item.sourceLabel || item.sourceType || 'その他');
      if ((sourceCounts.get(source) || 0) >= sourceCap) continue;
      out.push(item);
      used.add(key);
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
      target -= 1;
    }
  };

  // 10件の基本配分: 生産技術/QCD 6、製品×技術 2、異分野横展開 2。
  take(item => item.category === '生産技術・QCD', 6);
  take(item => item.category === '製品技術・競合', 2);
  take(item => item.category === '異分野アイデア', 2);

  // 不足分は役立ち度順。媒体の種類は固定2件ずつにせず、同一媒体だけに偏らない程度のソフト制約にする。
  for (const cap of [3, 4, Number.POSITIVE_INFINITY]) {
    take(() => true, 10 - out.length, cap);
    if (out.length >= 10) break;
  }
  return out.slice(0, 10);
}

function missingTypes(items = []) {
  return REQUIRED_SOURCE_TYPES.filter(type => !items.some(item => item.sourceType === type));
}

function looseJson(text = '') {
  const stripped = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error('research JSON parse failed');
}

function groundingUrls(raw = {}) {
  return (raw?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map(chunk => normalizeUrl(chunk?.web?.uri || ''))
    .filter(Boolean);
}

function domainMatches(type, url) {
  if (type === '特許情報') return /patents\.google\.|j-platpat\.inpit\.go\.jp|espacenet|epo\.org|wipo\.int/i.test(url);
  if (type === 'プレスリリース') return /prtimes\.jp|businesswire\.com|prnewswire\.com/i.test(url);
  if (type === 'クラウドファンディング') return /makuake\.com|camp-fire\.jp|kickstarter\.com/i.test(url);
  if (type === '研究機関PR') return /research-er\.jp|scienceportal\.jst\.go\.jp|eurekalert\.org/i.test(url);
  return /note\.com|kaden\.watch\.impress\.co\.jp|itmedia\.co\.jp|gizmodo\.jp|omron\.|keyence\.|hitachi-solutions|fujifilm|ojt-s\.jp/i.test(url);
}

function normalizeGeminiItems(parsed, rawResponse) {
  const grounding = groundingUrls(rawResponse);
  const used = new Set();
  const out = [];
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    let item = normalizeItem(raw);
    if (!item) {
      const sourceType = canonicalSourceType(raw?.sourceType || raw?.source || '');
      if (!sourceType) continue;
      const url = grounding.find(candidate => !used.has(candidate) && domainMatches(sourceType, candidate));
      if (!url) continue;
      used.add(url);
      item = normalizeItem({ ...raw, url });
    }
    if (item) out.push(item);
  }
  return dedupe(out);
}

function catalogText() {
  const current = TECHNOLOGY_SOURCE_CATALOG
    .map(group => `${group.sourceType}: ${group.media.map(media => media.name).join(' / ')}`)
    .join('\n');
  return `${current}\n追加の実務Web情報源: ${EXTRA_WEB_MEDIA.join(' / ')}`;
}

function candidateText(candidates) {
  return candidates
    .slice(0, 35)
    .map((item, i) => `${i + 1}. [${item.sourceType}/${item.sourceLabel}] ${normalizeDate(item.pubDate).toISOString().slice(0, 10)} | ${item.title} | ${item.url} | ${clean(item.summary, 220)}`)
    .join('\n');
}

function buildProductionPrompt({ directCandidates, excludeUrls = [], rotation }) {
  return `あなたは製造業の生産技術エンジニア向け技術スカウト担当です。Google Searchを使い、「明日の現場改善に使える記事」を優先して探してください。\n\n最優先テーマ:\n- QCD（品質・コスト・納期）、生産性向上、品質向上、工数/原価低減\n- 設備稼働率・可動率・OEE、停止ロス、チョコ停、MTBF/MTTR、保全\n- セル生産・コンベア生産、タクト、サイクルタイム、ラインバランス、ボトルネック\n- トレーサビリティ、4M、Lot No.と部品/設備/作業/検査結果のひも付け、MES\n- 不良率、歩留まり、直行率、工程能力、ポカヨケ、検査自動化\n- 省人化、自動化、治具、段取り短縮、標準作業、IE\n\n今回の重点:\n${rotation}\n\n製品との接点:\n炊飯器、魔法瓶、真空断熱、電気ケトル、加熱・温度制御・保温/保冷など、現在の製品開発/製造に近い記事も残す。競合企業例は ${TARGET_BRANDS.join('、')}。ただし製品情報だけの記事より、製造工程やQCD改善に使える記事を上位にする。\n\n異業種横展開:\n自動車、半導体、電子部品、食品、医薬、化学、物流、機械加工など、業種が違っても設備・品質・ライン・トレーサビリティの改善方法を転用できる記事は積極的に選ぶ。\n\n情報源:\n${catalogText()}\n上記以外でも、企業/工場の一次情報、信頼できる製造業専門メディア、技術ベンダーの具体的な導入事例は使用可。note.comは生産技術・製造改善の実務経験や具体的な方法/数値が書かれた記事を優先し、薄い一般論や宣伝だけの記事は除外する。\n\nすでにRSS/API等で直接取得できている候補:\n${candidateText(directCandidates) || 'なし'}\n\n選定ルール:\n- 12〜16候補を返す。目安は「生産技術・QCD」8件以上、「製品技術・競合」2〜3件、「異分野アイデア」2〜4件。\n- 直近180日を優先。ただしOEE算出方法、IE、トレーサビリティ設計など長く使える実務解説は2年程度まで許容。\n- タイトルだけでなく、本文/概要に導入方法、計算式、KPI、改善前後、効果、失敗/注意点のどれかがある記事を高く評価。\n- 広告だけ、ランキングだけ、製品購入だけ、SEO目的の薄い記事は除外。\n- URLは必ず元記事の具体URL。Google検索結果URLや推測URLは禁止。\n- sourceTypeは、note/企業技術ブログ/製造業解説/導入事例なら「専門Webメディア」とする。\n- applicationには、この記事を家電工場のセル/コンベア工程、設備、品質、トレーサビリティへどう使えるかを具体的に書く。\n${excludeUrls.length ? `- 次URLは重複禁止: ${excludeUrls.join(' , ')}\n` : ''}\nJSON以外を出力しない:\n{\"items\":[{\"sourceType\":\"特許情報|プレスリリース|専門Webメディア|クラウドファンディング|研究機関PR\",\"organization\":\"企業/組織/著者\",\"title\":\"正式タイトル\",\"category\":\"生産技術・QCD|製品技術・競合|異分野アイデア\",\"summary\":\"記事の具体的な要点\",\"application\":\"生産技術への応用着眼点\",\"sourceLabel\":\"媒体名\",\"publishedAt\":\"YYYY-MM-DD\",\"url\":\"https://元記事\"}]}`;
}

function isQuotaError(error) {
  const status = Number(error?.statusCode || 0) || 0;
  const message = String(error?.message || error || '');
  return status === 429 || /quota|resource[_\s-]*exhausted|rate limit/i.test(message);
}

async function callGemini(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');
  const model = String(process.env.GEMINI_RESEARCH_MODEL || 'gemini-3.5-flash-lite').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 7500, thinkingConfig: { thinkingLevel: 'minimal' } }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || `Gemini research ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    const text = (data?.candidates?.[0]?.content?.parts || []).filter(part => part?.thought !== true).map(part => part?.text || '').join('').trim();
    if (!text) throw new Error('Gemini research response empty');
    return { parsed: looseJson(text), raw: data };
  } finally {
    clearTimeout(timer);
  }
}

function toRssItems(items) {
  return items.map(item => ({
    title: item.title,
    link: item.url,
    pubDate: item.pubDate.getTime() ? item.pubDate : new Date(),
    author: item.organization,
    sourceName: `技術リサーチ｜${item.category}｜${item.sourceLabel}`,
    image: item.image,
    description: [
      '技術リサーチ: Web調査済み',
      `対象企業/組織名: ${item.organization}`,
      `カテゴリ: ${item.category}`,
      `概要: ${item.summary}`,
      `生産技術への応用: ${item.application}`,
      `媒体: ${item.sourceLabel}`,
      `取得方式: ${item.acquisition}`
    ].join(' ｜ ')
  }));
}

function typeCountsHeader(typeCounts = {}) {
  return [
    `patent=${Number(typeCounts['特許情報'] || 0)}`,
    `press=${Number(typeCounts['プレスリリース'] || 0)}`,
    `media=${Number(typeCounts['専門Webメディア'] || 0)}`,
    `crowdfund=${Number(typeCounts['クラウドファンディング'] || 0)}`,
    `research=${Number(typeCounts['研究機関PR'] || 0)}`
  ].join(',');
}

async function research({ refresh = false } = {}) {
  if (!refresh && memoryCache.xml && Date.now() - memoryCache.at < CACHE_TTL) return memoryCache;

  const collected = await collectTechnologySourceCandidates();
  const normalizedDirect = dedupe((collected.candidates || [])
    .map(raw => normalizeItem(raw, { direct: true }))
    .filter(Boolean));
  const strongDirect = normalizedDirect.filter(relevantDirectItem);
  const broadDirect = normalizedDirect.filter(item => !relevantDirectItem(item) && broadDirectItem(item));
  const directItems = dedupe([...strongDirect, ...broadDirect]);
  const slot = Math.floor(Date.now() / (4 * 60 * 60 * 1000));
  const rotation = PRODUCTION_FOCUS[slot % PRODUCTION_FOCUS.length];

  let pool = [...directItems];
  let geminiQuotaBlocked = false;

  // 既存15媒体で十分な生産技術記事が揃っていても、note/メーカー事例/異業種の横展開候補を1回だけ探索する。
  // 連続再試行は行わず、Gemini失敗時は直接取得候補だけで継続する。
  try {
    const supplement = await callGemini(buildProductionPrompt({
      directCandidates: directItems,
      excludeUrls: directItems.slice(0, 20).map(item => item.url),
      rotation
    }));
    pool = dedupe([...pool, ...normalizeGeminiItems(supplement.parsed, supplement.raw)]);
  } catch (error) {
    geminiQuotaBlocked = isQuotaError(error);
    console.warn('[technology-research] production web supplement failed', error?.message || error);
  }

  const selected = selectTen(pool);
  if (!selected.length) throw new Error('技術リサーチ候補を取得できませんでした');

  const directMedia = new Set(directItems.map(item => item.sourceLabel)).size;
  const typeCounts = Object.fromEntries(REQUIRED_SOURCE_TYPES.map(type => [type, selected.filter(item => item.sourceType === type).length]));
  const categoryCounts = {
    production: selected.filter(item => item.category === '生産技術・QCD').length,
    product: selected.filter(item => item.category === '製品技術・競合').length,
    crossIndustry: selected.filter(item => item.category === '異分野アイデア').length
  };
  const missing = missingTypes(selected);
  const xml = rssXml(
    '技術リサーチ',
    `生産技術・QCDを最優先し、製品技術と異業種の横展開も混ぜて選定。今回 ${selected.length}/10件。`,
    toRssItems(selected)
  );
  const meta = {
    directCandidateCount: directItems.length,
    directMediaCount: directMedia,
    sourceErrors: collected.errors?.length || 0,
    typeCounts,
    categoryCounts,
    geminiQuotaBlocked,
    missingTypes: missing
  };
  memoryCache.at = Date.now();
  memoryCache.xml = xml;
  memoryCache.items = selected;
  memoryCache.meta = meta;
  console.info('[technology-research] result', {
    selected: selected.length,
    directCandidates: directItems.length,
    directMedia,
    typeCounts,
    categoryCounts,
    geminiQuotaBlocked,
    sourceErrors: meta.sourceErrors
  });
  return memoryCache;
}

export async function technologyResearchFeed(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const refresh = String(req.query?.refresh || '') === '1';
  try {
    const result = await research({ refresh });
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', refresh ? 'no-store' : 'public, s-maxage=900, stale-while-revalidate=21600');
    res.setHeader('X-Technology-Research-Count', String(result.items.length));
    res.setHeader('X-Technology-Research-Direct-Candidates', String(result.meta?.directCandidateCount || 0));
    res.setHeader('X-Technology-Research-Direct-Media', String(result.meta?.directMediaCount || 0));
    res.setHeader('X-Technology-Research-Source-Errors', String(result.meta?.sourceErrors || 0));
    res.setHeader('X-Technology-Research-Type-Counts', typeCountsHeader(result.meta?.typeCounts || {}));
    res.setHeader('X-Technology-Research-Gemini-Quota', result.meta?.geminiQuotaBlocked ? 'blocked' : 'ok');
    if (result.meta?.missingTypes?.length) setAsciiHeader(res, 'X-Technology-Research-Missing-Types', result.meta.missingTypes.join('|'));
    if (result.items.length < 10) res.setHeader('X-Technology-Research-Partial', '1');
    return res.status(200).send(result.xml);
  } catch (error) {
    console.error('[technology-research]', error);
    if (memoryCache.xml) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Technology-Research-Stale', '1');
      return res.status(200).send(memoryCache.xml);
    }
    return res.status(502).json({ error: '技術リサーチを取得できませんでした', detail: String(error?.message || error).slice(0, 500) });
  }
}
