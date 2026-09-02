import assert from 'node:assert/strict';
import {
  parseGoogleNews,
  parseGoogleTrends,
  filterBlockedSources,
  filterRecentGoogleNews,
  preliminaryScore,
  finalizeSelection,
  requiresLegacyFallback
} from '../server/recommendations.mjs';

const newsXml = `<?xml version="1.0"?><rss><channel>
<item><title>大規模地震で避難指示 - NHK</title><link>https://news.google.com/a</link><pubDate>Thu, 03 Sep 2026 00:00:00 GMT</pubDate><source>NHK</source><description>各地で強い揺れ。津波への警戒が呼びかけられている。</description></item>
<item><title>大規模地震で避難指示 - 読売新聞</title><link>https://news.google.com/c</link><pubDate>Thu, 03 Sep 2026 00:00:30 GMT</pubDate><source>読売新聞</source><description>各地で強い揺れ。津波への警戒が呼びかけられている。</description></item>
<item><title>人気俳優が新ドラマ出演 - Example</title><link>https://news.google.com/b</link><pubDate>Thu, 03 Sep 2026 00:01:00 GMT</pubDate><source>Example</source><description>芸能ニュース。</description></item>
</channel></rss>`;
const trendsXml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trends/trendingsearches/daily"><channel>
<item><title>地震</title><ht:approx_traffic>100K+</ht:approx_traffic></item>
</channel></rss>`;

const parsedNews = parseGoogleNews(newsXml);
const news = filterBlockedSources(parsedNews);
const trends = parseGoogleTrends(trendsXml);
assert.equal(parsedNews.length, 3);
assert.equal(parsedNews[0].source, 'NHK');
assert.equal(news.length, 2);
assert.ok(news.every(item => item.source !== 'NHK'));
assert.equal(news[0].title, '大規模地震で避難指示');
assert.equal(news[0].googleRank, 2);
assert.equal(trends[0].title, '地震');
const ranked = preliminaryScore(news, trends).map((row, index) => ({
  ...row,
  gdeltIndependentSources: index === 0 ? 4 : 0,
  gdeltScore: index === 0 ? 16 : 0,
  score: row.preliminaryScore + (index === 0 ? 16 : 0)
}));
assert.equal(ranked[0].importanceCategory, '災害');
assert.ok(ranked[0].score > ranked[1].score);
assert.equal(finalizeSelection(ranked)[0].title, '大規模地震で避難指示');

// NHK表記の揺れも配信元フィルタで除外する。
const blockedVariants = [
  { source: 'NHK' },
  { source: 'NHK NEWS' },
  { source: 'NHKニュース' },
  { source: '日本放送協会' },
  { source: 'NHK NEWS WEB' },
  { source: '読売新聞' }
];
assert.deepEqual(filterBlockedSources(blockedVariants).map(item => item.source), ['読売新聞']);

// Google NewsのRSSに返ってきた記事は20件で切らず、12時間以内の記事をすべて評価対象にする。
const bulkItems = Array.from({ length: 25 }, (_, index) => (
  `<item><title>ニュース${index + 1} - Source${index + 1}</title>` +
  `<link>https://news.google.com/item-${index + 1}</link>` +
  `<pubDate>Thu, 03 Sep 2026 00:${String(index).padStart(2, '0')}:00 GMT</pubDate>` +
  `<source>Source${index + 1}</source><description>最新ニュース</description></item>`
)).join('');
const bulk = parseGoogleNews(`<?xml version="1.0"?><rss><channel>${bulkItems}</channel></rss>`);
assert.equal(bulk.length, 25);
const referenceNow = new Date('2026-09-03T06:00:00Z').getTime();
assert.equal(filterRecentGoogleNews(filterBlockedSources(bulk), { now: referenceNow }).length, 25);

// 最終表示件数にも上限を設けず、softニュースも減点だけで除外しない。
const manyRanked = Array.from({ length: 18 }, (_, index) => ({
  id: `r-${index}`, title: `記事${index}`, link: `https://example.com/${index}`,
  description: index >= 12 ? 'スポーツ 試合' : '社会ニュース',
  source: 'Example', feedName: 'Google News', pubDate: 'Thu, 03 Sep 2026 00:00:00 GMT',
  publishedTimestamp: referenceNow - index * 60_000, googleRank: index + 1,
  soft: index >= 12, score: 100 - index
}));
assert.equal(finalizeSelection(manyRanked).length, 18);

// Trends/GDELT are enrichment signals: their failure alone must not invoke the legacy all-RSS path.
assert.equal(requiresLegacyFallback({ googleNewsCount: 20, selectedCount: 20 }), false);
assert.equal(requiresLegacyFallback({ googleNewsCount: 1, selectedCount: 1 }), false);
assert.equal(requiresLegacyFallback({ googleNewsCount: 0, selectedCount: 0 }), true);
assert.equal(requiresLegacyFallback({ googleNewsCount: 4, selectedCount: 4 }), false);
console.log('recommendation selector checks passed');
