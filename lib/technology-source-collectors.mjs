import jsdomPackage from 'jsdom';
import { fetchRssSource } from './rss-merge.mjs';

const { JSDOM, VirtualConsole } = jsdomPackage;

export const TECHNOLOGY_SOURCE_CATALOG = [
  {
    sourceType: '特許情報',
    media: [
      { name: 'Google Patents', method: 'Google Patents / BigQuery（設定時）・Web検索フォールバック' },
      { name: 'J-PlatPat', method: 'J-PlatPat / RSSHub等（設定時）・Web検索フォールバック' },
      { name: 'Espacenet', method: 'EPO Open Patent Services API（認証情報設定時）' }
    ]
  },
  {
    sourceType: 'プレスリリース',
    media: [
      { name: 'PR TIMES', method: '公式RSS' },
      { name: 'Business Wire', method: 'RSS URL設定時・Web検索フォールバック' },
      { name: 'PR Newswire', method: 'RSS URL設定時・Web検索フォールバック' }
    ]
  },
  {
    sourceType: '専門Webメディア',
    media: [
      { name: '家電 Watch', method: '公式RSS' },
      { name: 'MONOist', method: '公式RSS' },
      { name: 'Gizmodo Japan', method: '公式RSS' }
    ]
  },
  {
    sourceType: 'クラウドファンディング',
    media: [
      { name: 'Makuake', method: 'RSSHub/JSON API URL設定時・Web検索フォールバック' },
      { name: 'CAMPFIRE', method: 'RSSHub/JSON API URL設定時・Web検索フォールバック' },
      { name: 'Kickstarter', method: '検索Atomフィード' }
    ]
  },
  {
    sourceType: '研究機関PR',
    media: [
      { name: '日本の研究.com', method: 'RSS URL設定時・Web検索フォールバック' },
      { name: 'Science Portal', method: 'JSTサイト直接取得' },
      { name: 'EurekAlert!', method: '公式RSS' }
    ]
  }
];

const DIRECT_RSS = [
  { sourceType: 'プレスリリース', sourceLabel: 'PR TIMES', urls: ['https://prtimes.jp/index.rdf'], maxItems: 40 },
  { sourceType: '専門Webメディア', sourceLabel: '家電 Watch', urls: ['https://kaden.watch.impress.co.jp/data/rss/1.0/kdw/feed.rdf'], maxItems: 40 },
  { sourceType: '専門Webメディア', sourceLabel: 'MONOist', urls: ['https://rss.itmedia.co.jp/rss/2.0/monoist.xml'], maxItems: 40 },
  { sourceType: '専門Webメディア', sourceLabel: 'Gizmodo Japan', urls: ['https://www.gizmodo.jp/index.xml'], maxItems: 40 },
  {
    sourceType: 'クラウドファンディング', sourceLabel: 'Kickstarter', maxItems: 18,
    urls: [
      'https://www.kickstarter.com/discover/advanced.atom?term=cooker',
      'https://www.kickstarter.com/discover/advanced.atom?term=thermal',
      'https://www.kickstarter.com/discover/advanced.atom?term=insulation',
      'https://www.kickstarter.com/discover/advanced.atom?term=heating'
    ]
  },
  { sourceType: '研究機関PR', sourceLabel: 'EurekAlert!', urls: ['https://www.eurekalert.org/rss.xml'], maxItems: 40 }
];

const OPTIONAL_RSS = [
  { sourceType: '特許情報', sourceLabel: 'Google Patents', env: 'GOOGLE_PATENTS_FEED_URL' },
  { sourceType: '特許情報', sourceLabel: 'J-PlatPat', env: 'JPLATPAT_FEED_URL' },
  { sourceType: 'プレスリリース', sourceLabel: 'Business Wire', env: 'BUSINESS_WIRE_RSS_URL' },
  { sourceType: 'プレスリリース', sourceLabel: 'PR Newswire', env: 'PR_NEWSWIRE_RSS_URL' },
  { sourceType: 'クラウドファンディング', sourceLabel: 'Makuake', env: 'MAKUAKE_FEED_URL' },
  { sourceType: 'クラウドファンディング', sourceLabel: 'CAMPFIRE', env: 'CAMPFIRE_FEED_URL' },
  { sourceType: '研究機関PR', sourceLabel: '日本の研究.com', env: 'RESEARCH_ER_RSS_URL' }
];

const CORE_RE = /(炊飯|米飯|rice\s*cook|rice\s*cooker|真空断熱|vacuum\s*(?:insulation|flask|bottle)|魔法瓶|thermos|電気ケトル|kettle|電気ポット|water\s*(?:boiler|warmer)|保温|保冷|heat\s*retention|temperature\s*control|温度制御|沸騰|boil|加熱|heating|thermal|断熱|insulation|phase\s*change|蓄熱|heat\s*storage)/i;
const BRAND_RE = /(タイガー魔法瓶|象印|zojirushi|panasonic|パナソニック|thermos|サーモス|iris\s*ohyama|アイリスオーヤマ|balmuda|バルミューダ|vermicular|バーミキュラ|siroca|山善|fellow|instant\s*brands|breville|de['’]?longhi|hydro\s*flask|stanley|ember)/i;
const IDEA_RE = /(新素材|新構造|新技術|世界初|独自|革新|innovation|novel|material|structure|sensor|制御|control|冷却|cooling|熱回収|energy|省エネ|相変化|phase\s*change|表面|coating|porous|多孔|aerogel|エアロゲル|触覚|haptic|ergonomic|人間工学|clean|洗浄|撥水|濡れ|microfluid|流体|蒸気|steam)/i;
const BROAD_RE = /(家電|調理|厨房|キッチン|cook|cooker|cookware|appliance|bottle|flask|coffee|food|飲料|水|water|steam|蒸気|heat|thermal|temperature|温度|加熱|冷却|cooling|断熱|insulation|vacuum|真空|energy|省エネ|material|素材|sensor|センサ|control|制御|battery|電池|surface|表面|coating|洗浄|clean|安全|safety|ergonomic|人間工学)/i;

function clean(value = '', max = 1000) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stripStyleBlocks(html = '') {
  return String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, ' ');
}

function createQuietHtmlDom(html, url) {
  const virtualConsole = new VirtualConsole();
  return new JSDOM(stripStyleBlocks(html), { url, virtualConsole });
}

function safeUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function relevanceScore(item) {
  const hay = `${item.title || ''} ${item.summary || ''} ${item.organization || ''}`;
  let score = 0;
  if (CORE_RE.test(hay)) score += 9;
  if (BRAND_RE.test(hay)) score += 8;
  if (IDEA_RE.test(hay)) score += 5;
  if (BROAD_RE.test(hay)) score += 2;
  const ageDays = Math.max(0, (Date.now() - dateValue(item.pubDate).getTime()) / 86400000);
  score += Math.max(0, 5 - Math.min(5, ageDays / 14));
  return score;
}

function candidateFromRss(row, config) {
  return {
    sourceType: config.sourceType,
    sourceLabel: config.sourceLabel,
    organization: clean(row.author || config.sourceLabel, 160),
    title: clean(row.title, 240),
    summary: clean(row.description || row.title, 700),
    url: safeUrl(row.link),
    pubDate: dateValue(row.pubDate),
    image: safeUrl(row.image),
    acquisition: config.acquisition || 'RSS直接取得'
  };
}

async function collectRssConfig(config) {
  const settled = await Promise.allSettled((config.urls || []).map(url =>
    fetchRssSource({ name: config.sourceLabel, url, maxItems: config.maxItems || 30 })
  ));
  const items = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value.map(row => candidateFromRss(row, config)));
    } else {
      errors.push(`${config.sourceLabel}: ${result.reason?.message || `RSS失敗 ${index + 1}`}`);
    }
  });
  const seen = new Set();
  const ranked = items
    .filter(item => item.title && item.url)
    .filter(item => {
      const key = item.url.replace(/[?#].*$/, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => relevanceScore(b) - relevanceScore(a) || dateValue(b.pubDate) - dateValue(a.pubDate))
    .slice(0, config.sourceLabel === 'Kickstarter' ? 24 : 20);
  return { items: ranked, errors };
}

async function collectOptionalRss(config) {
  const raw = String(process.env[config.env] || '').trim();
  if (!raw) return { items: [], errors: [], skipped: `${config.env}未設定` };
  const urls = raw.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
  return collectRssConfig({ ...config, urls, acquisition: `${config.env}で設定したRSS/APIフィード` });
}

async function collectSciencePortal() {
  const url = 'https://scienceportal.jst.go.jp/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'PersonalDashboardTechResearch/2.19.5', Accept: 'text/html,*/*;q=.5' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Science Portal HTTP ${response.status}`);
    const html = await response.text();
    const dom = createQuietHtmlDom(html, url);
    try {
      const links = Array.from(dom.window.document.querySelectorAll('a[href]'));
      const seen = new Set();
      const items = [];
      for (const anchor of links) {
        const href = safeUrl(new URL(anchor.getAttribute('href') || '', url).href);
        if (!href || !/scienceportal\.jst\.go\.jp\/(?:newsflash|review|reports|explore|feature)\//i.test(href)) continue;
        const title = clean(anchor.textContent, 240);
        if (title.length < 12) continue;
        const key = href.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        const containerText = clean(anchor.closest('article,li,section,div')?.textContent || title, 900);
        const dateMatch = containerText.match(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/);
        items.push({
          sourceType: '研究機関PR',
          sourceLabel: 'Science Portal',
          organization: '科学技術振興機構（JST）',
          title,
          summary: containerText,
          url: href,
          pubDate: dateValue(dateMatch?.[0]?.replace(/\./g, '-') || new Date()),
          image: '',
          acquisition: 'Science Portalサイト直接取得'
        });
        if (items.length >= 36) break;
      }
      return {
        items: items.sort((a, b) => relevanceScore(b) - relevanceScore(a) || dateValue(b.pubDate) - dateValue(a.pubDate)).slice(0, 20),
        errors: []
      };
    } finally {
      dom.window.close();
    }
  } catch (error) {
    return { items: [], errors: [`Science Portal: ${error?.message || error}`] };
  } finally {
    clearTimeout(timer);
  }
}

let epoTokenCache = { token: '', expiresAt: 0 };

async function epoToken() {
  const key = String(process.env.EPO_OPS_CONSUMER_KEY || '').trim();
  const secret = String(process.env.EPO_OPS_CONSUMER_SECRET || '').trim();
  if (!key || !secret) return '';
  if (epoTokenCache.token && Date.now() < epoTokenCache.expiresAt - 60_000) return epoTokenCache.token;
  const response = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) throw new Error(data?.error_description || `EPO OAuth HTTP ${response.status}`);
  epoTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 1200)) * 1000
  };
  return epoTokenCache.token;
}

function textFirst(node, selectors) {
  for (const selector of selectors) {
    const found = node.querySelector(selector);
    const value = clean(found?.textContent || '', 500);
    if (value) return value;
  }
  return '';
}

async function collectEpoOps() {
  let token = '';
  try { token = await epoToken(); }
  catch (error) { return { items: [], errors: [`Espacenet OPS: ${error?.message || error}`] }; }
  if (!token) return { items: [], errors: [], skipped: 'EPO_OPS_CONSUMER_KEY/SECRET未設定' };

  const queries = [
    'applicant=Panasonic OR applicant=Zojirushi OR applicant="Tiger Corporation" OR applicant=Breville OR applicant=Ember',
    'title=thermal OR title=insulation OR title="rice cooker" OR title=kettle OR title="temperature control"'
  ];
  const settled = await Promise.allSettled(queries.map(async query => {
    const endpoint = `https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q=${encodeURIComponent(query)}`;
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/exchange+xml',
        'X-OPS-Range': '1-25'
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`EPO search HTTP ${response.status}`);
    return response.text();
  }));

  const items = [];
  const errors = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      errors.push(`Espacenet OPS: ${result.reason?.message || '検索失敗'}`);
      continue;
    }
    const dom = new JSDOM(result.value, { contentType: 'text/xml' });
    try {
      for (const doc of dom.window.document.querySelectorAll('exchange-document')) {
        const country = clean(doc.getAttribute('country') || '', 8);
        const docNumber = clean(doc.getAttribute('doc-number') || '', 40);
        const kind = clean(doc.getAttribute('kind') || '', 8);
        const publication = `${country}${docNumber}${kind}`;
        const title = textFirst(doc, ['invention-title[lang="en"]', 'invention-title[lang="ja"]', 'invention-title']);
        if (!publication || !title) continue;
        const applicant = textFirst(doc, ['applicant-name name', 'applicant name', 'applicant-name', 'applicant']) || '特許出願人';
        const dateText = textFirst(doc, ['publication-reference date', 'bibliographic-data publication-reference date']);
        const abstract = textFirst(doc, ['abstract[lang="en"] p', 'abstract[lang="ja"] p', 'abstract p', 'abstract']);
        items.push({
          sourceType: '特許情報',
          sourceLabel: 'Espacenet',
          organization: applicant,
          title,
          summary: abstract || `EPO OPSで取得した公開特許 ${publication}`,
          url: `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(`pn=${publication}`)}`,
          pubDate: dateValue(dateText),
          image: '',
          acquisition: 'EPO Open Patent Services API'
        });
      }
    } finally {
      dom.window.close();
    }
  }
  const seen = new Set();
  return {
    items: items.filter(item => {
      const key = item.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => relevanceScore(b) - relevanceScore(a) || dateValue(b.pubDate) - dateValue(a.pubDate)).slice(0, 20),
    errors
  };
}

export async function collectTechnologySourceCandidates() {
  const jobs = [
    ...DIRECT_RSS.map(config => ({ label: config.sourceLabel, promise: collectRssConfig(config) })),
    ...OPTIONAL_RSS.map(config => ({ label: config.sourceLabel, promise: collectOptionalRss(config) })),
    { label: 'Science Portal', promise: collectSciencePortal() },
    { label: 'Espacenet', promise: collectEpoOps() }
  ];
  const settled = await Promise.allSettled(jobs.map(job => job.promise));
  const candidates = [];
  const errors = [];
  const status = [];

  settled.forEach((result, index) => {
    const label = jobs[index].label;
    if (result.status === 'rejected') {
      errors.push(`${label}: ${result.reason?.message || '取得失敗'}`);
      status.push({ sourceLabel: label, directCount: 0, state: 'error' });
      return;
    }
    candidates.push(...(result.value.items || []));
    errors.push(...(result.value.errors || []));
    status.push({
      sourceLabel: label,
      directCount: (result.value.items || []).length,
      state: result.value.skipped ? 'fallback' : (result.value.items?.length ? 'direct' : 'empty'),
      note: result.value.skipped || ''
    });
  });

  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.sourceLabel}|${String(item.url || '').replace(/[?#].*$/, '')}`.toLowerCase();
    if (!item.title || !item.url || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const activeDirectMedia = new Set(unique.map(item => item.sourceLabel));
  const missingMedia = TECHNOLOGY_SOURCE_CATALOG
    .flatMap(group => group.media.map(media => ({ sourceType: group.sourceType, sourceLabel: media.name })))
    .filter(media => !activeDirectMedia.has(media.sourceLabel));

  return {
    candidates: unique.sort((a, b) => relevanceScore(b) - relevanceScore(a) || dateValue(b.pubDate) - dateValue(a.pubDate)).slice(0, 120),
    missingMedia,
    status,
    errors
  };
}
