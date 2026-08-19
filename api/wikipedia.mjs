import { JSDOM } from 'jsdom';

const API = 'https://ja.wikipedia.org/w/api.php';
const USER_AGENT = 'PersonalDashboardWikipedia/2.12';

const POOLS = {
  classic: [
    ['八甲田雪中行軍遭難事件','極限状況を追う定番の長編記事'],
    ['三毛別羆事件','日本史上最大級の熊害を追う定番記事'],
    ['地方病 (日本住血吸虫症)','原因究明から撲滅まで100年以上の記録'],
    ['ディアトロフ峠事件','今も議論される不可解な遭難事件'],
    ['フランクリン遠征','北極圏で消えた大規模探検隊'],
    ['ジョン・タイター','ネット時代の有名な未来人伝説'],
    ['電車男','ネット文化が社会現象になった代表例'],
    ['きさらぎ駅','ネット発祥の都市伝説'],
    ['SCP Foundation','共同創作文化が巨大化したネット現象'],
    ['鮫島事件','掲示板文化が生んだ架空の事件'],
    ['コティングリー妖精事件','妖精写真をめぐる有名な騒動'],
    ['ロアノーク植民地','住民が消えた植民地の謎'],
    ['ツングースカ大爆発','20世紀初頭の巨大爆発事件'],
    ['ボイニッチ手稿','解読されない奇妙な写本'],
    ['メアリー・セレスト','無人で発見された船の謎']
  ],
  deep: [
    ['ジョーンズタウン','集団心理とカルトの最悪例をたどる'],
    ['ミルグラム実験','権威への服従を扱った有名な心理実験'],
    ['スタンフォード監獄実験','役割と権力をめぐり議論が続く実験'],
    ['タスキギー梅毒実験','研究倫理の転換点になった事件'],
    ['セイラム魔女裁判','恐怖と集団心理が暴走した歴史'],
    ['カーゴ・カルト','物質文化と信仰が交差した現象'],
    ['ダンシングマニア','人々が踊り続けた奇妙な集団現象'],
    ['チューリップ・バブル','投機熱の象徴として語られる出来事'],
    ['共有地の悲劇','個人合理性が全体を壊す有名な考え方'],
    ['傍観者効果','集団の中で助けが遅れる心理現象'],
    ['ストックホルム症候群','極端な状況下の心理をめぐる概念'],
    ['エルサレム症候群','特定の土地と妄想が結びつく稀な現象'],
    ['南海泡沫事件','熱狂と投機が社会を巻き込んだ金融史'],
    ['禁酒法','善意の制度が巨大な副作用を生んだ歴史'],
    ['優生学','科学・政策・倫理が危険に交差した歴史']
  ],
  trivia: [
    ['エミュー戦争','軍隊が鳥の群れに手を焼いた珍事件'],
    ['風船おじさん','風船で太平洋横断を試みた人物'],
    ['ダーウィン賞','信じがたい失敗談を集めた風刺的な賞'],
    ['イグノーベル賞','笑えて考えさせられる研究の宝庫'],
    ['空飛ぶスパゲッティ・モンスター教','風刺から生まれた奇妙な宗教運動'],
    ['ミラクルフルーツ','酸っぱい物を甘く感じさせる果実'],
    ['水中ホッケー','プールの底で行うホッケー競技'],
    ['妻問婚','通い婚という独特な婚姻形態'],
    ['トースト・サンドイッチ','パンでパンを挟む料理'],
    ['シュレーディンガーの猫','量子論を説明する有名すぎる思考実験'],
    ['バナナ共和国','果物と政治が結びついた政治用語'],
    ['コブラ効果','報奨制度が逆効果を生む現象'],
    ['ピーターの法則','昇進すると無能になるという皮肉な法則'],
    ['パーキンソンの法則','仕事は締切まで膨張するという法則'],
    ['モンティ・ホール問題','直感が外れやすい確率問題'],
    ['誕生日のパラドックス','少人数でも誕生日が重なる意外な確率'],
    ['クソリプ','ネット文化から生まれた日本語表現']
  ]
};

const META = {
  today: { label: '今日の出来事', short: '今日' },
  classic: { label: '王道・文学系', short: '王道' },
  deep: { label: '考察・読み物系', short: '考察' },
  trivia: { label: '雑学・トリビア系', short: '雑学' }
};

function jstParts() {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const iso = date.toISOString();
  return {
    date: iso.slice(0, 10),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10))
  };
}

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffled(pool, seedText) {
  const random = rng(hash(seedText));
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function pick(pool, count, seedText) { return shuffled(pool, seedText).slice(0, count); }

async function api(params, timeout = 14000) {
  const url = new URL(API);
  Object.entries({ format: 'json', formatversion: '2', ...params }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`Wikipedia API HTTP ${response.status}`);
  return response.json();
}

function titleMap(query = {}) {
  const map = new Map();
  (query.normalized || []).forEach(row => map.set(row.from, row.to));
  (query.redirects || []).forEach(row => map.set(row.from, row.to));
  return title => {
    let current = title;
    for (let i = 0; i < 5 && map.has(current); i += 1) current = map.get(current);
    return current;
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\[[0-9０-９]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function goodEventTitle(title) {
  const value = cleanText(title);
  if (!value || value.includes(':') || value.includes('#')) return false;
  if (/^(?:紀元前)?\d{1,4}年$/.test(value)) return false;
  if (/^\d{1,2}月\d{1,2}日$/.test(value)) return false;
  if (/^(グレゴリオ暦|ユリウス暦|旧暦|西暦|紀元前)$/.test(value)) return false;
  return true;
}

async function onThisDayCandidates(month, day, dateSeed) {
  const pageName = `${month}月${day}日`;
  const data = await api({ action: 'parse', page: pageName, prop: 'text', redirects: '1' }, 16000);
  const html = data.parse?.text || '';
  if (!html) return [];
  const dom = new JSDOM(`<main>${html}</main>`);
  try {
    const doc = dom.window.document;
    const headings = Array.from(doc.querySelectorAll('h2,h3'));
    const start = headings.find(node => /^(できごと|出来事)$/.test(cleanText(node.textContent).replace(/\[編集\]$/, '')));
    if (!start) return [];

    const rows = [];
    // 現行MediaWiki HTMLでは h2/h3 が .mw-heading ラッパー内に入る場合がある。
    // ラッパーの次から走査しないと編集リンクだけを見て終了してしまうため両構造に対応する。
    const headingBlock = start.closest('.mw-heading') || start;
    const isNextHeading = node => /^H[23]$/.test(node?.tagName || '') || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
    let cursor = headingBlock.nextElementSibling;
    while (cursor && !isNextHeading(cursor)) {
      const lis = cursor.matches?.('ul,ol') ? Array.from(cursor.querySelectorAll(':scope > li')) : [];
      for (const li of lis) {
        const eventText = cleanText(li.textContent);
        if (eventText.length < 12) continue;
        const anchors = Array.from(li.querySelectorAll('a[title]'));
        const target = anchors.map(a => cleanText(a.getAttribute('title'))).find(goodEventTitle);
        if (!target) continue;
        const year = eventText.match(/(?:紀元前\s*)?\d{1,4}年/)?.[0] || '';
        rows.push({
          title: target,
          reason: `${year ? `${year}の今日` : 'この日の出来事'} — ${eventText.replace(/^[-–—\s]+/, '').slice(0, 120)}`
        });
      }
      cursor = cursor.nextElementSibling;
    }

    const seen = new Set();
    return shuffled(rows, `${dateSeed}:events`).filter(row => {
      const key = row.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    dom.window.close();
  }
}

function makeCuratedCandidates(date) {
  const primary = [
    ...pick(POOLS.classic, 3, `${date}:classic` ).map(row => ({ kind: 'classic', row })),
    ...pick(POOLS.deep, 2, `${date}:deep`).map(row => ({ kind: 'deep', row })),
    ...pick(POOLS.trivia, 2, `${date}:trivia`).map(row => ({ kind: 'trivia', row }))
  ];
  const backup = [
    ...shuffled(POOLS.classic, `${date}:classic-backup`).map(row => ({ kind: 'classic', row })),
    ...shuffled(POOLS.deep, `${date}:deep-backup`).map(row => ({ kind: 'deep', row })),
    ...shuffled(POOLS.trivia, `${date}:trivia-backup`).map(row => ({ kind: 'trivia', row }))
  ];
  const seen = new Set(primary.map(item => item.row[0]));
  return [...primary, ...backup.filter(item => !seen.has(item.row[0]))];
}

async function fetchCards(titles) {
  if (!titles.length) return { resolveTitle: title => title, pages: new Map() };
  const data = await api({
    action: 'query',
    prop: 'extracts|pageimages|info',
    titles: titles.slice(0, 50).join('|'),
    redirects: '1',
    exintro: '1',
    explaintext: '1',
    exchars: '420',
    piprop: 'thumbnail',
    pithumbsize: '720',
    inprop: 'url'
  });
  const resolveTitle = titleMap(data.query || {});
  const pages = new Map((data.query?.pages || []).filter(page => !page.missing).map(page => [page.title, page]));
  return { resolveTitle, pages };
}

function pageRow(page, { date, kind, reason, index }) {
  return {
    id: `${date}:${kind}:${page.pageid || index}`,
    date,
    kind,
    category: META[kind].label,
    categoryShort: META[kind].short,
    title: page.title,
    reason,
    extract: String(page.extract || '').trim(),
    thumbnail: page.thumbnail?.source || '',
    url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`
  };
}

async function daily() {
  const { date, month, day } = jstParts();
  let eventCandidates = [];
  try { eventCandidates = await onThisDayCandidates(month, day, date); }
  catch (error) { console.warn('[wikipedia-v212] on-this-day fallback:', error?.message || error); }

  const eventWanted = eventCandidates.slice(0, 8);
  const curated = makeCuratedCandidates(date);
  const candidateTitles = [...new Set([
    ...eventWanted.map(item => item.title),
    ...curated.slice(0, 25).map(item => item.row[0])
  ])];
  const { resolveTitle, pages } = await fetchCards(candidateTitles);

  const items = [];
  const usedTitles = new Set();
  for (const event of eventWanted) {
    if (items.filter(item => item.kind === 'today').length >= 3) break;
    const page = pages.get(resolveTitle(event.title));
    if (!page || usedTitles.has(page.title)) continue;
    usedTitles.add(page.title);
    items.push(pageRow(page, { date, kind: 'today', reason: event.reason, index: items.length }));
  }

  for (const item of curated) {
    if (items.length >= 10) break;
    const [requestedTitle, reason] = item.row;
    const page = pages.get(resolveTitle(requestedTitle));
    if (!page || usedTitles.has(page.title)) continue;
    usedTitles.add(page.title);
    items.push(pageRow(page, { date, kind: item.kind, reason, index: items.length }));
  }

  return {
    date,
    dateLabel: `${month}月${day}日`,
    eventCount: items.filter(item => item.kind === 'today').length,
    items: items.slice(0, 10)
  };
}

const SKIP_HEADINGS = /^(脚注|注釈|出典|参考文献|参考資料|関連項目|外部リンク|参考|文献|ギャラリー|一覧)$/;
async function article(title) {
  const data = await api({ action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1' }, 18000);
  const html = data.parse?.text || '';
  if (!html) throw new Error('Wikipedia本文を取得できませんでした');
  const dom = new JSDOM(`<main>${html}</main>`);
  try {
    const doc = dom.window.document;
    doc.querySelectorAll('script,style,table,figure,.thumb,.mw-editsection,.navbox,.infobox,.sidebar,.metadata,.hatnote,sup.reference,.reflist').forEach(node => node.remove());
    const blocks = [];
    let totalChars = 0;
    let currentHeading = '本文';
    let skip = false;
    for (const node of doc.querySelectorAll('h2,h3,p,li')) {
      if (/^H[23]$/.test(node.tagName)) {
        currentHeading = cleanText(node.textContent).replace(/\[編集\]$/, '').trim();
        skip = SKIP_HEADINGS.test(currentHeading);
        if (!skip && currentHeading) {
          blocks.push({ type: 'heading', text: currentHeading });
          totalChars += currentHeading.length;
        }
        continue;
      }
      if (skip) continue;
      const value = cleanText(node.textContent);
      if (value.length < 18) continue;
      blocks.push({ type: node.tagName === 'LI' ? 'list' : 'paragraph', text: value });
      totalChars += value.length;
      if (totalChars > 65000) break;
    }
    const plain = blocks.map(block => block.text).join('\n\n');
    return {
      title: cleanText(data.parse?.displaytitle || title).replace(/<[^>]+>/g, ''),
      blocks,
      text: plain,
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`
    };
  } finally { dom.window.close(); }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const mode = String(req.query?.mode || 'daily');
  try {
    if (mode === 'article') {
      const title = String(req.query?.title || '').trim();
      if (!title || title.length > 180) return res.status(400).json({ error: '記事名が不正です' });
      const result = await article(title);
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
      return res.status(200).json(result);
    }
    const result = await daily();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=21600');
    return res.status(200).json(result);
  } catch (error) {
    console.error('[wikipedia-v212]', error);
    return res.status(500).json({ error: String(error?.message || error) });
  }
}
