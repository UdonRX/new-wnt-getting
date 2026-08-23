import jsdomPackage from 'jsdom';
import { rssXml } from '../lib/rss-merge.mjs';

const { JSDOM } = jsdomPackage;

/*
 * v26 論文フィード
 * - fast: J-STAGE + Semantic Scholar + PLOS を先に返して一覧を高速表示
 * - deep: fast に加えて Crossref競合企業、CiNii Research、CORE、IEEE Xplore を統合
 * - 英語タイトルのGemini和訳はRSS生成時には待たず、クライアントから /api/paper-titles で非同期実行
 * - CiNii/IEEEは各公式APIキー設定時に有効化。COREは無料の無登録枠でも取得を試す
 */

// v21: 製品名だけでなく、周辺の要素技術・熱現象まで検索対象を広げる。
// J-STAGEは日本語の関連語を複数検索し、Semantic ScholarはBoolean検索で広く拾った後、
// タイトル+抄録から関連度スコアを付けてノイズを落とす。
const JSTAGE_SEARCH_TERMS = [
  // 1) 炊飯科学：米の吸水・糊化・食感・食味・温度履歴
  '米 炊飯 糊化',
  '米 α化 炊飯',
  '米 吸水 炊飯',
  '米 浸漬 炊飯',
  '米飯 食感 硬さ 粘り',
  '米飯 官能評価 食味',
  '米 でんぷん アミロース 炊飯',
  '米 アミロペクチン 炊飯',
  '米飯 デンプン 溶出',
  '炊飯 温度履歴',
  '炊飯 加熱速度',
  'IH 炊飯 温度制御',
  '炊飯器 保温 米飯 品質',
  '炊飯器 保温 消費電力',

  // 2) 真空断熱・蓄熱
  '真空断熱 熱伝導',
  '真空断熱 放熱',
  '真空断熱 熱橋',
  '真空断熱 真空度',
  '真空断熱 バリア材',
  '真空断熱 経時劣化',
  '真空断熱 容器 保温',
  '魔法瓶 保温 熱',
  '魔法瓶 熱伝導',
  '相変化 蓄熱 保温 容器',
  '潜熱 蓄熱 温水 容器',

  // 3) 対象製品 × 省エネ・保温・ユーザビリティ
  '炊飯器 省エネルギー',
  '炊飯器 ユーザビリティ',
  '電気ポット 省エネルギー',
  '電気ポット 保温 消費電力',
  '電気ポット 操作性',
  '電気ケトル 省エネルギー',
  '電気ケトル 使いやすさ',
  '電気ケトル 安全性',
  '真空断熱ボトル 保温',
  '真空断熱ボトル 使いやすさ',
  'コーヒーメーカー 抽出 温度',
  'コーヒーメーカー 省エネルギー',
  'コーヒーメーカー ユーザビリティ',

  // 4) 競合メーカー × 対象製品
  'タイガー魔法瓶 炊飯器',
  'タイガー魔法瓶 真空断熱',
  '象印マホービン 炊飯器',
  '象印マホービン 電気ポット',
  'パナソニック 炊飯器',
  'パナソニック コーヒーメーカー',
  'サーモス 真空断熱',
  'サーモス コーヒーメーカー',
  'アイリスオーヤマ 炊飯器',
  'アイリスオーヤマ 電気ケトル'
];

const SEMANTIC_SCHOLAR_QUERIES = [
  {
    name: '重点3軸',
    query: '((rice + (cooking | cooked) + (gelatinization | starch | amylose | amylopectin | "water absorption" | soaking | hydration | texture | sensory | taste | stickiness | hardness | pasting | "starch leaching" | "temperature profile")) | (("vacuum insulation" | "vacuum insulated" | "vacuum flask" | "thermos flask" | dewar) + ("thermal conductivity" | "heat transfer" | "heat loss" | "thermal bridge" | emissivity | radiation | "vacuum degree" | "barrier envelope" | "core material" | aging | "heat retention")) | (("rice cooker" | "electric kettle" | "water boiler" | "water warmer" | "coffee maker" | "coffee machine" | "vacuum flask" | "vacuum insulated bottle") + ("energy efficiency" | "energy consumption" | "power consumption" | "heat loss" | insulation | "heat retention" | "temperature control" | usability | ergonomics | "user behavior" | safety | "human factors")))'
  },
  {
    name: '炊飯科学',
    query: '(rice + (cooking | cooked) + (gelatinization | starch | amylose | amylopectin | "water absorption" | "water uptake" | soaking | hydration | texture | hardness | stickiness | adhesiveness | sensory | taste | flavor | aroma | pasting | "starch leaching" | swelling | retrogradation | "thermal history"))'
  },
  {
    name: '真空断熱',
    query: '(("vacuum insulation" | "vacuum insulated" | "vacuum flask" | "thermos flask" | dewar) + ("thermal conductivity" | "heat transfer" | "heat loss" | "thermal bridge" | emissivity | radiation | "vacuum degree" | "barrier envelope" | "core material" | outgassing | aging | "service life" | "heat retention"))'
  },
  {
    name: '蓄熱・保温',
    query: '(("phase change material" | PCM | "thermal energy storage" | "latent heat storage") + ("heat retention" | "hot water" | beverage | food | container | vessel | bottle | flask | appliance | domestic | "keep warm"))'
  },
  {
    name: '製品省エネ・保温',
    query: '(("rice cooker" | "electric kettle" | "water boiler" | "water warmer" | "coffee maker" | "coffee machine" | "vacuum flask" | "vacuum insulated bottle") + ("energy efficiency" | "energy consumption" | "power consumption" | "heat loss" | insulation | "heat retention" | "keep warm" | "temperature control" | overfill | "boil control"))'
  },
  {
    name: '製品ユーザビリティ',
    query: '(("rice cooker" | "electric kettle" | "water boiler" | "coffee maker" | "coffee machine" | "vacuum bottle" | "vacuum flask") + (usability | ergonomics | "human factors" | "user behavior" | accessibility | safety | pouring | grip | cleaning | "water level" | "user interface"))'
  },
  {
    name: '競合メーカー関連',
    query: '((Panasonic | Zojirushi | "Tiger Corporation" | Thermos | "Iris Ohyama" | Cuckoo | Cuchen | Midea | Joyoung | "Groupe SEB" | Tefal | SUPOR | Breville | DeLonghi | SharkNinja | "Hamilton Beach" | Versuni) + ("rice cooker" | kettle | "water boiler" | "vacuum bottle" | "vacuum flask" | "coffee maker" | "coffee machine") + ("energy efficiency" | "heat retention" | insulation | "temperature control" | usability | safety | cooking | gelatinization | extraction))'
  }
];

const CROSSREF_COMPANIES = [
  { label: 'タイガー', query: 'Tiger Corporation', aliases: ['Tiger Corporation', 'Tiger Vacuum Bottle', 'タイガー魔法瓶'] },
  { label: '象印', query: 'Zojirushi Corporation', aliases: ['Zojirushi Corporation', 'Zojirushi', '象印マホービン', '象印魔法瓶'] },
  { label: 'Panasonic', query: 'Panasonic Corporation', aliases: ['Panasonic Corporation', 'Panasonic Holdings Corporation', 'Panasonic', 'Matsushita Electric Industrial', '松下電器産業'] },
  { label: 'THERMOS', query: 'THERMOS K.K.', aliases: ['THERMOS K.K.', 'Thermos LLC', 'Thermos L.L.C.', 'Thermos', 'サーモス'] },
  { label: 'アイリスオーヤマ', query: 'Iris Ohyama', aliases: ['Iris Ohyama', 'IRIS OHYAMA', 'アイリスオーヤマ'] },
  { label: '三菱電機', query: 'Mitsubishi Electric Corporation', aliases: ['Mitsubishi Electric Corporation', 'Mitsubishi Electric', '三菱電機'] },
  { label: 'Cuckoo', query: 'Cuckoo Electronics', aliases: ['Cuckoo Electronics', 'CUCKOO Electronics', 'Cuckoo'] },
  { label: 'Cuchen', query: 'Cuchen', aliases: ['Cuchen Co', 'Cuchen'] },
  { label: 'Midea', query: 'Midea Group', aliases: ['Midea Group', 'Midea'] },
  { label: 'Joyoung', query: 'Joyoung', aliases: ['Joyoung Co', 'Joyoung', '九阳'] },
  { label: 'Groupe SEB', query: 'Groupe SEB', aliases: ['Groupe SEB', 'SEB S.A.', 'SEB SA', 'Tefal'] },
  { label: 'SUPOR', query: 'Zhejiang Supor', aliases: ['Zhejiang Supor', 'SUPOR', 'Supor'] },
  { label: 'Breville', query: 'Breville', aliases: ['Breville Group', 'Breville Pty', 'Breville'] },
  { label: "De'Longhi", query: "De Longhi", aliases: ["De'Longhi", 'De Longhi', 'DeLonghi', "De'Longhi Group"] },
  { label: 'SharkNinja', query: 'SharkNinja', aliases: ['SharkNinja', 'SharkNinja Operating LLC', 'Ninja Kitchen'] },
  { label: 'Hamilton Beach', query: 'Hamilton Beach Brands', aliases: ['Hamilton Beach Brands', 'Hamilton Beach'] },
  { label: 'Versuni', query: 'Versuni', aliases: ['Versuni', 'Philips Domestic Appliances'] }
];

const JSTAGE_ENDPOINT = 'https://api.jstage.jst.go.jp/searchapi/do';
const SEMANTIC_SCHOLAR_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';
const SEMANTIC_SCHOLAR_BATCH_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const CROSSREF_ENDPOINT = 'https://api.crossref.org/works';
const CINII_ENDPOINT = 'https://cir.nii.ac.jp/opensearch/v2/articles';
const PLOS_ENDPOINT = 'https://api.plos.org/search';
const NCBI_ESEARCH_ENDPOINT = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const NCBI_ESUMMARY_ENDPOINT = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const CORE_ENDPOINT = 'https://api.core.ac.uk/v3/search/works';
const IEEE_ENDPOINT = 'https://ieeexploreapi.ieee.org/api/v1/search/articles';

const FAST_JSTAGE_TERMS = [
  '米 炊飯 糊化',
  '米 吸水 炊飯',
  '米飯 食感 食味',
  '真空断熱 容器 保温',
  '炊飯器 保温 消費電力',
  '電気ケトル 省エネルギー'
];
const FAST_SEMANTIC_QUERIES = [SEMANTIC_SCHOLAR_QUERIES[0]];
const CINII_SEARCH_TERMS = [
  '米 炊飯 糊化 吸水',
  '米飯 食感 食味 炊飯器',
  '真空断熱 熱伝導 保温',
  '相変化 蓄熱 保温 容器',
  '炊飯器 省エネルギー 保温',
  '電気ポット 電気ケトル 省エネルギー',
  'コーヒーメーカー 抽出 温度',
  '炊飯器 電気ポット 電気ケトル 魔法瓶 コーヒーメーカー ユーザビリティ'
];
const PAPER_QUERY_EN = [
  '"rice cooking" gelatinization',
  '"rice cooking" "water absorption"',
  '"cooked rice" texture sensory',
  '"rice cooker" "temperature control"',
  '"rice cooker" "energy consumption"',
  '"vacuum insulation" "thermal conductivity"',
  '"vacuum insulation" "heat retention"',
  '"vacuum flask" "heat transfer"',
  '"phase change material" "heat retention" container',
  '"electric kettle" "energy efficiency"',
  '"electric kettle" usability',
  '"water boiler" "heat retention"',
  '"coffee maker" "temperature control"',
  '"coffee brewing" temperature extraction',
  '"coffee maker" "energy consumption"'
];

const FAST_TTL = 10 * 60 * 1000;
const DEEP_TTL = 30 * 60 * 1000;
const JSTAGE_PER_TERM = 35;
const SEMANTIC_SCHOLAR_PER_QUERY = 100;
const CROSSREF_ROWS_PER_COMPANY = 45;
const MAX_ITEMS = 250;
const FAST_PROVIDER_TIMEOUT = 9_000;
const UPSTREAM_RETRY_DELAYS = [700, 1_600];

const feedCaches = {
  fast: { at: 0, xml: '' },
  deep: { at: 0, xml: '' }
};
const providerCache = new Map();

function normalizeSpace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeText(node, selector) {
  return node?.querySelector(selector)?.textContent?.trim() || '';
}

function firstText(node, selectors) {
  for (const selector of selectors) {
    const value = nodeText(node, selector);
    if (value) return value;
  }
  return '';
}

function safeDate(value, fallbackYear = '') {
  const d = new Date(value || '');
  if (Number.isFinite(d.getTime())) return d;

  const year = String(fallbackYear || '').match(/\d{4}/)?.[0];
  if (year) return new Date(`${year}-01-01T00:00:00Z`);
  return new Date(0);
}

function normalizeHttps(value) {
  return String(value || '').replace(/^http:\/\//i, 'https://').trim();
}

function hasJapanese(value) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(value || ''));
}

function stripHtml(value) {
  return normalizeSpace(
    String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}


function parseJStageEntry(entry) {
  const title = firstText(entry, [
    'article_title > ja',
    'article_title > en',
    'title'
  ]) || '無題';

  const link = normalizeHttps(firstText(entry, [
    'article_link > ja',
    'article_link > en'
  ]) || entry.querySelector('link')?.getAttribute('href') || nodeText(entry, 'id'));

  const authorsJa = Array.from(entry.querySelectorAll('author > ja > name'))
    .map(el => el.textContent?.trim())
    .filter(Boolean);
  const authorsEn = Array.from(entry.querySelectorAll('author > en > name'))
    .map(el => el.textContent?.trim())
    .filter(Boolean);
  const authors = (authorsJa.length ? authorsJa : authorsEn).slice(0, 8).join(', ');

  const journal = firstText(entry, [
    'material_title > ja',
    'material_title > en'
  ]);
  const doi = firstText(entry, ['prism\\:doi', 'doi']);
  const pubyear = nodeText(entry, 'pubyear');
  const updated = nodeText(entry, 'updated');
  const pubDate = safeDate(updated, pubyear);

  const details = [
    journal && `掲載誌: ${journal}`,
    authors && `著者: ${authors}`,
    doi && `DOI: ${doi}`,
    '情報提供元: J-STAGE'
  ].filter(Boolean).join('\n');

  return {
    title: normalizeSpace(title),
    originalTitle: normalizeSpace(title),
    link,
    pubDate,
    author: authors || journal || 'J-STAGE',
    sourceName: 'J-STAGE',
    description: details || title,
    doi: normalizeSpace(doi),
    sourceId: `jstage:${normalizeSpace(doi || link || title)}`
  };
}

function parseJStageXml(xml, term) {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  try {
    const doc = dom.window.document;
    if (doc.querySelector('parsererror')) {
      throw new Error(`J-STAGE XML解析エラー (${term})`);
    }

    const status = nodeText(doc, 'result > status');
    const message = nodeText(doc, 'result > message');

    // J-STAGEは0件でもHTTP 200 + ERR_001を返す。
    if (status === 'ERR_001') return [];
    if (status && status !== '0' && !status.startsWith('WARN_')) {
      throw new Error(`J-STAGE ${status}${message ? `: ${message}` : ''}`);
    }

    return Array.from(doc.querySelectorAll('entry'))
      .map(parseJStageEntry)
      .filter(item => item.link && item.title);
  } finally {
    dom.window.close();
  }
}

async function searchJStage(term, timeoutMs = 12_000) {
  const url = new URL(JSTAGE_ENDPOINT);
  url.searchParams.set('service', '3');
  url.searchParams.set('text', term);
  url.searchParams.set('count', String(JSTAGE_PER_TERM));

  const response = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/atom+xml, application/xml, text/xml, */*;q=0.5',
      'User-Agent': 'PersonalDashboardPapers/8.0'
    },
    timeoutMs,
    retryStatuses: new Set([429, 500, 502, 503, 504])
  });

  if (!response.ok) {
    throw new Error(`J-STAGE HTTP ${response.status} (${term})`);
  }

  return parseJStageXml(await response.text(), term).map(item => ({
    ...item,
    description: [item.description, `検索語: ${term}`].filter(Boolean).join('\n\n')
  }));
}

function semanticScholarDate(paper) {
  return safeDate(paper?.publicationDate, paper?.year);
}

function semanticScholarAuthors(paper) {
  return (Array.isArray(paper?.authors) ? paper.authors : [])
    .map(author => normalizeSpace(author?.name))
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
}

const RICE_BASE_PATTERNS = [
  /\brice\b/,
  /cooked\s+rice/,
  /rice\s+grain/,
  /japonica/,
  /oryza\s+sativa/,
  /米飯/,
  /α化米/,
  /アルファ化米/,
  /米(?:の|を|に|が|は|粒|デンプン|でんぷん|澱粉)/,
  /炊飯/,
  /米粒/,
  /精白米/,
  /ジャポニカ/,
  /コメ/
];

const RICE_TECH_PATTERNS = [
  /gelatini[sz]ation/,
  /糊化/,
  /α化/,
  /アルファ化/,
  /starch/,
  /でん粉/,
  /澱粉/,
  /amylose/,
  /amylopectin/,
  /アミロース/,
  /アミロペクチン/,
  /water\s+(?:absorption|uptake|penetration)/,
  /moisture\s+(?:uptake|migration|distribution)/,
  /吸水/,
  /浸漬/,
  /水分移動/,
  /含水/,
  /texture/,
  /hardness/,
  /stickiness/,
  /adhesiveness/,
  /chewiness/,
  /食感/,
  /硬さ/,
  /粘り/,
  /付着/,
  /sensory/,
  /taste/,
  /flavo[u]?r/,
  /aroma/,
  /官能/,
  /食味/,
  /甘み/,
  /pasting/,
  /gel\s+consistency/,
  /starch\s+leaching/,
  /swelling/,
  /retrogradation/,
  /溶出/,
  /膨潤/,
  /老化/,
  /temperature\s+profile/,
  /thermal\s+history/,
  /heating\s+rate/,
  /cooking\s+time/,
  /温度履歴/,
  /加熱速度/,
  /炊飯時間/,
  /induction\s+heating/,
  /ih\s*加熱/,
  /温度制御/,
  /fuzzy\s+control/,
  /sensor/,
  /制御/
];

const VACUUM_BASE_PATTERNS = [
  /vacuum\s+insulat/,
  /vacuum[-\s]+insulated/,
  /vacuum\s+flask/,
  /thermos\s+flask/,
  /\bthermos\b/,
  /\bdewar\b/,
  /真空断熱/,
  /魔法瓶/
];

const VACUUM_TECH_PATTERNS = [
  /thermal\s+conductiv/,
  /heat\s+transfer/,
  /heat\s+loss/,
  /thermal\s+bridge/,
  /emissiv/,
  /radiati(?:on|ve)/,
  /residual\s+gas/,
  /vacuum\s+degree/,
  /barrier\s+(?:film|envelope|layer)/,
  /core\s+material/,
  /outgassing/,
  /aging/,
  /service\s+life/,
  /heat\s+retention/,
  /thermal\s+resistance/,
  /熱伝導/,
  /伝熱/,
  /放熱/,
  /熱損失/,
  /熱橋/,
  /放射/,
  /輻射/,
  /真空度/,
  /バリア(?:材|フィルム|層)/,
  /芯材/,
  /経時劣化/,
  /耐久/,
  /寿命/,
  /保温/
];

const STORAGE_BASE_PATTERNS = [
  /phase\s+change\s+material/,
  /\bpcm\b/,
  /thermal\s+energy\s+storage/,
  /latent\s+heat\s+storage/,
  /latent\s+heat/,
  /相変化/,
  /潜熱/,
  /蓄熱/
];

const STORAGE_APPLICATION_PATTERNS = [
  /heat\s+retention/,
  /keep\s+warm/,
  /hot\s+water/,
  /beverage/,
  /food/,
  /container/,
  /vessel/,
  /bottle/,
  /flask/,
  /domestic/,
  /household/,
  /appliance/,
  /温水/,
  /飲料/,
  /食品/,
  /容器/,
  /ボトル/,
  /ポット/,
  /保温/,
  /家庭用/,
  /調理家電/
];

const TARGET_PRODUCT_PATTERNS = [
  /rice\s+cooker/,
  /electric\s+kettle/,
  /water\s+(?:boiler|warmer)/,
  /hot\s+water\s+(?:pot|dispenser)/,
  /vacuum[-\s]+insulated\s+(?:bottle|flask|pot|carafe)/,
  /vacuum\s+flask/,
  /thermos\s+(?:bottle|flask)/,
  /coffee\s+(?:maker|machine|brewer)/,
  /espresso\s+machine/,
  /炊飯器/,
  /炊飯ジャー/,
  /電気ポット/,
  /ジャーポット/,
  /電気ケトル/,
  /真空断熱(?:ボトル|ポット|水筒|容器)/,
  /魔法瓶/,
  /コーヒーメーカー/
];

const PRODUCT_TECH_PATTERNS = [
  /energy\s+efficien/,
  /energy\s+consumption/,
  /power\s+consumption/,
  /energy\s+sav/,
  /省エネ/,
  /省エネルギー/,
  /消費電力/,
  /電力量/,
  /heat\s+loss/,
  /heat\s+retention/,
  /keep\s+warm/,
  /insulat/,
  /thermal\s+efficien/,
  /保温/,
  /断熱/,
  /放熱/,
  /temperature\s+control/,
  /temperature\s+profil/,
  /brewing\s+temperature/,
  /extraction(?:\s+yield)?/,
  /抽出(?:温度|率)?/,
  /boil\s+control/,
  /heating\s+control/,
  /温度制御/,
  /加熱制御/,
  /usability/,
  /ergonomic/,
  /human\s+factors?/,
  /user\s+behavio[u]?r/,
  /user\s+interface/,
  /accessib/,
  /overfill/,
  /pouring/,
  /grip/,
  /cleaning/,
  /water\s+level/,
  /safety/,
  /使いやす/,
  /操作性/,
  /ユーザビリティ/,
  /人間工学/,
  /ユーザー行動/,
  /安全性/,
  /転倒/,
  /湯漏れ/,
  /注ぎ/,
  /把持/,
  /洗浄/,
  /手入れ/,
  /水位/,
  /product\s+development/,
  /design\s+optimization/,
  /smart\s+appliance/,
  /control\s+algorithm/,
  /sensor/,
  /製品開発/,
  /最適化/,
  /制御/,
  /センサ/
];

const COFFEE_BASE_PATTERNS = [
  /coffee/,
  /espresso/,
  /コーヒー/
];

const COFFEE_TECH_PATTERNS = [
  /brewing/,
  /extraction/,
  /temperature\s+profil/,
  /brewing\s+temperature/,
  /extraction\s+yield/,
  /sensory/,
  /taste/,
  /抽出/,
  /抽出温度/,
  /抽出率/,
  /官能/,
  /味/
];

const COMPANY_PATTERNS = [
  /tiger\s+corporation/,
  /タイガー魔法瓶/,
  /zojirushi/,
  /象印マホービン/,
  /panasonic/,
  /thermos/,
  /サーモス/,
  /iris\s+ohyama/,
  /アイリスオーヤマ/,
  /mitsubishi\s+electric/,
  /三菱電機/,
  /cuckoo/,
  /cuchen/,
  /midea/,
  /joyoung/,
  /groupe\s+seb/,
  /tefal/,
  /supor/,
  /breville/,
  /de[’']?longhi/,
  /sharkninja/,
  /hamilton\s+beach/,
  /versuni/
];

const HARD_NEGATIVE_PATTERNS = [
  /cancer/,
  /tumou?r/,
  /medical\s+imaging/,
  /drug\s+delivery/,
  /cryogenic/,
  /liquid\s+(?:hydrogen|nitrogen|helium)/,
  /\blng\b/,
  /spacecraft/,
  /satellite/,
  /pipeline/,
  /automotive\s+engine/,
  /electric\s+vehicle/,
  /battery\s+cell/,
  /semiconductor/
];

const SOFT_NEGATIVE_PATTERNS = [
  /building\s+envelope/,
  /building\s+insulation/,
  /wall\s+insulation/,
  /window\s+insulation/,
  /construction/,
  /refrigerator/,
  /cold\s+storage/,
  /laboratory\s+flask/,
  /chemical\s+reactor/
];

function patternHits(patterns, text) {
  return patterns.filter(pattern => pattern.test(text)).length;
}

function evaluateResearchRelevance(raw) {
  const text = [
    raw?.title,
    raw?.originalTitle,
    raw?.abstract,
    raw?.description,
    raw?.author,
    raw?.sourceName,
    raw?.companyLabel
  ].filter(Boolean).join('\n').normalize('NFKC').toLowerCase();

  if (!text.trim()) return { score: 0, axes: [] };

  const riceBase = patternHits(RICE_BASE_PATTERNS, text);
  const riceTech = patternHits(RICE_TECH_PATTERNS, text);
  const vacuumBase = patternHits(VACUUM_BASE_PATTERNS, text);
  const vacuumTech = patternHits(VACUUM_TECH_PATTERNS, text);
  const storageBase = patternHits(STORAGE_BASE_PATTERNS, text);
  const storageApp = patternHits(STORAGE_APPLICATION_PATTERNS, text);
  const product = patternHits(TARGET_PRODUCT_PATTERNS, text);
  const productTech = patternHits(PRODUCT_TECH_PATTERNS, text);
  const coffeeBase = patternHits(COFFEE_BASE_PATTERNS, text);
  const coffeeTech = patternHits(COFFEE_TECH_PATTERNS, text);
  const company = patternHits(COMPANY_PATTERNS, text);
  const hardNegative = patternHits(HARD_NEGATIVE_PATTERNS, text);
  const softNegative = patternHits(SOFT_NEGATIVE_PATTERNS, text);

  const axes = [];
  let score = 0;

  // 軸1: 炊飯科学。米だけ/食品だけでは採用せず、物性・吸水・糊化・食味などを必須にする。
  if (riceBase > 0 && riceTech > 0) {
    axes.push('炊飯科学');
    score += 12 + Math.min(8, riceTech * 2);
    if (/rice\s+cooker|炊飯器/.test(text)) score += 3;
  }

  // 軸2: 真空断熱。vacuum単独や建築用途単独では採用しない。
  if (vacuumBase > 0 && vacuumTech > 0) {
    axes.push('真空断熱');
    score += 12 + Math.min(8, vacuumTech * 2);
  }

  // 軸2補助: 蓄熱。PCMだけでは広すぎるため、保温/容器/温水/家庭機器の文脈を必須にする。
  if (storageBase > 0 && storageApp > 0) {
    axes.push('蓄熱・保温');
    score += 9 + Math.min(6, storageApp * 2);
  }

  // 軸3: 対象5製品 × 省エネ・保温・ユーザビリティ/製品制御
  if (product > 0 && productTech > 0) {
    axes.push('製品技術');
    score += 11 + Math.min(8, productTech * 2);
  }

  // コーヒーメーカー開発へ直接つながる抽出温度・抽出率・官能研究も拾う。
  if (coffeeBase > 0 && coffeeTech > 0) {
    axes.push('コーヒー抽出');
    score += 10 + Math.min(6, coffeeTech * 2);
  }

  // 軸3補助: 対象メーカーが関与していて、上記いずれかの研究軸にも入る場合だけ加点。
  if (company > 0 && axes.length > 0) {
    axes.push('競合企業');
    score += 6;
  }

  // 明らかな別分野は強く落とす。建築VIPは基礎技術として転用可能なためsoft penaltyに留める。
  score -= Math.min(24, hardNegative * 12);
  if (!product && !company) score -= Math.min(10, softNegative * 5);
  else score -= Math.min(4, softNegative * 2);

  return {
    score,
    axes: [...new Set(axes)]
  };
}

function semanticRelevanceScore(paper) {
  return evaluateResearchRelevance({
    title: paper?.title,
    originalTitle: paper?.title,
    abstract: paper?.abstract
  }).score;
}

function applyResearchFilter(item) {
  if (!item) return null;
  const result = evaluateResearchRelevance(item);
  if (!result.axes.length || result.score < 10) return null;

  item.relevanceScore = Math.max(Number(item.relevanceScore || 0), result.score);
  item.researchAxes = result.axes;

  const axisText = `調査軸: ${result.axes.join(' / ')}`;
  const scoreText = `関連度スコア: ${result.score}`;
  const description = normalizeSpace(item.description || '');
  if (!description.includes('調査軸:')) {
    item.description = [axisText, scoreText, description].filter(Boolean).join('\n\n');
  }
  return item;
}

function parseSemanticScholarPaper(paper) {
  const originalTitle = normalizeSpace(paper?.title);
  const pdfUrl = normalizeHttps(paper?.openAccessPdf?.url);
  if (!originalTitle || !pdfUrl) return null;

  const relevanceScore = semanticRelevanceScore(paper);
  if (relevanceScore < 10) return null;

  const authors = semanticScholarAuthors(paper);
  const venue = normalizeSpace(paper?.venue);
  const doi = normalizeSpace(paper?.externalIds?.DOI || paper?.externalIds?.doi);
  const abstract = normalizeSpace(paper?.abstract).slice(0, 4000);
  const s2Url = normalizeHttps(paper?.url);

  const details = [
    `原題: ${originalTitle}`,
    authors && `著者: ${authors}`,
    venue && `掲載先: ${venue}`,
    doi && `DOI: ${doi}`,
    abstract && `抄録: ${abstract}`,
    s2Url && `Semantic Scholar: ${s2Url}`,
    `関連度スコア: ${relevanceScore}`,
    '情報提供元: Semantic Scholar（公開PDF）'
  ].filter(Boolean).join('\n\n');

  return {
    title: originalTitle,
    originalTitle,
    // 公開PDFを直接リンクにすることで、既存のPDF要約処理へ直結する。
    link: pdfUrl,
    pubDate: semanticScholarDate(paper),
    author: authors || venue || 'Semantic Scholar',
    sourceName: 'Semantic Scholar OA',
    description: details,
    doi,
    relevanceScore,
    sourceId: `s2:${normalizeSpace(paper?.paperId || doi || pdfUrl)}`
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, {
  headers = {},
  timeoutMs = 10_000,
  retryStatuses = new Set([429, 500, 502, 503, 504]),
  delays = UPSTREAM_RETRY_DELAYS
} = {}) {
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow'
      });
      lastResponse = response;
      if (!retryStatuses.has(response.status) || attempt >= delays.length) return response;
    } catch (err) {
      lastError = err;
      if (attempt >= delays.length) throw err;
    }

    await sleep(delays[attempt]);
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error('外部API通信に失敗しました');
}

async function searchSemanticScholar(queryDef, timeoutMs = 18_000) {
  const url = new URL(SEMANTIC_SCHOLAR_ENDPOINT);
  url.searchParams.set('query', queryDef.query);
  url.searchParams.set('fields', 'title,url,abstract,authors,venue,publicationDate,year,externalIds,openAccessPdf,publicationTypes');
  url.searchParams.set('sort', 'publicationDate:desc');
  // publicationTypesは絞り過ぎるとpreprint等を落とすためv22では指定しない。
  url.searchParams.set('publicationDateOrYear', '2010-01-01:');
  url.searchParams.set('limit', String(SEMANTIC_SCHOLAR_PER_QUERY));

  const requestUrl = `${url.toString()}&openAccessPdf`;
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'PersonalDashboardPapers/8.0'
  };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;

  const response = await fetchWithRetry(requestUrl, {
    headers,
    timeoutMs,
    retryStatuses: new Set([429, 500, 502, 503, 504])
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Semantic Scholar HTTP ${response.status} [${queryDef.name}]${text ? `: ${text.slice(0, 180)}` : ''}`);
  }

  const data = await response.json();
  const items = (Array.isArray(data?.data) ? data.data : [])
    .map(parseSemanticScholarPaper)
    .filter(Boolean);

  return {
    name: queryDef.name,
    estimatedTotal: Number(data?.total || 0),
    items
  };
}

async function searchSemanticScholarAll() {
  const items = [];
  const errors = [];
  const counts = [];
  const hasOwnKey = Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY);

  for (let i = 0; i < SEMANTIC_SCHOLAR_QUERIES.length; i += 1) {
    if (i > 0) await sleep(hasOwnKey ? 1050 : 1350);
    const queryDef = SEMANTIC_SCHOLAR_QUERIES[i];

    try {
      const result = await searchSemanticScholar(queryDef);
      items.push(...result.items);
      counts.push(`${result.name}:${result.items.length}`);
    } catch (err) {
      errors.push(err?.message || `Semantic Scholar取得失敗 [${queryDef.name}]`);
    }
  }

  return { items, errors, counts };
}

// --- Crossref: 競合メーカー所属著者の論文 ------------------------------
// Crossrefの query.affiliation は完全一致フィルタではないため、
// 返却された author[].affiliation[].name を aliases と照合してから採用する。
function normalizeCompanyText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function crossrefAffiliations(work) {
  return (Array.isArray(work?.author) ? work.author : [])
    .flatMap(author => Array.isArray(author?.affiliation) ? author.affiliation : [])
    .map(aff => normalizeSpace(aff?.name))
    .filter(Boolean);
}

function matchesCompanyAffiliation(affiliations, company) {
  const normalizedAffiliations = affiliations.map(normalizeCompanyText);
  const normalizedAliases = (company?.aliases || [])
    .map(normalizeCompanyText)
    .filter(alias => alias.length >= 4);

  const matched = affiliations.filter((affiliation, index) => {
    const value = normalizedAffiliations[index];
    return normalizedAliases.some(alias => (
      value === alias ||
      value.startsWith(`${alias} `) ||
      value.endsWith(` ${alias}`) ||
      value.includes(` ${alias} `)
    ));
  });

  return matched;
}

function crossrefDateParts(value) {
  const parts = value?.['date-parts']?.[0];
  if (!Array.isArray(parts) || !parts.length) return null;
  const [year, month = 1, day = 1] = parts.map(Number);
  if (!year) return null;
  const date = new Date(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)));
  return Number.isFinite(date.getTime()) ? date : null;
}

function crossrefDate(work) {
  return (
    crossrefDateParts(work?.['published-online']) ||
    crossrefDateParts(work?.['published-print']) ||
    crossrefDateParts(work?.published) ||
    crossrefDateParts(work?.issued) ||
    crossrefDateParts(work?.created) ||
    new Date(0)
  );
}

function crossrefAuthors(work) {
  return (Array.isArray(work?.author) ? work.author : [])
    .map(author => normalizeSpace([author?.given, author?.family].filter(Boolean).join(' ')))
    .filter(Boolean)
    .slice(0, 10)
    .join(', ');
}

function crossrefTitle(work) {
  const raw = Array.isArray(work?.title) ? work.title[0] : work?.title;
  return normalizeSpace(stripHtml(raw));
}

function crossrefTopicScore(work) {
  const title = crossrefTitle(work);
  const abstract = stripHtml(work?.abstract || '');
  const journal = normalizeSpace(Array.isArray(work?.['container-title']) ? work['container-title'][0] : work?.['container-title']);
  return evaluateResearchRelevance({
    title,
    originalTitle: title,
    abstract,
    description: journal
  }).score;
}

function crossrefBestLink(work) {
  const links = Array.isArray(work?.link) ? work.link : [];
  const pdf = links.find(link => {
    const contentType = String(link?.['content-type'] || link?.contentType || '').toLowerCase();
    const url = String(link?.URL || link?.url || '');
    return contentType.includes('pdf') || /\.pdf(?:$|[?#])/i.test(url);
  });
  const anyFullText = links.find(link => link?.URL || link?.url);
  const doi = normalizeSpace(work?.DOI);

  return normalizeHttps(
    pdf?.URL || pdf?.url ||
    anyFullText?.URL || anyFullText?.url ||
    work?.URL ||
    (doi ? `https://doi.org/${doi}` : '')
  );
}

function parseCrossrefWork(work, company) {
  const type = normalizeSpace(work?.type);
  if (type && !['journal-article', 'proceedings-article', 'posted-content', 'book-chapter', 'report'].includes(type)) {
    return null;
  }

  const title = crossrefTitle(work);
  if (!title) return null;

  const affiliations = crossrefAffiliations(work);
  const matchedAffiliations = matchesCompanyAffiliation(affiliations, company);
  if (!matchedAffiliations.length) return null;

  const relevanceScore = crossrefTopicScore(work);
  if (relevanceScore < 10) return null;

  const link = crossrefBestLink(work);
  if (!link) return null;

  const authors = crossrefAuthors(work);
  const journal = normalizeSpace(Array.isArray(work?.['container-title']) ? work['container-title'][0] : work?.['container-title']);
  const doi = normalizeSpace(work?.DOI);
  const abstract = stripHtml(work?.abstract || '').slice(0, 5000);
  const hasPdfLink = /\.pdf(?:$|[?#])/i.test(link) || (Array.isArray(work?.link) && work.link.some(item => String(item?.['content-type'] || '').toLowerCase().includes('pdf')));

  const details = [
    `企業関与: ${company.label}（著者所属で確認）`,
    `所属表記: ${matchedAffiliations.slice(0, 4).join(' / ')}`,
    authors && `著者: ${authors}`,
    journal && `掲載先: ${journal}`,
    doi && `DOI: ${doi}`,
    abstract && `抄録: ${abstract}`,
    `関連度スコア: ${relevanceScore}`,
    hasPdfLink ? '全文リンク: PDF候補あり' : '全文リンク: DOI/出版社ページ',
    '情報提供元: Crossref affiliation search'
  ].filter(Boolean).join('\n\n');

  return {
    title,
    originalTitle: title,
    link,
    pubDate: crossrefDate(work),
    author: authors || company.label,
    sourceName: `企業研究: ${company.label}`,
    description: details,
    doi,
    relevanceScore,
    companyLabel: company.label,
    sourceId: `crossref:${doi || link}`
  };
}

async function searchCrossrefCompany(company) {
  const url = new URL(CROSSREF_ENDPOINT);
  url.searchParams.set('query.affiliation', company.query);
  url.searchParams.set(
    'query.bibliographic',
    'rice cooker rice cooking gelatinization water absorption electric kettle water boiler vacuum insulated bottle vacuum flask thermos coffee maker coffee brewing energy efficiency heat retention temperature control usability thermal conductivity'
  );
  url.searchParams.set('filter', 'from-pub-date:2005-01-01,has-affiliation:1');
  url.searchParams.set('rows', String(CROSSREF_ROWS_PER_COMPANY));

  // CROSSREF_MAILTOは任意。未設定でもPublic poolで動作する。
  if (process.env.CROSSREF_MAILTO) {
    url.searchParams.set('mailto', process.env.CROSSREF_MAILTO);
  }

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': process.env.CROSSREF_MAILTO
        ? `PersonalDashboardPapers/8.0 (mailto:${process.env.CROSSREF_MAILTO})`
        : 'PersonalDashboardPapers/8.0'
    },
    signal: AbortSignal.timeout(16_000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Crossref HTTP ${response.status} [${company.label}]${text ? `: ${text.slice(0, 160)}` : ''}`);
  }

  const data = await response.json();
  const works = Array.isArray(data?.message?.items) ? data.message.items : [];
  const items = works
    .map(work => parseCrossrefWork(work, company))
    .filter(Boolean);

  return {
    company: company.label,
    total: Number(data?.message?.['total-results'] || 0),
    items
  };
}

async function searchCrossrefCompanies() {
  const settled = await runWithConcurrency(CROSSREF_COMPANIES, 5, searchCrossrefCompany);
  const items = [];
  const errors = [];
  const counts = [];

  settled.forEach((result, index) => {
    if (result?.status === 'fulfilled') {
      items.push(...result.value.items);
      counts.push(`${result.value.company}:${result.value.items.length}`);
    } else {
      const label = CROSSREF_COMPANIES[index]?.label || 'company';
      errors.push(result?.reason?.message || `Crossref取得失敗 [${label}]`);
    }
  });

  return { items, errors, counts };
}

async function enrichCrossrefWithOpenAccessPdf(items) {
  const doiItems = items.filter(item => normalizeSpace(item?.doi));
  if (!doiItems.length) return { enriched: 0, error: '' };

  const byDoi = new Map(
    doiItems.map(item => [normalizeSpace(item.doi).toLowerCase(), item])
  );
  const batches = splitIntoBatches(Array.from(byDoi.keys()), 400);
  let enriched = 0;

  for (const batch of batches) {
    const url = new URL(SEMANTIC_SCHOLAR_BATCH_ENDPOINT);
    url.searchParams.set('fields', 'title,url,externalIds,openAccessPdf,abstract');

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'PersonalDashboardPapers/8.0'
    };
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: batch.map(doi => `DOI:${doi}`) }),
        signal: AbortSignal.timeout(18_000)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Semantic Scholar batch HTTP ${response.status}${text ? `: ${text.slice(0, 150)}` : ''}`);
      }

      const papers = await response.json();
      for (const paper of Array.isArray(papers) ? papers : []) {
        if (!paper) continue;
        const doi = normalizeSpace(paper?.externalIds?.DOI || paper?.externalIds?.doi).toLowerCase();
        const item = byDoi.get(doi);
        const pdfUrl = normalizeHttps(paper?.openAccessPdf?.url);
        if (!item || !pdfUrl) continue;

        item.link = pdfUrl;
        item.description = `${item.description}\n\n公開PDF: Semantic Scholar経由で確認`;
        item.hasOpenAccessPdf = true;
        enriched += 1;
      }
    } catch (err) {
      // OA PDF補完だけ失敗してもCrossref論文自体は残す。
      return { enriched, error: err?.message || 'Semantic Scholar PDF補完失敗' };
    }

    if (batches.length > 1) await sleep(process.env.SEMANTIC_SCHOLAR_API_KEY ? 1050 : 1350);
  }

  return { enriched, error: '' };
}


function paperQueryText() {
  return PAPER_QUERY_EN.join(' OR ');
}

async function cachedProvider(key, ttlMs, worker, { forceRefresh = false } = {}) {
  const cached = providerCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < ttlMs) return cached.value;
  const value = await worker();
  providerCache.set(key, { at: Date.now(), value });
  if (providerCache.size > 32) {
    const oldestKey = providerCache.keys().next().value;
    providerCache.delete(oldestKey);
  }
  return value;
}

function parseRssLikeItems(xml, sourceName) {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  try {
    const doc = dom.window.document;
    if (doc.querySelector('parsererror')) throw new Error(`${sourceName}: XML parse error`);
    return Array.from(doc.querySelectorAll('item, entry')).map(node => {
      const title = firstText(node, ['title']) || '無題';
      let link = firstText(node, ['link', 'guid', 'id']);
      if (!link) {
        const alternate = Array.from(node.querySelectorAll('link')).find(el => {
          const rel = String(el.getAttribute('rel') || '').toLowerCase();
          return !rel || rel === 'alternate';
        });
        link = alternate?.getAttribute('href') || '';
      }

      const candidatePdf = Array.from(node.querySelectorAll('link, rdfs\\:seeAlso, dc\\:identifier'))
        .map(el => el.getAttribute?.('href') || el.getAttribute?.('rdf:resource') || el.textContent || '')
        .map(normalizeHttps)
        .find(value => /\.pdf(?:$|[?#])/i.test(value));

      const rawDate = firstText(node, ['pubDate', 'published', 'updated', 'dc\\:date', 'prism\\:publicationDate', 'date']);
      const author = firstText(node, ['dc\\:creator', 'creator', 'author > name', 'author']) || sourceName;
      const description = firstText(node, ['description', 'summary', 'content', 'dc\\:description']) || title;
      const doi = firstText(node, ['prism\\:doi', 'dc\\:identifier', 'doi']);
      const finalLink = candidatePdf || normalizeHttps(link);
      if (!finalLink) return null;
      return {
        title: normalizeSpace(title),
        originalTitle: normalizeSpace(title),
        link: finalLink,
        pubDate: safeDate(rawDate),
        author: normalizeSpace(author),
        sourceName,
        description: normalizeSpace(description),
        doi: /10\.\d{4,9}\//i.test(doi) ? normalizeSpace(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : ''
      };
    }).filter(Boolean);
  } finally {
    dom.window.close();
  }
}

async function searchCiniiAll() {
  const appid = normalizeSpace(process.env.CINII_APP_ID);
  if (!appid) return { items: [], errors: [], counts: [], disabled: 'CINII_APP_ID未設定' };

  const settled = await runWithConcurrency(CINII_SEARCH_TERMS, 3, async term => {
    const url = new URL(CINII_ENDPOINT);
    url.searchParams.set('appid', appid);
    url.searchParams.set('q', term);
    url.searchParams.set('count', '80');
    url.searchParams.set('sortorder', '0');
    url.searchParams.set('format', 'rss');
    url.searchParams.set('lang', 'ja');

    const response = await fetch(url, {
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*;q=0.5', 'User-Agent': 'PersonalDashboardPapers/8.0' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`CiNii HTTP ${response.status}`);
    const items = parseRssLikeItems(await response.text(), 'CiNii Research').map(item => ({
      ...item,
      description: [item.description, `検索語: ${term}`].filter(Boolean).join('\n\n')
    }));
    return { term, items };
  });

  const items = [];
  const errors = [];
  const counts = [];
  settled.forEach((result, index) => {
    if (result?.status === 'fulfilled') {
      items.push(...result.value.items);
      counts.push(`${result.value.term}:${result.value.items.length}`);
    } else {
      errors.push(result?.reason?.message || `CiNii取得失敗 [${CINII_SEARCH_TERMS[index]}]`);
    }
  });
  return { items, errors, counts };
}

async function searchPlos(timeoutMs = 8_000) {
  const terms = [
    '"rice cooking"', 'gelatinization', '"water absorption"', '"cooked rice texture"',
    '"rice cooker"', '"vacuum insulation"', '"vacuum flask"', '"thermal conductivity"',
    '"heat retention"', '"electric kettle"', '"energy efficiency"',
    '"water boiler"', '"coffee maker"', '"coffee brewing"', '"temperature control"'
  ];
  const url = new URL(PLOS_ENDPOINT);
  url.searchParams.set('q', `title:(${terms.join(' OR ')}) OR abstract:(${terms.join(' OR ')})`);
  url.searchParams.set('fl', 'id,title,publication_date,author_display,abstract,journal');
  url.searchParams.set('rows', '100');
  url.searchParams.set('sort', 'publication_date desc');
  url.searchParams.set('wt', 'json');
  if (process.env.PLOS_API_KEY) url.searchParams.set('api_key', process.env.PLOS_API_KEY);

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'PersonalDashboardPapers/8.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`PLOS HTTP ${response.status}`);
  const data = await response.json();
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  return docs.map(doc => {
    const doi = normalizeSpace(doc?.id);
    const title = normalizeSpace(Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '無題';
    const authors = Array.isArray(doc?.author_display) ? doc.author_display.join(', ') : normalizeSpace(doc?.author_display);
    const abstract = normalizeSpace(Array.isArray(doc?.abstract) ? doc.abstract.join(' ') : doc?.abstract);
    return {
      title,
      originalTitle: title,
      link: doi ? `https://doi.org/${encodeURIComponent(doi)}` : '',
      pubDate: safeDate(doc?.publication_date),
      author: authors || 'PLOS',
      sourceName: 'PLOS',
      description: [abstract, doc?.journal && `Journal: ${doc.journal}`, doi && `DOI: ${doi}`].filter(Boolean).join('\n\n'),
      doi
    };
  }).filter(item => item.link);
}

async function searchPmcOpenAccess() {
  const term = [
    '("rice cooking"[Title/Abstract] AND (gelatinization[Title/Abstract] OR starch[Title/Abstract] OR "water absorption"[Title/Abstract] OR texture[Title/Abstract] OR sensory[Title/Abstract]))',
    '("rice cooker"[Title/Abstract] AND ("temperature control"[Title/Abstract] OR "energy consumption"[Title/Abstract] OR "heat retention"[Title/Abstract]))',
    '("vacuum insulation"[Title/Abstract] AND ("thermal conductivity"[Title/Abstract] OR "heat transfer"[Title/Abstract] OR "heat retention"[Title/Abstract]))',
    '("phase change material"[Title/Abstract] AND (container[Title/Abstract] OR "hot water"[Title/Abstract] OR "heat retention"[Title/Abstract]))',
    '("electric kettle"[Title/Abstract] AND ("energy efficiency"[Title/Abstract] OR usability[Title/Abstract] OR safety[Title/Abstract]))',
    '("coffee maker"[Title/Abstract] AND (temperature[Title/Abstract] OR extraction[Title/Abstract] OR "energy consumption"[Title/Abstract]))'
  ].join(' OR ');

  const searchUrl = new URL(NCBI_ESEARCH_ENDPOINT);
  searchUrl.searchParams.set('db', 'pmc');
  searchUrl.searchParams.set('term', `(${term}) AND open access[filter]`);
  searchUrl.searchParams.set('retmode', 'json');
  searchUrl.searchParams.set('retmax', '100');
  searchUrl.searchParams.set('sort', 'pub date');
  searchUrl.searchParams.set('tool', 'personal_dashboard');
  if (process.env.NCBI_EMAIL) searchUrl.searchParams.set('email', process.env.NCBI_EMAIL);
  if (process.env.NCBI_API_KEY) searchUrl.searchParams.set('api_key', process.env.NCBI_API_KEY);

  const searchResponse = await fetch(searchUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'PersonalDashboardPapers/8.0' },
    signal: AbortSignal.timeout(8_000)
  });
  if (!searchResponse.ok) throw new Error(`PMC ESearch HTTP ${searchResponse.status}`);
  const searchData = await searchResponse.json();
  const ids = Array.isArray(searchData?.esearchresult?.idlist) ? searchData.esearchresult.idlist : [];
  if (!ids.length) return [];

  const summaryUrl = new URL(NCBI_ESUMMARY_ENDPOINT);
  summaryUrl.searchParams.set('db', 'pmc');
  summaryUrl.searchParams.set('id', ids.join(','));
  summaryUrl.searchParams.set('retmode', 'json');
  summaryUrl.searchParams.set('version', '2.0');
  summaryUrl.searchParams.set('tool', 'personal_dashboard');
  if (process.env.NCBI_EMAIL) summaryUrl.searchParams.set('email', process.env.NCBI_EMAIL);
  if (process.env.NCBI_API_KEY) summaryUrl.searchParams.set('api_key', process.env.NCBI_API_KEY);

  const summaryResponse = await fetch(summaryUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'PersonalDashboardPapers/8.0' },
    signal: AbortSignal.timeout(8_000)
  });
  if (!summaryResponse.ok) throw new Error(`PMC ESummary HTTP ${summaryResponse.status}`);
  const data = await summaryResponse.json();
  const result = data?.result || {};

  return ids.map(uid => {
    const doc = result?.[uid];
    if (!doc) return null;
    const title = normalizeSpace(doc.title) || '無題';
    const articleIds = Array.isArray(doc.articleids) ? doc.articleids : [];
    const pmcid = normalizeSpace(
      articleIds.find(id => String(id?.idtype || '').toLowerCase() === 'pmcid')?.value || `PMC${uid}`
    );
    const doi = normalizeSpace(articleIds.find(id => String(id?.idtype || '').toLowerCase() === 'doi')?.value);
    const authors = Array.isArray(doc.authors) ? doc.authors.map(a => a?.name).filter(Boolean).join(', ') : '';
    return {
      title,
      originalTitle: title,
      link: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
      pubDate: safeDate(doc.pubdate || doc.epubdate || doc.sortpubdate),
      author: authors || 'PubMed Central',
      sourceName: 'PMC Open Access',
      description: [doc.fulljournalname, doi && `DOI: ${doi}`, `PMCID: ${pmcid}`].filter(Boolean).join('\n\n'),
      doi
    };
  }).filter(Boolean);
}

async function searchCore() {
  const apiKey = normalizeSpace(process.env.CORE_API_KEY);
  const url = new URL(CORE_ENDPOINT);
  url.searchParams.set('q', paperQueryText());
  url.searchParams.set('limit', '100');
  const headers = { 'Accept': 'application/json', 'User-Agent': 'PersonalDashboardPapers/8.0' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`CORE HTTP ${response.status}`);
  const data = await response.json();
  const works = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : [];
  const items = works.map(work => {
    const title = normalizeSpace(work?.title) || '無題';
    const authors = (Array.isArray(work?.authors) ? work.authors : [])
      .map(author => normalizeSpace(author?.name || author)).filter(Boolean).join(', ');
    const fulltextCandidates = [
      work?.downloadUrl,
      work?.fullTextUrl,
      ...(Array.isArray(work?.sourceFulltextUrls) ? work.sourceFulltextUrls : []),
      ...(Array.isArray(work?.links) ? work.links.map(link => link?.url || link) : [])
    ].map(normalizeHttps).filter(Boolean);
    const link = fulltextCandidates.find(value => /\.pdf(?:$|[?#])/i.test(value))
      || fulltextCandidates[0]
      || normalizeHttps(work?.doi ? `https://doi.org/${work.doi}` : work?.url);
    if (!link) return null;
    const doi = normalizeSpace(work?.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    return {
      title,
      originalTitle: title,
      link,
      pubDate: safeDate(work?.publishedDate || work?.datePublished || work?.yearPublished),
      author: authors || 'CORE',
      sourceName: 'CORE',
      description: normalizeSpace(work?.abstract || work?.description || title),
      doi
    };
  }).filter(Boolean);
  return { items };
}

async function searchIeeeOpenAccess() {
  const apiKey = normalizeSpace(process.env.IEEE_API_KEY);
  if (!apiKey) return { items: [], disabled: 'IEEE_API_KEY未設定' };
  const url = new URL(IEEE_ENDPOINT);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('querytext', paperQueryText());
  url.searchParams.set('open_access', 'true');
  url.searchParams.set('max_records', '100');
  url.searchParams.set('start_year', '2010');
  url.searchParams.set('sort_field', 'publication_year');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'PersonalDashboardPapers/8.0' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`IEEE Xplore HTTP ${response.status}`);
  const data = await response.json();
  const articles = Array.isArray(data?.articles) ? data.articles : [];
  const items = articles.map(article => {
    const title = normalizeSpace(article?.title) || '無題';
    const doi = normalizeSpace(article?.doi);
    const link = normalizeHttps(article?.html_url || article?.abstract_url || (doi ? `https://doi.org/${doi}` : ''));
    if (!link) return null;
    return {
      title,
      originalTitle: title,
      link,
      pubDate: safeDate(article?.publication_date || article?.publication_year),
      author: normalizeSpace(article?.authors?.authors?.map?.(a => a?.full_name).filter(Boolean).join(', ')) || 'IEEE Xplore',
      sourceName: 'IEEE Xplore OA',
      description: normalizeSpace(article?.abstract || title),
      doi
    };
  }).filter(Boolean);
  return { items };
}

async function collectFastSources({ forceRefresh = false } = {}) {
  // v24: J-STAGEは短時間に4並列で叩かず、最大2並列に戻す。
  // Semantic Scholarは未認証ユーザーが共有レート制限の影響を受けるためリトライ付き。
  // PLOSは公式検索例がAPIキー付きのため、キー未設定時はfastの必須ソースにしない。
  const tasks = [
    runWithConcurrency(
      FAST_JSTAGE_TERMS,
      2,
      term => searchJStage(term, FAST_PROVIDER_TIMEOUT)
    ),
    Promise.allSettled(
      FAST_SEMANTIC_QUERIES.map(query => searchSemanticScholar(query, FAST_PROVIDER_TIMEOUT))
    )
  ];

  if (normalizeSpace(process.env.PLOS_API_KEY)) {
    tasks.push(
      Promise.allSettled([
        cachedProvider(
          'plos-fast',
          20 * 60 * 1000,
          () => searchPlos(FAST_PROVIDER_TIMEOUT),
          { forceRefresh }
        )
      ])
    );
  }

  const settled = await Promise.allSettled(tasks);
  const errors = [];
  let jstageItems = [];
  let semanticItems = [];
  let plosItems = [];

  const jstageTask = settled[0];
  if (jstageTask?.status === 'fulfilled') {
    jstageItems = jstageTask.value.flatMap(result => {
      if (result?.status === 'fulfilled') return result.value;
      errors.push(result?.reason?.message || 'J-STAGE取得失敗');
      return [];
    });
  } else {
    errors.push(jstageTask?.reason?.message || 'J-STAGE取得失敗');
  }

  const semanticTask = settled[1];
  if (semanticTask?.status === 'fulfilled') {
    semanticItems = semanticTask.value.flatMap(result => {
      if (result?.status === 'fulfilled') return result.value?.items || [];
      errors.push(result?.reason?.message || 'Semantic Scholar取得失敗');
      return [];
    });
  } else {
    errors.push(semanticTask?.reason?.message || 'Semantic Scholar取得失敗');
  }

  if (tasks.length >= 3) {
    const plosTask = settled[2];
    if (plosTask?.status === 'fulfilled') {
      const plosResult = plosTask.value?.[0];
      if (plosResult?.status === 'fulfilled') plosItems = Array.isArray(plosResult.value) ? plosResult.value : [];
      else errors.push(plosResult?.reason?.message || 'PLOS取得失敗');
    } else {
      errors.push(plosTask?.reason?.message || 'PLOS取得失敗');
    }
  } else {
    errors.push('PLOS: PLOS_API_KEY未設定のためfast取得をスキップ');
  }

  return {
    items: dedupePapers([...jstageItems, ...semanticItems, ...plosItems]),
    errors,
    counts: {
      jstage: jstageItems.length,
      semantic: semanticItems.length,
      plos: plosItems.length
    }
  };
}

async function collectDeepSources({ forceRefresh = false } = {}) {
  const optionalTasks = [
    cachedProvider('cinii', DEEP_TTL, searchCiniiAll, { forceRefresh }),
    cachedProvider('core', DEEP_TTL, searchCore, { forceRefresh }),
    cachedProvider('ieee', DEEP_TTL, searchIeeeOpenAccess, { forceRefresh })
  ];

  const [jstageSettled, semanticResult, crossrefResult, plosResult, pmcResult, optionalSettled] = await Promise.all([
    runWithConcurrency(JSTAGE_SEARCH_TERMS, 3, searchJStage),
    searchSemanticScholarAll(),
    searchCrossrefCompanies(),
    cachedProvider('plos', 20 * 60 * 1000, searchPlos, { forceRefresh }).catch(error => ({ __error: error })),
    cachedProvider('pmc', 20 * 60 * 1000, searchPmcOpenAccess, { forceRefresh }).catch(error => ({ __error: error })),
    Promise.allSettled(optionalTasks)
  ]);

  const jstageItems = jstageSettled.flatMap(result => result?.status === 'fulfilled' ? result.value : []);
  const crossrefItems = crossrefResult.items;
  const crossrefPdfResult = await enrichCrossrefWithOpenAccessPdf(crossrefItems);
  const plosItems = Array.isArray(plosResult) ? plosResult : [];
  const pmcItems = Array.isArray(pmcResult) ? pmcResult : [];

  const optional = { cinii: [], core: [], ieee: [] };
  const optionalErrors = [];
  ['cinii', 'core', 'ieee'].forEach((key, index) => {
    const result = optionalSettled[index];
    if (result?.status === 'fulfilled') {
      const value = result.value || {};
      optional[key] = Array.isArray(value?.items) ? value.items : [];
      if (Array.isArray(value?.errors)) optionalErrors.push(...value.errors);
    } else {
      optionalErrors.push(result?.reason?.message || `${key}取得失敗`);
    }
  });

  const errors = [
    ...jstageSettled.filter(r => r?.status === 'rejected').map(r => r.reason?.message || 'J-STAGE取得失敗'),
    ...semanticResult.errors,
    ...crossrefResult.errors,
    ...(crossrefPdfResult.error ? [crossrefPdfResult.error] : []),
    ...(plosResult?.__error ? [plosResult.__error?.message || 'PLOS取得失敗'] : []),
    ...(pmcResult?.__error ? [pmcResult.__error?.message || 'PMC取得失敗'] : []),
    ...optionalErrors
  ];

  return {
    items: dedupePapers([
      ...jstageItems,
      ...semanticResult.items,
      ...crossrefItems,
      ...plosItems,
      ...pmcItems,
      ...optional.cinii,
      ...optional.core,
      ...optional.ieee
    ]),
    errors,
    counts: {
      jstage: jstageItems.length,
      semantic: semanticResult.items.length,
      crossref: crossrefItems.length,
      plos: plosItems.length,
      pmc: pmcItems.length,
      cinii: optional.cinii.length,
      core: optional.core.length,
      ieee: optional.ieee.length,
      crossrefPdf: crossrefPdfResult.enriched
    }
  };
}

function decorateCompanyTitles(items) {
  for (const item of items) {
    if (!item?.companyLabel || !item?.title) continue;
    const prefix = `【${item.companyLabel}】`;
    if (!item.title.startsWith(prefix)) item.title = `${prefix}${item.title}`;
  }
}

// J-STAGEの同時アクセス制限を踏みにくくするため最大2並列。
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function splitIntoBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function dedupePapers(items) {
  const seen = new Set();
  return items.filter(item => {
    const doiKey = normalizeSpace(item?.doi).toLowerCase();
    const linkKey = normalizeSpace(item?.link).replace(/[?#].*$/, '').toLowerCase();
    const titleKey = normalizeSpace(item?.originalTitle || item?.title).toLowerCase();
    const key = doiKey ? `doi:${doiKey}` : linkKey ? `url:${linkKey}` : `title:${titleKey}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || 'deep').toLowerCase() === 'fast' ? 'fast' : 'deep';
    const forceRefresh = Boolean(req.query?._fresh || req.query?.refresh);
    const cache = feedCaches[mode];
    const ttl = mode === 'deep' ? DEEP_TTL : FAST_TTL;

    if (!forceRefresh && cache.xml && Date.now() - cache.at < ttl) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', mode === 'deep' ? 's-maxage=1800, stale-while-revalidate=3600' : 's-maxage=600, stale-while-revalidate=1800');
      res.setHeader('X-Papers-Mode', mode);
      return res.status(200).send(cache.xml);
    }

    const result = mode === 'deep'
      ? await collectDeepSources({ forceRefresh })
      : await collectFastSources({ forceRefresh });

    const finalItems = dedupePapers(result.items)
      .map(applyResearchFilter)
      .filter(Boolean)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, MAX_ITEMS);

    // 企業所属論文には会社名を残す。英語タイトルの和訳はここでは待たず、UI側で非同期実行する。
    decorateCompanyTitles(finalItems);

    if (!finalItems.length) {
      // v24: 外部論文APIが同時に一時失敗してもHTTP 502にしない。
      // 古いRSSがあればそれを返し、なければ有効な空RSSを200で返す。
      const staleXml = cache.xml || feedCaches.deep.xml || feedCaches.fast.xml;
      if (staleXml) {
        res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Papers-Mode', mode);
        res.setHeader('X-Papers-Stale', '1');
        res.setHeader('X-Papers-Partial-Errors', String(result.errors.length || 1));
        return res.status(200).send(staleXml);
      }

      const emptyXml = rssXml(
        '論文',
        `論文取得先が一時的に応答していません。再読み込みで再試行します。${result.errors.length ? ` エラー数:${result.errors.length}` : ''}`,
        []
      );
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Papers-Mode', mode);
      res.setHeader('X-Papers-Empty', '1');
      res.setHeader('X-Papers-Partial-Errors', String(result.errors.length || 1));
      return res.status(200).send(emptyXml);
    }

    const countText = Object.entries(result.counts || {})
      .map(([key, value]) => `${key}:${value}`)
      .join(' / ');

    const xml = rssXml(
      '論文',
      [
        '炊飯科学・真空断熱/蓄熱・対象5製品の省エネ/保温/ユーザビリティ・競合企業関与の4軸で厳密に絞り込んだ論文を統合。',
        mode === 'fast'
          ? '高速表示: J-STAGE + Semantic Scholar + PLOS。PMCなどは一覧表示後に詳細取得。'
          : '詳細表示: 高速ソース + Crossref競合企業 + CORE + PMC + CiNii Research/IRDB・IEEE Xplore（設定済みAPIのみ）。',
        `取得内訳 ${countText}。`,
        '英語タイトルは画面表示後にGeminiで非同期和訳するため、RSS応答では翻訳待ちをしません。'
      ].join(' '),
      finalItems
    );

    feedCaches[mode] = { at: Date.now(), xml };

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', mode === 'deep' ? 's-maxage=1800, stale-while-revalidate=3600' : 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('X-Papers-Mode', mode);
    res.setHeader('X-Papers-Source', mode === 'deep'
      ? 'J-STAGE,Semantic Scholar,Crossref,PLOS,PMC,CiNii Research,CORE,IEEE Xplore'
      : 'J-STAGE,Semantic Scholar,PLOS');
    res.setHeader('X-Papers-Count', String(finalItems.length));
    res.setHeader('X-Papers-Counts', countText.slice(0, 900));
    if (result.errors.length) res.setHeader('X-Papers-Partial-Errors', String(result.errors.length));

    return res.status(200).send(xml);
  } catch (err) {
    console.error('[papers-feed:v26]', err);

    const staleXml = feedCaches.fast.xml || feedCaches.deep.xml;
    if (staleXml) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Papers-Stale', '1');
      res.setHeader('X-Papers-Fatal', '1');
      return res.status(200).send(staleXml);
    }

    const emptyXml = rssXml(
      '論文',
      `論文取得処理で一時エラーが発生しました。再読み込みで再試行します: ${String(err?.message || 'unknown').slice(0, 240)}`,
      []
    );
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Papers-Fatal', '1');
    return res.status(200).send(emptyXml);
  }
}
