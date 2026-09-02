import assert from 'node:assert/strict';
import { parseGoogleNews, parseGoogleTrends, preliminaryScore, finalizeSelection, requiresLegacyFallback } from '../server/recommendations.mjs';

const newsXml = `<?xml version="1.0"?><rss><channel>
<item><title>大規模地震で避難指示 - NHK</title><link>https://news.google.com/a</link><pubDate>Thu, 03 Sep 2026 00:00:00 GMT</pubDate><source>NHK</source><description>各地で強い揺れ。津波への警戒が呼びかけられている。</description></item>
<item><title>人気俳優が新ドラマ出演 - Example</title><link>https://news.google.com/b</link><pubDate>Thu, 03 Sep 2026 00:01:00 GMT</pubDate><source>Example</source><description>芸能ニュース。</description></item>
</channel></rss>`;
const trendsXml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trends/trendingsearches/daily"><channel>
<item><title>地震</title><ht:approx_traffic>100K+</ht:approx_traffic></item>
</channel></rss>`;

const news = parseGoogleNews(newsXml);
const trends = parseGoogleTrends(trendsXml);
assert.equal(news.length, 2);
assert.equal(news[0].title, '大規模地震で避難指示');
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

// Trends/GDELT are enrichment signals: their failure alone must not invoke the legacy all-RSS path.
assert.equal(requiresLegacyFallback({ googleNewsCount: 20, selectedCount: 10 }), false);
assert.equal(requiresLegacyFallback({ googleNewsCount: 20, selectedCount: 1 }), false);
assert.equal(requiresLegacyFallback({ googleNewsCount: 0, selectedCount: 0 }), true);
assert.equal(requiresLegacyFallback({ googleNewsCount: 4, selectedCount: 4 }), true);
console.log('recommendation selector checks passed');
