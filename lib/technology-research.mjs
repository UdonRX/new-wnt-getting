import { rssXml } from './rss-merge.mjs';
import { collectTechnologySourceCandidates, TECHNOLOGY_SOURCE_CATALOG } from './technology-source-collectors.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const CACHE_TTL = 30 * 60 * 1000;
const REQUIRED_SOURCE_TYPES = ['特許情報', 'プレスリリース', '専門Webメディア', 'クラウドファンディング', '研究機関PR'];
const memoryCache = { at: 0, xml: '', items: [], meta: null };

const CORE_RE = /(炊飯|米飯|rice\s*cook|rice\s*cooker|真空断熱|vacuum\s*(?:insulation|flask|bottle)|魔法瓶|thermos|電気ケトル|kettle|電気ポット|water\s*(?:boiler|warmer)|保温|保冷|heat\s*retention|temperature\s*control|温度制御|沸騰|boil|加熱|heating|thermal|断熱|insulation|phase\s*change|蓄熱|heat\s*storage)/i;
const BRAND_RE = /(タイガー魔法瓶|象印|zojirushi|panasonic|パナソニック|thermos|サーモス|iris\s*ohyama|アイリスオーヤマ|balmuda|バルミューダ|vermicular|バーミキュラ|siroca|山善|fellow|instant\s*brands|breville|de['’]?longhi|hydro\s*flask|stanley|ember)/i;
const IDEA_RE = /(異分野|着想|新素材|新構造|新技術|世界初|独自|革新|innovation|novel|material|structure|sensor|制御|control|冷却|cooling|熱回収|energy|省エネ|相変化|phase\s*change|表面|coating|porous|多孔|aerogel|エアロゲル|触覚|haptic|ergonomic|人間工学|clean|洗浄|撥水|濡れ|microfluid|流体|蒸気|steam)/i;
const BROAD_DIRECT_RE = /(家電|調理|厨房|キッチン|cook|cooker|cookware|appliance|bottle|flask|coffee|food|飲料|水|water|steam|蒸気|heat|thermal|temperature|温度|加熱|冷却|cooling|断熱|insulation|vacuum|真空|energy|省エネ|material|素材|sensor|センサ|control|制御|battery|電池|surface|表面|coating|洗浄|clean|安全|safety|ergonomic|人間工学)/i;
const TARGET_BRANDS = [
  'タイガー魔法瓶', '象印マホービン', 'パナソニック', 'サーモス', 'アイリスオーヤマ',
  'バルミューダ', 'バーミキュラ（愛知ドビー）', 'シロカ', '山善',
  'Fellow Products', 'Instant Brands', 'Breville', "De\'Longhi", 'Hydro Flask',
  'Stanley', 'Ember', 'Zojirushi America'
];
const ROTATION_FOCUS = [
  '材料・断熱・熱橋・輻射・真空封止',
  'センサー・温度推定・制御アルゴリズム・省エネ',
  '流体・沸騰・蒸気・圧力・気泡制御',
  '表面処理・濡れ性・汚れ防止・洗浄性',
  '相変化材料・蓄熱・冷却・熱回収',
  '人間工学・UI・触覚・安全・アクセシビリティ'
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
  if (/専門.*メディア|webメディア|ウェブメディア|media|家電watch|monoist|gizmodo/.test(text)) return '専門Webメディア';
  return REQUIRED_SOURCE_TYPES.find(type => type.toLowerCase().replace(/\s+/g, '') === text) || '';
}

function categoryOf(raw = {}) {
  const explicit = clean(raw.category, 80);
  if (explicit === 'コア技術・競合' || explicit === '異分野アイデア') return explicit;
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''} ${raw.organization || ''}`;
  if (CORE_RE.test(hay)) return 'コア技術・競合';
  if (IDEA_RE.test(hay)) return '異分野アイデア';
  return '異分野アイデア';
}

function applicationIdea(raw = {}) {
  const hay = `${raw.title || ''} ${raw.summary || raw.description || ''}`;
  if (/断熱|vacuum|insulation|aerogel|熱橋|輻射|radiation/i.test(hay)) return '断熱層の薄型化、熱橋低減、放射熱抑制の観点で、魔法瓶や炊飯器の保温構造へ転用できるか検討したい。';
  if (/温度|sensor|control|制御|algorithm|推定|AI|heating|加熱/i.test(hay)) return '温度推定や加熱制御の考え方を、炊飯工程の状態推定、沸騰検知、保温時の省エネ制御へ応用できる可能性がある。';
  if (/相変化|phase\s*change|蓄熱|thermal\s*storage|cooling|冷却/i.test(hay)) return '蓄熱・放熱の時間特性を利用し、保温の電力ピーク低減や温度ムラ抑制、携帯容器の保冷・保温性能向上へ応用できそう。';
  if (/表面|coating|撥水|濡れ|clean|洗浄|汚れ|porous|多孔/i.test(hay)) return '表面機能を内釜・ふた・蒸気経路へ応用し、付着抑制、洗浄性、耐久性を両立できるかが着眼点になる。';
  if (/grip|ergonomic|haptic|触覚|UI|interface|安全|safety/i.test(hay)) return '操作・把持・安全設計の発想を、ケトルやボトルの注ぎやすさ、誤操作防止、アクセシビリティ向上へ展開できる。';
  return '構造・材料・制御・使い勝手に分解し、炊飯・断熱・加熱・保温のどこへ置き換えられるかを検討する着想ネタになる。';
}

function normalizeItem(raw = {}, { direct = false } = {}) {
  const sourceType = canonicalSourceType(raw.sourceType || raw.source || raw.type || '');
  const sourceLabel = clean(raw.sourceLabel || raw.media || raw.publication || '', 120);
  const title = clean(raw.title || raw.project || raw.product, 240);
  const url = normalizeUrl(raw.url || raw.link || raw.sourceUrl);
  const summary = clean(raw.summary || raw.overview || raw.description || title, 700);
  const organization = clean(raw.organization || raw.company || raw.brand || raw.institution || raw.author || sourceLabel, 160);
  const application = clean(raw.application || raw.applicationPoint || raw.insight || raw.idea || (direct ? applicationIdea(raw) : ''), 700);
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
    acquisition: clean(raw.acquisition || raw.method || (direct ? '媒体直接取得' : 'Google Searchによる媒体限定補完'), 160)
  };
}

function dedupe(items = []) {
  const seen = new Set();
  return items.filter(item => {
    if (!item) return false;
    const key = `${item.sourceType}|${item.url.replace(/[?#].*$/, '').toLowerCase()}|${item.title.toLowerCase()}`;
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
  return CORE_RE.test(hay) || BRAND_RE.test(hay) || IDEA_RE.test(hay);
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
  if (age <= 180) return 2;
  if (age <= 365) return 1;
  return 0;
}

function relevanceScore(item) {
  const hay = `${item.title} ${item.summary} ${item.organization}`;
  return (CORE_RE.test(hay) ? 8 : 0) + (BRAND_RE.test(hay) ? 6 : 0) + (IDEA_RE.test(hay) ? 4 : 0) + (BROAD_DIRECT_RE.test(hay) ? 1 : 0) + ageScore(item);
}

function ranked(items = []) {
  return dedupe(items).sort((a, b) => relevanceScore(b) - relevanceScore(a) || normalizeDate(b.pubDate) - normalizeDate(a.pubDate));
}

function selectTen(items = []) {
  const normalized = ranked(items);
  const result = [];

  for (const type of REQUIRED_SOURCE_TYPES) {
    const rows = normalized.filter(item => item.sourceType === type);
    const selected = [];
    const core = rows.find(item => item.category === 'コア技術・競合');
    if (core) selected.push(core);
    const idea = rows.find(item => item.category === '異分野アイデア' && !selected.includes(item) && !selected.some(s => s.sourceLabel === item.sourceLabel))
      || rows.find(item => item.category === '異分野アイデア' && !selected.includes(item));
    if (idea) selected.push(idea);

    for (const row of rows) {
      if (selected.length >= 2) break;
      if (selected.includes(row)) continue;
      if (selected.some(s => s.sourceLabel === row.sourceLabel) && rows.some(candidate => !selected.includes(candidate) && !selected.some(s => s.sourceLabel === candidate.sourceLabel))) continue;
      selected.push(row);
    }
    for (const row of rows) {
      if (selected.length >= 2) break;
      if (!selected.includes(row)) selected.push(row);
    }
    result.push(...selected.slice(0, 2));
  }

  return result.slice(0, 10);
}

function fillToTen(selected = [], pool = []) {
  const out = dedupe(selected);
  const used = new Set(out.map(item => `${item.sourceType}|${item.url.replace(/[?#].*$/, '').toLowerCase()}|${item.title.toLowerCase()}`));
  const counts = new Map(REQUIRED_SOURCE_TYPES.map(type => [type, out.filter(item => item.sourceType === type).length]));
  const candidates = ranked(pool);

  for (const cap of [3, 4, Number.POSITIVE_INFINITY]) {
    for (const item of candidates) {
      if (out.length >= 10) break;
      const key = `${item.sourceType}|${item.url.replace(/[?#].*$/, '').toLowerCase()}|${item.title.toLowerCase()}`;
      if (used.has(key)) continue;
      const current = counts.get(item.sourceType) || 0;
      if (current >= cap) continue;
      out.push(item);
      used.add(key);
      counts.set(item.sourceType, current + 1);
    }
    if (out.length >= 10) break;
  }

  return out.slice(0, 10);
}

function missingTypes(items = []) {
  return REQUIRED_SOURCE_TYPES.filter(type => items.filter(item => item.sourceType === type).length < 2);
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
  if (type === '専門Webメディア') return /kaden\.watch\.impress\.co\.jp|itmedia\.co\.jp|gizmodo\.jp/i.test(url);
  if (type === 'クラウドファンディング') return /makuake\.com|camp-fire\.jp|kickstarter\.com/i.test(url);
  return /research-er\.jp|scienceportal\.jst\.go\.jp|eurekalert\.org/i.test(url);
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

function catalogText(types) {
  return TECHNOLOGY_SOURCE_CATALOG
    .filter(group => types.includes(group.sourceType))
    .map(group => `${group.sourceType}: ${group.media.map(media => media.name).join(' / ')}`)
    .join('\n');
}

function candidateText(candidates, types) {
  return candidates
    .filter(item => types.includes(item.sourceType))
    .slice(0, 45)
    .map((item, i) => `${i + 1}. [${item.sourceType}/${item.sourceLabel}] ${normalizeDate(item.pubDate).toISOString().slice(0, 10)} | ${item.title} | ${item.url} | ${clean(item.summary, 220)}`)
    .join('\n');
}

function buildPrompt({ types, directCandidates, excludeUrls = [], rotation }) {
  return `あなたは家電・熱技術の技術スカウト担当です。Google Searchを使い、指定媒体だけから最新情報を補完してください。\n\n対象分類（各分類2件になるまで候補を返す）:\n${types.join('\n')}\n\n利用可能な媒体:\n${catalogText(types)}\n\nコア対象企業例:\n${TARGET_BRANDS.join('、')}\n\n探索重点:\n${rotation}\n\nすでにRSS/API等で直接取得できている候補:\n${candidateText(directCandidates, types) || 'なし'}\n\nルール:\n- 直近90日を最優先。不足時のみ直近12か月まで広げる。\n- 各分類で最低3候補を返す。可能なら「コア技術・競合」と「異分野アイデア」を混ぜる。\n- 上記15媒体以外は使わない。\n- URLは必ず元ページの具体URL。Google検索結果URLや推測URLは禁止。\n- 広告だけ、ランキングだけ、単なる価格情報は除外。\n- 概要は媒体上の事実。応用着眼点は炊飯・真空断熱・加熱/温度制御・保温/保冷・省エネ・清掃性・安全性・UXへの転用案。\n${excludeUrls.length ? `- 次URLは重複禁止: ${excludeUrls.join(' , ')}\n` : ''}\nJSON以外を出力しない:\n{\"items\":[{\"sourceType\":\"特許情報|プレスリリース|専門Webメディア|クラウドファンディング|研究機関PR\",\"organization\":\"企業/組織\",\"title\":\"正式タイトル\",\"category\":\"コア技術・競合|異分野アイデア\",\"summary\":\"概要\",\"application\":\"応用着眼点\",\"sourceLabel\":\"媒体名\",\"publishedAt\":\"YYYY-MM-DD\",\"url\":\"https://元ページ\"}]}`;
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
    sourceName: `技術リサーチ｜${item.sourceType}｜${item.sourceLabel}`,
    image: item.image,
    description: [
      '技術リサーチ: Web調査済み',
      `対象企業/組織名: ${item.organization}`,
      `カテゴリ: ${item.category}`,
      `概要: ${item.summary}`,
      `応用着眼点: ${item.application}`,
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
  const rotation = ROTATION_FOCUS[slot % ROTATION_FOCUS.length];

  let pool = [...directItems];
  let selected = selectTen(pool);
  let missing = missingTypes(selected);
  let geminiQuotaBlocked = false;

  if (missing.length) {
    try {
      const first = await callGemini(buildPrompt({ types: missing, directCandidates: directItems, rotation }));
      pool = dedupe([...pool, ...normalizeGeminiItems(first.parsed, first.raw)]);
      selected = selectTen(pool);
      missing = missingTypes(selected);
    } catch (error) {
      geminiQuotaBlocked = isQuotaError(error);
      console.warn('[technology-research] first web supplement failed', error?.message || error);
    }
  }

  if (missing.length && !geminiQuotaBlocked) {
    try {
      const second = await callGemini(buildPrompt({
        types: missing,
        directCandidates: directItems,
        excludeUrls: selected.map(item => item.url),
        rotation
      }));
      pool = dedupe([...pool, ...normalizeGeminiItems(second.parsed, second.raw)]);
      selected = selectTen(pool);
      missing = missingTypes(selected);
    } catch (error) {
      geminiQuotaBlocked = isQuotaError(error);
      console.warn('[technology-research] second web supplement failed', error?.message || error);
    }
  }

  // GeminiがQuota超過でも、直接取得できた関連候補を捨てない。
  // 5分類×2件を優先しつつ、欠ける分類がある場合は他分類の直接候補で最大10件まで埋める。
  selected = fillToTen(selectTen(pool), pool);

  if (!selected.length) throw new Error('15媒体から技術リサーチ候補を取得できませんでした');

  const directMedia = new Set(directItems.map(item => item.sourceLabel)).size;
  const typeCounts = Object.fromEntries(REQUIRED_SOURCE_TYPES.map(type => [type, selected.filter(item => item.sourceType === type).length]));
  const xml = rssXml(
    '技術リサーチ',
    `指定15媒体をRSS/API/サイト直接取得し、不足だけ媒体限定Web検索で補完。今回 ${selected.length}/10件。`,
    toRssItems(selected)
  );
  const meta = {
    directCandidateCount: directItems.length,
    directMediaCount: directMedia,
    sourceErrors: collected.errors?.length || 0,
    typeCounts,
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
