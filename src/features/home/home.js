import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { iconSvg } from '../../shared/icons.js';
import { applyWeatherShellTheme } from '../../app/router.js';

const WEATHER_TTL = 10 * 60 * 1000;
const REC_KEY = 'pdv2:recommendationSnapshot:v1';
const TWITCH_KEY = 'pdv2:twitchCache:v2195';
const YOUTUBE_KEY = 'pdv2:youtubeCache:kind4-lockup';
const STORY_KEY = 'pdv2:instagramStorySnapshot:v1';
const STORY_VIEWED_KEY = 'instagramStoryViewedIdsV1';
const DISCOVER_KEY = 'pdv2:homeDiscover:v1';
const SEEN_YOUTUBE = 'pdv2:lastSeen:youtube';
const SEEN_X = 'pdv2:lastSeen:x';
const STYLE_ID = 'pdv2-home-final-style';
const STACK_ORDER = ['weather', 'news', 'twitch', 'instagram', 'youtube', 'x', 'discover'];
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
function weatherContext() {
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
    return `<text class="wx" x="${point.x}" y="${point.y - 9}">${glyph}</text><circle cx="${point.x}" cy="${point.y}" r="1.7"/><text class="temp" x="${point.x}" y="${point.y + 13}">${Math.round(point.temp)}°</text><text class="time" x="${point.x}" y="108">${hour}時</text>${point.rain >= .1 ? `<text class="rain" x="${point.x}" y="120">${point.rain.toFixed(1)}mm</text>` : ''}`;
  }).join('');
  return `<div class="home-weather-chart"><svg viewBox="0 0 320 124" preserveAspectRatio="xMidYMid meet" aria-label="数時間先までの天気"><polyline points="${line}"/>${nodes}</svg></div>`;
}
function paintWeather(card, screen, location, model) {
  const current = model?.current || {}, [glyph, label] = wx(current.weather_code), rows = hours(model), rain = rows.find(row => row.rain >= .2);
  const kind = weatherKind(model);
  screen.dataset.wx = kind;
  applyWeatherShellTheme(kind);
  const temp = Number(current.temperature_2m), feel = Number(current.apparent_temperature);
  card.innerHTML = `<div class="hw-top"><div><b>${esc(location?.name || '天気')}</b><small>${glyph} ${label}</small></div><div class="hw-now"><strong>${Number.isFinite(temp) ? Math.round(temp) : '—'}°</strong><small>体感 ${Number.isFinite(feel) ? Math.round(feel) : '—'}°</small></div></div><div class="hw-hint">${rain ? (rain === rows[0] ? 'この先も雨' : `${new Date(rain.time).getHours()}時ごろから雨`) : ''}</div>${weatherGraph(rows)}<div class="hw-more">天気を詳しく ›</div>`;
}
function weatherPlaceholder(card, location) {
  card.innerHTML = `<div class="hw-top"><div><b>${esc(location?.name || '天気')}</b><small>☁︎ 保存済み予報なし</small></div><div class="hw-now"><strong>—°</strong><small>体感 —°</small></div></div><div class="hw-empty">予報を更新中<small>ホームはこのまま使えます</small></div>`;
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
function topicButton(topic, index, navigate) {
  const key = `news:${topic.leadId || index}`;
  const button = el('button', { class: `home-news-item ${index === 0 ? 'is-hero' : 'is-small'}`, type: 'button', 'data-home-hero-key': key });
  if (index === 0) {
    const media = el('div', { class: 'home-news-media' });
    const image = makeImage(topic.image, '');
    if (image) media.append(image);
    media.append(el('span', { class: 'home-news-fallback', text: topic.category || 'ニュース' }));
    button.append(media);
  }
  const copy = el('div', { class: 'home-news-copy' });
  copy.append(el(index === 0 ? 'h2' : 'h3', { text: topic.title || 'ニュース' }), el('small', { text: `${Math.max(1, Number(topic.mediaCount || 1))}媒体が報道` }));
  button.append(copy);
  button.onclick = () => heroNavigate(navigate, button, key, 'newsToday', { openId: topic.leadId });
  return button;
}
function makeNewsCard(snapshot, navigate) {
  const shell = el('section', { class: 'home-news-shell home-stack-card', 'data-stack-key': 'news' });
  const topics = (snapshot?.topics || []).slice(0, 3), count = snapshot?.items?.length || 0;
  const host = el('div', { class: 'home-news-items' });
  if (topics.length) topics.forEach((topic, index) => host.append(topicButton(topic, index, navigate)));
  else host.append(el('div', { class: 'home-news-empty' }, [el('b', { text: '12時間ニュースを準備中' }), el('small', { text: '初回描画後に裏で更新します' })]));
  const all = el('button', { class: 'home-news-all', type: 'button', onclick: () => navigate('newsToday', { source: 'home-news-all' }) }, [el('span', { text: `12時間以内のニュース ${count}件` }), el('span', { text: '→' })]);
  shell.append(host, all);
  return shell;
}
function updateNewsCard(shell, snapshot, navigate) {
  const replacement = makeNewsCard(snapshot, navigate);
  shell.replaceChildren(...replacement.childNodes);
}
function cardIcon(name, size = 24) {
  try { return iconSvg(name, { size }); } catch { return ''; }
}
function serviceCard({ key, eyebrow, title, detail = '', image = '', icon = '', count = 0, className = '', onClick }) {
  const button = el('button', { class: `home-service-card home-stack-card ${className}`, type: 'button', 'data-stack-key': key, 'data-home-hero-key': key, 'data-new-count': String(count || 0) });
  const visual = el('div', { class: 'home-service-visual' });
  if (image) {
    const img = makeImage(image, '');
    if (img) visual.append(img);
  }
  if (!visual.childElementCount) visual.innerHTML = icon || '<span class="home-service-dot">•</span>';
  const copy = el('div', { class: 'home-service-copy' });
  copy.append(el('small', { text: eyebrow }), el('strong', { text: title }));
  if (detail) copy.append(el('span', { text: detail }));
  button.append(visual, copy, el('span', { class: 'home-service-arrow', text: '›', 'aria-hidden': 'true' }));
  button.onclick = onClick;
  return button;
}
function twitchCard(navigate, force = false) {
  const cache = readJson(TWITCH_KEY, null), live = (cache?.rows || []).find(row => row?.live?.isLive);
  if (!live && !force) return null;
  const broadcaster = live?.broadcaster || {}, stream = live?.live || {};
  const card = serviceCard({
    key: 'twitch', eyebrow: '● LIVE', title: broadcaster.displayName || 'Twitch', detail: stream.title || (force ? '配信を確認済み' : 'LIVE配信中'),
    image: broadcaster.profileImageUrl || '', icon: cardIcon('twitch'), className: 'service-twitch',
    onClick: event => heroNavigate(navigate, event.currentTarget, 'twitch', 'media', { mediaMode: 'twitch' })
  });
  return card;
}
function storyViewed() {
  const raw = readJson(STORY_VIEWED_KEY, {}), now = Date.now(), result = new Set();
  Object.entries(raw || {}).forEach(([id, at]) => { if (id && now - Number(at || 0) < 48 * 60 * 60 * 1000) result.add(String(id)); });
  return result;
}
function instagramStoryState(force = false) {
  const snapshot = readJson(STORY_KEY, null), viewed = storyViewed(), cutoff = Date.now() - 30 * 60 * 60 * 1000;
  const accounts = (snapshot?.accounts || []).map(account => {
    const stories = Array.isArray(account.stories) ? account.stories : [];
    const unread = stories.length
      ? stories.filter(story => story?.id && !viewed.has(String(story.id)) && (!story.takenAt || Date.parse(story.takenAt) >= cutoff))
      : (account.unread ? [{ id: `tray:${account.username || ''}` }] : []);
    return { ...account, unread };
  }).filter(account => account.unread.length);
  if (accounts.length) return { account: accounts[0], count: accounts.reduce((sum, account) => sum + account.unread.length, 0) };
  if (force && snapshot?.accounts?.length) return { account: snapshot.accounts[0], count: 0 };
  return null;
}
function instagramCard(navigate, force = false) {
  const state = instagramStoryState(force);
  if (!state) return null;
  const account = state.account || {};
  const button = serviceCard({
    key: 'instagram', eyebrow: state.count ? '未読 STORY' : 'STORY', title: `@${account.username || 'Instagram'}`, detail: state.count ? `${state.count}件の未読Story` : 'Storyを確認済み',
    image: account.profilePicUrl || '', icon: cardIcon('instagram'), count: state.count, className: 'service-instagram',
    onClick: event => {
      if (account.username) sessionStorage.setItem('pdv2:openInstagramStory', account.username);
      heroNavigate(navigate, event.currentTarget, 'instagram', 'twitter', { snsMode: 'instagram' });
    }
  });
  button.querySelector('.home-service-visual')?.classList.add('story-ring');
  return button;
}
function youtubeItems() {
  const cache = readJson(YOUTUBE_KEY, null);
  return (cache?.rows || []).flatMap(row => row?.items || []).filter(item => item?.publishedAt);
}
function youtubeNewCount() {
  const seen = numberValue(SEEN_YOUTUBE);
  return youtubeItems().filter(item => new Date(item.publishedAt).getTime() > seen).length;
}
function youtubeCard(navigate, force = false) {
  const count = youtubeNewCount();
  if (!count && !force) return null;
  return serviceCard({
    key: 'youtube', eyebrow: '▶ YouTube', title: count ? `新着 ${count}件` : 'YouTube', detail: count ? '前回確認後に公開' : '確認済み', icon: cardIcon('youtube'), count, className: 'service-youtube',
    onClick: event => heroNavigate(navigate, event.currentTarget, 'youtube', 'media', { mediaMode: 'youtube', deferSeen: true, serviceSeen: 'youtube' })
  });
}
function xPostTime(post) {
  const stamp = Date.parse(post?.createdAt || '');
  return Number.isFinite(stamp) ? stamp : 0;
}
function xCardFromCache(cache, navigate, force = false) {
  const seen = numberValue(SEEN_X), posts = cache?.posts || [], fresh = posts.filter(post => xPostTime(post) > seen), count = fresh.length;
  if (!count && !force) return null;
  const lead = fresh[0] || posts[0] || {};
  const image = lead?.media?.find(media => media?.type === 'image')?.url || lead?.author?.avatar || '';
  return serviceCard({
    key: 'x', eyebrow: 'X', title: count ? `新着 ${count}件` : 'X', detail: count ? (lead.author?.name || lead.author?.handle || '新しいポストがあります') : '確認済み', image, icon: '𝕏', count, className: 'service-x',
    onClick: event => heroNavigate(navigate, event.currentTarget, 'x', 'twitter', { snsMode: 'x', deferSeen: true, serviceSeen: 'x' })
  });
}
function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]').map(String)); }
  catch { return new Set(); }
}
function discoverPick(items, read, preferredId = '') {
  const rows = (items || []).filter(item => item?.link || item?.url);
  const preferred = preferredId && rows.find(item => String(item.id) === String(preferredId) && !read.has(String(item.id)));
  if (preferred) return preferred;
  const unread = rows.filter(item => !read.has(String(item.id))).sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return unread[0] || rows.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))[0] || null;
}
function discoverItem(item, label, readKey) {
  const link = item?.link || item?.url || '';
  const anchor = el('a', { class: 'home-discover-item', href: link, target: '_blank', rel: 'noopener noreferrer' });
  anchor.addEventListener('click', () => { if (!item?.id || !readKey) return; const read = readSet(readKey); read.add(String(item.id)); try { localStorage.setItem(readKey, JSON.stringify([...read].slice(-1500))); } catch {} }, { passive: true });
  const media = el('div', { class: 'home-discover-media' });
  const image = makeImage(item?.image || '', '');
  if (image) media.append(image);
  else media.append(el('span', { text: label }));
  const copy = el('div', { class: 'home-discover-copy' });
  copy.append(el('strong', { text: item?.titleJa || item?.title || '記事' }), el('small', { text: item?.source || item?.feedName || label }));
  anchor.append(media, copy);
  return anchor;
}
async function discoverCard() {
  try {
    const { readReaderCache } = await import('../reader/reader-data.js');
    const [knowledge, papers] = await Promise.all([readReaderCache('knowledge', 'core'), readReaderCache('papers', 'technology')]);
    const stored = readJson(DISCOVER_KEY, {}), day = jstDay();
    const sameDay = stored?.day === day;
    const knowledgeRead = readSet('pdv2:read:knowledge'), paperRead = readSet('pdv2:read:papers:technology');
    const k = discoverPick(knowledge?.items, knowledgeRead, sameDay ? stored.knowledgeId : '');
    const p = discoverPick(papers?.items, paperRead, sameDay ? stored.paperId : '');
    if (!k && !p) return null;
    try { localStorage.setItem(DISCOVER_KEY, JSON.stringify({ day, knowledgeId: k?.id || '', paperId: p?.id || '' })); } catch {}
    const shell = el('section', { class: 'home-discover-shell home-stack-card', 'data-stack-key': 'discover' });
    if (k) shell.append(discoverItem(k, '知識', 'pdv2:read:knowledge'));
    if (p) shell.append(discoverItem(p, '論文', 'pdv2:read:papers:technology'));
    return shell;
  } catch { return null; }
}
function reindex(stack) {
  [...stack.children].forEach((card, index) => {
    card.style.setProperty('--stack-index', String(index));
    card.style.zIndex = String(20 + index);
  });
}
function placeCard(stack, cards, key, node) {
  const old = cards.get(key);
  if (old === node) return;
  if (old?.isConnected) old.remove();
  cards.delete(key);
  if (!node) { reindex(stack); return; }
  const index = STACK_ORDER.indexOf(key);
  const next = [...stack.children].find(child => STACK_ORDER.indexOf(child.dataset.stackKey) > index);
  stack.insertBefore(node, next || null);
  cards.set(key, node);
  reindex(stack);
}
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  body.pdv2-home-fullscreen #app-main{width:100%;max-width:none;margin:0;padding:0!important;background:transparent}
  body.pdv2-home-fullscreen #bottom-nav{display:none!important}
  .home-screen{--ha:var(--app-weather-accent,#8398aa);--hb:var(--app-weather-accent-2,#b1bcc5);--hd:var(--app-weather-deep,#22303a);min-height:100dvh!important;animation:none!important;padding:calc(env(safe-area-inset-top) + 8px) max(14px,env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 92px) max(14px,env(safe-area-inset-left));background:radial-gradient(105% 34% at 10% 0,color-mix(in srgb,var(--ha) 18%,transparent),transparent 76%);overflow:visible}
  .home-stack{width:min(100%,620px);margin:0 auto;display:block;padding-bottom:18dvh}.home-stack-card{position:sticky;top:calc(env(safe-area-inset-top) + 8px + (var(--stack-index,0) * 14px));width:100%;margin:0 0 22px;isolation:isolate}.home-stack-card:last-child{margin-bottom:0}
  .home-weather-card{min-height:250px;padding:19px 16px 13px;border-radius:30px;text-align:left;color:#fff;background:radial-gradient(80% 105% at 90% -10%,color-mix(in srgb,var(--hb) 48%,transparent),transparent 66%),linear-gradient(145deg,color-mix(in srgb,var(--ha) 68%,var(--hd)),var(--hd));border:1px solid color-mix(in srgb,var(--hb) 25%,var(--line));box-shadow:0 14px 36px rgba(0,0,0,.14);overflow:hidden}.home-weather-card:active,.home-service-card:active,.home-news-item:active{opacity:.92}.hw-top{display:flex;justify-content:space-between;gap:12px}.hw-top b{font-size:15px}.hw-top small,.hw-now small{display:block;margin-top:6px;color:rgba(255,255,255,.72);font-size:11px}.hw-now{text-align:right}.hw-now strong{font-size:48px;font-weight:300;line-height:.9}.hw-hint{height:18px;margin-top:10px;font-size:12px;font-weight:700}.home-weather-chart svg{display:block;width:100%;height:124px}.home-weather-chart polyline{fill:none;stroke:rgba(255,255,255,.78);stroke-width:2}.home-weather-chart circle{fill:#fff}.home-weather-chart text{text-anchor:middle;font-family:-apple-system,sans-serif;fill:rgba(255,255,255,.65)}.home-weather-chart .wx{fill:#fff;font-size:15px}.home-weather-chart .temp{fill:#fff;font-size:9px;font-weight:700}.home-weather-chart .time{font-size:8px}.home-weather-chart .rain{fill:#d9f3ff;font-size:7px}.hw-more{text-align:right;font-size:10px;color:rgba(255,255,255,.58)}.hw-empty{min-height:150px;display:grid;align-content:center;font-weight:700}.hw-empty small{display:block;margin-top:5px;color:rgba(255,255,255,.65)}
  .home-news-shell{border-radius:30px;padding:10px;background:color-mix(in srgb,var(--ha) 7%,var(--surface-solid));border:1px solid color-mix(in srgb,var(--ha) 18%,var(--line));box-shadow:0 13px 34px rgba(0,0,0,.12)}.home-news-items{display:grid;gap:9px}.home-news-item{width:100%;padding:0;text-align:left;color:inherit;background:color-mix(in srgb,var(--ha) 4%,var(--surface));border:1px solid var(--line);overflow:hidden}.home-news-item.is-hero{border-radius:23px}.home-news-item.is-small{border-radius:18px;min-height:76px}.home-news-media{height:154px;position:relative;display:grid;place-items:center;background:color-mix(in srgb,var(--ha) 14%,var(--surface-2));overflow:hidden}.home-news-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.home-news-fallback{font-weight:800;color:color-mix(in srgb,var(--ha) 72%,var(--text))}.home-news-copy{padding:12px 13px}.home-news-copy h2,.home-news-copy h3{margin:0;line-height:1.3;text-wrap:pretty}.home-news-copy h2{font-size:20px}.home-news-copy h3{font-size:15px}.home-news-copy small{display:block;margin-top:5px;color:var(--muted);font-size:10px}.home-news-all{width:100%;min-height:42px;padding:0 5px;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:space-between;font-size:11px}.home-news-empty{padding:18px 14px;border-radius:20px;background:var(--surface-2)}.home-news-empty b,.home-news-empty small{display:block}.home-news-empty small{margin-top:4px;color:var(--muted);font-size:10px}
  .home-service-card{min-height:106px;padding:14px 15px;display:grid;grid-template-columns:58px minmax(0,1fr) 20px;align-items:center;gap:12px;border-radius:27px;text-align:left;color:var(--text);background:linear-gradient(135deg,color-mix(in srgb,var(--service-accent,var(--ha)) 12%,var(--surface-solid)),color-mix(in srgb,var(--service-accent,var(--ha)) 5%,var(--surface)));border:1px solid color-mix(in srgb,var(--service-accent,var(--ha)) 22%,var(--line));box-shadow:0 12px 30px rgba(0,0,0,.1)}.home-service-visual{width:58px;height:58px;border-radius:19px;display:grid;place-items:center;overflow:hidden;background:color-mix(in srgb,var(--service-accent,var(--ha)) 18%,var(--surface-2));font-size:27px;font-weight:800}.home-service-visual svg{width:27px;height:27px}.home-service-visual img{width:100%;height:100%;object-fit:cover}.home-service-visual.story-ring{border-radius:50%;padding:3px;background:linear-gradient(145deg,#743cff,#e73c85 58%,#ff9e45)}.home-service-visual.story-ring img{border-radius:50%;border:2px solid var(--surface)}.home-service-copy{min-width:0}.home-service-copy small,.home-service-copy strong,.home-service-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.home-service-copy small{font-size:10px;color:color-mix(in srgb,var(--service-accent,var(--ha)) 76%,var(--muted));font-weight:800}.home-service-copy strong{margin-top:3px;font-size:19px}.home-service-copy span{margin-top:4px;color:var(--muted);font-size:11px}.home-service-arrow{font-size:25px;color:var(--muted);text-align:right}.service-twitch{--service-accent:#9147ff}.service-instagram{--service-accent:#d84f86}.service-youtube{--service-accent:#ff3b30}.service-x{--service-accent:#7c8b99}.home-service-dot{font-size:34px}
  .home-discover-shell{padding:10px;border-radius:30px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;background:color-mix(in srgb,var(--ha) 6%,var(--surface-solid));border:1px solid color-mix(in srgb,var(--ha) 18%,var(--line));box-shadow:0 12px 30px rgba(0,0,0,.1)}.home-discover-item{min-width:0;text-decoration:none;color:inherit;border-radius:21px;overflow:hidden;background:var(--surface);border:1px solid var(--line)}.home-discover-media{height:110px;display:grid;place-items:center;position:relative;overflow:hidden;background:color-mix(in srgb,var(--ha) 12%,var(--surface-2));color:var(--muted);font-size:12px;font-weight:800}.home-discover-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.home-discover-copy{padding:10px}.home-discover-copy strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:13px;line-height:1.4}.home-discover-copy small{display:block;margin-top:6px;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media(max-width:390px){.home-screen{padding-left:12px;padding-right:12px}.home-stack-card{top:calc(env(safe-area-inset-top) + 7px + (var(--stack-index,0) * 13px));margin-bottom:18px}.home-weather-card{min-height:244px;padding-inline:14px}.hw-now strong{font-size:45px}.home-news-media{height:146px}.home-service-card{min-height:101px}.home-discover-media{height:100px}}
  @media(prefers-reduced-motion:reduce){.home-stack-card{scroll-behavior:auto}}
  `;
  document.head.append(style);
}
function afterPaint(callback) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(callback, { timeout: 900 });
    else setTimeout(callback, 40);
  }));
}

export async function renderHome(root, { navigate, refresh = false, heroReturnKey = '' } = {}) {
  const started = performance.now();
  cleanupHome(); ensureStyles();
  let disposed = false, weatherUpdating = false, newsUpdating = false, hiddenAt = 0, forcedReturn = String(heroReturnKey || '');
  const screen = el('section', { class: 'screen home-screen', 'data-wx': 'cloudy' });
  const stack = el('div', { class: 'home-stack' });
  const cards = new Map(); screen.append(stack);

  const { location, key: weatherKey } = weatherContext(), weatherCached = weatherKey ? readJson(weatherKey, null) : null;
  const weatherCard = el('button', { class: 'home-weather-card home-stack-card', type: 'button', 'data-stack-key': 'weather', 'data-home-hero-key': 'weather' });
  weatherCard.onclick = event => heroNavigate(navigate, event.currentTarget, 'weather', 'weatherDetail');
  weatherCached?.model ? paintWeather(weatherCard, screen, location, weatherCached.model) : weatherPlaceholder(weatherCard, location);
  if (!weatherCached?.model) applyWeatherShellTheme('cloudy');
  placeCard(stack, cards, 'weather', weatherCard);

  const newsSnapshot = readJson(REC_KEY, null), newsCard = makeNewsCard(newsSnapshot, navigate);
  placeCard(stack, cards, 'news', newsCard);

  const syncServices = () => {
    placeCard(stack, cards, 'twitch', twitchCard(navigate, forcedReturn === 'twitch'));
    placeCard(stack, cards, 'instagram', instagramCard(navigate, forcedReturn === 'instagram'));
    placeCard(stack, cards, 'youtube', youtubeCard(navigate, forcedReturn === 'youtube'));
    if (forcedReturn === 'x' && !cards.get('x')) placeCard(stack, cards, 'x', xCardFromCache({ posts: [] }, navigate, true));
  };
  syncServices();
  root.replaceChildren(screen);
  try { localStorage.setItem('pdv2:lastVisitMs', String(Date.now())); } catch {}
  window.__PDV2_HOME_METRIC = {
    domMs: Math.round((performance.now() - started) * 10) / 10,
    weatherCacheHit: Boolean(weatherCached?.model), newsCacheHit: Boolean(newsSnapshot?.items?.length),
    initialCards: stack.childElementCount, syncOnly: true, at: Date.now()
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
    } catch (error) { console.warn('[home-weather]', error?.message || error); }
    finally { weatherUpdating = false; }
  };
  const updateNews = async (force = false) => {
    if (disposed || newsUpdating) return;
    newsUpdating = true;
    try {
      const { refreshRecommendationSnapshot } = await import('../reader/reader-recommendations.js');
      const snapshot = await refreshRecommendationSnapshot({ force });
      if (!disposed && newsCard.isConnected) updateNewsCard(newsCard, snapshot, navigate);
    } catch (error) { console.warn('[home-news]', error?.message || error); }
    finally { newsUpdating = false; }
  };
  const updateXFromCache = async () => {
    if (disposed) return;
    try {
      const { readXPostCache } = await import('../twitter/x-cache.js');
      const cache = await readXPostCache();
      if (!disposed) placeCard(stack, cards, 'x', xCardFromCache(cache, navigate, forcedReturn === 'x'));
    } catch {}
  };
  const updateDiscover = async () => {
    if (disposed) return;
    const card = await discoverCard();
    if (!disposed) placeCard(stack, cards, 'discover', card);
  };

  const navigationEntry = performance.getEntriesByType?.('navigation')?.[0];
  afterPaint(() => {
    updateXFromCache();
    updateDiscover();
    updateWeather(Boolean(refresh || navigationEntry?.type === 'reload'));
    updateNews(Boolean(refresh || navigationEntry?.type === 'reload'));
  });

  const onNews = event => { if (!disposed && event.detail && newsCard.isConnected) updateNewsCard(newsCard, event.detail, navigate); };
  const onStory = () => { if (!disposed) placeCard(stack, cards, 'instagram', instagramCard(navigate, forcedReturn === 'instagram')); };
  const onSeen = event => {
    if (disposed) return;
    const service = event?.detail?.service || '';
    if (service === 'youtube') placeCard(stack, cards, 'youtube', youtubeCard(navigate, forcedReturn === 'youtube'));
    if (service === 'x') afterPaint(updateXFromCache);
  };
  const onHeroReturn = () => {
    if (disposed || !forcedReturn) return;
    const previous = forcedReturn; forcedReturn = '';
    if (previous === 'twitch') placeCard(stack, cards, 'twitch', twitchCard(navigate, false));
    if (previous === 'instagram') placeCard(stack, cards, 'instagram', instagramCard(navigate, false));
    if (previous === 'youtube') placeCard(stack, cards, 'youtube', youtubeCard(navigate, false));
    if (previous === 'x') afterPaint(updateXFromCache);
  };
  const onVisibility = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= 60 * 1000) { hiddenAt = 0; afterPaint(() => { updateWeather(false); updateNews(false); updateXFromCache(); }); }
  };
  const onNavigate = () => cleanupHome();
  window.addEventListener('pdv2:recommendations-updated', onNews);
  window.addEventListener('pdv2:instagram-story-cache-updated', onStory);
  window.addEventListener('pdv2:service-seen', onSeen);
  window.addEventListener('pdv2:hero-return-finished', onHeroReturn);
  document.addEventListener('visibilitychange', onVisibility, { passive: true });
  window.addEventListener('pdv2:before-navigate', onNavigate, { once: true });
  cleanupHome = () => {
    if (disposed) return; disposed = true;
    window.removeEventListener('pdv2:recommendations-updated', onNews);
    window.removeEventListener('pdv2:instagram-story-cache-updated', onStory);
    window.removeEventListener('pdv2:service-seen', onSeen);
    window.removeEventListener('pdv2:hero-return-finished', onHeroReturn);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pdv2:before-navigate', onNavigate);
  };
}
