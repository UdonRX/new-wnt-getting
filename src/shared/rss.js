import { relativeTime } from './time.js';
import { articleDateDebug, readerTable, readerTrace } from './reader-debug.js';

const KNOWN_RSS_SOURCE = [
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/monoist\.xml(?:\?|$)/i, 'monoist'],
  [/^https?:\/\/rss\.itmedia\.co\.jp\/rss\/2\.0\/eetimes\.xml(?:\?|$)/i, 'eetimes'],
  [/^https?:\/\/(?:www\.)?gigazine\.net\/news\/rss_2\.0\/(?:\?|$)/i, 'gigazine']
];

function text(parent, selectors) {
  for (const selector of selectors) {
    const node = parent.querySelector(selector);
    const value = node?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function safeHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function imageUrlsFromHtml(value = '') {
  const source = String(value || '').trim();
  if (!source || !/<img\b/i.test(source)) return [];
  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const urls = [];
    for (const image of doc.querySelectorAll('img')) {
      const candidates = [image.getAttribute('src'), image.getAttribute('data-src'), image.getAttribute('data-original'), image.getAttribute('data-lazy-src')];
      const srcset = image.getAttribute('srcset') || image.getAttribute('data-srcset') || '';
      if (srcset) {
        const largest = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).pop();
        if (largest) candidates.unshift(largest);
      }
      for (const candidate of candidates) {
        const url = safeHttpUrl(candidate);
        if (url) { urls.push(url); break; }
      }
    }
    return [...new Set(urls)];
  } catch { return []; }
}

function looksLikeVideoUrl(value = '') {
  const url = safeHttpUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/\.(?:mp4|m3u8|webm|mov)$/i.test(path)) return true;
    return host === 'video.twimg.com' && /\/(?:vid|pl|tweet_video)\//i.test(path);
  } catch { return false; }
}

function videoUrlsFromHtml(value = '') {
  const source = String(value || '').trim();
  if (!source || !/(?:<video\b|<source\b|video\.twimg\.com)/i.test(source)) return { urls: [], posters: [] };
  try {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const urls = [];
    const posters = [];
    const pushVideo = value => { const url=safeHttpUrl(value); if(url&&looksLikeVideoUrl(url)) urls.push(url); };
    const pushPoster = value => { const url=safeHttpUrl(value); if(url) posters.push(url); };
    for (const video of doc.querySelectorAll('video')) {
      pushVideo(video.getAttribute('src'));
      pushPoster(video.getAttribute('poster'));
      for (const sourceNode of video.querySelectorAll('source[src]')) pushVideo(sourceNode.getAttribute('src'));
    }
    for (const sourceNode of doc.querySelectorAll('source[src]')) {
      const type=String(sourceNode.getAttribute('type')||'').toLowerCase();
      if(type.startsWith('video/')||/mpegurl|m3u8/.test(type)||looksLikeVideoUrl(sourceNode.getAttribute('src'))) pushVideo(sourceNode.getAttribute('src'));
    }
    for (const anchor of doc.querySelectorAll('a[href]')) if(looksLikeVideoUrl(anchor.getAttribute('href'))) pushVideo(anchor.getAttribute('href'));
    return { urls:[...new Set(urls)].slice(0,12), posters:[...new Set(posters)].slice(0,12) };
  } catch { return { urls:[], posters:[] }; }
}

function rawDescriptionOf(item) {
  for (const selector of ['content\\:encoded', 'content', 'description', 'summary']) {
    const node=item.querySelector(selector);
    const value=node?.textContent?.trim()||'';
    if(value) return value;
  }
  return '';
}

function mediaImagesOf(item, rawDescription='') {
  const urls=[];
  const push=value=>{ const url=safeHttpUrl(value); if(url) urls.push(url); };
  for(const node of item.getElementsByTagName('*')) {
    const name=String(node.nodeName||'').toLowerCase();
    const local=String(node.localName||'').toLowerCase();
    const url=node.getAttribute?.('url')||'';
    const type=String(node.getAttribute?.('type')||'').toLowerCase();
    const medium=String(node.getAttribute?.('medium')||'').toLowerCase();
    const isVideo=medium==='video'||type.startsWith('video/')||/mpegurl|m3u8/.test(type)||looksLikeVideoUrl(url);
    if(name==='media:thumbnail'||local==='thumbnail') { push(url); continue; }
    if(name==='media:content'||local==='content') {
      if(!isVideo&&(!medium||medium==='image'||type.startsWith('image/'))) push(url);
      continue;
    }
    if(local==='enclosure'&&url&&!isVideo&&(!type||type.startsWith('image/'))) push(url);
  }
  push(text(item,['image > url','image']));
  imageUrlsFromHtml(rawDescription).forEach(push);
  return [...new Set(urls)].slice(0,12);
}

function mediaVideosOf(item, rawDescription='') {
  const urls=[]; const posters=[];
  const pushVideo=value=>{const url=safeHttpUrl(value);if(url&&looksLikeVideoUrl(url)) urls.push(url);};
  const pushPoster=value=>{const url=safeHttpUrl(value);if(url) posters.push(url);};
  for(const node of item.getElementsByTagName('*')) {
    const name=String(node.nodeName||'').toLowerCase();
    const local=String(node.localName||'').toLowerCase();
    const url=node.getAttribute?.('url')||node.getAttribute?.('href')||'';
    const type=String(node.getAttribute?.('type')||'').toLowerCase();
    const medium=String(node.getAttribute?.('medium')||'').toLowerCase();
    if((name==='media:content'||local==='content'||local==='enclosure')&&(medium==='video'||type.startsWith('video/')||/mpegurl|m3u8/.test(type)||looksLikeVideoUrl(url))) pushVideo(url);
    if(name==='media:thumbnail'||local==='thumbnail') pushPoster(node.getAttribute?.('url')||'');
    if(local==='video'){pushVideo(node.getAttribute?.('src')||url);pushPoster(node.getAttribute?.('poster')||'');}
  }
  const fromHtml=videoUrlsFromHtml(rawDescription);
  fromHtml.urls.forEach(pushVideo); fromHtml.posters.forEach(pushPoster);
  return {urls:[...new Set(urls)].slice(0,12),posters:[...new Set(posters)].slice(0,12)};
}

function plainText(value='') {
  const source=String(value||'');
  if(!source) return '';
  try { const doc=new DOMParser().parseFromString(source,'text/html'); return (doc.body?.textContent||source).replace(/\s+/g,' ').trim(); }
  catch { return source.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
}

export function parseFeed(xmlText, feedName='') {
  const doc=new DOMParser().parseFromString(xmlText,'text/xml');
  if(doc.querySelector('parsererror')) throw new Error('XMLパースエラー');
  const nodes=[...doc.querySelectorAll('item, entry')];
  const items=nodes.map((item,index)=>{
    const title=text(item,['title'])||'無題';
    const guid=text(item,['guid','id']);
    let link=text(item,['link']);
    if(!link){
      const alternate=[...item.querySelectorAll('link[href]')].find(node=>{const rel=String(node.getAttribute('rel')||'').toLowerCase();return !rel||rel==='alternate';});
      link=alternate?.getAttribute('href')||guid||'';
    }
    const dateRaw=text(item,['pubDate','published','updated','dc\\:date','date']);
    const parsedDate=new Date(dateRaw);
    const publishedTimestamp=parsedDate.getTime();
    const dateValid=Number.isFinite(publishedTimestamp) && publishedTimestamp > 0;
    const pubDate=dateValid ? parsedDate : new Date(0);
    const rawDescription=rawDescriptionOf(item);
    const description=plainText(rawDescription)||title;
    const source=text(item,['source','category'])||feedName;
    const author=text(item,['dc\\:creator','creator','author name','author'])||source;
    const images=mediaImagesOf(item,rawDescription);
    const videoMedia=mediaVideosOf(item,rawDescription);
    return {
      id:`${link||guid||title}-${dateRaw||index}`,
      guid,
      title,link,description,rawDescription,source,author,feedName,
      image:images[0]||'',images,video:videoMedia.urls[0]||'',videos:videoMedia.urls,videoPosters:videoMedia.posters,
      pubDate,
      originalDate:dateRaw,
      normalizedDate:dateValid ? parsedDate.toISOString() : '',
      publishedTimestamp:dateValid ? publishedTimestamp : 0,
      dateValid,
      relative:dateValid ? relativeTime(pubDate) : '日付不明'
    };
  });
  readerTrace('rss-parsed', { feed: feedName || 'RSS', count: items.length });
  readerTable(`rss-dates:${feedName || 'RSS'}`, items.map(articleDateDebug));
  return items;
}

function targetForFeed(url='') {
  if(url.startsWith('/')) return url;
  const known=KNOWN_RSS_SOURCE.find(([pattern])=>pattern.test(url));
  if(known) return `/api/rss?source=${encodeURIComponent(known[1])}`;
  return `/api/rss?url=${encodeURIComponent(url)}`;
}

function forceFreshTarget(target, force) {
  if (!force) return target;
  try {
    const url = new URL(target, location.origin);
    url.searchParams.set('_fresh', String(Date.now()));
    return `${url.pathname}${url.search}`;
  } catch { return target; }
}

export async function fetchFeed(feed, { force = false, timeoutMs = 35_000 } = {}) {
  const url=String(feed.url||'');
  const target=forceFreshTarget(targetForFeed(url), force);
  const controller=new AbortController();
  const wait=Math.max(12_000,Math.min(50_000,Number(timeoutMs)||35_000));
  const timer=setTimeout(()=>controller.abort(),wait);
  const started=performance.now();
  readerTrace('rss-fetch-start', { feed: feed?.name || '', url, force });
  try {
    const response=await fetch(target,{cache:force?'no-store':'default',signal:controller.signal,headers:{Accept:'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=.2'}});
    if(!response.ok) {
      let detail='';
      try {
        const type=String(response.headers.get('content-type')||'');
        if(/json/i.test(type)) detail=String((await response.json())?.error||'');
        else detail=String(await response.text()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      } catch {}
      throw new Error(`RSS取得エラー (${response.status})${detail?`: ${detail.slice(0,120)}`:''}`);
    }
    const xml=await response.text();
    if(!/<(?:rss|feed|rdf:RDF)\b/i.test(xml.slice(0,1000))) throw new Error('RSSではない応答を受信しました');
    const items=parseFeed(xml,feed.name||'');
    readerTrace('rss-fetch-finish', { feed: feed?.name || '', count: items.length, elapsedMs: Math.round(performance.now()-started) });
    return items;
  } catch(error) {
    readerTrace('rss-fetch-error', { feed: feed?.name || '', error: String(error?.message || error), elapsedMs: Math.round(performance.now()-started) });
    if(error?.name==='AbortError') throw new Error(`RSS取得がタイムアウトしました (${Math.round(wait/1000)}秒)`);
    throw error;
  } finally { clearTimeout(timer); }
}

function normalizedDedupeKey(item={}) {
  const raw=String(item?.link||'').trim();
  if(raw){
    try{
      const url=new URL(raw,location.href);
      url.hash='';
      for(const key of [...url.searchParams.keys()]) if(/^utm_|^(?:fbclid|gclid|yclid)$/i.test(key)) url.searchParams.delete(key);
      return `url:${url.href.toLowerCase()}`;
    }catch{return `url:${raw.toLowerCase()}`;}
  }
  const title=String(item?.title||'').replace(/\s+/g,' ').trim().toLowerCase();
  const source=String(item?.feedName||item?.source||'').trim().toLowerCase();
  const stamp=Number(item?.publishedTimestamp)||new Date(item?.pubDate||0).getTime()||0;
  return `fallback:${source}|${title}|${stamp}`;
}

function articleTimestamp(item={}) {
  const explicit=Number(item?.publishedTimestamp);
  if(Number.isFinite(explicit)&&explicit>0) return explicit;
  const parsed=new Date(item?.pubDate||0).getTime();
  return Number.isFinite(parsed)&&parsed>0 ? parsed : 0;
}

export function dedupeSort(items,limit=250) {
  const input=Array.isArray(items)?items:[];
  const seen=new Set();
  const deduped=input.filter(item=>{
    const key=normalizedDedupeKey(item);
    if(seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b)=>articleTimestamp(b)-articleTimestamp(a));
  const output=Number(limit)>0 ? deduped.slice(0,Number(limit)) : deduped;
  readerTrace('dedupe-sort', { before: input.length, afterDedupe: deduped.length, output: output.length, limit: Number(limit)||0 });
  return output;
}
