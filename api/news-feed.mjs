import { mergeRssSources, rssXml } from '../lib/rss-merge.mjs';

const google = query =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;

/*
 * v2.13.1
 * 「無料で読める報道記事」を優先するため、会員制比率の高い媒体を標準ソースから外す。
 * Google News検索も媒体を絞り、個人ブログ・キュレーション・コラムを混ぜにくくする。
 *
 * RSSだけでは記事本文の完全な無料判定は100%不可能なので、
 * 1) 標準ソースの許可リスト
 * 2) タイトル/descriptionの会員・コラム語除外
 * 3) 明確な有料系ホストの除外
 * の3段階で軽量に絞る。
 */
const CATEGORIES = {
  national: {
    title: '全国ニュース',
    sources: [
      { name: 'Googleニュース 報道', url: google('(社会 OR 事件 OR 災害 OR 司法 OR 行政) (site:reuters.com OR site:bbc.com OR site:itmedia.co.jp OR site:watch.impress.co.jp) -コラム -社説 -オピニオン') }
    ]
  },
  politics: {
    title: '日本政治ニュース',
    sources: [
      { name: 'Googleニュース 政治報道', url: google('(国会 OR 政府 OR 首相 OR 内閣 OR 政党 OR 選挙) (site:reuters.com OR site:bbc.com) -コラム -社説 -オピニオン') }
    ]
  },
  'domestic-business': {
    title: '国内企業ニュース',
    sources: [
      { name: 'ITmedia 企業・業界', url: 'https://rss.itmedia.co.jp/rss/2.0/news_industry.xml' },
      { name: 'Impress Watch', url: 'https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf' },
      { name: 'Googleニュース 国内企業報道', url: google('(企業 OR 決算 OR 工場 OR 生産 OR 経営 OR 投資) (site:reuters.com OR site:itmedia.co.jp OR site:watch.impress.co.jp) -コラム -レビュー') }
    ]
  },
  'global-business': {
    title: '海外企業ニュース',
    sources: [
      { name: 'ITmedia 海外', url: 'https://rss.itmedia.co.jp/rss/2.0/news_foreign.xml' },
      { name: 'Googleニュース 海外企業報道', url: google('(Apple OR Google OR Microsoft OR Amazon OR Tesla OR Samsung OR NVIDIA OR TSMC) (site:reuters.com OR site:bbc.com OR site:itmedia.co.jp) -コラム -レビュー') }
    ]
  },
  world: {
    title: '海外ニュース',
    sources: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Googleニュース 国際報道', url: google('(国際 OR アメリカ OR 中国 OR 欧州 OR 中東 OR ウクライナ OR 台湾) (site:reuters.com OR site:bbc.com) -コラム -社説 -オピニオン') }
    ]
  },
  it: {
    title: 'IT系',
    sources: [
      { name: 'ITmedia NEWS', url: 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml' },
      { name: 'ITmedia 科学・テクノロジー', url: 'https://rss.itmedia.co.jp/rss/2.0/news_technology.xml' },
      { name: 'Impress Watch', url: 'https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf' },
      { name: 'PC Watch', url: 'https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf' }
    ]
  },
  appliances: {
    title: '家電',
    sources: [
      { name: '家電 Watch', url: 'https://kaden.watch.impress.co.jp/data/rss/1.0/kdw/feed.rdf' },
      { name: 'ITmedia 製品動向', url: 'https://rss.itmedia.co.jp/rss/2.0/news_products.xml' },
      { name: 'Googleニュース 家電報道', url: google('(家電 OR 炊飯器 OR 電気ケトル OR 電気ポット OR 真空断熱ボトル) (site:itmedia.co.jp OR site:watch.impress.co.jp) -レビュー -ランキング -PR') }
    ]
  },
  kagawa: {
    title: '香川のニュース',
    sources: [
      { name: 'Googleニュース 香川報道', url: google('(香川県 OR 高松市 OR 丸亀市) (site:reuters.com OR site:bbc.com OR site:news.ksb.co.jp OR site:ohk.co.jp) -コラム -PR') }
    ]
  },
  kyoto: {
    title: '京都のニュース',
    sources: [
      { name: 'Googleニュース 京都報道', url: google('(京都府 OR 京都市) (site:reuters.com OR site:bbc.com OR site:ktv.jp OR site:mbs.jp OR site:ytv.co.jp) -コラム -PR') }
    ]
  }
};

const cache = new Map();
const TTL = 5 * 60 * 1000;

const EDITORIAL_RE = /(?:^|[\s【\[(（])(?:コラム|オピニオン|論説|社説|寄稿|エッセイ|評論|識者談|座談会|インタビュー|レビュー|ランキング|まとめ|特集コラム|PR|広告|Sponsored)(?:$|[\s】\])）:：])/i;
const PAYWALL_RE = /会員限定|有料記事|有料会員|会員登録|購読者限定|続きを読むには|subscription|subscriber(?:s)? only|members? only|premium article/i;
const PERSONAL_RE = /個人ブログ|note\.com|アメブロ|はてなブログ|medium\.com|substack\.com/i;

const BLOCKED_HOSTS = new Set([
  'nikkei.com', 'www.nikkei.com', 'asia.nikkei.com',
  'toyokeizai.net', 'www.toyokeizai.net'
]);

function hostnameOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function isBlockedHost(hostname) {
  if (!hostname) return false;
  if (BLOCKED_HOSTS.has(hostname)) return true;
  return [...BLOCKED_HOSTS].some(host => hostname.endsWith(`.${host}`));
}

function isStraightFreeNews(item) {
  const title = String(item?.title || '');
  const description = String(item?.description || '');
  const source = String(item?.source || item?.sourceName || '');
  const link = String(item?.link || item?.url || '');
  const hay = `${title}\n${description}\n${source}\n${link}`;

  if (EDITORIAL_RE.test(hay)) return false;
  if (PAYWALL_RE.test(hay)) return false;
  if (PERSONAL_RE.test(hay)) return false;
  if (isBlockedHost(hostnameOf(link))) return false;
  return Boolean(title.trim() && link.trim());
}

export default async function handler(req, res) {
  const key = String(req.query?.category || '').trim();
  const config = CATEGORIES[key];
  if (!config) return res.status(404).send('Unknown news category');

  try {
    const forceRefresh = Boolean(req.query?._fresh || req.query?.refresh);
    const cached = cache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.at < TTL) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('X-Feed-Source-Errors', String(cached.errors.length));
      res.setHeader('X-News-Filtered-Count', String(cached.filteredCount || 0));
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).send(cached.xml);
    }

    const { items, errors } = await mergeRssSources(config.sources, { limit: 120 });
    const filtered = items.filter(isStraightFreeNews).slice(0, 100);
    if (!filtered.length) throw new Error(errors.join(' / ') || '条件に合う無料ニュースを取得できませんでした');

    const filteredCount = Math.max(0, items.length - filtered.length);
    const xml = rssXml(
      config.title,
      `${config.title}。報道機関の記事を中心に、コラム・個人記事・会員限定表記のある記事を除外`,
      filtered
    );
    cache.set(key, { at: Date.now(), xml, errors, filteredCount });

    if (errors.length) console.warn(`[news-feed:${key}] partial failures`, errors);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('X-Feed-Source-Errors', String(errors.length));
    res.setHeader('X-News-Filtered-Count', String(filteredCount));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).send(xml);
  } catch (err) {
    console.error(`[news-feed:${key}]`, err);
    return res.status(502).send(`RSS merge failed: ${err?.message || 'unknown'}`);
  }
}
