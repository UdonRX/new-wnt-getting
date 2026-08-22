import { rssXml } from '../lib/rss-merge.mjs';

const CACHE_TTL = 90 * 60 * 1000;
const REQUIRED_SOURCE_TYPES = ['特許情報', 'プレスリリース', '専門Webメディア', 'クラウドファンディング', '研究機関PR'];
const ALLOWED_CATEGORIES = new Set(['コア技術・競合', '異分野アイデア']);
const memoryCache = { at: 0, xml: '', items: [] };

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
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    if (/google\.[^/]+\/search/i.test(url.href)) return '';
    return url.href;
  } catch { return ''; }
}

function normalizeDate(value = '') {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
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
  if (sourceType === '特許情報') return /patents\.google\.|j-platpat\.inpit\.go\.jp|espacenet|wipo\.int|uspto\.gov/i;
  if (sourceType === 'プレスリリース') return /prtimes\.jp|businesswire\.com|prnewswire\.com|newsroom|press|corporate|company/i;
  if (sourceType === '専門Webメディア') return /impress\.co\.jp|itmedia\.co\.jp|xtech\.nikkei\.com|gizmodo\.jp|wired\.|techcrunch\./i;
  if (sourceType === 'クラウドファンディング') return /makuake\.com|camp-fire\.jp|kickstarter\.com|indiegogo\.com/i;
  return /research-er\.jp|scienceportal\.jst\.go\.jp|\.ac\.jp|\.go\.jp|jst\.go\.jp|aist\.go\.jp|riken\.jp/i;
}

function fallbackGroundingUrl(sourceType, urls, used) {
  const matcher = domainHint(sourceType);
  return urls.find(url => !used.has(url) && matcher.test(url)) || urls.find(url => !used.has(url)) || '';
}

function normalizeItems(rawItems, rawResponse) {
  const grounded = groundingUrls(rawResponse);
  const usedGrounding = new Set();
  const seen = new Set();
  const grouped = new Map(REQUIRED_SOURCE_TYPES.map(type => [type, []]));

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const sourceType = clean(raw?.sourceType || raw?.source || '', 80);
    if (!grouped.has(sourceType)) continue;
    const category = ALLOWED_CATEGORIES.has(clean(raw?.category, 80)) ? clean(raw.category, 80) : '異分野アイデア';
    const title = clean(raw?.title, 220);
    const organization = clean(raw?.organization || raw?.company || raw?.brand, 160);
    const summary = clean(raw?.summary || raw?.overview, 700);
    const application = clean(raw?.application || raw?.applicationPoint || raw?.insight, 700);
    const sourceLabel = clean(raw?.sourceLabel || raw?.media || sourceType, 120);
    let url = normalizeUrl(raw?.url || raw?.sourceUrl || raw?.link);
    if (!url) {
      url = fallbackGroundingUrl(sourceType, grounded, usedGrounding);
      if (url) usedGrounding.add(url);
    }
    if (!title || !organization || !summary || !application || !url) continue;
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
      url,
      pubDate: normalizeDate(raw?.publishedAt || raw?.date || raw?.pubDate),
      image: normalizeUrl(raw?.image || '')
    });
  }

  const result = [];
  for (const sourceType of REQUIRED_SOURCE_TYPES) {
    const rows = grouped.get(sourceType) || [];
    const core = rows.find(row => row.category === 'コア技術・競合');
    const creative = rows.find(row => row.category === '異分野アイデア' && row !== core);
    if (core) result.push(core);
    if (creative) result.push(creative);
    for (const row of rows) {
      if (result.includes(row)) continue;
      const count = result.filter(item => item.sourceType === sourceType).length;
      if (count >= 2) break;
      result.push(row);
    }
  }
  return result.filter(item => REQUIRED_SOURCE_TYPES.includes(item.sourceType)).slice(0, 10);
}

function buildPrompt({ today, rotation, missingTypes = [], excludeUrls = [] }) {
  const targets = missingTypes.length ? missingTypes : REQUIRED_SOURCE_TYPES;
  return `あなたは家電・熱技術の技術スカウト担当です。Google Searchを必ず使い、${today}時点で公開確認できるWeb情報を調査してください。

目的:
- 炊飯器・魔法瓶・ケトル・電気ポット等に関係する最新技術動向、競合の取り組みを集める。
- 一見無関係でも製品開発の着想になる異分野イノベーションを集める。

コア分野:
${CORE_TOPICS.map(v => `- ${v}`).join('\n')}

対象企業・ブランド例:
${TARGET_BRANDS.join('、')}
例示以外の国内外メーカーも対象にしてよい。

今回の探索重点:
${rotation}

調査対象の情報源種別:
${targets.map(v => `- ${v}`).join('\n')}
- 特許情報: Google Patents、J-PlatPat、Espacenet、WIPO等の公開特許・公開出願の具体ページを優先。
- プレスリリース: PR TIMES、Business Wire、企業公式ニュースルーム等の新製品・技術開発・共同研究。
- 専門Webメディア: 家電Watch、MONOist、日経クロステック、Gizmodo等の具体記事。
- クラウドファンディング: Makuake、CAMPFIRE、Kickstarter、Indiegogo等の具体プロジェクト。
- 研究機関PR: 日本の研究.com、Science Portal、大学、公的研究機関の具体リリース。

選定ルール:
1. 各情報源種別ごとに2件。可能な限り1件は「コア技術・競合」、1件は「異分野アイデア」にする。
2. 直近90日を最優先。情報が不足する種別は直近12か月まで広げてよい。特許は公開日が新しいものを優先。
3. 同じ製品・同じURL・実質同じニュースの重複は禁止。
4. 広告だけ、ランキングだけ、単なる価格情報は除外。
5. URLはGoogle検索結果ではなく、必ず確認した元ページの具体URL。URLを推測・捏造しない。
6. 「応用着眼点」は、炊飯、真空断熱、加熱/温度制御、保温/保冷、清掃性、安全性、省エネ、UX等へどう転用できるかを具体的に1〜2文で書く。
7. 事実と応用アイデアを混同しない。「概要」は元ページの事実、「応用着眼点」は技術スカウトとしての示唆。
${excludeUrls.length ? `8. 次のURLは前回候補なので再選定しない: ${excludeUrls.join(' , ')}` : ''}

JSON以外は出力しない。形式:
{
  "items": [
    {
      "sourceType": "特許情報|プレスリリース|専門Webメディア|クラウドファンディング|研究機関PR",
      "organization": "対象企業/組織名",
      "title": "プロジェクト名・製品名・記事/特許タイトル",
      "category": "コア技術・競合|異分野アイデア",
      "summary": "技術やプロダクトの概要を日本語で簡潔に",
      "application": "革新点と家電・熱制御製品への応用着眼点",
      "sourceLabel": "媒体名",
      "publishedAt": "YYYY-MM-DD",
      "url": "https://具体的な元ページURL"
    }
  ]
}
${missingTypes.length ? `今回は不足補完なので、指定した種別だけを各3件程度候補として返してください。` : '合計10件を返してください。'}
`;
}

async function callGemini(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません');
  const model = String(
    process.env.GEMINI_RESEARCH_MODEL || process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite'
  ).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          maxOutputTokens: 5000,
          temperature: 0.35,
          thinkingConfig: { thinkingLevel: 'minimal' }
        }
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

function toRssItems(items) {
  return items.map(item => ({
    title: item.title,
    link: item.url,
    pubDate: item.pubDate,
    author: item.organization,
    sourceName: `${item.sourceType}｜${item.category}`,
    image: item.image,
    description: [
      '技術リサーチ: Web調査済み',
      `対象企業/組織名: ${item.organization}`,
      `カテゴリ: ${item.category}`,
      `概要: ${item.summary}`,
      `応用着眼点: ${item.application}`,
      `媒体: ${item.sourceLabel}`
    ].join(' ｜ ')
  }));
}

async function research({ refresh = false } = {}) {
  if (!refresh && memoryCache.xml && Date.now() - memoryCache.at < CACHE_TTL) return memoryCache;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const slot = Math.floor(now.getTime() / (4 * 60 * 60 * 1000));
  const rotation = ROTATION_FOCUS[slot % ROTATION_FOCUS.length];
  const first = await callGemini(buildPrompt({ today, rotation }));
  let items = normalizeItems(first.parsed?.items, first.raw);

  const missingTypes = REQUIRED_SOURCE_TYPES.filter(type => items.filter(item => item.sourceType === type).length < 2);
  if (missingTypes.length) {
    try {
      const second = await callGemini(buildPrompt({
        today,
        rotation,
        missingTypes,
        excludeUrls: items.map(item => item.url).slice(0, 12)
      }));
      const supplement = normalizeItems(second.parsed?.items, second.raw);
      items = normalizeItems([...items, ...supplement], { candidates: [{ groundingMetadata: { groundingChunks: [] } }] });
    } catch (error) {
      console.warn('[technology-research] supplement failed', error?.message || error);
    }
  }

  if (items.length !== 10) throw new Error(`技術リサーチの有効候補が不足しました (${items.length}/10)`);
  const xml = rssXml('技術リサーチ', '5情報源×各2件の最新技術・競合・異分野アイデア', toRssItems(items));
  memoryCache.at = Date.now();
  memoryCache.xml = xml;
  memoryCache.items = items;
  return memoryCache;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const refresh = String(req.query?.refresh || '') === '1';
  try {
    const result = await research({ refresh });
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', refresh ? 'no-store' : 'public, s-maxage=1800, stale-while-revalidate=21600');
    res.setHeader('X-Technology-Research-Count', String(result.items.length));
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
