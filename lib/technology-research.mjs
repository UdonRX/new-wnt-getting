import jsdomPackage from 'jsdom';
import { fetchRssSource, rssXml } from './rss-merge.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const { JSDOM, VirtualConsole } = jsdomPackage;

const CACHE_TTL = 30 * 60 * 1000;
const memoryCache = { at: 0, xml: '', items: [], meta: null };

const RESEARCH_VERSION = '生産技術8タブ-v4';
const RESEARCH_CATEGORIES = ['生技基礎', '改善事例', '技術革新', '論文・研究', '製品・製造技術', '異業種横展開'];

const PRODUCTION_RE = /(生産技術|製造技術|ものづくり|モノづくり|生産性|生産効率|工程改善|工程設計|工程管理|現場改善|省人化|省力化|自動化|自働化|標準作業|作業標準|標準工数|industrial\s*engineering|\bIE\b|ラインバランス|line\s*balanc|タクト|takt|cycle\s*time|サイクルタイム|セル生産|コンベア生産|一個流し|多品種少量|変種変量|段取り|SMED|ボトルネック|仕掛|\bWIP\b|かんばん|kanban|andon|アンドン|\bMES\b|製造DX|スマートファクトリ|工場DX|生産計画|人員配置|作業改善)/i;
const QUALITY_RE = /(\bQCD\b|\bSQCD\b|品質管理|品質保証|品質改善|品質向上|不良率|不良低減|不良削減|歩留まり|直行率|\bFPY\b|first\s*pass\s*yield|工程能力|\bCp\b|\bCpk\b|\bSPC\b|ポカヨケ|poka[ -]?yoke|外観検査|画像検査|検査自動化|測定|再加工|手直し|原価低減|コスト削減|材料ロス|リードタイム|納期)/i;
const EQUIPMENT_RE = /(\bOEE\b|設備総合効率|総合設備効率|設備効率|稼働率|可動率|稼動率|停止ロス|停止時間|チョコ停|微停止|設備停止|設備保全|予防保全|予知保全|予兆保全|\bTPM\b|\bMTBF\b|\bMTTR\b|故障解析|保全計画|ダウンタイム)/i;
const TRACE_RE = /(トレーサビリティ|traceability|\b4M\b|ロット追跡|lot\s*trace|Lot\s*No|履歴管理|工程履歴|検査履歴|部品情報|製造実績|設備データ|稼働データ|\bRFID\b|QRコード|二次元コード|\bPLC\b|OPC\s*UA|個体管理)/i;
const FOUNDATION_RE = /(基礎|基本|入門|とは|考え方|原理|手法|計算式|算出方法|計算方法|使い分け|特徴|メリット|デメリット|標準時間|工程分析|動作研究|動作分析|時間研究|稼働分析|方法工学|作業測定|\bECRS\b|QC7つ道具|なぜなぜ分析|5S|標準作業|ラインバランス|ラインバランシング|セル生産|\bQCD\b|\bOEE\b|\bIE\b|ワークサンプリング|VSM)/i;
const CASE_RE = /(導入|改善|活用事例|導入事例|改善事例|事例|ケーススタディ|case\s*study|実証|実践|課題|解決策|改善前|改善後|before\s*after|削減|短縮|向上|低減|\d+(?:\.\d+)?\s*%|工数|時間\/日|円\/年|万円|人\/|名\/|停止時間)/i;
const INNOVATION_RE = /(新技術|技術革新|新工法|新製法|新素材|新構造|世界初|業界初|独自技術|革新|innovation|novel|breakthrough|新規開発|開発した|実用化|量産化|研究開発|R&D|デジタルツイン|AI|機械学習|画像認識|センシング|ロボット|協働ロボット|AMR|3Dプリンタ|積層造形|形式知化|スマートファクトリ)/i;
const PRODUCT_RE = /(炊飯|米飯|rice\s*cook|rice\s*cooker|真空断熱|vacuum\s*(?:insulation|flask|bottle)|魔法瓶|thermos|電気ケトル|kettle|電気ポット|water\s*(?:boiler|warmer)|保温|保冷|heat\s*retention|temperature\s*control|温度制御|沸騰|boil|加熱|heating|thermal|熱伝達|断熱|insulation|phase\s*change|蓄熱|heat\s*storage|蒸気|steam|コーティング|coating|接合|joining|溶接|ろう付け|センサ|sensor|洗浄|cleaning|表面処理|材料技術)/i;
const BRAND_RE = /(タイガー魔法瓶|象印|zojirushi|panasonic|パナソニック|thermos|サーモス|iris\s*ohyama|アイリスオーヤマ|balmuda|バルミューダ|vermicular|バーミキュラ|siroca|山善|fellow|instant\s*brands|breville|de['’]?longhi|hydro\s*flask|stanley|ember)/i;
const CROSS_INDUSTRY_RE = /(自動車|自動車部品|automotive|半導体|semiconductor|電子部品|\bEMS\b|食品工場|食品製造|food\s*factory|医薬|製薬|pharma|化学工場|物流|logistics|倉庫|航空|aerospace|機械加工|金属加工|射出成形|樹脂成形|組立工場|包装|packaging|製鉄|鉄鋼)/i;
const USEFUL_RE = /(仕組み|原理|計算|算出|方法|手順|進め方|KPI|指標|効果|比較|課題|原因|対策|注意点|失敗|改善|導入|実装|検証|評価|実験|測定|データ|解析|可視化|見える化|ダッシュボード|設計|標準化|定量|分析)/i;
const PROMO_ONLY_RE = /(キャンペーン|セール|割引|プレゼント|ランキング|おすすめ\d+選|購入はこちら|予約販売|クーポン|新発売のお知らせ|発売記念|販売開始|価格改定)/i;
const BLOCKED_DOMAIN_RE = /(?:^|\.)(?:prtimes\.jp|businesswire\.com|prnewswire\.com|makuake\.com|camp-fire\.jp|kickstarter\.com)$/i;
const TRUSTED_PRIMARY_RE = /(?:j-ie\.com|jmac\.co\.jp|omron\.|keyence\.|mitsubishielectric\.co\.jp|panasonic\.|aist\.go\.jp|nedo\.go\.jp|jst\.go\.jp|jstage\.jst\.go\.jp|cir\.nii\.ac\.jp|itmedia\.co\.jp|monoist)/i;

const PAPER_QUERIES = [
  '生産技術 IE 生産性',
  '工程改善 ライン 生産システム',
  '品質管理 工程能力 歩留まり',
  '設備保全 OEE 稼働率',
  'トレーサビリティ MES 製造',
  '熱伝達 断熱 加熱 温度制御'
];

const DIRECT_SEEDS = [
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: 'IEとは', url: 'https://www.j-ie.com/about_ie/', publishedAt: '2024-02-26',
    summary: 'IE（Industrial Engineering）の基本的な考え方を解説。人・モノ・情報・設備・エネルギーを含むシステムを設計・改善し、価値とムダを定量的に捉えて生産性向上につなげる基礎。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '動作研究', url: 'https://www.j-ie.com/about_ie/methods/01/', publishedAt: '2024-02-19',
    summary: '作業者の身体動作や目の動きを分析し、ムダな動作をなくして効率的で疲労の少ない作業方法を確立するIE手法。サーブリッグ分析など改善の基礎を体系的に解説。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '時間研究', url: 'https://www.j-ie.com/about_ie/methods/02/', publishedAt: '2024-03-15',
    summary: '作業を要素作業に分解して時間を測定し、作業改善や標準時間設定につなげる時間研究の基礎。改善効果を時間で定量評価する考え方を解説。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '稼働分析', url: 'https://www.j-ie.com/about_ie/methods/03/', publishedAt: '2024-03-15',
    summary: '作業者や設備の稼働率と時間構成比率を求め、稼働・準稼働・非稼働に層別してムダを定量化するIE手法。連続観測法とワークサンプリングも解説。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '工程分析', url: 'https://www.j-ie.com/about_ie/methods/04/', publishedAt: '2024-03-15',
    summary: '材料や製品、作業者、運搬の流れを記号化して工程全体を可視化し、ムダや改善対象を見つける工程分析の基本を解説。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '標準時間', url: 'https://www.j-ie.com/about_ie/term/04/', publishedAt: '2024-03-15',
    summary: '標準時間を作業管理・生産計画・標準原価の基準として使う考え方と、正味時間・余裕時間・レイティング係数を用いた基本計算を解説。'
  },
  {
    category: '生技基礎', sourceLabel: '日本IE協会', organization: '日本インダストリアル・エンジニアリング協会',
    title: '流動数分析', url: 'https://www.j-ie.com/about_ie/methods/11/', publishedAt: '2024-03-15',
    summary: '工程への累積流入量と累積流出量の差から仕掛品在庫量や停滞時間を把握し、生産進捗やWIPのムダを分析するIE手法。'
  },
  {
    category: '生技基礎', sourceLabel: 'OMRON FA', organization: 'オムロン',
    title: 'OEEとは？7大ロスを見直して設備総合効率を改善', url: 'https://www.fa.omron.co.jp/product/special/maintenance-solution/column/column10/', publishedAt: '2025-01-01',
    summary: 'OEE（設備総合効率）を時間稼働率×性能稼働率×良品率で算出し、停止・性能・不良などのロスへ分解して設備改善につなげる方法を解説。'
  },
  {
    category: '生技基礎', sourceLabel: 'JMAC', organization: '日本能率協会コンサルティング',
    title: 'IE・標準時間設定コンサルティング', url: 'https://www.jmac.co.jp/consulting/category/production/most.html', publishedAt: '2025-01-01',
    summary: '方法改善、作業分析、稼働分析、工程分析、ライン作業分析、標準時間設定など、IEの基礎テクニックと現場改善の進め方を体系的に整理。'
  },
  {
    category: '生技基礎', sourceLabel: 'JMAC', organization: '日本能率協会コンサルティング',
    title: '工程分析', url: 'https://www.jmac.co.jp/glossary/ka/process_analysis.html', publishedAt: '2025-01-01',
    summary: '材料や製品の工程系列を記号で表し、工程構成・相互関係・問題点を明確化して、生産期間短縮、仕掛削減、工数低減につなげる工程分析の基礎。'
  },
  {
    category: '改善事例', sourceLabel: 'OMRON FA', organization: 'オムロン',
    title: '現場と経営の情報連携プラットフォームを専門的なIT知識不要で構築', url: 'https://www.fa.omron.co.jp/solution/proposal/app_043/', publishedAt: '2025-01-01',
    summary: '工場全体のOEEと各ラインの稼働データをひも付け、問題設備の特定やKPI可視化を属人作業から切り離して改善サイクルへつなげる事例。'
  },
  {
    category: '改善事例', sourceLabel: 'OMRON FA', organization: 'オムロン',
    title: 'トレーサビリティで実現する変種変量生産の品質管理', url: 'https://www.fa.omron.co.jp/solution/proposal/app_006/', publishedAt: '2025-01-01',
    summary: '製品と部品単位に4M情報、工程・作業情報をひも付けて品質を管理し、不良流出時の影響範囲特定や作業ミス防止へつなげるトレーサビリティ事例。'
  },
  {
    category: '技術革新', sourceLabel: 'OMRON FA', organization: 'オムロン',
    title: '熟練技能者が持つ匠の技を形式知化。設備総合効率をさらに向上', url: 'https://www.fa.omron.co.jp/solution/proposal/app_001/', publishedAt: '2025-01-01',
    summary: 'AI・IoT・センシングを使って熟練者の暗黙知を形式知化し、停止ロス、段取りロス、チョコ停、不良ロスなどOEE阻害要因を改善する技術アプローチ。'
  }
];

const WEB_SEARCH_GROUPS = [
  { id: 'foundation-case', categories: ['生技基礎', '改善事例'], target: '各カテゴリ10〜18件' },
  { id: 'innovation-product', categories: ['技術革新', '製品・製造技術'], target: '各カテゴリ10〜18件' },
  { id: 'cross', categories: ['異業種横展開'], target: '12〜20件' }
];

const CATEGORY_GUIDES = {
  '生技基礎': 'IE、QCD/SQCD、OEE、稼働率/可動率、標準時間、工程分析、動作研究、ECRS、ラインバランス、セル生産、コンベア生産、タクト、工程能力Cp/Cpk、SPC、4M、TPM、MTBF/MTTR、トレーサビリティ等の体系的な解説。',
  '改善事例': '工場での生産性、品質、工数、原価、停止時間、歩留まり、直行率、ライン、設備、検査、トレーサビリティ改善。課題→原因→対策、改善前後、数値、手順のいずれかが具体的に分かるもの。',
  '技術革新': '新工法、新製法、新素材、センシング、画像認識、AI、ロボット、デジタルツインなど、製造や製品開発へ流用できそうな新技術。単なる発売告知ではなく原理・技術内容が分かるもの。',
  '製品・製造技術': '炊飯器、魔法瓶、真空断熱、電気ケトル、加熱、温度制御、保温/保冷、蒸気、熱伝達、接合、コーティング、洗浄、センサ等。タイガー魔法瓶、象印、Panasonic、Thermos等の製品に近く、技術や量産工程の学びがあるもの。',
  '異業種横展開': '自動車、半導体、電子部品、食品、医薬、化学、物流、機械加工、鉄鋼などの改善事例で、設備・品質・工程・ライン・トレーサビリティの考え方を家電工場へ転用できるもの。'
};

function clean(value = '', max = 2400) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(value = '') {
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

function hostOf(value = '') {
  try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function normalizeDate(value = '') {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function itemKey(item = {}) {
  return `${String(item.url || '').replace(/[?#].*$/, '').toLowerCase()}|${String(item.title || '').toLowerCase()}`;
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

function hayOf(item = {}) {
  return `${item.title || ''} ${item.summary || ''} ${item.organization || ''} ${item.application || ''}`;
}

function isBlockedUrl(url = '') {
  return BLOCKED_DOMAIN_RE.test(hostOf(url));
}

function categoryOf(raw = {}) {
  const explicit = clean(raw.category, 80);
  if (RESEARCH_CATEGORIES.includes(explicit)) return explicit;
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (PRODUCT_RE.test(hay) && (BRAND_RE.test(hay) || /(製造|工法|構造|材料|熱|温度|加熱|断熱|接合|洗浄)/i.test(hay))) return '製品・製造技術';
  if (CROSS_INDUSTRY_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay))) return '異業種横展開';
  if (CASE_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay))) return '改善事例';
  if (FOUNDATION_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay))) return '生技基礎';
  if (INNOVATION_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay) || PRODUCT_RE.test(hay))) return '技術革新';
  return '';
}

function applicationIdea(raw = {}, category = '') {
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (category === '生技基礎') return '用語・計算式・使い分けを自工程の標準指標に置き換え、改善前後を同じ尺度で評価するための基礎知識として使える。';
  if (/(OEE|設備総合効率|稼働率|可動率|チョコ停|停止時間|MTBF|MTTR)/i.test(hay)) return '停止・速度・品質ロスを分解し、設備別/工程別KPI、ボトルネック、停止理由の標準化に転用できる。';
  if (/(トレーサビリティ|traceability|4M\b|ロット|工程履歴|検査履歴|部品情報)/i.test(hay)) return 'Lot No.に設備・部品・作業・検査結果をひも付け、異常時の影響範囲特定と原因解析の短縮へ応用できる。';
  if (/(セル生産|コンベア|タクト|takt|サイクルタイム|line\s*balanc|ラインバランス|ボトルネック)/i.test(hay)) return 'タクト差、待ち、滞留、作業者負荷を見える化し、ラインバランスや人員配置の改善に使える。';
  if (/(不良|歩留まり|直行率|FPY|工程能力|CpK?|ポカヨケ|検査)/i.test(hay)) return '不良を4Mで分解し、直行率/歩留まりのKPI化、ポカヨケや検査方法の改善につなげられる。';
  if (category === '製品・製造技術') return '製品機能だけでなく、量産性、工程安定性、検査性、材料・設備条件へ分解して新規開発や工程設計の着眼点に使える。';
  if (category === '異業種横展開') return '業種固有の部分を外し、工程設計・設備・品質・データ活用の共通原理だけを自工程へ横展開できる。';
  return '手法・原理・定量効果を自工程の課題に置き換え、改善テーマや新規技術探索の着眼点として使える。';
}

function hardAccept(item) {
  if (!item?.url || !item?.title || !item?.category || isBlockedUrl(item.url)) return false;
  const hay = hayOf(item);
  if (PROMO_ONLY_RE.test(hay) && !CASE_RE.test(hay) && !USEFUL_RE.test(hay)) return false;
  const tech = PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay) || PRODUCT_RE.test(hay);
  if (!tech) return false;
  if (item.category === '生技基礎') return FOUNDATION_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay));
  if (item.category === '改善事例') return CASE_RE.test(hay) && USEFUL_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay));
  if (item.category === '技術革新') return INNOVATION_RE.test(hay) && USEFUL_RE.test(hay) && tech;
  if (item.category === '論文・研究') return tech;
  if (item.category === '製品・製造技術') return PRODUCT_RE.test(hay) && (USEFUL_RE.test(hay) || INNOVATION_RE.test(hay) || BRAND_RE.test(hay));
  if (item.category === '異業種横展開') return CROSS_INDUSTRY_RE.test(hay) && CASE_RE.test(hay) && (PRODUCTION_RE.test(hay) || QUALITY_RE.test(hay) || EQUIPMENT_RE.test(hay) || TRACE_RE.test(hay));
  return false;
}

function ageScore(item) {
  const time = normalizeDate(item.pubDate).getTime();
  if (!time) return 0;
  const age = Math.max(0, (Date.now() - time) / 86400000);
  if (age <= 30) return 5;
  if (age <= 90) return 4;
  if (age <= 180) return 3;
  if (age <= 365) return 2;
  if (age <= 730) return 1;
  return 0;
}

function relevanceScore(item) {
  const hay = hayOf(item);
  let score = 0;
  if (PRODUCTION_RE.test(hay)) score += 20;
  if (QUALITY_RE.test(hay)) score += 18;
  if (EQUIPMENT_RE.test(hay)) score += 18;
  if (TRACE_RE.test(hay)) score += 18;
  if (USEFUL_RE.test(hay)) score += 15;
  if (CASE_RE.test(hay)) score += 10;
  if (FOUNDATION_RE.test(hay)) score += 8;
  if (INNOVATION_RE.test(hay)) score += 8;
  if (PRODUCT_RE.test(hay)) score += 8;
  if (CROSS_INDUSTRY_RE.test(hay)) score += 6;
  if (TRUSTED_PRIMARY_RE.test(item.url || '')) score += 8;
  if (/note\.com/i.test(item.url || '')) score += CASE_RE.test(hay) && USEFUL_RE.test(hay) ? 4 : -5;
  score += ageScore(item);
  if (PROMO_ONLY_RE.test(hay) && !CASE_RE.test(hay)) score -= 20;
  return score;
}

function normalizeItem(raw = {}, { category = '', direct = false } = {}) {
  const title = clean(raw.title, 320);
  const url = safeUrl(raw.url || raw.link);
  const summary = clean(raw.summary || raw.overview || raw.description || '', 1200);
  const sourceLabel = clean(raw.sourceLabel || raw.sourceName || raw.media || raw.source || '', 140);
  const organization = clean(raw.organization || raw.company || raw.brand || raw.institution || raw.author || sourceLabel, 180);
  const resolvedCategory = category || categoryOf(raw);
  const application = clean(raw.application || raw.applicationPoint || raw.insight || applicationIdea(raw, resolvedCategory), 700);
  if (!title || !url || !summary || !sourceLabel || !organization || !resolvedCategory) return null;
  const item = {
    category: resolvedCategory,
    title,
    url,
    summary,
    sourceLabel,
    organization,
    application,
    pubDate: normalizeDate(raw.publishedAt || raw.pubDate || raw.date),
    image: safeUrl(raw.image || raw.imageUrl),
    acquisition: clean(raw.acquisition || raw.method || (direct ? '公式RSS/API/固定基礎ソースによる直接取得' : 'Gemini Google Searchによるカテゴリ別Web調査'), 180)
  };
  return hardAccept(item) ? item : null;
}

function collectDirectSeeds() {
  return DIRECT_SEEDS.map(seed => normalizeItem({
    ...seed,
    application: applicationIdea(seed, seed.category),
    acquisition: '信頼できる公式解説・公式事例を直接収録'
  }, { category: seed.category, direct: true })).filter(Boolean);
}

function createQuietXmlDom(xml) {
  const virtualConsole = new VirtualConsole();
  return new JSDOM(xml, { contentType: 'text/xml', virtualConsole });
}

function nodeText(node, selectors = []) {
  for (const selector of selectors) {
    const value = node?.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

async function searchJStage(term) {
  const url = new URL('https://api.jstage.jst.go.jp/searchapi/do');
  url.searchParams.set('service', '3');
  url.searchParams.set('text', term);
  url.searchParams.set('count', '24');
  const response = await fetch(url, {
    headers: { Accept: 'application/atom+xml,application/xml,text/xml', 'User-Agent': 'PersonalDashboardTechnologyResearch/4.0' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`J-STAGE HTTP ${response.status} (${term})`);
  const dom = createQuietXmlDom(await response.text());
  try {
    return Array.from(dom.window.document.querySelectorAll('entry')).map(entry => {
      const title = nodeText(entry, ['article_title > ja', 'article_title > en', 'title']);
      const link = safeUrl(nodeText(entry, ['article_link > ja', 'article_link > en']) || entry.querySelector('link')?.getAttribute('href') || nodeText(entry, ['id']));
      const abstract = nodeText(entry, ['abstract > ja', 'abstract > en', 'summary', 'description']);
      const journal = nodeText(entry, ['material_title > ja', 'material_title > en']);
      const author = Array.from(entry.querySelectorAll('author > ja > name, author > en > name, author > name')).map(node => clean(node.textContent, 80)).filter(Boolean).slice(0, 6).join(', ');
      const date = nodeText(entry, ['pubdate', 'publication_date', 'published', 'online_pubdate', 'updated']) || nodeText(entry, ['pubyear']);
      return normalizeItem({
        title,
        url: link,
        summary: [abstract, journal && `掲載誌: ${journal}`].filter(Boolean).join(' ｜ '),
        organization: author || journal || 'J-STAGE',
        sourceLabel: 'J-STAGE',
        publishedAt: date,
        acquisition: `J-STAGE WebAPI（検索軸: ${term}）`
      }, { category: '論文・研究', direct: true });
    }).filter(Boolean);
  } finally { dom.window.close(); }
}

async function searchCiNii(term) {
  const url = new URL('https://cir.nii.ac.jp/opensearch/articles');
  url.searchParams.set('q', term);
  url.searchParams.set('count', '25');
  url.searchParams.set('format', 'rss');
  url.searchParams.set('lang', 'ja');
  const rows = await fetchRssSource({ name: `CiNii Research:${term}`, url: url.href, maxItems: 25 });
  return rows.map(row => normalizeItem({
    title: row.title,
    url: row.link,
    summary: clean(row.description, 1000),
    organization: row.author || 'CiNii Research',
    sourceLabel: 'CiNii Research',
    publishedAt: row.pubDate,
    image: row.image,
    acquisition: `CiNii Research OpenSearch（検索軸: ${term}）`
  }, { category: '論文・研究', direct: true })).filter(Boolean);
}

async function collectDirectPapers() {
  const jobs = [];
  for (const term of PAPER_QUERIES) {
    jobs.push(searchJStage(term));
    jobs.push(searchCiNii(term));
  }
  const settled = await Promise.allSettled(jobs);
  const items = [];
  const errors = [];
  settled.forEach(result => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push(String(result.reason?.message || result.reason || 'paper source failed'));
  });
  return { items: dedupe(items), errors };
}

async function collectMonoist() {
  try {
    const rows = await fetchRssSource({ name: 'MONOist', url: 'https://rss.itmedia.co.jp/rss/2.0/monoist.xml', maxItems: 80 });
    const items = rows.map(row => normalizeItem({
      title: row.title,
      url: row.link,
      summary: row.description,
      organization: row.author || 'MONOist',
      sourceLabel: 'MONOist',
      publishedAt: row.pubDate,
      image: row.image,
      acquisition: 'MONOist公式RSS'
    }, { direct: true })).filter(Boolean);
    return { items, errors: [] };
  } catch (error) {
    return { items: [], errors: [String(error?.message || error)] };
  }
}

function looseJson(text = '') {
  const stripped = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error('technology research JSON parse failed');
}

function groundingUrls(raw = {}) {
  return (raw?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map(chunk => safeUrl(chunk?.web?.uri || ''))
    .filter(Boolean);
}

function normalizeGeminiItems(parsed, rawResponse) {
  const grounding = groundingUrls(rawResponse);
  const used = new Set();
  const out = [];
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    let url = safeUrl(raw?.url);
    if (!url) url = grounding.find(candidate => !used.has(candidate) && !isBlockedUrl(candidate)) || '';
    if (url) used.add(url);
    const item = normalizeItem({ ...raw, url });
    if (item) out.push(item);
  }
  return dedupe(out);
}

function buildSearchPrompt(group) {
  const guides = group.categories.map((category, index) => `${index + 1}. ${category}: ${CATEGORY_GUIDES[category]}`).join('\n');
  return `あなたは製造業の生産技術エンジニア向け技術リサーチ担当です。Google Searchを使って、ニュースの話題性ではなく「読んだあとに知識・改善方法・技術着想が残る記事」を探してください。\n\n今回探すカテゴリは次だけです。別カテゴリの記事は返さないでください。\n${guides}\n\n優先取得先:\n- 生技基礎: 日本IE協会、日本能率協会コンサルティング(JMAC)、OMRON等の体系的な技術解説\n- 改善事例/異業種: OMRON FA、OMRON TECHNICS、KEYENCE、三菱電機 e-F@ctory、メーカー公式工場事例、MONOist\n- 技術革新: 産総研、NEDO、JST、大学・研究機関、メーカーR&D/技術ページ、信頼できる専門メディア\n- 製品・製造技術: メーカー公式R&D/技術ページ、特許解説、信頼できる専門媒体\n- note.com: 生産技術・製造改善の実務経験があり、具体的な手法、数値、失敗、改善過程が書かれた記事だけ可\n\n絶対に除外:\n- PR TIMES、Business Wire、PR Newswire、クラウドファンディング、EC/商品購入ページ\n- キャンペーン、発売告知だけ、ランキング、広告、SEO目的の薄い一般論\n- タイトルにキーワードがあるだけで本文が製造・製品技術と無関係な記事\n\n選別条件:\n- 各記事は「生産技術/品質/設備/トレーサビリティ/対象製品技術」のどれかに直接一致すること。\n- さらに「仕組み・原理・計算・方法・手順・改善前後・数値効果・失敗/注意点・技術内容」のどれかが確認できること。\n- 直近1年を優先。ただしIE/QCD/OEE等の基礎解説は古くても内容が良ければ可。\n- 正式な元記事URLのみ。Google検索結果URLは禁止。\n- ${group.target}を目標にし、条件に合う候補は省略せず返す。条件を満たさない記事で件数を埋めない。\n\nJSON以外を出力しない:\n{"items":[{"category":"${group.categories.join('|')}","organization":"企業/組織/著者","title":"正式タイトル","summary":"具体的な要点。方法や数値があれば含める","application":"家電工場・製品開発へどう使えるか","sourceLabel":"媒体名","publishedAt":"YYYY-MM-DD","url":"https://元記事URL"}]}`;
}

function isQuotaError(error) {
  const status = Number(error?.statusCode || 0) || 0;
  const message = String(error?.message || error || '');
  return status === 429 || /quota|resource[_\s-]*exhausted|rate limit/i.test(message);
}

async function callGemini(group) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');
  const model = String(process.env.GEMINI_RESEARCH_MODEL || 'gemini-3.5-flash-lite').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildSearchPrompt(group) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: 'minimal' } }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || `Gemini technology research ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    const text = (data?.candidates?.[0]?.content?.parts || []).filter(part => part?.thought !== true).map(part => part?.text || '').join('').trim();
    if (!text) throw new Error('Gemini technology research response empty');
    return { parsed: looseJson(text), raw: data };
  } finally { clearTimeout(timer); }
}

async function collectWebResearch() {
  const settled = await Promise.allSettled(WEB_SEARCH_GROUPS.map(group => callGemini(group).then(response => ({ group, response }))));
  const items = [];
  const errors = [];
  let quotaBlocked = false;
  for (const row of settled) {
    if (row.status === 'fulfilled') {
      items.push(...normalizeGeminiItems(row.value.response.parsed, row.value.response.raw));
    } else {
      quotaBlocked ||= isQuotaError(row.reason);
      errors.push(clean(row.reason?.message || row.reason, 180));
    }
  }
  return { items: dedupe(items), errors, quotaBlocked };
}

function selectAllAccepted(items = []) {
  return dedupe(items.filter(hardAccept)).sort((a, b) =>
    relevanceScore(b) - relevanceScore(a) || normalizeDate(b.pubDate) - normalizeDate(a.pubDate)
  );
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
      `研究方式: ${RESEARCH_VERSION}`,
      `対象企業/組織名: ${item.organization}`,
      `カテゴリ: ${item.category}`,
      `概要: ${item.summary}`,
      `応用着眼点: ${item.application}`,
      `媒体: ${item.sourceLabel}`,
      `取得方式: ${item.acquisition}`
    ].join(' ｜ ')
  }));
}

async function research({ refresh = false } = {}) {
  if (!refresh && memoryCache.xml && Date.now() - memoryCache.at < CACHE_TTL) return memoryCache;

  const seeds = collectDirectSeeds();
  const [papers, monoist, web] = await Promise.all([
    collectDirectPapers(),
    collectMonoist(),
    collectWebResearch()
  ]);

  const pool = dedupe([...seeds, ...papers.items, ...monoist.items, ...web.items]);
  const selected = selectAllAccepted(pool);
  if (!selected.length) throw new Error('条件を満たす技術リサーチ記事を取得できませんでした');

  const categoryCounts = Object.fromEntries(RESEARCH_CATEGORIES.map(category => [category, selected.filter(item => item.category === category).length]));
  const xml = rssXml(
    '技術リサーチ',
    `生産技術向けの厳格選別フィード。選別条件に合格した候補はカテゴリ別件数上限を設けず全件配信。今回 ${selected.length}件。`,
    toRssItems(selected)
  );
  const meta = {
    count: selected.length,
    categoryCounts,
    seedCount: seeds.length,
    paperErrors: papers.errors.length,
    monoistErrors: monoist.errors.length,
    webErrors: web.errors.length,
    geminiQuotaBlocked: web.quotaBlocked
  };

  memoryCache.at = Date.now();
  memoryCache.xml = xml;
  memoryCache.items = selected;
  memoryCache.meta = meta;
  console.info('[technology-research] all accepted result', meta);
  return memoryCache;
}

function categoryHeader(counts = {}) {
  return RESEARCH_CATEGORIES.map(category => `${category}=${Number(counts[category] || 0)}`).join(',');
}

export async function technologyResearchFeed(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const refresh = String(req.query?.refresh || '') === '1';
  try {
    const result = await research({ refresh });
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', refresh ? 'no-store' : 'public, s-maxage=900, stale-while-revalidate=21600');
    res.setHeader('X-Technology-Research-Count', String(result.items.length));
    res.setHeader('X-Technology-Research-Version', '4');
    res.setHeader('X-Technology-Research-Seed-Count', String(result.meta?.seedCount || 0));
    res.setHeader('X-Technology-Research-Paper-Errors', String(result.meta?.paperErrors || 0));
    res.setHeader('X-Technology-Research-Monoist-Errors', String(result.meta?.monoistErrors || 0));
    res.setHeader('X-Technology-Research-Web-Errors', String(result.meta?.webErrors || 0));
    res.setHeader('X-Technology-Research-Gemini-Quota', result.meta?.geminiQuotaBlocked ? 'blocked' : 'ok');
    setAsciiHeader(res, 'X-Technology-Research-Categories', categoryHeader(result.meta?.categoryCounts || {}));
    return res.status(200).send(result.xml);
  } catch (error) {
    console.error('[technology-research]', error);
    if (memoryCache.xml) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Technology-Research-Stale', '1');
      return res.status(200).send(memoryCache.xml);
    }
    return res.status(502).json({ error: '技術リサーチを取得できませんでした', detail: clean(error?.message || error, 500) });
  }
}
