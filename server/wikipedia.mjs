import { JSDOM } from 'jsdom';

const API = 'https://ja.wikipedia.org/w/api.php';
const USER_AGENT = 'PersonalDashboardWikipedia/2.13';

const POOLS = {
  classic: [
  [
    "八甲田雪中行軍遭難事件",
    "極限状況の判断と組織の失敗が重なる長編記録"
  ],
  [
    "三毛別羆事件",
    "日本史上最大級の熊害を克明に追う定番記事"
  ],
  [
    "地方病 (日本住血吸虫症)",
    "原因究明から撲滅まで100年以上の記録"
  ],
  [
    "ディアトロフ峠事件",
    "不可解な遭難をめぐる有名な未解決事件"
  ],
  [
    "フランクリン遠征",
    "北極圏で消えた探検隊を追う長編記事"
  ],
  [
    "メアリー・セレスト",
    "無人で発見された船をめぐる謎"
  ],
  [
    "ツングースカ大爆発",
    "シベリアで起きた巨大爆発の記録"
  ],
  [
    "ボイニッチ手稿",
    "今も解読されない奇妙な写本"
  ],
  [
    "ロアノーク植民地",
    "住民が消えた植民地の謎"
  ],
  [
    "コティングリー妖精事件",
    "妖精写真をめぐる有名な騒動"
  ],
  [
    "ジョン・タイター",
    "ネット時代を代表する未来人伝説"
  ],
  [
    "電車男",
    "掲示板文化から社会現象になった物語"
  ],
  [
    "きさらぎ駅",
    "ネット発祥の都市伝説"
  ],
  [
    "SCP財団",
    "共同創作文化が巨大化したネット現象"
  ],
  [
    "鮫島事件",
    "掲示板文化が生んだ架空の事件"
  ],
  [
    "アメリア・イアハート",
    "失踪した女性飛行士をめぐる物語"
  ],
  [
    "タイタニック号沈没事故",
    "巨大客船沈没をめぐる詳細な記録"
  ],
  [
    "切り裂きジャック",
    "正体不明の連続殺人犯をめぐる定番記事"
  ],
  [
    "ゾディアック事件",
    "暗号と犯行声明で知られる未解決事件"
  ],
  [
    "D.B.クーパー事件",
    "旅客機から消えたハイジャック犯の謎"
  ],
  [
    "ヒンターカイフェック事件",
    "農場で起きた不可解な未解決殺人事件"
  ],
  [
    "三億円事件",
    "日本を代表する未解決事件の一つ"
  ],
  [
    "グリコ・森永事件",
    "企業脅迫と報道が交錯した昭和の事件"
  ],
  [
    "下山事件",
    "戦後史に残る不可解な鉄道事件"
  ],
  [
    "帝銀事件",
    "戦後の大量殺人事件と裁判を追う記事"
  ],
  [
    "アンティキティラ島の機械",
    "古代の精密機械が残した大きな謎"
  ],
  [
    "死海文書",
    "発見経緯から研究史まで読み応えのある資料"
  ],
  [
    "ネブラ・ディスク",
    "青銅器時代の天文表現を伝える遺物"
  ],
  [
    "ピルトダウン人",
    "科学史に残る大規模な捏造事件"
  ],
  [
    "ナスカの地上絵",
    "巨大地上絵の目的をめぐる有名な謎"
  ],
  [
    "トロイア",
    "神話と考古学が交差する古代都市"
  ],
  [
    "ポンペイ",
    "噴火に埋もれた都市の生活が残る遺跡"
  ],
  [
    "エルドラド",
    "黄金郷伝説が探検を動かした歴史"
  ],
  [
    "ファラオの呪い",
    "発掘と都市伝説が結びついた有名な話"
  ],
  [
    "バミューダトライアングル",
    "失踪伝説で知られる海域"
  ],
  [
    "宇宙戦争 (ラジオ)",
    "ラジオ放送とパニック伝説をめぐる有名項目"
  ]
],
  deep: [
  [
    "ジョーンズタウン",
    "集団心理とカルトの極端な事例"
  ],
  [
    "ミルグラム実験",
    "権威への服従を扱った有名な心理実験"
  ],
  [
    "スタンフォード監獄実験",
    "役割と権力をめぐり議論が続く実験"
  ],
  [
    "タスキギー梅毒実験",
    "研究倫理の転換点になった事件"
  ],
  [
    "セイラム魔女裁判",
    "恐怖と集団心理が暴走した歴史"
  ],
  [
    "カーゴ・カルト",
    "物質文化と信仰が交差した現象"
  ],
  [
    "ダンシングマニア",
    "人々が踊り続けた奇妙な集団現象"
  ],
  [
    "チューリップ・バブル",
    "投機熱の象徴として語られる出来事"
  ],
  [
    "共有地の悲劇",
    "個人合理性が全体を壊す有名な考え方"
  ],
  [
    "傍観者効果",
    "集団の中で援助が遅れる心理現象"
  ],
  [
    "ストックホルム症候群",
    "極端な状況下の心理をめぐる概念"
  ],
  [
    "エルサレム症候群",
    "特定の土地と妄想が結びつく稀な現象"
  ],
  [
    "南海泡沫事件",
    "熱狂と投機が社会を巻き込んだ金融史"
  ],
  [
    "禁酒法",
    "善意の制度が巨大な副作用を生んだ歴史"
  ],
  [
    "優生学",
    "科学・政策・倫理が危険に交差した歴史"
  ],
  [
    "パノプティコン",
    "監視と権力を考えるうえで有名な概念"
  ],
  [
    "囚人のジレンマ",
    "合理的な選択が全体最適を崩すゲーム理論"
  ],
  [
    "認知的不協和",
    "矛盾を抱えた人間の心理を説明する概念"
  ],
  [
    "正常性バイアス",
    "危険を過小評価する心理傾向"
  ],
  [
    "集団思考",
    "組織が誤った意思決定へ向かう仕組み"
  ],
  [
    "社会的手抜き",
    "集団になると努力が薄れる心理現象"
  ],
  [
    "ハロー効果",
    "一つの印象が評価全体を左右する現象"
  ],
  [
    "確証バイアス",
    "自分に都合のよい情報を集める心理傾向"
  ],
  [
    "ダニング＝クルーガー効果",
    "能力評価と自己認識のずれを扱う概念"
  ],
  [
    "悪の凡庸さ",
    "人間と組織の責任を考えさせる概念"
  ],
  [
    "魔女狩り",
    "恐怖・偏見・制度が暴走した歴史"
  ],
  [
    "赤狩り",
    "政治的不安が社会を覆った歴史"
  ],
  [
    "大粛清",
    "国家権力と恐怖政治を扱う重い読み物"
  ],
  [
    "人民寺院",
    "共同体が破局へ向かった過程を追う"
  ],
  [
    "ヘヴンズ・ゲート",
    "終末思想と集団心理を考える事例"
  ],
  [
    "オウム真理教",
    "宗教・組織・犯罪が交差した現代史"
  ],
  [
    "モラル・パニック",
    "社会的不安が増幅される仕組み"
  ],
  [
    "アッシュの同調実験",
    "周囲に合わせる人間心理を示す実験"
  ],
  [
    "シミュレーション仮説",
    "現実そのものを問い直す思考実験"
  ],
  [
    "フェルミのパラドックス",
    "宇宙文明が見えない理由を考える問い"
  ],
  [
    "世界終末時計",
    "人類規模のリスクを象徴化した指標"
  ]
],
  trivia: [
  [
    "エミュー戦争",
    "軍隊が鳥の群れに手を焼いた珍事件"
  ],
  [
    "風船おじさん",
    "風船で太平洋横断を試みた人物"
  ],
  [
    "ダーウィン賞",
    "信じがたい失敗談を集めた風刺的な賞"
  ],
  [
    "イグノーベル賞",
    "笑えて考えさせられる研究の宝庫"
  ],
  [
    "空飛ぶスパゲッティ・モンスター教",
    "風刺から生まれた奇妙な宗教運動"
  ],
  [
    "ミラクルフルーツ",
    "酸っぱい物を甘く感じさせる果実"
  ],
  [
    "水中ホッケー",
    "プールの底で行うホッケー競技"
  ],
  [
    "妻問婚",
    "通い婚という独特な婚姻形態"
  ],
  [
    "トースト・サンドイッチ",
    "パンでパンを挟む料理"
  ],
  [
    "シュレーディンガーの猫",
    "量子論を説明する有名な思考実験"
  ],
  [
    "バナナ共和国",
    "果物と政治が結びついた政治用語"
  ],
  [
    "コブラ効果",
    "報奨制度が逆効果を生む現象"
  ],
  [
    "ピーターの法則",
    "昇進すると無能になるという皮肉な法則"
  ],
  [
    "パーキンソンの法則",
    "仕事は締切まで膨張するという法則"
  ],
  [
    "モンティ・ホール問題",
    "直感が外れやすい確率問題"
  ],
  [
    "誕生日のパラドックス",
    "少人数でも誕生日が重なる意外な確率"
  ],
  [
    "クソリプ",
    "ネット文化から生まれた日本語表現"
  ],
  [
    "バター猫のパラドックス",
    "二つの俗説を組み合わせたジョーク"
  ],
  [
    "パウリ効果",
    "物理学者にまつわる有名な逸話"
  ],
  [
    "マーフィーの法則",
    "失敗にまつわる有名な経験則"
  ],
  [
    "無限の猿定理",
    "無限と確率を直感的に考える思考実験"
  ],
  [
    "ホフスタッターの法則",
    "作業時間予測を皮肉る自己言及的な法則"
  ],
  [
    "スティグラーの法則",
    "発見者の名前が本人ではないという法則"
  ],
  [
    "グレシャムの法則",
    "悪貨が良貨を駆逐するという有名な法則"
  ],
  [
    "クラークの三法則",
    "未来技術を語るときによく引用される法則"
  ],
  [
    "パレイドリア",
    "無関係な模様に顔などを見つける心理現象"
  ],
  [
    "アポフェニア",
    "偶然の中に意味や関連を見つける心理傾向"
  ],
  [
    "バナナ等価線量",
    "放射線量をバナナで例えるユニークな単位"
  ],
  [
    "スパゲッティ化",
    "ブラックホールで物体が引き伸ばされる現象"
  ],
  [
    "ゴルディロックスの原理",
    "ちょうどよい条件を表す考え方"
  ],
  [
    "ブーメラン効果",
    "説得が逆効果になる現象"
  ],
  [
    "プラシーボ効果",
    "思い込みが身体反応に影響する現象"
  ],
  [
    "ノセボ効果",
    "悪い予想が症状を強める現象"
  ],
  [
    "犬笛政治",
    "一見普通の表現に別の意味を込める政治用語"
  ],
  [
    "ウィキペディアにおける削除主義と包摂主義",
    "百科事典の編集方針をめぐる内輪的で面白い論争"
  ],
  [
    "ビッグマック指数",
    "ハンバーガーで為替水準を比べる指標"
  ]
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

async function onThisDayCandidates(month, day) {
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
    const headingBlock = start.closest('.mw-heading') || start;
    const isNextHeading = node => /^H[23]$/.test(node?.tagName || '') || Boolean(node?.matches?.('.mw-heading') && node.querySelector('h2,h3'));
    let cursor = headingBlock.nextElementSibling;

    while (cursor && !isNextHeading(cursor)) {
      const lis = cursor.matches?.('ul,ol') ? Array.from(cursor.querySelectorAll(':scope > li')) : [];
      for (const li of lis) {
        const eventText = cleanText(li.textContent);
        if (eventText.length < 10) continue;

        const anchors = Array.from(li.querySelectorAll('a[title]'));
        const target = anchors
          .map(a => ({ title: cleanText(a.getAttribute('title')), text: cleanText(a.textContent) }))
          .filter(row => goodEventTitle(row.title))
          .sort((a, b) => Number(b.text.length >= 2) - Number(a.text.length >= 2))
          .map(row => row.title)[0];

        if (!target) continue;
        const year = eventText.match(/(?:紀元前\s*)?\d{1,4}年/)?.[0] || '';
        rows.push({
          title: target,
          reason: `${year ? `${year}の出来事` : 'この日の出来事'} — ${eventText.replace(/^[-–—\s]+/, '').slice(0, 138)}`
        });
      }
      cursor = cursor.nextElementSibling;
    }

    const seen = new Set();
    return rows.filter(row => {
      const key = row.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    dom.window.close();
  }
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

async function buildCurated(kind, date) {
  const candidates = shuffled(POOLS[kind] || [], `${date}:${kind}`);
  const wanted = candidates.slice(0, 30);
  const { resolveTitle, pages } = await fetchCards(wanted.map(row => row[0]));
  const rows = [];
  const used = new Set();

  for (const [requestedTitle, reason] of wanted) {
    if (rows.length >= 10) break;
    const page = pages.get(resolveTitle(requestedTitle));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    rows.push(pageRow(page, { date, kind, reason, index: rows.length }));
  }
  return rows;
}

async function buildToday(date, month, day) {
  let candidates = [];
  try {
    candidates = await onThisDayCandidates(month, day);
  } catch (error) {
    console.warn('[wikipedia-v213] on-this-day:', error?.message || error);
    return [];
  }

  const wanted = candidates.slice(0, 30);
  const { resolveTitle, pages } = await fetchCards(wanted.map(row => row.title));
  const rows = [];
  const used = new Set();

  for (const item of wanted) {
    if (rows.length >= 10) break;
    const page = pages.get(resolveTitle(item.title));
    if (!page || used.has(page.title)) continue;
    used.add(page.title);
    rows.push(pageRow(page, { date, kind: 'today', reason: item.reason, index: rows.length }));
  }
  return rows;
}

async function daily() {
  const { date, month, day } = jstParts();
  const [today, classic, deep, trivia] = await Promise.all([
    buildToday(date, month, day),
    buildCurated('classic', date),
    buildCurated('deep', date),
    buildCurated('trivia', date)
  ]);

  return {
    date,
    dateLabel: `${month}月${day}日`,
    counts: { today: today.length, classic: classic.length, deep: deep.length, trivia: trivia.length },
    poolSize: { classic: POOLS.classic.length, deep: POOLS.deep.length, trivia: POOLS.trivia.length },
    items: [...today, ...classic, ...deep, ...trivia]
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
    let skip = false;
    for (const node of doc.querySelectorAll('h2,h3,p,li')) {
      if (/^H[23]$/.test(node.tagName)) {
        const heading = cleanText(node.textContent).replace(/\[編集\]$/, '').trim();
        skip = SKIP_HEADINGS.test(heading);
        if (!skip && heading) {
          blocks.push({ type: 'heading', text: heading });
          totalChars += heading.length;
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
    return {
      title: cleanText(data.parse?.displaytitle || title).replace(/<[^>]+>/g, ''),
      blocks,
      text: blocks.map(block => block.text).join('\n\n'),
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
    console.error('[wikipedia-v213]', error);
    return res.status(500).json({ error: String(error?.message || error) });
  }
}
