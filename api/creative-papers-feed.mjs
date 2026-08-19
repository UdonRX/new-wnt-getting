import jsdomPackage from 'jsdom';
import { rssXml } from '../lib/rss-merge.mjs';
import { CREATIVE_PAPER_GROUPS, CREATIVE_PAPER_METHOD_TERMS } from '../shared/paper-creative-keywords.js';

const { JSDOM } = jsdomPackage;
const JSTAGE_ENDPOINT = 'https://api.jstage.jst.go.jp/searchapi/do';
const S2_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';
const FAST_TTL = 10 * 60 * 1000;
const DEEP_TTL = 30 * 60 * 1000;
const MAX_ITEMS = 420;
const S2_LIMIT = 120;
const JSTAGE_PER_TERM = 55;
const caches = { fast: { at: 0, xml: '' }, deep: { at: 0, xml: '' } };

/*
 * V2.9: 独創研究の取りこぼしを減らすため、検索入口を広げる。
 * 公開PDFの有無は「採用条件」にしない。抄録が十分なら論文ページ/DOIへリンクする。
 */
const S2_DISCOVERY_QUERIES = [
  { label:'状態・界面', query:'(acoustic OR vibration OR wettability OR capillary OR microstructure) + (sensing OR boiling OR food OR rice OR pouring)' },
  { label:'熱・感覚', query:'(aroma OR volatile OR haptic OR "thermal effusivity" OR "human factors") + (temperature OR material OR appliance OR sensory)' },
  { label:'設計・制御', query:'(biomimetic OR "digital twin" OR "sensor fusion" OR "user behavior") + (thermal OR appliance OR cooking OR energy OR usability)' },
  { label:'知覚・接触', query:'(tribology OR friction OR haptic OR psychophysics OR crossmodal OR multisensory) + (material OR grip OR touch OR perception OR experiment)' },
  { label:'形・機能', query:'(origami OR kirigami OR metamaterial OR "architected material" OR "bio-inspired surface") + (mechanical OR acoustic OR thermal OR friction OR wettability)' },
  { label:'集団・因果', query:'("collective behavior" OR "crowd dynamics" OR "network science" OR "causal inference" OR "natural experiment") + (behavior OR traffic OR diffusion OR intervention OR empirical)' },
  { label:'環境・認知', query:'(light OR noise OR temperature OR "indoor environment") + (cognition OR attention OR sleep OR decision OR productivity) + (experiment OR measurement)' },
  { label:'計測・AI', query:'(smartphone OR "low-cost sensor" OR "computational imaging" OR "human AI" OR "AI advice") + (measurement OR calibration OR decision OR trust OR validation)' },
  { label:'液滴・複雑系', query:'("droplet evaporation" OR "coffee-ring effect" OR "cascading failure" OR "complex network") + (transport OR deposition OR resilience OR model OR experiment)' }
];

// V2.11: 応用発想の入口を、家電名そのものだけでなく「現象 + 計測/設計」まで広げる。
const APPLIED_DISCOVERY_QUERIES = [
  { label:'応用・沸騰界面', query:'(boiling OR nucleate boiling OR bubble OR heat transfer) + (wettability OR surface roughness OR heater OR cooking OR fouling)' },
  { label:'応用・食品水分', query:'(rice OR starch OR cereal OR food) + (hydration OR moisture diffusion OR porous media OR microstructure OR texture OR rheology)' },
  { label:'応用・香り抽出', query:'(aroma OR volatile OR coffee OR beverage) + (temperature OR extraction OR mass transfer OR brewing OR thermal history)' },
  { label:'応用・注ぎ流体', query:'(pouring OR spout OR dripping OR droplet OR liquid jet) + (wettability OR contact angle OR surface tension OR fluid dynamics)' },
  { label:'応用・非接触計測', query:'(cooking OR thermal appliance OR kettle OR cooker OR food process) + (infrared OR computer vision OR acoustic OR sensor fusion OR state estimation)' },
  { label:'応用・人間工学', query:'(household appliance OR kitchen appliance OR control panel) + (human factors OR usability OR cognitive ergonomics OR older adults OR error prevention)' },
  { label:'応用・触覚熱', query:'(thermal effusivity OR contact temperature OR heat transfer) + (touch OR grip OR haptic OR handle OR material perception)' },
  { label:'応用・省エネ行動', query:'(electric kettle OR water heating OR household appliance) + (user behavior OR overfilling OR feedback OR nudge OR energy saving)' }
];
const ALL_S2_QUERIES = [...APPLIED_DISCOVERY_QUERIES, ...S2_DISCOVERY_QUERIES];
const FAST_S2 = [...APPLIED_DISCOVERY_QUERIES.slice(0, 6), S2_DISCOVERY_QUERIES[0], S2_DISCOVERY_QUERIES[3]];

const FAST_JSTAGE_IDS = new Set([
  'acoustic-cooking','pouring-wetting','surface-boiling-fouling','capillary-food','microstructure-sensory',
  'behavior-energy','noncontact-digital-twin','tribology-haptics','geometry-metamaterials','lowcost-computational-sensing'
]);

const HARD_NEGATIVE = [
  /cancer|tumou?r|chemotherapy|drug delivery|clinical trial|patient|surgery|disease diagnosis/i,
  /rocket|spacecraft|satellite propulsion|missile|weapon/i,
  /oil pipeline|gas pipeline|petroleum reservoir|drilling/i
];

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function https(value) { return String(value || '').replace(/^http:\/\//i, 'https://').trim(); }
function nodeText(node, selector) { return node?.querySelector(selector)?.textContent?.trim() || ''; }
function firstText(node, selectors) { for (const selector of selectors) { const v = nodeText(node, selector); if (v) return v; } return ''; }
function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' '); }

function dateInfo(value, fallbackYear = '') {
  const raw = String(value || '').trim();
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1900) return { date: parsed, precision: 'date' };
  }
  const year = String(fallbackYear || '').match(/(?:19|20)\d{2}/)?.[0];
  if (year) return { date: new Date(`${year}-07-01T12:00:00Z`), precision: 'year', year };
  return { date: new Date('2000-01-01T12:00:00Z'), precision: 'unknown', year: '' };
}

function dateMeta(info) {
  if (info.precision === 'year') return [`公開年: ${info.year}`, '日付精度: 年'];
  if (info.precision === 'unknown') return ['日付精度: 不明'];
  return [];
}

async function fetchRetry(url, { headers = {}, timeoutMs = 14000 } = {}) {
  let last;
  for (const delay of [0, 700, 1500]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (![429, 500, 502, 503, 504].includes(response.status) || delay === 1500) return response;
    } catch (err) { last = err; if (delay === 1500) throw err; }
  }
  throw last || new Error('外部API通信に失敗しました');
}

function groupMatches(raw) {
  const hay = normalize(raw);
  const rows = [];
  for (const group of CREATIVE_PAPER_GROUPS) {
    const a = (group.conceptA || []).filter(term => hay.includes(normalize(term))).length;
    const b = (group.conceptB || []).filter(term => hay.includes(normalize(term))).length;
    if (a && b) rows.push({ group, a, b });
  }
  return rows;
}

function methodHits(raw) {
  const hay = normalize(raw);
  return (CREATIVE_PAPER_METHOD_TERMS || []).filter(term => hay.includes(normalize(term))).length;
}

function evaluate(item) {
  const raw = [item.title, item.abstract, item.description].filter(Boolean).join('\n');
  const groups = groupMatches(raw);
  if (!groups.length) return null;
  const rigor = methodHits(raw);
  const maxConcept = Math.max(...groups.map(row => row.a + row.b));
  const families = [...new Set(groups.map(row => row.group.family || 'applied'))];
  const hasGeneral = families.includes('general');
  let score = groups.reduce((sum, row) => sum + (row.group.family === 'general' ? 10 : 9) + Math.min(6, row.a + row.b), 0);
  score += Math.min(12, rigor * 2.6);
  if (raw.length > 450) score += 3;
  if (item.venue || item.journal) score += 2;
  if (item.hasOpenAccessPdf) score += 2;
  score += Math.min(6, Math.log2(1 + Math.max(0, Number(item.citationCount || 0))));
  score -= HARD_NEGATIVE.filter(pattern => pattern.test(raw)).length * 20;

  // V2.9: 旧版より少し緩和。ただし「概念接続が1組もない論文」は通さない。
  if (rigor < 1 && maxConcept < 3) score -= 7;
  if (hasGeneral && rigor < 1 && maxConcept < 4) score -= 6;
  // 応用発想は『2概念が接続していて検証可能』なら取りこぼしを減らす。一般独創の厳しさは維持。
  const threshold = hasGeneral ? 12 : 8.5;
  if (score < threshold) return null;
  return { score, rigor, groups: groups.map(row => row.group), families };
}

function decorate(item) {
  const result = evaluate(item);
  if (!result) return null;
  const familyLabels = result.families.map(f => f === 'general' ? '一般独創' : '応用発想');
  const labels = [...new Set(result.groups.map(group => group.label))].slice(0, 4);
  const intents = [...new Set(result.groups.map(group => group.intent))].slice(0, 2);
  item.description = [
    `独創区分: ${familyLabels.join(' / ')}`,
    `独創研究軸: ${labels.join(' / ')}`,
    `狙い: ${intents.join(' ')}`,
    `独創性スコア: ${Math.round(result.score * 10) / 10}`,
    `検証性スコア: ${result.rigor}`,
    item.description
  ].filter(Boolean).join('\n\n');
  item.creativeScore = result.score;
  return item;
}

function parseJStageEntry(entry, term) {
  const title = firstText(entry, ['article_title > ja','article_title > en','title']) || '無題';
  const link = https(firstText(entry, ['article_link > ja','article_link > en']) || entry.querySelector('link')?.getAttribute('href') || nodeText(entry, 'id'));
  const abstract = firstText(entry, ['abstract > ja','abstract > en','summary','description']);
  const journal = firstText(entry, ['material_title > ja','material_title > en']);
  const doi = firstText(entry, ['prism\\:doi','doi']);
  const authors = Array.from(entry.querySelectorAll('author > ja > name, author > en > name')).map(el => text(el.textContent)).filter(Boolean).slice(0, 8).join(', ');
  const exact = firstText(entry, ['pubdate','publication_date','published','online_pubdate','updated']);
  const info = dateInfo(exact, nodeText(entry, 'pubyear'));
  return {
    title: text(title), link, pubDate: info.date, year: Number(nodeText(entry, 'pubyear')) || info.date.getUTCFullYear(),
    author: authors || journal || 'J-STAGE', sourceName: 'J-STAGE', journal, abstract: text(abstract), doi: text(doi),
    description: [
      abstract && `抄録: ${text(abstract)}`, journal && `掲載誌: ${journal}`, authors && `著者: ${authors}`,
      doi && `DOI: ${doi}`, `検索語: ${term}`, ...dateMeta(info), '情報提供元: J-STAGE'
    ].filter(Boolean).join('\n'),
    sourceId: `creative-jstage:${text(doi || link || title)}`
  };
}

async function searchJStage(term) {
  const url = new URL(JSTAGE_ENDPOINT);
  url.searchParams.set('service', '3');
  url.searchParams.set('text', term);
  url.searchParams.set('count', String(JSTAGE_PER_TERM));
  const response = await fetchRetry(url, { headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': 'PersonalDashboardCreativePapers/2.11' } });
  if (!response.ok) throw new Error(`J-STAGE HTTP ${response.status} (${term})`);
  const dom = new JSDOM(await response.text(), { contentType: 'text/xml' });
  try {
    const doc = dom.window.document;
    if (doc.querySelector('parsererror')) throw new Error(`J-STAGE XML解析エラー (${term})`);
    return Array.from(doc.querySelectorAll('entry')).map(entry => parseJStageEntry(entry, term)).filter(item => item.link && item.title);
  } finally { dom.window.close(); }
}

function parseS2(paper, discovery) {
  const title = text(paper?.title);
  if (!title) return null;
  const pdf = https(paper?.openAccessPdf?.url);
  const doi = text(paper?.externalIds?.DOI || paper?.externalIds?.doi);
  const page = https(paper?.url) || (doi ? `https://doi.org/${doi}` : '');
  const link = pdf || page;
  if (!link) return null;
  const abstract = text(paper?.abstract).slice(0, 7000);
  if (!abstract && !pdf) return null;
  const authors = (Array.isArray(paper?.authors) ? paper.authors : []).map(a => text(a?.name)).filter(Boolean).slice(0, 8).join(', ');
  const venue = text(paper?.venue);
  const info = dateInfo(paper?.publicationDate, paper?.year);
  return {
    title, link, pubDate: info.date, year: Number(paper?.year) || info.date.getUTCFullYear(),
    author: authors || 'Semantic Scholar', sourceName: 'Semantic Scholar', venue, abstract, doi,
    citationCount: Number(paper?.citationCount || 0), influentialCitationCount: Number(paper?.influentialCitationCount || 0),
    hasOpenAccessPdf: Boolean(pdf),
    description: [
      abstract, venue && `掲載先: ${venue}`, authors && `著者: ${authors}`, doi && `DOI: ${doi}`,
      `被引用数: ${Number(paper?.citationCount || 0)}`, `独創検索: ${discovery.label}`,
      ...dateMeta(info), `情報提供元: Semantic Scholar${pdf ? '（公開PDFあり）' : ''}`
    ].filter(Boolean).join('\n\n'),
    sourceId: `creative-s2:${text(paper?.paperId || doi || link)}`
  };
}

async function searchS2(discovery) {
  const url = new URL(S2_ENDPOINT);
  url.searchParams.set('query', discovery.query);
  url.searchParams.set('fields', 'title,url,abstract,authors,venue,publicationDate,year,externalIds,openAccessPdf,citationCount,influentialCitationCount');
  url.searchParams.set('sort', 'publicationDate:desc');
  url.searchParams.set('publicationDateOrYear', '2008-01-01:');
  url.searchParams.set('limit', String(S2_LIMIT));
  const headers = { Accept: 'application/json', 'User-Agent': 'PersonalDashboardCreativePapers/2.11' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  // 旧版の `&openAccessPdf` フィルタを外し、抄録がある論文ページも取得対象にする。
  const response = await fetchRetry(url, { headers, timeoutMs: 17000 });
  if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status} [${discovery.label}]`);
  const data = await response.json();
  return (Array.isArray(data?.data) ? data.data : []).map(paper => parseS2(paper, discovery)).filter(Boolean);
}

async function runLimited(tasks, concurrency = 3) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function dedupeAndRank(items) {
  const seen = new Set();
  return items
    .map(decorate)
    .filter(Boolean)
    .filter(item => {
      const key = text(item.doi || item.sourceId || item.link || item.title).toLowerCase().replace(/[?#].*$/, '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const score = Number(b.creativeScore || 0) - Number(a.creativeScore || 0);
      if (Math.abs(score) > 2.5) return score;
      return b.pubDate.getTime() - a.pubDate.getTime();
    })
    .slice(0, MAX_ITEMS);
}

async function collect(mode) {
  const s2Queries = mode === 'deep' ? ALL_S2_QUERIES : FAST_S2;
  const jstageGroups = mode === 'deep'
    ? CREATIVE_PAPER_GROUPS
    : CREATIVE_PAPER_GROUPS.filter(group => FAST_JSTAGE_IDS.has(group.id));
  const jstageTerms = [...new Set(jstageGroups.flatMap(group => (group.jaKeywords || []).slice(0, mode === 'deep' ? 2 : 1)))];

  const tasks = [
    ...s2Queries.map(query => () => searchS2(query)),
    ...jstageTerms.map(term => () => searchJStage(term))
  ];
  const settled = await runLimited(tasks, 3);
  const items = [];
  const errors = [];
  settled.forEach(result => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push(String(result.reason?.message || result.reason));
  });
  return { items: dedupeAndRank(items), errors };
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || 'fast') === 'deep' ? 'deep' : 'fast';
  const cache = caches[mode];
  const ttl = mode === 'deep' ? DEEP_TTL : FAST_TTL;
  const force = String(req.query?.refresh || '') === '1';

  if (!force && cache.xml && Date.now() - cache.at < ttl) {
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    res.setHeader('X-Papers-Mode', mode);
    return res.status(200).send(cache.xml);
  }

  try {
    const result = await collect(mode);
    const xml = rssXml(
      '独創研究',
      '異分野接続・実験性・検証性を重視。V2.11は応用発想の検索入口を現象・計測・人間工学まで拡張。',
      result.items
    );
    cache.at = Date.now();
    cache.xml = xml;
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', mode === 'deep' ? 's-maxage=900, stale-while-revalidate=3600' : 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('X-Papers-Track', 'creative');
    res.setHeader('X-Papers-Mode', mode);
    res.setHeader('X-Papers-Count', String(result.items.length));
    if (result.errors.length) res.setHeader('X-Papers-Partial-Errors', String(result.errors.length));
    return res.status(200).send(xml);
  } catch (err) {
    console.error('[creative-papers-feed-v211]', err);
    if (cache.xml) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Papers-Stale', '1');
      return res.status(200).send(cache.xml);
    }
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    return res.status(200).send(rssXml('独創研究', `取得エラー: ${String(err?.message || 'unknown').slice(0, 180)}`, []));
  }
}
