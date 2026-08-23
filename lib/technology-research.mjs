import { rssXml } from './rss-merge.mjs';
import { collectTechnologySourceCandidates, TECHNOLOGY_SOURCE_CATALOG } from './technology-source-collectors.mjs';

const CACHE_TTL = 30 * 60 * 1000;
const REQUIRED_SOURCE_TYPES = ['特許情報', 'プレスリリース', '専門Webメディア', 'クラウドファンディング', '研究機関PR'];
const ALLOWED_CATEGORIES = new Set(['コア技術・競合', '異分野アイデア']);
const memoryCache = { at: 0, xml: '', items: [], meta: null };

const CORE_TOPICS = [
  '米・炊飯技術',
  '真空断熱構造',
  '沸騰・加熱・温度制御技術',
  '保温・保冷技術'
];

const TARGET_BRANDS = [
  'タイガー魔法瓶', '象印マホービン', 'パナソニック', 'サーモス', 'アイリスオーヤマ',
  'バルミューダ', 'バーミキュラ（愛知ドビー）', 'シロカ', '山善',
  'Fellow Products', 'Instant Brands', 'Breville', "De'Longhi", 'Hydro Flask',
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

function canonicalSourceType(value = '') {
  const text = clean(value, 120).toLowerCase().replace(/[\s・｜|:_-]+/g, '');
  if (!text) return '';
  if (/特許|patent|jplatpat|espacenet|wipo|uspto/.test(text)) return '特許情報';
  if (/プレス|pressrelease|press|prtimes|businesswire|newswire|ニュースリリース/.test(text)) return 'プレスリリース';
  if (/クラウドファン|クラファン|crowdfund|kickstarter|indiegogo|makuake|campfire/.test(text)) return 'クラウドファンディング';
  if (/研究機関|大学|公的研究|scienceportal|researcher|researchpr|学術広報|eurekalert/.test(text)) return '研究機関PR';
  if (/専門.*メディア|webメディア|ウェブメディア|media|家電watch|monoist|xtech|gizmodo|wired|techcrunch/.test(text)) return '専門Webメディア';
  return REQUIRED_SOURCE_TYPES.find(type => type.toLowerCase().replace(/\s+/g, '') === text) || '';
}

function canonicalCategory(value = '', raw = {}) {
  const text = clean(value, 100);
  if (ALLOWED_CATEGORIES.has(text)) return text;
  const haystack = `${text} ${clean(raw?.title, 220)} ${clean(raw?.summary || raw?.overview, 500)} ${clean(raw?.application || raw?.insight, 500)}`;
  if (/異分野|アイデア|着想|応用ネタ|転用|cross.?domain|innovation|新構造|新素材|ユニーク/i.test(haystack)) return '異分野アイデア';
  if (/コア|競合|炊飯|米|真空|断熱|沸騰|加熱|温度制御|保温|保冷|rice.?cook|vacuum|thermal|kettle/i.test(haystack)) return 'コア技術・競合';
  return '異分野アイデア';
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
  const match = String(value || '').match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return new Date();
  const date = new Date(`${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : new Date();
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
  const chunks = raw?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks.map(chunk => normalizeUrl(chunk?.web?.uri || '')).filter(Boolean);
}

function domainHint(sourceType) {
  if (sourceType === '特許情報') return /patents\.google\.|j-platpat\.inpit\.go\.jp|espacenet|epo\.org|wipo\.int|uspto\.gov/i;
  if (sourceType === 'プレスリリース') return /prtimes\.jp|businesswire\.com|prnewswire\.com/i;
  if (sourceType === '専門Webメディア') return /kaden\.watch\.impress\.co\.jp|itmedia\.co\.jp|gizmodo\.jp/i;
  if (sourceType === 'クラウドファンディング') return /makuake\.com|camp-fire\.jp|kickstarter\.com/i;
  return /research-er\.jp|scienceportal\.jst\.go\.jp|eurekalert\.org/i;
}

function fallbackGroundingUrl(sourceType, urls, used) {
  const matcher = domainHint(sourceType);
  return urls.find(url => !used.has(url) && matcher.test(url)) || urls.find(url => !used.has(url)) || '';
}

function normalizeItems(rawItems, rawResponse = {}) {
  const grounded = groundingUrls(rawResponse);
  const usedGrounding = new Set();
  const seen = new Set();
  const grouped = new Map(REQUIRED_SOURCE_TYPES.map(type => [type, []]));

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const sourceType = canonicalSourceType(raw?.sourceType || raw?.source || raw?.type || raw?.mediaType || '');
    if (!grouped.has(sourceType)) continue;
    const category = canonicalCategory(raw?.category, raw);
    const title = clean(raw?.title || raw?.project || raw?.product, 220);
    const organization = clean(raw?.organization || raw?.company || raw?.brand || raw?.institution || raw?.author, 160);
    const summary = clean(raw?.summary || raw?.overview || raw?.description, 700);
    const application = clean(raw?.application || raw?.applicationPoint || raw?.insight || raw?.idea, 700);
    const sourceLabel = clean(raw?.sourceLabel || raw?.media || raw?.publication || sourceType, 120);
    const acquisition = clean(raw?.acquisition || raw?.method || '', 160);
    let url = normalizeUrl(raw?.url || raw?.sourceUrl || raw?.link || raw?.sourceURL);
    if (!url) {
      url = fallbackGroundingUrl(sourceType, grounded, usedGrounding);
      if (url) usedGrounding.add(url);
    }
    if (!title || !organization || !summary || !application || !url || !sourceLabel) continue;
    const key = `${url.replace(/[?#].*$/, '')}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped.get(sourceType).push({
      sourceType,
      category,
      title,
      organization,
      summary,
      application,
      sourceLabel,
      acquisition,
      url,
      pubDate: normalizeDate(raw?.publishedAt || raw?.date || raw?.pubDate),
      image: normalizeUrl(raw?.image || raw?.imageUrl || '')
    });
  }

  const result = [];
  for (const sourceType of REQUIRED_SOURCE_TYPES) {
    const rows = grouped.get(sourceType) || [];
    const core = rows.find(row => row.category === 'コア技術・競合');
    const creative = rows.find(row => row.category === '異分野アイデア' && (!core || row.sourceLabel !== core.sourceLabel))
      || rows.find(row => row.category === '異分野アイデア' && row !== core);
    if (core) result.push(core);
    if (creative) result.push(creative);

    for (const row of rows) {
      if (result.includes(row)) continue;
      const selected = result.filter(item => item.sourceType === sourceType);
      if (selected.length >= 2) break;
      if (selected.some(item => item.sourceLabel === row.sourceLabel) && rows.some(candidate => !selected.some(item => item.sourceLabel === candidate.sourceLabel))) continue;
      result.push(row);
    }
    for (const row of rows) {
      if (result.includes(row)) continue;
      if (result.filter(item => item.sourceType === sourceType).length >= 2) break;
      result.push(row);
    }
  }
  return result.filter(item => REQUIRED_SOURCE_TYPES.includes(item.sourceType)).slice(0, 10);
}

function mergeItems(...groups) {
  const raw = groups.flat().map(item => ({
    ...item,
    publishedAt: item?.pubDate instanceof Date ? item.pubDate.toISOString() : item?.publishedAt,
    url: item?.url
  }));
  return normalizeItems(raw, {});
}

function applicationIdea(item) {
  const hay = `${item?.title || ''} ${item?.summary || ''}`;
  if (/断熱|vacuum|insulation|aerogel|熱橋|輻射|radiation/i.test(hay)) return '断熱層の薄型化、熱橋低減、放射熱抑制の観点で、魔法瓶や炊飯器の保温構造へ転用できるか検討したい。';
  if (/温度|sensor|control|制御|algorithm|推定|AI|heating|加熱/i.test(hay)) return '温度推定や加熱制御の考え方を、炊飯工程の状態推定、沸騰検知、保温時の省エネ制御へ応用できる可能性がある。';
  if (/相変化|phase\s*change|蓄熱|thermal\s*storage|cooling|冷却/i.test(hay)) return '蓄熱・放熱の時間特性を利用し、保温の電力ピーク低減や温度ムラ抑制、携帯容器の保冷・保温性能向上へ応用できそう。';
  if (/表面|coating|撥水|濡れ|clean|洗浄|汚れ|porous|多孔/i.test(hay)) return '表面機能を内釜・ふた・蒸気経路へ応用し、付着抑制、洗浄性、耐久性を両立できるかが着眼点になる。';
  if (/grip|ergonomic|haptic|触覚|UI|interface|安全|safety/i.test(hay)) return '操作・把持・安全設計の発想を、ケトルやボトルの注ぎやすさ、誤操作防止、アクセシビリティ向上へ展開できる。';
  return 'この技術の価値を「構造・材料・制御・使い勝手」に分解し、炊飯・断熱・加熱・保温のどこへ置き換えられるかを検討する着想ネタになる。';
}

function directFallbackItems(candidates = []) {
  return candidates.map(item => ({
    ...item,
    category: canonicalCategory('', item),
    application: applicationIdea(item),
    publishedAt: item.pubDate instanceof Date ? item.pubDate.toISOString() : item.pubDate,
    acquisition: item.acquisition || '媒体直接取得'
  }));
}

function candidateBlock(candidates = []) {
  return candidates.slice(0, 55).map((item, index) => {
    const date = normalizeDate(item.pubDate).toISOString().slice(0, 10);
    return `${index + 1}. [${item.sourceType} / ${item.sourceLabel}] ${date} | ${clean(item.title, 160)} | ${normalizeUrl(item.url)} | ${clean(item.summary, 260)}`;
  }).join('\n');
}

function catalogBlock() {
  return TECHNOLOGY_SOURCE_CATALOG.map(group =>
    `- ${group.sourceType}: ${group.media.map(media => media.name).join(' / ')}`
  ).join('\n');
}

function buildPrompt({ today, rotation, directCandidates = [], missingTypes = [], missingMedia = [], excludeUrls = [] }) {
  const targets = missingTypes.length ? missingTypes : REQUIRED_SOURCE_TYPES;
  const missingText = missingMedia.length
    ? missingMedia.map(row => `${row.sourceType}: ${row.sourceLabel}`).join(' / ')
    : 'なし';
  return `あなたは家電・熱技術の技術スカウト担当です。Google Searchを使えますが、まず下記のRSS/API/サイト直接取得候補を最優先に採用してください。候補だけで不足する媒体・分類のみWeb検索で補完してください。\n\n日付: ${today}\n探索重点: ${rotation}\n\n対象の5分類と監視媒体（これ以外の媒体は採用禁止）:\n${catalogBlock()}\n\n今回の直接取得候補:\n${candidateBlock(directCandidates) || '直接取得候補なし'}\n\n直接取得できずWeb検索補完が必要な媒体:\n${missingText}\n\n目的:\n- 炊飯器・魔法瓶・ケトル・電気ポット等に関係する最新技術動向、競合の取り組みを集める。\n- 一見無関係でも製品開発の着想になる異分野イノベーションを集める。\n\nコア分野:\n${CORE_TOPICS.map(v => `- ${v}`).join('\n')}\n\n対象企業・ブランド例:\n${TARGET_BRANDS.join('、')}\n\n選定ルール:\n1. 対象分類は ${targets.join(' / ')}。各分類2件、合計10件を目標にする。\n2. 各分類の2件は可能な限り別媒体から選び、1件は「コア技術・競合」、もう1件は「異分野アイデア」にする。\n3. RSS/API直接取得候補に十分新しく関連性の高い記事がある場合、そのURLを優先する。URLやタイトルを書き換えない。\n4. Web検索補完は上記15媒体のサイト内だけ。Google検索結果URLではなく元ページURLを使う。URLを推測・捏造しない。\n5. 直近90日を最優先。不足時のみ12か月まで広げる。\n6. 広告だけ、ランキングだけ、単なる価格情報、同一内容の重複は除外。\n7. 概要は元媒体に書かれた事実を80〜180文字程度。応用着眼点は事実と分け、炊飯・真空断熱・加熱/温度制御・保温/保冷・清掃性・安全性・省エネ・UXへの転用を具体化する。\n${excludeUrls.length ? `8. 次のURLは再選定しない: ${excludeUrls.join(' , ')}` : ''}\n\nJSON以外は出力しない。形式:\n{\n  "items": [\n    {\n      "sourceType": "特許情報|プレスリリース|専門Webメディア|クラウドファンディング|研究機関PR",\n      "organization": "対象企業/組織名",\n      "title": "記事・特許・プロジェクトの正式タイトル",\n      "category": "コア技術・競合|異分野アイデア",\n      "summary": "元媒体に基づく概要",\n      "application": "家電・熱技術への応用着眼点",\n      "sourceLabel": "上記15媒体のいずれかの正式名称",\n      "publishedAt": "YYYY-MM-DD",\n      "url": "https://元ページURL"\n    }\n  ]\n}\n`;
}

async function callGemini(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');
  const model = String(process.env.GEMINI_RESEARCH_MODEL || 'gemini-3.5-flash-lite').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: 'minimal' } }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Gemini research ${response.status}`);
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .filter(part => part?.thought !== true)
      .map(part => part?.text || '')
      .join('')
      .trim();
    if (!text) throw new Error('Gemini research response empty');
    return { parsed: looseJson(text), raw: data, model };
  } finally {
    clearTimeout(timer);
  }
}

function attachAcquisition(items, directCandidates) {
  const directByUrl = new Map(directCandidates.map(item => [normalizeUrl(item.url).replace(/[?#].*$/, ''), item]));
  return items.map(item => {
    const direct = directByUrl.get(normalizeUrl(item.url).replace(/[?#].*$/, ''));
    return {
      ...item,
      acquisition: direct?.acquisition || item.acquisition || 'Google Searchによる媒体限定補完',
      image: item.image || direct?.image || ''
    };
  });
}

function toRssItems(items) {
  return items.map(item => ({
    title: item.title,
    link: item.url,
    pubDate: item.pubDate,
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
      `取得方式: ${item.acquisition || '媒体限定Web検索'}`
    ].join(' ｜ ')
  }));
}

async function research({ refresh = false } = {}) {
  if (!refresh && memoryCache.xml && Date.now() - memoryCache.at < CACHE_TTL) return memoryCache;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const slot = Math.floor(now.getTime() / (4 * 60 * 60 * 1000));
  const rotation = ROTATION_FOCUS[slot % ROTATION_FOCUS.length];
  const collected = await collectTechnologySourceCandidates();
  const directCandidates = collected.candidates || [];

  let items = [];
  try {
    const first = await callGemini(buildPrompt({
      today,
      rotation,
      directCandidates,
      missingMedia: collected.missingMedia
    }));
    items = attachAcquisition(normalizeItems(first.parsed?.items, first.raw), directCandidates);

    const missingTypes = REQUIRED_SOURCE_TYPES.filter(type => items.filter(item => item.sourceType === type).length < 2);
    if (missingTypes.length) {
      try {
        const second = await callGemini(buildPrompt({
          today,
          rotation,
          directCandidates,
          missingTypes,
          missingMedia: collected.missingMedia.filter(row => missingTypes.includes(row.sourceType)),
          excludeUrls: items.map(item => item.url).slice(0, 12)
        }));
        items = attachAcquisition(mergeItems(items, normalizeItems(second.parsed?.items, second.raw)), directCandidates);
      } catch (error) {
        console.warn('[technology-research] supplement failed', error?.message || error);
      }
    }
  } catch (error) {
    console.warn('[technology-research] grounded curation failed; using direct candidates', error?.message || error);
    items = attachAcquisition(normalizeItems(directFallbackItems(directCandidates), {}), directCandidates);
  }

  if (!items.length) throw new Error('15媒体から技術リサーチ候補を取得できませんでした');

  const directMedia = new Set(directCandidates.map(item => item.sourceLabel)).size;
  const xml = rssXml(
    '技術リサーチ',
    `指定15媒体をRSS/API/サイト直接取得し、不足媒体だけWeb検索補完。5分類×各2件を目標（今回 ${items.length}/10件、直接取得媒体 ${directMedia}/15）`,
    toRssItems(items)
  );
  const meta = {
    directCandidateCount: directCandidates.length,
    directMediaCount: directMedia,
    missingMediaCount: collected.missingMedia?.length || 0,
    sourceErrors: collected.errors?.length || 0
  };
  memoryCache.at = Date.now();
  memoryCache.xml = xml;
  memoryCache.items = items;
  memoryCache.meta = meta;
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
