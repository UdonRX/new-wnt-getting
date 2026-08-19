import { load, save } from '../shared/storage.js';

export const DEFAULTS = {
  weatherLocations: [{ name: '京都府', jmaCode: '260000', lat: 35.0116, lon: 135.7681 }],
  newsFeeds: [
    { name:'全国ニュース', url:'/api/news-feed?category=national' },
    { name:'日本政治ニュース', url:'/api/news-feed?category=politics' },
    { name:'国内企業ニュース', url:'/api/news-feed?category=domestic-business' },
    { name:'海外企業ニュース', url:'/api/news-feed?category=global-business' },
    { name:'海外ニュース', url:'/api/news-feed?category=world' },
    { name:'IT系', url:'/api/news-feed?category=it' },
    { name:'家電', url:'/api/news-feed?category=appliances' },
    { name:'香川のニュース', url:'/api/news-feed?category=kagawa' },
    { name:'京都のニュース', url:'/api/news-feed?category=kyoto' }
  ],
  knowledgeFeeds: [
    { name:'MONOist', url:'https://rss.itmedia.co.jp/rss/2.0/monoist.xml' },
    { name:'EE Times Japan', url:'https://rss.itmedia.co.jp/rss/2.0/eetimes.xml' },
    { name:'GIGAZINE', url:'https://gigazine.net/news/rss_2.0/' }
  ],
  paperFeeds: [{ name:'論文', url:'/api/papers-feed' }],
  youtubeChannels: [],
  twitchChannels: [],
  twitterFeeds: [{ name:'デフォルトリスト', id:'2087706843519111304' }],
  settings: {
    edgeEnabled: true,
    edgeWidth: 1.5,
    edgeOpacity: .38,
    edgeGlow: 4,
    rankWithAi: true,
    twitchCommentDensity: 'normal',
    colors: {
      home:'#64d2ff', weather:'#4da5ff', news:'#ff9f0a', knowledge:'#30d158', papers:'#8e73ff', reader:'#8e73ff',
      youtube:'#ff453a', twitch:'#9146ff', twitter:'#31a7ff', settings:'#8e8e93'
    },
    twitterRssBase:'https://rsshub-latest-wekl.onrender.com/twitter/list/'
  }
};

export const state = {
  screen: load('lastScreen', 'home'),
  mediaMode: load('lastMediaMode', 'youtube'),
  readerMode: load('lastReaderMode', 'news'),
  paperTrack: load('paperTrack', 'core'),
  creativePaperFamily: load('creativePaperFamily', 'all'),
  weatherLocations: load('weatherLocations', DEFAULTS.weatherLocations),
  newsFeeds: load('newsFeeds', DEFAULTS.newsFeeds),
  knowledgeFeeds: load('knowledgeFeeds', DEFAULTS.knowledgeFeeds),
  paperFeeds: load('paperFeeds', DEFAULTS.paperFeeds),
  youtubeChannels: load('youtubeChannels', DEFAULTS.youtubeChannels),
  twitchChannels: load('twitchChannels', DEFAULTS.twitchChannels),
  twitterFeeds: load('twitterFeeds', DEFAULTS.twitterFeeds),
  settings: (() => {
    const saved = load('settings', DEFAULTS.settings) || {};
    return { ...DEFAULTS.settings, ...saved, colors: { ...DEFAULTS.settings.colors, ...(saved.colors || {}) } };
  })()
};

export function update(key, value) {
  state[key] = value;
  save(key, value);

  if (key === 'lastReaderMode') state.readerMode = value;
  if (key === 'lastMediaMode') state.mediaMode = value;
  if (key === 'paperTrack') state.paperTrack = value === 'creative' ? 'creative' : 'core';
  if (key === 'creativePaperFamily') state.creativePaperFamily = ['all', 'applied', 'general'].includes(value) ? value : 'all';

  if (['lastReaderMode', 'lastMediaMode', 'paperTrack', 'creativePaperFamily'].includes(key)) {
    window.dispatchEvent(new CustomEvent('pdv2:context-changed', { detail: { key, value } }));
  }
}

export function patchSettings(partial) {
  update('settings', {
    ...state.settings,
    ...partial,
    colors: { ...state.settings.colors, ...(partial.colors || {}) }
  });
  window.dispatchEvent(new CustomEvent('pdv2:settings-changed'));
}
