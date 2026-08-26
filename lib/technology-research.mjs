import jsdomPackage from 'jsdom';
import { fetchRssSource, rssXml } from './rss-merge.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const { JSDOM, VirtualConsole } = jsdomPackage;

const CACHE_TTL = 30 * 60 * 1000;
const memoryCache = { at: 0, xml: '', items: [], meta: null };

const RESEARCH_VERSION = '生産技術8タブ-v5';
const RESEARCH_CATEGORIES = ['生技基礎', '改善事例', '技術革新', '論文・研究', '製品・製造技術', '異業種横展開'];
const WEB_CATEGORIES = ['生技基礎', '改善事例', '技術革新', '製品・製造技術', '異業種横展開'];

const PRODUCTION_RE = /(生産技術|製造技術|ものづくり|モノづくり|生産性|生産効率|工程改善|工程設計|工程管理|現場改善|省人化|省力化|自動化|自働化|標準作業|作業標準|標準工数|industrial\s*engineering|\bIE\b|ラインバランス|line\s*balanc|タクト|takt|cycle\s*time|サイクルタイム|セル生産|コンベア生産|一個流し|多品種少量|変種変量|段取り|SMED|ボトルネック|仕掛|\bWIP\b|かんばん|kanban|andon|アンドン|\bMES\b|製造DX|スマートファクトリ|工場DX|生産計画|人員配置|作業改善|工程|工場|製造現場)/i;
const QUALITY_RE = /(\bQCD\b|\bSQCD\b|品質管理|品質保証|品質改善|品質向上|不良率|不良低減|不良削減|歩留まり|直行率|\bFPY\b|first\s*pass\s*yield|工程能力|\bCp\b|\bCpk\b|\bSPC\b|ポカヨケ|poka[ -]?yoke|外観検査|画像検査|検査自動化|測定|再加工|手直し|原価低減|コスト削減|材料ロス|リードタイム|納期|品質)/i;
const EQUIPMENT_RE = /(\bOEE\b|設備総合効率|総合設備効率|設備効率|稼働率|可動率|稼動率|停止ロス|停止時間|チョコ停|微停止|設備停止|設備保全|予防保全|予知保全|予兆保全|\bTPM\b|\bMTBF\b|\bMTTR\b|故障解析|保全計画|ダウンタイム|設備)/i;
const TRACE_RE = /(トレーサビリティ|traceability|\b4M\b|ロット追跡|lot\s*trace|Lot\s*No|履歴管理|工程履歴|検査履歴|部品情報|製造実績|設備データ|稼働データ|\bRFID\b|QRコード|二次元コード|\bPLC\b|OPC\s*UA|個体管理|ロット管理|製造履歴)/i;
const FOUNDATION_RE = /(基礎|基本|入門|とは|考え方|原理|手法|計算式|算出方法|計算方法|使い分け|特徴|メリット|デメリット|標準時間|工程分析|動作研究|動作分析|時間研究|稼働分析|方法工学|作業測定|\bECRS\b|QC7つ道具|なぜなぜ分析|5S|標準作業|ラインバランス|ラインバランシング|セル生産|\bQCD\b|\bOEE\b|\bIE\b|ワークサンプリング|VSM|工程能力|\bCp\b|\bCpk\b|\bSPC\b|\bTPM\b|\bMTBF\b|\bMTTR\b)/i;
const CASE_RE = /(導入|改善|活用事例|導入事例|改善事例|事例|ケーススタディ|case\s*study|実証|実践|課題|解決策|改善前|改善後|before\s*after|削減|短縮|向上|低減|\d+(?:\.\d+)?\s*%|工数|時間\/日|円\/年|万円|人\/|名\/|停止時間|省人|省力|効率化)/i;
const INNOVATION_RE = /(新技術|技術革新|新工法|新製法|新素材|新構造|世界初|業界初|独自技術|革新|innovation|novel|breakthrough|新規開発|開発した|実用化|量産化|研究開発|R&D|デジタルツイン|AI|機械学習|画像認識|センシング|ロボット|協働ロボット|AMR|3Dプリンタ|積層造形|形式知化|スマートファクトリ|予知保全|予兆保全)/i;
const PRODUCT_RE = /(炊飯|米飯|rice\s*cook|rice\s*cooker|真空断熱|vacuum\s*(?:insulation|flask|bottle)|魔法瓶|thermos|電気ケトル|kettle|電気ポット|water\s*(?:boiler|warmer)|保温|保冷|heat\s*retention|temperature\s*control|温度制御|沸騰|boil|加熱|heating|thermal|熱伝達|断熱|insulation|phase\s*change|蓄熱|heat\s*storage|蒸気|steam|コーティング|coating|接合|joining|溶接|ろう付け|センサ|sensor|洗浄|cleaning|表面処理|材料技術|成形|組立|ヒーター|誘導加熱|IH)/i;
const CROSS_INDUSTRY_RE = /(自動車|自動車部品|automotive|半導体|semiconductor|電子部品|\bEMS\b|食品工場|食品製造|food\s*factory|医薬|製薬|pharma|化学工場|物流|logistics|倉庫|航空|aerospace|機械加工|金属加工|射出成形|樹脂成形|組立工場|包装|packaging|製鉄|鉄鋼|電池|battery|建機|工作機械)/i;
const PROMO_ONLY_RE = /(キャンペーン|セール|割引|プレゼント|ランキング|おすすめ\d+選|購入はこちら|予約販売|クーポン|新発売のお知らせ|発売記念|販売開始|価格改定|採用情報|求人|セミナー申込|資料ダウンロードだけ)/i;
const BLOCKED_DOMAIN_RE = /(?:^|\.)(?:prtimes\.jp|businesswire\.com|prnewswire\.com|makuake\.com|camp-fire\.jp|kickstarter\.com)$/i;
const TRUSTED_PRIMARY_RE = /(?:j-ie\.com|jmac\.co\.jp|omron\.|keyence\.|mitsubishielectric\.co\.jp|panasonic\.|aist\.go\.jp|nedo\.go\.jp|jst\.go\.jp|jstage\.jst\.go\.jp|cir\.nii\.ac\.jp|itmedia\.co\.jp|monoist|ricoh\.|canon\.|fujifilm\.|daikin\.|yaskawa\.|fanuc\.|denso\.|toyota\.)/i;

const PAPER_QUERIES = [
  '生産技術 IE 生産性',
  '工程改善 ライン 生産システム',
  '品質管理 工程能力 歩留まり',
  '設備保全 OEE 稼働率',
  'トレーサビリティ MES 製造',
  '熱伝達 断熱 加熱 温度制御'
];

const SEARCH_MATRIX = {
  '生技基礎': {
    general: [
      'IE 基礎 生産技術 工程改善', 'QCD SQCD 製造 基礎', 'OEE 計算 稼働率 可動率 設備総合効率',
      '標準時間 時間研究 作業測定', '工程分析 動作分析 ECRS IE', 'セル生産 ライン生産 特徴 比較',
      'ラインバランス タクト サイクルタイム 計算', 'Cp Cpk SPC 工程能力 品質管理', '4M なぜなぜ ポカヨケ QC7つ道具',
      'TPM MTBF MTTR 設備保全 基礎', 'トレーサビリティ MES 製造 基礎', '5S VSM かんばん 一個流し',
      'ワークサンプリング 稼働分析 IE', 'ボトルネック WIP 仕掛 生産管理'
    ],
    note: [
      'site:note.com 生産技術 IE 改善', 'site:note.com OEE 稼働率 工場', 'site:note.com セル生産 ラインバランス',
      'site:note.com 標準時間 タクト 生産', 'site:note.com Cp Cpk 品質管理 製造', 'site:note.com トレーサビリティ MES 製造',
      'site:note.com ECRS 工程改善', 'site:note.com MTBF MTTR 設備保全'
    ]
  },
  '改善事例': {
    general: [
      '工場 生産性向上 改善事例', 'サイクルタイム 短縮 工場 事例', '段取り時間 短縮 SMED 事例',
      'OEE 改善 設備停止 チョコ停 事例', '不良率 削減 歩留まり 改善 製造 事例', '画像検査 自動化 品質改善 事例',
      '省人化 自動化 工数削減 工場 事例', 'ラインバランス 人員配置 改善事例', 'セル生産 改善 生産性 事例',
      'トレーサビリティ 導入 4M ロット 事例', 'MES 可視化 工場 改善 事例', '原価低減 材料ロス 製造 改善事例',
      '予防保全 予知保全 停止時間 削減 事例', 'ポカヨケ 作業ミス 削減 工場 事例'
    ],
    note: [
      'site:note.com 生産技術 改善事例 工場', 'site:note.com タクト短縮 工程改善', 'site:note.com 設備改善 OEE',
      'site:note.com 不良削減 品質改善 製造', 'site:note.com 省人化 治具 改善', 'site:note.com トレーサビリティ 製造 改善',
      'site:note.com 段取り改善 SMED', 'site:note.com ラインバランス 改善'
    ]
  },
  '技術革新': {
    general: [
      '製造 新技術 AI 外観検査', '工場 画像認識 センシング 新技術', 'デジタルツイン 製造 工場 技術',
      '協働ロボット AMR 製造 技術', '予知保全 AI センサ 製造設備', '新工法 新製法 製造 技術',
      '新素材 量産 工法 製品開発', '接合 新技術 溶接 ろう付け 製造', 'コーティング 表面処理 新技術 製造',
      '3Dプリンタ 積層造形 量産 製造', 'スマートファクトリ 技術 実装', '熟練技能 形式知化 AI 製造',
      '非破壊検査 新技術 製造', 'ロボット 自動化 新技術 組立'
    ],
    note: [
      'site:note.com 製造 AI 外観検査', 'site:note.com 生産技術 新技術', 'site:note.com デジタルツイン 工場',
      'site:note.com 協働ロボット 製造', 'site:note.com 予知保全 AI 設備', 'site:note.com 新工法 製造',
      'site:note.com 3Dプリンタ 製造', 'site:note.com センシング 工場'
    ]
  },
  '製品・製造技術': {
    general: [
      '炊飯器 加熱 温度制御 技術', '炊飯 IH 技術 圧力 蒸気', '真空断熱 魔法瓶 技術 製造',
      '保温 保冷 断熱 材料 技術', '電気ケトル 温度制御 加熱 技術', '熱伝達 加熱 ヒーター 製品 技術',
      '蒸気 制御 家電 技術', '接合 溶接 ろう付け 家電 製造', 'コーティング 表面処理 調理家電 技術',
      '洗浄 技術 製造 工程 家電', 'センサ 温度検知 家電 技術', '樹脂成形 金属加工 家電 製造',
      '量産 工程設計 家電 製造技術', '断熱材 新素材 製品開発'
    ],
    note: [
      'site:note.com 炊飯 技術 加熱', 'site:note.com 真空断熱 技術', 'site:note.com 温度制御 家電 技術',
      'site:note.com 熱伝達 製品開発', 'site:note.com 接合 製造技術', 'site:note.com コーティング 製造',
      'site:note.com センサ 家電 開発', 'site:note.com 量産 工程設計 製品開発'
    ]
  },
  '異業種横展開': {
    general: [
      '自動車 工場 生産性 改善 OEE', '自動車部品 トレーサビリティ 品質 改善', '半導体 工場 稼働率 OEE 改善',
      '半導体 製造 トレーサビリティ MES', '電子部品 工場 自動化 品質 改善', '食品工場 生産性 ライン 改善',
      '食品工場 トレーサビリティ 検査 改善', '製薬 工場 品質 トレーサビリティ 改善', '化学工場 設備保全 予知保全 改善',
      '物流 倉庫 生産性 可視化 改善', '機械加工 稼働率 段取り 改善', '射出成形 不良 歩留まり 改善',
      '鉄鋼 工場 設備保全 改善', '電池 工場 品質 トレーサビリティ'
    ],
    note: [
      'site:note.com 自動車 工場 改善 生産技術', 'site:note.com 半導体 工場 改善', 'site:note.com 食品工場 生産性 改善',
      'site:note.com 物流 改善 工程', 'site:note.com 機械加工 段取り 改善', 'site:note.com 製薬 トレーサビリティ 製造',
      'site:note.com 射出成形 品質 改善', 'site:note.com 異業種 改善 製造'
    ]
  }
};

const CATEGORY_GUIDES = {
  '生技基礎': 'IE、QCD/SQCD、OEE、稼働率/可動率、標準時間、工程分析、動作研究、ECRS、ラインバランス、セル生産、コンベア生産、タクト、工程能力Cp/Cpk、SPC、4M、TPM、MTBF/MTTR、トレーサビリティ等を、生産技術者が理解・計算・使い分けできる解説。',
  '改善事例': '工場の生産性、品質、工数、原価、停止時間、歩留まり、直行率、ライン、設備、検査、トレーサビリティの改善。課題・対策・効果・手順などが具体的に分かる事例。',
  '技術革新': '新工法、新製法、新素材、センシング、画像認識、AI、ロボット、デジタルツインなど、製造や製品開発へ流用できる技術。単なる発売告知ではなく技術内容や仕組みが分かるもの。',
  '製品・製造技術': '炊飯器、魔法瓶、真空断熱、電気ケトル、加熱、温度制御、保温/保冷、蒸気、熱伝達、接合、コーティング、洗浄、センサなど、対象製品や量産工程に近い技術。',
  '異業種横展開': '自動車、半導体、電子部品、食品、医薬、化学、物流、機械加工、鉄鋼などの工場で、生産性・設備・品質・工程・トレーサビリティ改善の考え方を家電工場へ転用できるもの。'
};

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
  const url = String(item.url || '').replace(/[?#].*$/, '').toLowerCase();
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${url}|${title}`;
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

function isBlockedUrl(url = '') {
  return BLOCKED_DOMAIN_RE.test(hostOf(url));
}

function boolOf(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'pass', '採用'].includes(text)) return true;
  if (['false', 'no', 'reject', '不採用'].includes(text)) return false;
  return null;
}

function scoreOf(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
}

function localTopicRelevant(text = '') {
  return PRODUCTION_RE.test(text) || QUALITY_RE.test(text) || EQUIPMENT_RE.test(text) || TRACE_RE.test(text) || PRODUCT_RE.test(text);
}

function categoryOf(raw = {}) {
  const explicit = clean(raw.category, 80);
  if (RESEARCH_CATEGORIES.includes(explicit)) return explicit;
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (CROSS_INDUSTRY_RE.test(hay) && localTopicRelevant(hay)) return '異業種横展開';
  if (PRODUCT_RE.test(hay) && /(製造|工法|構造|材料|熱|温度|加熱|断熱|接合|洗浄|成形|組立|技術)/i.test(hay)) return '製品・製造技術';
  if (CASE_RE.test(hay) && localTopicRelevant(hay)) return '改善事例';
  if (FOUNDATION_RE.test(hay) && localTopicRelevant(hay)) return '生技基礎';
  if (INNOVATION_RE.test(hay) && localTopicRelevant(hay)) return '技術革新';
  return '';
}

function applicationIdea(raw = {}, category = '') {
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (category === '生技基礎') return '用語・計算式・使い分けを自工程の標準指標に置き換え、改善前後を同じ尺度で評価する基礎知識として使える。';
  if (/(OEE|設備総合効率|稼働率|可動率|チョコ停|停止時間|MTBF|MTTR)/i.test(hay)) return '停止・速度・品質ロスを分解し、設備別/工程別KPI、ボトルネック、停止理由の標準化に転用できる。';
  if (/(トレーサビリティ|traceability|4M\b|ロット|工程履歴|検査履歴|部品情報)/i.test(hay)) return 'Lot No.に設備・部品・作業・検査結果をひも付け、異常時の影響範囲特定と原因解析の短縮へ応用できる。';
  if (/(セル生産|コンベア|タクト|takt|サイクルタイム|line\s*balanc|ラインバランス|ボトルネック)/i.test(hay)) return 'タクト差、待ち、滞留、作業者負荷を見える化し、ラインバランスや人員配置の改善に使える。';
  if (/(不良|歩留まり|直行率|FPY|工程能力|CpK?|ポカヨケ|検査)/i.test(hay)) return '不良を4Mで分解し、直行率/歩留まりのKPI化、ポカヨケや検査方法の改善につなげられる。';
  if (category === '製品・製造技術') return '製品機能だけでなく、量産性、工程安定性、検査性、材料・設備条件へ分解して新規開発や工程設計の着眼点に使える。';
  if (category === '異業種横展開') return '業種固有の部分を外し、工程設計・設備・品質・データ活用の共通原理だけを自工程へ横展開できる。';
  return '手法・原理・定量効果を自工程の課題に置き換え、改善テーマや新規技術探索の着眼点として使える。';
}

function normalizeSeed(seed = {}) {
  const title = clean(seed.title, 320);
  const url = safeUrl(seed.url);
  const summary = clean(seed.summary, 1200);
  const sourceLabel = clean(seed.sourceLabel, 140);
  const organization = clean(seed.organization || sourceLabel, 180);
  if (!title || !url || !summary || !sourceLabel || !organization || isBlockedUrl(url)) return null;
  return {
    category: seed.category,
    title,
    url,
    summary,
    sourceLabel,
    organization,
    application: applicationIdea(seed, seed.category),
    pubDate: normalizeDate(seed.publishedAt),
    image: '',
    acquisition: '信頼できる公式解説・公式事例を直接収録',
    relevance: 100,
    usefulness: 100,
    selectionReason: '公式の基礎解説または具体的な製造改善事例として事前選定'
  };
}

function collectDirectSeeds() {
  return DIRECT_SEEDS.map(normalizeSeed).filter(Boolean);
}

function normalizeDirectItem(raw = {}, { category = '' } = {}) {
  const title = clean(raw.title, 320);
  const url = safeUrl(raw.url || raw.link);
  const summary = clean(raw.summary || raw.description || '', 1200);
  const sourceLabel = clean(raw.sourceLabel || raw.sourceName || raw.source || '', 140);
  const organization = clean(raw.organization || raw.author || sourceLabel, 180);
  const resolvedCategory = category || categoryOf(raw);
  if (!title || !url || !summary || !sourceLabel || !organization || !resolvedCategory || isBlockedUrl(url)) return null;
  const hay = `${title} ${summary}`;
  if (PROMO_ONLY_RE.test(hay) && !localTopicRelevant(hay)) return null;
  if (resolvedCategory === '論文・研究' && !localTopicRelevant(hay)) return null;
  if (resolvedCategory !== '論文・研究' && !localTopicRelevant(hay)) return null;
  return {
    category: resolvedCategory,
    title,
    url,
    summary,
    sourceLabel,
    organization,
    application: applicationIdea(raw, resolvedCategory),
    pubDate: normalizeDate(raw.publishedAt || raw.pubDate || raw.date),
    image: safeUrl(raw.image || raw.imageUrl),
    acquisition: clean(raw.acquisition || '公式RSS/APIによる直接取得', 180),
    relevance: 80,
    usefulness: 70,
    selectionReason: '直接取得記事を意味の広い技術関連判定で分類'
  };
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
    headers: { Accept: 'application/atom+xml,application/xml,text/xml', 'User-Agent': 'PersonalDashboardTechnologyResearch/5.0' },
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
      return normalizeDirectItem({
        title,
        url: link,
        summary: [abstract, journal && `掲載誌: ${journal}`].filter(Boolean).join(' ｜ '),
        organization: author || journal || 'J-STAGE',
        sourceLabel: 'J-STAGE',
        publishedAt: date,
        acquisition: `J-STAGE WebAPI（検索軸: ${term}）`
      }, { category: '論文・研究' });
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
  return rows.map(row => normalizeDirectItem({
    title: row.title,
    url: row.link,
    summary: clean(row.description, 1000),
    organization: row.author || 'CiNii Research',
    sourceLabel: 'CiNii Research',
    publishedAt: row.pubDate,
    image: row.image,
    acquisition: `CiNii Research OpenSearch（検索軸: ${term}）`
  }, { category: '論文・研究' })).filter(Boolean);
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
    const rows = await fetchRssSource({ name: 'MONOist', url: 'https://rss.itmedia.co.jp/rss/2.0/monoist.xml', maxItems: 100 });
    const items = rows.map(row => normalizeDirectItem({
      title: row.title,
      url: row.link,
      summary: row.description,
      organization: row.author || 'MONOist',
      sourceLabel: 'MONOist',
      publishedAt: row.pubDate,
      image: row.image,
      acquisition: 'MONOist公式RSS'
    })).filter(Boolean);
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

function isLikelyPromo(candidate = {}) {
  const hay = `${candidate.title || ''} ${candidate.summary || ''}`;
  return PROMO_ONLY_RE.test(hay) && !/(改善|技術|工程|品質|設備|製造|分析|事例|原理|方法)/i.test(hay);
}

function semanticThreshold(category) {
  if (category === '生技基礎') return { relevance: 60, usefulness: 45 };
  if (category === '技術革新') return { relevance: 58, usefulness: 48 };
  if (category === '製品・製造技術') return { relevance: 58, usefulness: 45 };
  return { relevance: 62, usefulness: 52 };
}

function normalizeWebCandidates(parsed, rawResponse, category) {
  const rawItems = Array.isArray(parsed?.candidates) ? parsed.candidates : Array.isArray(parsed?.items) ? parsed.items : [];
  const grounding = groundingUrls(rawResponse);
  const used = new Set();
  const accepted = [];
  let blocked = 0;
  let aiRejected = 0;
  let malformed = 0;
  let noteCandidates = 0;
  let noteAccepted = 0;

  for (const raw of rawItems) {
    let url = safeUrl(raw?.url);
    if (!url) url = grounding.find(candidate => !used.has(candidate) && !isBlockedUrl(candidate)) || '';
    if (url) used.add(url);
    const title = clean(raw?.title, 320);
    const summary = clean(raw?.summary || raw?.overview || raw?.description, 1400);
    const sourceLabel = clean(raw?.sourceLabel || raw?.media || raw?.source || hostOf(url), 140);
    const organization = clean(raw?.organization || raw?.company || raw?.author || sourceLabel, 180);
    const relevance = scoreOf(raw?.relevance);
    const usefulness = scoreOf(raw?.usefulness ?? raw?.practicality);
    const pass = boolOf(raw?.pass);
    const isNote = /(?:^|\.)note\.com$/i.test(hostOf(url));
    if (isNote) noteCandidates += 1;

    if (!url || !title || !summary || !sourceLabel || !organization) {
      malformed += 1;
      continue;
    }
    if (isBlockedUrl(url) || isLikelyPromo({ title, summary })) {
      blocked += 1;
      continue;
    }

    const threshold = semanticThreshold(category);
    const semanticPass = pass === true || (pass !== false && relevance >= threshold.relevance && usefulness >= threshold.usefulness);
    if (!semanticPass || relevance < threshold.relevance || usefulness < threshold.usefulness) {
      aiRejected += 1;
      continue;
    }

    const item = {
      category,
      title,
      url,
      summary,
      sourceLabel,
      organization,
      application: clean(raw?.application || raw?.applicationPoint || applicationIdea(raw, category), 700),
      pubDate: normalizeDate(raw?.publishedAt || raw?.pubDate || raw?.date),
      image: safeUrl(raw?.image || raw?.imageUrl),
      acquisition: isNote ? 'Gemini Google Searchによるnote専用探索＋意味判定' : 'Gemini Google Searchによる一般Web探索＋意味判定',
      relevance,
      usefulness,
      selectionReason: clean(raw?.reason || raw?.selectionReason || '生産技術との関連性と学習・実務価値を意味的に判定', 500),
      topics: Array.isArray(raw?.topics) ? raw.topics.map(value => clean(value, 80)).filter(Boolean).slice(0, 10) : []
    };
    accepted.push(item);
    if (isNote) noteAccepted += 1;
  }

  return {
    items: dedupe(accepted),
    stats: {
      candidates: rawItems.length,
      blocked,
      aiRejected,
      malformed,
      accepted: accepted.length,
      noteCandidates,
      noteAccepted
    }
  };
}

function buildSearchPrompt(category) {
  const matrix = SEARCH_MATRIX[category];
  const generalQueries = matrix.general.map((query, index) => `${index + 1}. ${query}`).join('\n');
  const noteQueries = matrix.note.map((query, index) => `${index + 1}. ${query}`).join('\n');
  return `あなたは製造業の生産技術エンジニア向け技術リサーチ担当です。Google Searchを使い、次の1カテゴリだけについて候補記事を幅広く探した後、記事の意味を読んで採用/不採用を判定してください。\n\nカテゴリ: ${category}\n定義: ${CATEGORY_GUIDES[category]}\n\n【一般Webの検索軸】\n${generalQueries}\n\n【note.com専用の検索軸】\n${noteQueries}\n\n検索方針:\n- 上の検索軸をできるだけ広く使い、同じ意味の別表現も検索する。\n- 一般Webから最低15件、note.comから最低8件を目標に、合計25〜35件程度の候補を作る。条件に合う候補が多ければ35件近く返してよい。\n- 日本IE協会、JMAC、OMRON、KEYENCE、三菱電機、パナソニック、産総研、NEDO、JST、MONOist、メーカー技術ブログ、工場事例、専門メディア、コンサルの技術解説などに限定しすぎず、信頼できる他のWeb記事も探す。\n- note.comは実務経験、具体的な考え方、計算、失敗、改善過程、技術解説がある記事を積極的に候補へ含める。\n- 同じ媒体だけに偏らず、可能なら8ドメイン以上から探す。\n- 直近1〜2年を優先。ただし基礎知識や定番事例は古くても有用なら候補に含める。\n\n絶対除外:\n- PR TIMES、Business Wire、PR Newswire、クラウドファンディング、EC/購入ページ。\n- キャンペーン、求人、発売告知だけ、ランキング、薄いSEO記事。\n- 生産技術や製品・製造技術との接点が実質ない記事。\n\n意味判定:\n- キーワードの完全一致ではなく、記事本文・検索内容の意味で判定する。\n- relevance: このカテゴリへの直接関連度を0〜100。\n- usefulness: 生産技術者が知識・改善方法・技術着想を得られる価値を0〜100。\n- pass=trueは「読んで役立つ」と判断できる場合だけ。\n- ${category === '生技基礎' ? '基礎知識は計算式・特徴・使い分け・考え方が理解できれば、具体的な改善事例がなくてもpass=trueでよい。' : ''}\n- ${category === '技術革新' ? '新しさだけでなく、原理・仕組み・製造への転用可能性が分かることを重視する。' : ''}\n- ${category === '改善事例' || category === '異業種横展開' ? '数値がなくても、課題→対策→効果や具体的な改善方法が読み取れればpass=trueでよい。' : ''}\n\n正式な元記事URLだけを返し、Google検索結果URLは返さない。\nJSON以外は出力しない。候補は不採用も含めて返す。\n{"candidates":[{"pass":true,"category":"${category}","organization":"企業/組織/著者","title":"正式タイトル","summary":"記事から分かる具体的内容","application":"自工程や製品開発への応用着眼点","sourceLabel":"媒体名","publishedAt":"YYYY-MM-DD","url":"https://元記事URL","relevance":0,"usefulness":0,"reason":"採用/不採用理由","topics":["OEE","設備改善"]}]}`;
}

function isQuotaError(error) {
  const status = Number(error?.statusCode || 0) || 0;
  const message = String(error?.message || error || '');
  return status === 429 || /quota|resource[_\s-]*exhausted|rate limit/i.test(message);
}

async function callGemini(category) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');
  const model = String(process.env.GEMINI_RESEARCH_MODEL || 'gemini-3.5-flash-lite').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildSearchPrompt(category) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 8500, thinkingConfig: { thinkingLevel: 'minimal' } }
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
    if (!text) throw new Error(`Gemini technology research response empty (${category})`);
    return { parsed: looseJson(text), raw: data };
  } finally { clearTimeout(timer); }
}

async function collectWebResearch() {
  const settled = await Promise.allSettled(WEB_CATEGORIES.map(category => callGemini(category).then(response => ({ category, response }))));
  const items = [];
  const stats = {};
  const errors = [];
  let quotaBlocked = false;

  settled.forEach((row, index) => {
    const category = WEB_CATEGORIES[index];
    if (row.status === 'fulfilled') {
      const normalized = normalizeWebCandidates(row.value.response.parsed, row.value.response.raw, category);
      items.push(...normalized.items);
      stats[category] = normalized.stats;
      console.info(`[technology-research][${category}]`, normalized.stats);
    } else {
      quotaBlocked ||= isQuotaError(row.reason);
      const message = clean(row.reason?.message || row.reason, 180);
      errors.push(`${category}: ${message}`);
      stats[category] = { candidates: 0, blocked: 0, aiRejected: 0, malformed: 0, accepted: 0, noteCandidates: 0, noteAccepted: 0, error: message };
      console.warn(`[technology-research][${category}] search failed`, message);
    }
  });

  return { items: dedupe(items), stats, errors, quotaBlocked };
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

function sortScore(item) {
  let score = scoreOf(item.relevance) + scoreOf(item.usefulness) * 0.8 + ageScore(item);
  if (TRUSTED_PRIMARY_RE.test(item.url || '')) score += 5;
  if (/note\.com/i.test(item.url || '')) score += 1;
  return score;
}

function selectAllAccepted(items = []) {
  return dedupe(items).sort((a, b) => sortScore(b) - sortScore(a) || normalizeDate(b.pubDate) - normalizeDate(a.pubDate));
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
      `関連度: ${Math.round(scoreOf(item.relevance))}`,
      `有用度: ${Math.round(scoreOf(item.usefulness))}`,
      item.selectionReason ? `選別理由: ${item.selectionReason}` : '',
      item.topics?.length ? `トピック: ${item.topics.join(', ')}` : '',
      `取得方式: ${item.acquisition}`
    ].filter(Boolean).join(' ｜ ')
  }));
}

function summarizeSourceCounts(items = []) {
  const counts = {};
  items.forEach(item => {
    const key = item.sourceLabel || 'その他';
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([source, count]) => `${source}:${count}`).join(', ');
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
  const sourceCounts = summarizeSourceCounts(selected);
  const xml = rssXml(
    '技術リサーチ',
    `検索語マトリクス＋note専用探索＋AI意味判定。意味判定に合格した記事は件数上限なしで全件配信。今回 ${selected.length}件。`,
    toRssItems(selected)
  );
  const meta = {
    count: selected.length,
    categoryCounts,
    sourceCounts,
    seedCount: seeds.length,
    paperErrors: papers.errors.length,
    monoistErrors: monoist.errors.length,
    webErrors: web.errors.length,
    webStats: web.stats,
    geminiQuotaBlocked: web.quotaBlocked
  };

  memoryCache.at = Date.now();
  memoryCache.xml = xml;
  memoryCache.items = selected;
  memoryCache.meta = meta;
  console.info('[technology-research] final', meta);
  return memoryCache;
}

function categoryHeader(counts = {}) {
  return RESEARCH_CATEGORIES.map(category => `${category}=${Number(counts[category] || 0)}`).join(',');
}

function candidateHeader(stats = {}) {
  return WEB_CATEGORIES.map(category => {
    const row = stats[category] || {};
    return `${category}:${Number(row.candidates || 0)}/${Number(row.accepted || 0)}`;
  }).join(',');
}

export async function technologyResearchFeed(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const refresh = String(req.query?.refresh || '') === '1';
  try {
    const result = await research({ refresh });
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', refresh ? 'no-store' : 'public, s-maxage=900, stale-while-revalidate=21600');
    res.setHeader('X-Technology-Research-Count', String(result.items.length));
    res.setHeader('X-Technology-Research-Version', '5');
    res.setHeader('X-Technology-Research-Seed-Count', String(result.meta?.seedCount || 0));
    res.setHeader('X-Technology-Research-Paper-Errors', String(result.meta?.paperErrors || 0));
    res.setHeader('X-Technology-Research-Monoist-Errors', String(result.meta?.monoistErrors || 0));
    res.setHeader('X-Technology-Research-Web-Errors', String(result.meta?.webErrors || 0));
    res.setHeader('X-Technology-Research-Gemini-Quota', result.meta?.geminiQuotaBlocked ? 'blocked' : 'ok');
    setAsciiHeader(res, 'X-Technology-Research-Categories', categoryHeader(result.meta?.categoryCounts || {}));
    setAsciiHeader(res, 'X-Technology-Research-Candidates', candidateHeader(result.meta?.webStats || {}));
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
