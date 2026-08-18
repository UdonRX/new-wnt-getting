import { mergeRssSources, rssXml } from '../lib/rss-merge.mjs';

const google = (query) => `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;

const CATEGORIES = {
  national: {
    title: '全国ニュース',
    sources: [
      { name: 'Googleニュース全国', url: google('全国 OR 社会 OR 事件 OR 災害 -芸能') },
      { name: 'nippon.com', url: 'https://www.nippon.com/ja/feed/' }
    ]
  },
  politics: {
    title: '日本政治ニュース',
    sources: [
      { name: 'Googleニュース政治', url: google('国会 OR 政府 OR 首相 OR 内閣 OR 政党') },
      { name: '財経新聞 政治社会', url: 'https://www.zaikei.co.jp/rss/news/9.xml' }
    ]
  },
  'domestic-business': {
    title: '国内企業ニュース',
    sources: [
      // ユーザー指定: 日経RSSを必須ソースとして最優先で登録。
      { name: '日本経済新聞', url: 'https://www.nikkei.com/rss/top.rdf' },
      { name: 'ITmedia 企業・業界', url: 'https://rss.itmedia.co.jp/rss/2.0/news_industry.xml' },
      { name: '東洋経済オンライン', url: 'https://toyokeizai.net/list/feed/rss' },
      { name: 'Googleニュース 日経企業', url: google('site:nikkei.com (企業 OR 決算 OR 工場 OR 経営)') }
    ]
  },
  'global-business': {
    title: '海外企業ニュース',
    sources: [
      { name: 'ITmedia 海外', url: 'https://rss.itmedia.co.jp/rss/2.0/news_foreign.xml' },
      { name: 'Googleニュース海外企業', url: google('(Apple OR Google OR Microsoft OR Amazon OR Tesla OR Samsung OR NVIDIA) 企業') },
      { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar' }
    ]
  },
  world: {
    title: '海外ニュース',
    sources: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Googleニュース海外', url: google('国際 OR 海外 OR アメリカ OR 中国 OR 欧州 OR 中東') }
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
      { name: 'Googleニュース家電', url: google('家電 OR 炊飯器 OR 電気ケトル OR 電気ポット OR 真空断熱ボトル') }
    ]
  },
  kagawa: {
    title: '香川のニュース',
    sources: [
      { name: 'Googleニュース香川', url: google('香川県 OR 高松市 OR 丸亀市') }
    ]
  },
  kyoto: {
    title: '京都のニュース',
    sources: [
      { name: 'Googleニュース京都', url: google('京都府 OR 京都市') }
    ]
  }
};

const cache = new Map();
const TTL = 5 * 60 * 1000;

// v25: NHK ONE系のRSSは取得対象から除外する。
// 現在の統合フィード定義からNHKソース自体を削除しているが、
// 将来の編集で誤って戻っても取得しないよう二重で防御する。
function isExcludedNewsSource(source) {
  const name = String(source?.name || '').trim();
  const rawUrl = String(source?.url || '').trim();

  if (/^NHK(?:\s|$|主要|政治|国際|香川|京都)/i.test(name)) return true;

  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'news.web.nhk';
  } catch {
    return false;
  }
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
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).send(cached.xml);
    }

    const activeSources = config.sources.filter(source => !isExcludedNewsSource(source));
    const { items, errors } = await mergeRssSources(activeSources, { limit: 100 });
    if (!items.length) throw new Error(errors.join(' / ') || '全RSSの取得に失敗しました');

    const xml = rssXml(config.title, `${config.title}を複数RSSから時系列統合`, items);
    cache.set(key, { at: Date.now(), xml, errors });

    if (errors.length) console.warn(`[news-feed:${key}] partial failures`, errors);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('X-Feed-Source-Errors', String(errors.length));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).send(xml);
  } catch (err) {
    console.error(`[news-feed:${key}]`, err);
    return res.status(502).send(`RSS merge failed: ${err?.message || 'unknown'}`);
  }
}
