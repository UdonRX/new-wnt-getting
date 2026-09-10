import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { iconSvg } from '../../shared/icons.js';
import { applyWeatherShellTheme } from '../../app/router.js';

const WEATHER_TTL = 10 * 60 * 1000;
const REC_KEY = 'pdv2:recommendationSnapshot:v1';
const TWITCH_KEY = 'pdv2:twitchCache:v2195';
const YOUTUBE_KEY = 'pdv2:youtubeCache:kind4-lockup';
const DISCOVER_KEY = 'pdv2:homeDiscover:v1';
const SEEN_YOUTUBE = 'pdv2:lastSeen:youtube';
const SEEN_X = 'pdv2:lastSeen:x';
const SEEN_INSTAGRAM = 'pdv2:lastSeen:instagram';
const STYLE_ID = 'pdv2-home-final-style';
let cleanupHome = () => {};

function readJson(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function numberValue(key) {
  const n = Number(localStorage.getItem(key) || 0);
  return Number.isFinite(n) ? n : 0;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function jstDay() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date()); }
  catch { return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
}
function plainText(value = '', max = 220) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function relativeTime(value) {
  const stamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
  if (minutes < 60) return `${minutes || 1}分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}時間前`;
  return `${Math.floor(minutes / (24 * 60))}日前`;
}
function weatherContext() {
  const current = readJson('pdv2:weatherCurrentLocation:v1', null);
  if (Number.isFinite(Number(current?.lat)) && Number.isFinite(Number(current?.lon))) {
    const location = {
      name: String(current.name || '現在地'),
      lat: Number(current.lat),
      lon: Number(current.lon),
      isCurrent: true,
      locatedAt: Number(current.locatedAt || 0)
    };
    return { location, key: `pdv2:weatherCache:multi-source:${location.lat},${location.lon}` };
  }
  const locations = state.weatherLocations || [];
  if (!locations.length) return {};
  const stored = Number(localStorage.getItem('pdv2:weatherIndex') || 0);
  const index = Number.isFinite(stored) ? Math.max(0, Math.min(locations.length - 1, stored)) : 0;
  const location = locations[index];
  return { location, key: `pdv2:weatherCache:multi-source:${location.lat},${location.lon}` };
}
function wx(code) {
  const c = Number(code);
  if (c === 0) return ['☀︎', '快晴', 'sunny'];
  if (c <= 2) return ['☀︎', '晴れ', 'sunny'];
  if (c === 3 || c === 45 || c === 48) return ['☁︎', c === 3 ? 'くもり' : '霧', 'cloudy'];
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) return ['❄︎', '雪', 'snow'];
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95) return [c >= 95 ? '⚡︎' : '☂︎', c >= 95 ? '雷雨' : '雨', 'rain'];
  return ['☁︎', 'くもり', 'cloudy'];
}
function weatherKind(model) {
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 18) return 'night';
  return wx(model?.current?.weather_code)[2];
}
function hours(model, limit = 8) {
  const h = model?.hourly || {}, times = h.time || [], now = Date.now();
  let start = times.findIndex(time => new Date(time).getTime() >= now - 30 * 60 * 1000);
  if (start < 0) start = 0;
  const rows = [];
  for (let i = start; i < times.length && rows.length < limit; i += 1) {
    const temp = Number(h.temperature_2m?.[i]);
    if (!Number.isFinite(temp)) continue;
    rows.push({ time: times[i], temp, rain: Math.max(0, Number(h.precipitation?.[i] || 0)), code: h.weather_code?.[i] });
  }
  return rows;
}
function weatherGraph(rows) {
  if (rows.length < 2) return '';
  const width = 320, high = Math.max(...rows.map(r => r.temp)), low = Math.min(...rows.map(r => r.temp)), range = Math.max(4, high - low);
  const points = rows.map((row, index) => ({ ...row, x: index / (rows.length - 1) * width, y: 34 + (high - row.temp) / range * 38 }));
  const line = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const nodes = points.map(point => {
    const [glyph] = wx(point.code), hour = new Date(point.time).getHours();
    return `<text class="wx" x="${point.x}" y="${point.y - 9}">${glyph}</text><circle cx="${point.x}" cy="${point.y}" r="1.7"/><text class="temp" x="${point.x}" cy="${point.y}" y="${point.y + 13}">${Math.round(point.temp)}°</text><text class="time" x="${point.x}" y="108">${hour}時</text>${point.rain >= .1 ? `<text class="rain" x="${point.x}" y="120">${point.rain.toFixed(1)}mm</text>` : ''}`;
  }).join('');
  return `<div class="home-weather-chart"><svg viewBox="0 0 320 124" preserveAspectRatio="xMidYMid meet" aria-label="数時間先までの天気"><polyline points="${line}"/>${nodes}</svg></div>`;
}
function paintWeather(card, screen, location, model) {
  const current = model?.current || {}, [glyph, label] = wx(current.weather_code), rows = hours(model), rain = rows.find(row => row.rain >= .2);
  const kind = weatherKind(model);
  screen.dataset.wx = kind;
  applyWeatherShellTheme(kind);
  const temp = Number(current.temperature_2m), feel = Number(current.apparent_temperature);
  card.innerHTML = `<div class="home-section-label home-section-label-inverse"><span>WEATHER</span></div><div class="hw-top"><div><b>${esc(location?.name || '天気')}</b><small>${glyph} ${label}</small></div><div class="hw-now"><strong>${Number.isFinite(temp) ? Math.round(temp) : '—'}°</strong><small>体感 ${Number.isFinite(feel) ? Math.round(feel) : '—'}°</small></div></div><div class="hw-hint">${rain ? (rain === rows[0] ? 'この先も雨' : `${new Date(rain.time).getHours()}時ごろから雨`) : ''}</div>${weatherGraph(rows)}<div class="hw-more">天気を詳しく ›</div>`;
}
function weatherPlaceholder(card, location) {
  card.innerHTML = `<div class="home-section-label home-section-label-inverse"><span>WEATHER</span></div><div class="hw-top"><div><b>${esc(location?.name || '天気')}</b><small>☁︎ 保存済み予報なし</small></div><div class="hw-now"><strong>—°</strong><small>体感 —°</small></div></div><div class="hw-empty">予報を更新中<small>ホームはこのまま使えます</small></div>`;
}
function heroNavigate(navigate, element, key, screen, options = {}) {
  navigate(screen, { ...options, source: 'home-hero', heroKey: key, heroElement: element });
}
function makeImage(url, alt = '') {
  if (!url) return null;
  const image = el('img', { src: url, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  image.addEventListener('error', () => image.remove(), { once: true });
  return image;
}
function cardIcon(name, size = 24) {
  try { return iconSvg(name, { size }); } catch { return ''; }
}
function statusBadge(text, className = '') {
  if (!text) return null;
  return el('span', { class: `home-status ${className}`.trim(), text });
}
function sectionHeader(label, status = null) {
  const header = el('div', { class: 'home-section-label' }, [el('span', { text: label })]);
  if (status) header.append(status);
  return header;
}
function newsLeadItem(snapshot, topic) {
  const items = snapshot?.items || [];
  return items.find(item => String(item?.id || '') === String(topic?.leadId || '')) || null;
}
function newsTopicButton(topic, index, snapshot, navigate) {
  const key = `news:${topic.leadId || index}`;
  const lead = newsLeadItem(snapshot, topic);
  const button = el('button', { class: `home-news-item ${index === 0 ? 'is-hero' : 'is-small'}`, type: 'button', 'data-home-hero-key': key });
  if (index === 0) {
    const media = el('div', { class: 'home-news-media' });
    const image = makeImage(topic.image, '');
    if (image) media.append(image);
    media.append(el('span', { class: 'home-news-fallback', text: topic.category || 'ニュース' }));
    button.append(media);
  }
  const copy = el('div', { class: 'home-news-copy' });
  if (index === 0) {
    const meta = el('div', { class: 'home-news-meta' });
    meta.append(el('span', { text: topic.category || lead?.importance || 'ニュース' }));
    if (lead?.source) meta.append(el('span', { text: lead.source }));
    const time = relativeTime(lead?.pubDate || lead?.effectivePublishedTimestamp);
    if (time) meta.append(el('span', { text: time }));
    copy.append(meta);
  }
  copy.append(el(index === 0 ? 'h2' : 'h3', { text: topic.title || 'ニュース' }));
  const summary = index === 0 ? plainText(lead?.description || '', 210) : '';
  if (summary) copy.append(el('p', { class: 'home-news-summary', text: summary }));
  copy.append(el('small', { text: `${Math.max(1, Number(topic.mediaCount || 1))}媒体が報道` }));
  button.append(copy);
  button.onclick = () => heroNavigate(navigate, button, key, 'newsToday', { openId: topic.leadId });
  return button;
}
function makeNewsCard(snapshot, navigate) {
  const shell = el('section', { class: 'home-card home-news-shell', 'data-home-section': 'news' });
  updateNewsCard(shell, snapshot, navigate);
  return shell;
}
function updateNewsCard(shell, snapshot, navigate) {
  const topics = (snapshot?.topics || []).slice(0, 3), count = snapshot?.items?.length || 0;
  const host = el('div', { class: 'home-news-items' });
  if (topics.length) topics.forEach((topic, index) => host.append(newsTopicButton(topic, index, snapshot, navigate)));
  else host.append(el('div', { class: 'home-empty-copy' }, [el('b', { text: '重要ニュースを準備中' }), el('small', { text: '保存済みデータが入るとここに表示します' })]));
  const all = el('button', { class: 'home-card-footer', type: 'button', onclick: () => navigate('newsToday', { source: 'home-news-all' }) }, [el('span', { text: count ? `12時間以内 ${count}件` : 'ニュースを見る' }), el('span', { text: '→' })]);
  shell.replaceChildren(sectionHeader('NEWS'), host, all);
}

function makeXCard(navigate) {
  const card = el('button', { class: 'home-card home-social-card home-x-card', type: 'button', 'data-home-hero-key': 'x', 'data-home-section': 'x' });
  card.onclick = event => heroNavigate(navigate, event.currentTarget, 'x', 'twitter', { snsMode: 'x', deferSeen: true, serviceSeen: 'x' });
  paintXCard(card, { posts: [] });
  return card;
}
function xPostTime(post) {
  const stamp = Date.parse(post?.createdAt || '');
  return Number.isFinite(stamp) ? stamp : 0;
}
function paintXCard(card, cache) {
  const seen = numberValue(SEEN_X), posts = cache?.posts || [], fresh = posts.filter(post => xPostTime(post) > seen), count = fresh.length;
  const lead = fresh[0] || posts[0] || {};
  const handle = String(lead?.author?.handle || '').trim();
  const author = handle ? (handle.startsWith('@') ? handle : `@${handle}`) : (lead?.author?.name || 'X');
  const imageUrl = lead?.media?.find(media => media?.type === 'image')?.url || lead?.author?.avatar || '';
  const status = count ? statusBadge(`● NEW ${count}`, 'is-new') : null;
  const header = sectionHeader('X', status);
  const body = el('div', { class: 'home-social-body' });
  const copy = el('div', { class: 'home-social-copy' }, [
    el('strong', { text: author }),
    el('p', { text: plainText(lead?.text || '', 260) || '最新の投稿を確認' })
  ]);
  body.append(copy);
  const image = makeImage(imageUrl, '');
  if (image) body.append(el('div', { class: 'home-social-media' }, [image]));
  card.dataset.newCount = String(count);
  card.replaceChildren(header, body, el('span', { class: 'home-card-open', text: 'Xを開く ›' }));
}

function makeInstagramCard(navigate) {
  const card = el('button', { class: 'home-card home-instagram-card', type: 'button', 'data-home-hero-key': 'instagram', 'data-home-section': 'instagram' });
  card.onclick = event => heroNavigate(navigate, event.currentTarget, 'instagram', 'twitter', { snsMode: 'instagram', serviceSeen: 'instagram' });
  paintInstagramCard(card, { items: [], count: 0 });
  return card;
}
function instagramItemTime(item) {
  if (item?.timestampIso) {
    const parsed = Date.parse(item.timestampIso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const seconds = Number(item?.timestamp || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}
function instagramImage(item) {
  const media = Array.isArray(item?.media) ? item.media : [];
  const entry = media.find(value => value?.highResUrl || value?.posterUrl || value?.url);
  return entry?.highResUrl || entry?.posterUrl || entry?.url || '';
}
function paintInstagramCard(card, data) {
  const items = data?.items || [], count = Number(data?.count || 0), lead = items[0] || {};
  const username = String(lead?.account?.username || '').trim();
  const status = count ? statusBadge(`新着投稿 ${count}件`, 'is-instagram') : null;
  const header = sectionHeader('Instagram', status);
  const copy = el('div', { class: 'home-instagram-copy' }, [
    el('strong', { text: username ? `@${username}` : 'Instagram' }),
    el('p', { text: plainText(lead?.text || '', 260) || '最近の投稿を確認' })
  ]);
  const body = el('div', { class: 'home-instagram-body' }, [copy]);
  const urls = [];
  for (const item of items) {
    const url = instagramImage(item);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 3) break;
  }
  if (urls.length) {
    const gallery = el('div', { class: `home-instagram-gallery count-${urls.length}` });
    urls.forEach(url => {
      const image = makeImage(url, '');
      if (image) gallery.append(image);
    });
    body.append(gallery);
  }
  card.dataset.newCount = String(count);
  card.replaceChildren(header, body, el('span', { class: 'home-card-open', text: 'Instagramを開く ›' }));
}
async function readInstagramHomeData() {
  try {
    const [{ instagramAccounts }, { readInstagramCaches }] = await Promise.all([
      import('../twitter/instagram-accounts.js'),
      import('../twitter/instagram-cache.js')
    ]);
    const accounts = instagramAccounts();
    if (!accounts.length) return { items: [], count: 0 };
    const caches = await readInstagramCaches(accounts);
    const items = [...caches.values()].flatMap(record => record?.items || [])
      .filter(Boolean)
      .sort((a, b) => instagramItemTime(b) - instagramItemTime(a));
    const seen = numberValue(SEEN_INSTAGRAM);
    return { items, count: items.filter(item => instagramItemTime(item) > seen).length };
  } catch {
    return { items: [], count: 0 };
  }
}

function youtubeItems() {
  const cache = readJson(YOUTUBE_KEY, null);
  return (cache?.rows || []).flatMap(row => row?.items || []).filter(item => item?.publishedAt)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}
function youtubeNewCount(items = youtubeItems()) {
  const seen = numberValue(SEEN_YOUTUBE);
  return items.filter(item => new Date(item.publishedAt).getTime() > seen).length;
}
function makeMediaPair(navigate) {
  const shell = el('section', { class: 'home-media-pair', 'data-home-section': 'media' });
  const youtube = el('button', { class: 'home-card home-media-mini service-youtube', type: 'button', 'data-home-hero-key': 'youtube' });
  youtube.onclick = event => heroNavigate(navigate, event.currentTarget, 'youtube', 'media', { mediaMode: 'youtube', deferSeen: true, serviceSeen: 'youtube' });
  const twitch = el('button', { class: 'home-card home-media-mini service-twitch', type: 'button', 'data-home-hero-key': 'twitch' });
  twitch.onclick = event => heroNavigate(navigate, event.currentTarget, 'twitch', 'media', { mediaMode: 'twitch' });
  shell.append(youtube, twitch);
  paintMediaPair(youtube, twitch);
  return { shell, youtube, twitch };
}
function paintMediaPair(youtube, twitch) {
  const items = youtubeItems(), count = youtubeNewCount(items), lead = items[0] || {};
  const ytStatus = count ? statusBadge(`NEW ${count}`, 'is-youtube') : null;
  const ytHeader = sectionHeader('YouTube', ytStatus);
  const ytVisual = el('div', { class: 'home-media-mini-visual' });
  const ytImage = makeImage(lead?.thumbnail || '', '');
  if (ytImage) ytVisual.append(ytImage);
  else ytVisual.innerHTML = cardIcon('youtube', 30);
  const ytTitle = plainText(lead?.title || '', 85) || (count ? `${count}件の新着動画` : '動画を見る');
  youtube.dataset.newCount = String(count);
  youtube.replaceChildren(ytHeader, ytVisual, el('strong', { class: 'home-media-mini-title', text: ytTitle }));

  const cache = readJson(TWITCH_KEY, null), rows = cache?.rows || [], liveRows = rows.filter(row => row?.live?.isLive);
  const live = liveRows[0], broadcaster = live?.broadcaster || {}, stream = live?.live || {};
  const twStatus = liveRows.length ? statusBadge(`● LIVE ${liveRows.length}`, 'is-live') : null;
  const twHeader = sectionHeader('Twitch', twStatus);
  const twVisual = el('div', { class: 'home-media-mini-visual' });
  const twImage = makeImage(broadcaster.profileImageUrl || '', '');
  if (twImage) twVisual.append(twImage);
  else twVisual.innerHTML = cardIcon('twitch', 30);
  const twTitle = liveRows.length ? (broadcaster.displayName || stream.title || 'LIVE配信中') : '配信を見る';
  twitch.dataset.liveCount = String(liveRows.length);
  twitch.replaceChildren(twHeader, twVisual, el('strong', { class: 'home-media-mini-title', text: plainText(twTitle, 85) }));
}

function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]').map(String)); }
  catch { return new Set(); }
}
function makeDiscoverCard(label, kind, navigate) {
  const shell = el('a', {
    class: `home-card home-discover-card home-discover-${kind}`,
    href: '#',
    'data-home-section': kind,
    'aria-label': `${label}の記事をAI要約で開く`
  });
  paintDiscoverCard(shell, null, label, '', navigate, kind);
  return shell;
}
function paintDiscoverCard(shell, item, label, readKey, navigate, kind) {
  shell.href = '#';
  shell.removeAttribute('target');
  shell.removeAttribute('rel');
  shell.onclick = event => {
    event.preventDefault();
    if (!item?.id || !navigate) return;
    if (readKey) {
      const read = readSet(readKey);
      read.add(String(item.id));
      try { localStorage.setItem(readKey, JSON.stringify([...read].slice(-1500))); } catch {}
    }
    const paper = kind === 'paper';
    heroNavigate(navigate, shell, `${kind}:${item.id}`, 'reader', {
      readerMode: paper ? 'papers' : 'knowledge',
      openId: String(item.id),
      ...(paper ? { technologyTab: 'papers' } : {})
    });
  };
  const copy = el('div', { class: 'home-discover-copy' });
  copy.append(
    el('strong', { text: item?.titleJa || item?.title || `${label}の記事を確認` }),
    el('p', { text: plainText(item?.description || '', 260) || (item ? (item?.source || item?.feedName || '') : '保存済みの記事を確認中') })
  );
  const meta = el('div', { class: 'home-discover-meta' });
  const source = item?.source || item?.feedName || '';
  if (source) meta.append(el('span', { text: source }));
  const time = relativeTime(item?.pubDate);
  if (time) meta.append(el('span', { text: time }));
  if (meta.childElementCount) copy.append(meta);
  const body = el('div', { class: 'home-discover-body' }, [copy]);
  const image = makeImage(item?.image || '', '');
  if (image) body.append(el('div', { class: 'home-discover-media' }, [image]));
  shell.replaceChildren(sectionHeader(label), body, el('span', { class: 'home-card-open', text: 'AI要約を開く ›' }));
}
async function readDiscoverItems() {
  try {
    const [{ readReaderCache }, { pickHomeKnowledge, pickHomePaper }] = await Promise.all([
      import('../reader/reader-data.js'),
      import('../reader/reader-attention.js')
    ]);
    const [knowledge, papers] = await Promise.all([readReaderCache('knowledge', 'core'), readReaderCache('papers', 'technology')]);
    const stored = readJson(DISCOVER_KEY, {}), day = jstDay(), sameDay = stored?.day === day;
    const knowledgeRead = readSet('pdv2:read:knowledge'), paperRead = readSet('pdv2:read:papers:technology');
    const knowledgeItems = knowledge?.items || [], paperItems = papers?.items || [];
    const k = pickHomeKnowledge(knowledgeItems, knowledgeRead, sameDay ? stored.knowledgeId : '');
    const p = pickHomePaper(paperItems, paperRead, sameDay ? stored.paperId : '');
    try { localStorage.setItem(DISCOVER_KEY, JSON.stringify({ day, knowledgeId: k?.id || '', paperId: p?.id || '' })); } catch {}
    return {
      knowledge: k, paper: p, knowledgeItems, paperItems,
      knowledgeFresh: Boolean(knowledge?.fresh), paperFresh: Boolean(papers?.fresh)
    };
  } catch {
    return { knowledge: null, paper: null, knowledgeItems: [], paperItems: [], knowledgeFresh: false, paperFresh: false };
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  body.pdv2-home-fullscreen #app-main{width:100%;max-width:none;margin:0;padding:0!important;background:transparent}
  .home-screen{--ha:var(--app-weather-accent,#8398aa);--hb:var(--app-weather-accent-2,#b1bcc5);--hd:var(--app-weather-deep,#22303a);min-height:100dvh!important;animation:none!important;padding:calc(env(safe-area-inset-top) + 10px) max(14px,env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 116px) max(14px,env(safe-area-inset-left));background:radial-gradient(115% 38% at 12% -4%,color-mix(in srgb,var(--ha) 28%,transparent),transparent 72%),linear-gradient(180deg,color-mix(in srgb,var(--ha) 12%,transparent),transparent 42%);overflow:visible}
  .home-stack{width:min(100%,620px);margin:0 auto;display:grid;gap:16px;padding-bottom:10px}
  .home-card{width:100%;min-width:0;margin:0;border:1px solid color-mix(in srgb,var(--ha) 18%,var(--line));border-radius:28px;background:linear-gradient(145deg,color-mix(in srgb,var(--ha) 9%,var(--surface-solid)),color-mix(in srgb,var(--ha) 4%,var(--surface-solid)));box-shadow:0 10px 26px rgba(0,0,0,.09);color:var(--text);overflow:hidden;text-align:left;text-decoration:none;-webkit-tap-highlight-color:transparent}
  button.home-card{font:inherit}.home-card:active,.home-news-item:active{opacity:.93}
  .home-section-label{min-height:28px;padding:0 2px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:color-mix(in srgb,var(--ha) 72%,var(--text));font-size:11px;font-weight:850;letter-spacing:.08em}.home-section-label-inverse{padding:0;color:rgba(255,255,255,.68)}
  .home-status{max-width:58%;padding:4px 8px;border-radius:999px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;letter-spacing:0;font-weight:850;background:color-mix(in srgb,var(--ha) 13%,var(--surface-2));color:var(--text)}.home-status.is-new{color:#fff;background:#16181b}.home-status.is-instagram{color:#fff;background:linear-gradient(120deg,#aa3a8c,#df4c69)}.home-status.is-youtube{color:#fff;background:#e33b32}.home-status.is-live{color:#fff;background:#7b42d9}
  .home-card-open{display:block;margin-top:12px;color:var(--muted);font-size:10px;text-align:right}
  .home-weather-card{min-height:262px;padding:17px 16px 13px;border-radius:30px;text-align:left;color:#fff;background:radial-gradient(80% 105% at 90% -10%,color-mix(in srgb,var(--hb) 48%,transparent),transparent 66%),linear-gradient(145deg,color-mix(in srgb,var(--ha) 68%,var(--hd)),var(--hd));border:1px solid color-mix(in srgb,var(--hb) 25%,var(--line));box-shadow:0 14px 36px rgba(0,0,0,.14);overflow:hidden}
  .hw-top{display:flex;justify-content:space-between;gap:12px;margin-top:2px}.hw-top b{font-size:16px}.hw-top small,.hw-now small{display:block;margin-top:6px;color:rgba(255,255,255,.72);font-size:11px}.hw-now{text-align:right}.hw-now strong{font-size:48px;font-weight:300;line-height:.9}.hw-hint{height:18px;margin-top:10px;font-size:12px;font-weight:750}.home-weather-chart svg{display:block;width:100%;height:124px}.home-weather-chart polyline{fill:none;stroke:rgba(255,255,255,.78);stroke-width:2}.home-weather-chart circle{fill:#fff}.home-weather-chart text{text-anchor:middle;font-family:-apple-system,sans-serif;fill:rgba(255,255,255,.65)}.home-weather-chart .wx{fill:#fff;font-size:15px}.home-weather-chart .temp{fill:#fff;font-size:9px;font-weight:700}.home-weather-chart .time{font-size:8px}.home-weather-chart .rain{fill:#d9f3ff;font-size:7px}.hw-more{text-align:right;font-size:10px;color:rgba(255,255,255,.58)}.hw-empty{min-height:150px;display:grid;align-content:center;font-weight:700}.hw-empty small{display:block;margin-top:5px;color:rgba(255,255,255,.65)}
  .home-news-shell{padding:12px}.home-news-items{display:grid;gap:9px}.home-news-item{width:100%;padding:0;text-align:left;color:inherit;background:color-mix(in srgb,var(--ha) 4%,var(--surface));border:1px solid var(--line);overflow:hidden}.home-news-item.is-hero{border-radius:22px}.home-news-item.is-small{border-radius:17px;min-height:72px}.home-news-media{height:160px;position:relative;display:grid;place-items:center;background:color-mix(in srgb,var(--ha) 14%,var(--surface-2));overflow:hidden}.home-news-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.home-news-fallback{font-weight:800;color:color-mix(in srgb,var(--ha) 72%,var(--text))}.home-news-copy{padding:12px 13px}.home-news-meta{display:flex;gap:7px;align-items:center;overflow:hidden;color:var(--muted);font-size:9px;white-space:nowrap}.home-news-meta span{overflow:hidden;text-overflow:ellipsis}.home-news-meta span:last-child{margin-left:auto;flex:0 0 auto}.home-news-copy h2,.home-news-copy h3{margin:0;line-height:1.33;text-wrap:pretty}.home-news-copy h2{margin-top:6px;font-size:20px}.home-news-copy h3{font-size:15px}.home-news-summary{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin:8px 0 0;color:var(--text);font-size:12px;line-height:1.55}.home-news-copy small{display:block;margin-top:7px;color:var(--muted);font-size:10px}.home-card-footer{width:100%;min-height:42px;padding:4px 4px 0;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:space-between;font-size:11px}.home-empty-copy{padding:22px 14px;border-radius:20px;background:var(--surface-2)}.home-empty-copy b,.home-empty-copy small{display:block}.home-empty-copy small{margin-top:5px;color:var(--muted);font-size:10px}
  .home-social-card,.home-instagram-card{min-height:154px;padding:15px 16px}.home-social-body{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:13px;align-items:start;margin-top:5px}.home-social-copy{min-width:0}.home-social-copy strong,.home-instagram-copy strong{display:block;font-size:16px;line-height:1.25}.home-social-copy p,.home-instagram-copy p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin:7px 0 0;color:var(--text);font-size:14px;line-height:1.5;overflow-wrap:anywhere}.home-social-media{width:76px;height:76px;border-radius:19px;overflow:hidden;background:var(--surface-2)}.home-social-media img{width:100%;height:100%;object-fit:cover}.home-x-card{--service-accent:#7c8b99}
  .home-instagram-body{display:grid;gap:12px;margin-top:5px}.home-instagram-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.home-instagram-gallery.count-1{grid-template-columns:1fr}.home-instagram-gallery.count-2{grid-template-columns:repeat(2,minmax(0,1fr))}.home-instagram-gallery img{width:100%;height:84px;border-radius:15px;object-fit:cover;background:var(--surface-2)}.home-instagram-gallery.count-1 img{height:126px}
  .home-media-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.home-media-mini{min-height:158px;padding:12px;display:flex;flex-direction:column}.home-media-mini .home-section-label{padding:0}.home-media-mini-visual{height:66px;margin-top:5px;border-radius:18px;display:grid;place-items:center;overflow:hidden;background:color-mix(in srgb,var(--service-accent,var(--ha)) 15%,var(--surface-2));color:var(--service-accent,var(--text))}.home-media-mini-visual img{width:100%;height:100%;object-fit:cover}.home-media-mini-visual svg{width:30px;height:30px}.home-media-mini-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:10px;font-size:12px;line-height:1.38}.service-youtube{--service-accent:#ff3b30}.service-twitch{--service-accent:#9147ff}
  .home-discover-card{min-height:162px;padding:15px 16px;display:block}.home-discover-body{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:start;margin-top:5px}.home-discover-copy{min-width:0}.home-discover-copy strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:18px;line-height:1.36;letter-spacing:-.01em}.home-discover-copy p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.55}.home-discover-meta{display:flex;gap:7px;margin-top:9px;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden}.home-discover-meta span{overflow:hidden;text-overflow:ellipsis}.home-discover-media{width:100px;height:92px;border-radius:18px;overflow:hidden;background:color-mix(in srgb,var(--ha) 12%,var(--surface-2))}.home-discover-media img{width:100%;height:100%;object-fit:cover}
  @media(max-width:390px){.home-screen{padding-left:12px;padding-right:12px}.home-stack{gap:14px}.home-card{border-radius:25px}.home-weather-card{min-height:252px;padding-inline:14px;border-radius:28px}.hw-now strong{font-size:45px}.home-news-shell{padding:10px}.home-news-media{height:150px}.home-social-card,.home-instagram-card{padding-inline:14px}.home-instagram-gallery img{height:78px}.home-media-pair{gap:9px}.home-media-mini{min-height:152px;padding:11px}.home-discover-card{padding-inline:14px}.home-discover-media{width:92px;height:88px}}
  @media(max-width:340px){.home-media-pair{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.home-media-mini{padding:9px}.home-media-mini .home-section-label{font-size:10px}.home-media-mini-visual{height:58px}.home-discover-media{width:82px;height:80px}}
  @media(prefers-reduced-motion:reduce){.home-card:active,.home-news-item:active{opacity:1}}
  `;
  document.head.append(style);
}
function afterPaint(callback) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(callback, { timeout: 900 });
    else setTimeout(callback, 40);
  }));
}

export async function renderHome(root, { navigate, refresh = false } = {}) {
  const started = performance.now();
  cleanupHome();
  ensureStyles();
  let disposed = false, weatherUpdating = false, newsUpdating = false, discoverUpdating = false, hiddenAt = 0;
  const screen = el('section', { class: 'screen home-screen', 'data-wx': 'cloudy' });
  const stack = el('div', { class: 'home-stack' });
  screen.append(stack);

  let { location, key: weatherKey } = weatherContext();
  let weatherCached = weatherKey ? readJson(weatherKey, null) : null;
  const weatherCard = el('button', { class: 'home-weather-card', type: 'button', 'data-home-hero-key': 'weather', 'data-home-section': 'weather' });
  weatherCard.onclick = event => heroNavigate(navigate, event.currentTarget, 'weather', 'weatherDetail');
  weatherCached?.model ? paintWeather(weatherCard, screen, location, weatherCached.model) : weatherPlaceholder(weatherCard, location);
  if (!weatherCached?.model) applyWeatherShellTheme('cloudy');

  const newsSnapshot = readJson(REC_KEY, null);
  const newsCard = makeNewsCard(newsSnapshot, navigate);
  const xCard = makeXCard(navigate);
  const instagramCard = makeInstagramCard(navigate);
  const media = makeMediaPair(navigate);
  const knowledgeCard = makeDiscoverCard('知識', 'knowledge', navigate);
  const paperCard = makeDiscoverCard('論文', 'paper', navigate);

  stack.append(weatherCard, newsCard, xCard, instagramCard, media.shell, knowledgeCard, paperCard);
  root.replaceChildren(screen);
  try { localStorage.setItem('pdv2:lastVisitMs', String(Date.now())); } catch {}
  window.__PDV2_HOME_METRIC = {
    domMs: Math.round((performance.now() - started) * 10) / 10,
    weatherCacheHit: Boolean(weatherCached?.model),
    newsCacheHit: Boolean(newsSnapshot?.items?.length),
    fixedOrder: ['weather', 'news', 'x', 'instagram', 'youtube+twitch', 'knowledge', 'paper'],
    initialSections: stack.childElementCount,
    syncOnly: true,
    at: Date.now()
  };

  const syncWeatherContext = () => {
    const next = weatherContext();
    if (!next.location || !next.key) return;
    location = next.location;
    weatherKey = next.key;
    weatherCached = readJson(weatherKey, null);
    if (weatherCached?.model) paintWeather(weatherCard, screen, location, weatherCached.model);
    else weatherPlaceholder(weatherCard, location);
  };
  const updateWeather = async (force = false) => {
    if (disposed || weatherUpdating || !location || !weatherKey) return;
    const old = readJson(weatherKey, null);
    if (!force && old?.model && Date.now() - Number(old.at || 0) < WEATHER_TTL) return;
    weatherUpdating = true;
    try {
      const { fetchWeatherBundle } = await import('../weather/weather-sources.js');
      const model = await fetchWeatherBundle(location, { refresh: Boolean(force) });
      const payload = { at: Date.now(), model };
      try { localStorage.setItem(weatherKey, JSON.stringify(payload)); } catch {}
      window.dispatchEvent(new CustomEvent('pdv2:weather-cache-updated', { detail: { key: weatherKey, location, model, at: payload.at } }));
      if (!disposed && weatherCard.isConnected) paintWeather(weatherCard, screen, location, model);
    } catch (error) {
      console.warn('[home-weather]', error?.message || error);
    } finally {
      weatherUpdating = false;
    }
  };
  const updateNews = async (force = false) => {
    if (disposed || newsUpdating) return;
    newsUpdating = true;
    try {
      const { refreshRecommendationSnapshot } = await import('../reader/reader-recommendations.js');
      const snapshot = await refreshRecommendationSnapshot({ force });
      if (!disposed && newsCard.isConnected) updateNewsCard(newsCard, snapshot, navigate);
    } catch (error) {
      console.warn('[home-news]', error?.message || error);
    } finally {
      newsUpdating = false;
    }
  };
  const updateXFromCache = async () => {
    if (disposed) return;
    try {
      const { readXPostCache } = await import('../twitter/x-cache.js');
      const cache = await readXPostCache();
      if (!disposed && xCard.isConnected) paintXCard(xCard, cache);
    } catch {}
  };
  const updateInstagramFromCache = async () => {
    if (disposed) return;
    const data = await readInstagramHomeData();
    if (!disposed && instagramCard.isConnected) paintInstagramCard(instagramCard, data);
  };
  const paintDiscoverResult = result => {
    if (disposed) return;
    paintDiscoverCard(knowledgeCard, result.knowledge, '知識', 'pdv2:read:knowledge', navigate, 'knowledge');
    paintDiscoverCard(paperCard, result.paper, '論文', 'pdv2:read:papers:technology', navigate, 'paper');
  };
  const updateDiscover = async (force = false) => {
    if (disposed || discoverUpdating) return;
    discoverUpdating = true;
    try {
      let result = await readDiscoverItems();
      if (disposed) return;
      paintDiscoverResult(result);

      const [{ loadReader }, { refreshKnowledgeTrendScores }] = await Promise.all([
        import('../reader/reader-data.js'),
        import('../reader/reader-attention.js')
      ]);
      const sourceJobs = [];
      if (force || !result.knowledgeFresh) {
        sourceJobs.push(loadReader('knowledge', { force, selectedFeed: '', preferCache: false, backgroundRefresh: true }).catch(() => null));
      }
      if (force || !result.paperFresh) {
        sourceJobs.push(loadReader('papers', { force, paperTrack: 'core', fastOnly: true, preferCache: false, backgroundRefresh: true }).catch(() => null));
      }
      if (sourceJobs.length) {
        await Promise.allSettled(sourceJobs);
        if (disposed) return;
        result = await readDiscoverItems();
        paintDiscoverResult(result);
      }

      if (result.knowledgeItems.length) {
        await refreshKnowledgeTrendScores(result.knowledgeItems, { force });
        if (disposed) return;
        result = await readDiscoverItems();
        paintDiscoverResult(result);
      }
    } catch (error) {
      console.warn('[home-discover]', error?.message || error);
    } finally {
      discoverUpdating = false;
    }
  };
  const syncLocalCards = () => {
    if (disposed) return;
    paintMediaPair(media.youtube, media.twitch);
  };

  const navigationEntry = performance.getEntriesByType?.('navigation')?.[0];
  const forceOnEntry = Boolean(refresh || navigationEntry?.type === 'reload');
  afterPaint(() => {
    updateXFromCache();
    updateInstagramFromCache();
    updateDiscover(forceOnEntry);
    syncLocalCards();
    updateWeather(forceOnEntry);
    updateNews(forceOnEntry);
  });

  const onCurrentWeather = () => { if (!disposed) syncWeatherContext(); };
  const onWeatherCache = event => {
    if (disposed || event?.detail?.key !== weatherKey || !event.detail.model) return;
    weatherCached = { at: Number(event.detail.at || Date.now()), model: event.detail.model };
    paintWeather(weatherCard, screen, location, event.detail.model);
  };
  const onNews = event => {
    if (!disposed && event.detail && newsCard.isConnected) updateNewsCard(newsCard, event.detail, navigate);
  };
  const onSeen = event => {
    if (disposed) return;
    const service = event?.detail?.service || '';
    if (service === 'youtube') syncLocalCards();
    if (service === 'x') afterPaint(updateXFromCache);
    if (service === 'instagram') afterPaint(updateInstagramFromCache);
  };
  const onInstagramAccounts = () => { if (!disposed) afterPaint(updateInstagramFromCache); };
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt >= 60 * 1000) {
      hiddenAt = 0;
      afterPaint(() => {
        syncLocalCards();
        updateWeather(false);
        updateNews(false);
        updateXFromCache();
        updateInstagramFromCache();
        updateDiscover(false);
      });
    }
  };
  const onNavigate = () => cleanupHome();
  window.addEventListener('pdv2:current-location-updated', onCurrentWeather);
  window.addEventListener('pdv2:weather-cache-updated', onWeatherCache);
  window.addEventListener('pdv2:recommendations-updated', onNews);
  window.addEventListener('pdv2:service-seen', onSeen);
  window.addEventListener('pdv2:instagram-accounts-changed', onInstagramAccounts);
  document.addEventListener('visibilitychange', onVisibility, { passive: true });
  window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  cleanupHome = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pdv2:current-location-updated', onCurrentWeather);
    window.removeEventListener('pdv2:weather-cache-updated', onWeatherCache);
    window.removeEventListener('pdv2:recommendations-updated', onNews);
    window.removeEventListener('pdv2:service-seen', onSeen);
    window.removeEventListener('pdv2:instagram-accounts-changed', onInstagramAccounts);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pdv2:before-navigate', onNavigate);
  };
}
