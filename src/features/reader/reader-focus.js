import { el } from '../../shared/dom.js';
import { shortDate } from '../../shared/time.js';
import { readerTrace } from '../../shared/reader-debug.js';
import { articleIdentity, clampReaderIndex, nextPrefetchIndices, readerFlowSnapshot } from './reader-flow.js';

const summaryCache = new Map();
const summaryPromises = new Map();
const summaryProgress = new WeakMap();
const SUMMARY_STORAGE_KEY = 'reader-summary-cache-v2180';
const SUMMARY_STORAGE_LIMIT = 84;
const IMPORTANT_RE = /(?:[+＋\-−]?\d[\d,.]*(?:\.\d+)?\s*(?:%|％|倍|兆円|億円|万円|円|ドル|人|件|台|社|年|か月|ヶ月|日|時間|分|秒|nm|μm|mm|cm|km|℃|°C|GW|MW|kW|GWh|MWh|kWh|Wh|TB|GB|MB)|世界初|国内初|業界初|史上初|世界最大|国内最大|世界最小|国内最小|過去最高|過去最低|最高値|最安値|初めて|新記録|首位|No\.?\s*1|突破|倍増|半減)/giu;
const GENERIC_SUMMARY_RE = /(?:についての記事です|について紹介(?:する|しています)|背景や特徴.*(?:整理|確認)|影響や今後.*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?で確認|要約を(?:取得|作成)できません|詳しくは元記事|続報の確認が必要)/i;
const BROKEN_EDGE_RE = /^(?:[」』）】〉》]|[\s]*[!?！？])|[「『（【〈《]\s*$/;

function summaryTtl(mode = '') {
  return mode === 'papers' ? 14 * 24 * 60 * 60 * 1000 : 36 * 60 * 60 * 1000;
}

function readStoredSummaries() {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw || {})) {
      if (!entry?.value || !entry?.ts || entry.value?.cacheable === false) continue;
      const mode = String(entry.mode || '');
      if (now - Number(entry.ts) > summaryTtl(mode)) continue;
      if (!isUsableSummary(entry.value)) continue;
      summaryCache.set(key, entry.value);
    }
  } catch {}
}

function persistSummary(key, value, mode = '') {
  if (!value || value.cacheable === false || !isUsableSummary(value)) return;
  try {
    const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY) || '{}');
    raw[key] = { value, ts: Date.now(), mode };
    const entries = Object.entries(raw)
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, SUMMARY_STORAGE_LIMIT);
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function stripHtml(value = '') {
  const d = document.createElement('div');
  d.innerHTML = String(value || '');
  return (d.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}
function plainText(value = '') { return stripHtml(String(value || '').replace(/\*\*/g, '')); }
function looksMostlyEnglish(value = '') {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ja = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return latin >= 24 && latin > ja * 1.35;
}
function summaryModeOf(item, fallback = '') { return String(item?._readerMode || fallback || '').trim(); }
function focusItemKey(item) { return articleIdentity(item); }

function itemDateLabel(item) {
  const description = String(item?.description || '');
  const yearOnly = description.match(/(?:公開年|出版年):\s*(\d{4})/)?.[1];
  if (item?.dateValid === false || Number(item?.publishedTimestamp) === 0) return '日付不明';
  if (/日付精度:\s*不明/.test(description)) return '日付不明';
  if (/日付精度:\s*年/.test(description) && yearOnly) return `${yearOnly}年`;
  return shortDate(item?.pubDate);
}

function itemLabel(item, fallback = 'おすすめ') {
  if (item?._recommendationLabel) return item._recommendationLabel;
  if (item?._readerMode === 'news') return 'ニュース';
  if (item?._readerMode === 'knowledge') return '知識';
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '製品熱研究';
    if (item?._creativeFamily === 'general') return '一般独創';
    if (item?._creativeFamily === 'applied') return '応用発想';
    return '独創研究';
  }
  return fallback;
}

function categoryHeaderLabel(item, fallback = 'おすすめ') {
  if (item?._readerMode === 'news') return item?.feedName ? `ニュース:${item.feedName}` : 'ニュース';
  if (item?._readerMode === 'knowledge') return item?.feedName ? `知識:${item.feedName}` : '知識';
  if (item?._readerMode === 'papers') {
    if (item?._paperTrack === 'core') return '論文:製品熱研究';
    if (item?._creativeFamily === 'general') return '論文:一般独創';
    if (item?._creativeFamily === 'applied') return '論文:応用発想';
    return '論文:独創研究';
  }
  return itemLabel(item, fallback);
}

function summaryKey(item, mode = '') {
  return `${item?.link || item?.id || item?.title || ''}::${summaryModeOf(item, mode) || 'auto'}::v2180`;
}

function summaryLines(summary) {
  const labels = ['結論/事実', '背景/特徴', '影響/展望'];
  if (Array.isArray(summary?.lines) && summary.lines.length) {
    return labels.map((label, index) => ({ label: summary.lines[index]?.label || label, text: summary.lines[index]?.text || '' }));
  }
  const points = Array.isArray(summary?.points) ? summary.points : [];
  return [
    { label: labels[0], text: summary?.short || '' },
    { label: labels[1], text: points[0] || '' },
    { label: labels[2], text: points[1] || '' }
  ];
}

function isUsableSummary(summary) {
  if (!summary || ['pending', 'instant', 'insufficient', 'unavailable'].includes(String(summary.provider || ''))) return false;
  const lines = summaryLines(summary).map(row => plainText(row.text));
  if (lines.length !== 3 || lines.some(text => text.length < 12)) return false;
  if (lines.some(text => GENERIC_SUMMARY_RE.test(text) || BROKEN_EDGE_RE.test(text))) return false;
  if (lines.some(text => /(?:…|\.{3})\s*$/.test(text))) return false;
  if (lines.some(text => !/[。！？!?][」』）】〉》]?$/.test(text))) return false;
  return new Set(lines.map(text => text.replace(/[。、，,.!！?？\s]/g, '').toLowerCase())).size === 3;
}

function cachedSummary(item, mode = '') {
  const value = summaryCache.get(summaryKey(item, mode));
  return isUsableSummary(value) ? value : null;
}

function storeSummary(item, mode, summary) {
  if (!isUsableSummary(summary)) return false;
  const key = summaryKey(item, mode);
  summaryCache.set(key, summary);
  persistSummary(key, summary, summaryModeOf(item, mode));
  while (summaryCache.size > SUMMARY_STORAGE_LIMIT) summaryCache.delete(summaryCache.keys().next().value);
  return true;
}

function sentenceCandidates(value = '') {
  const text = plainText(value).replace(/([。！？!?])(?=[^」』）】〉》])/g, '$1\n');
  return (text.split(/\n+/).flatMap(row => row.match(/[^。！？!?]+[。！？!?]+(?:[」』）】〉》])?/g) || []))
    .map(row => row.trim()).filter(row => row.length >= 12).slice(0, 30);
}
function meaningfulCandidate(value = '') {
  const text = plainText(value);
  if (text.length < 12 || GENERIC_SUMMARY_RE.test(text) || BROKEN_EDGE_RE.test(text)) return false;
  if (!/[。！？!?][」』）】〉》]?$/.test(text)) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 10;
}
function descriptionNeedsFullText(item, description, mode) {
  if (mode === 'papers') return true;
  const text = plainText(description);
  if (text.length < 620) return true;
  if (sentenceCandidates(text).filter(meaningfulCandidate).length < 3) return true;
  const title = plainText(item?.title).replace(/[\s、。・:：\-—|｜]/g, '');
  const compact = text.replace(/[\s、。・:：\-—|｜]/g, '');
  return title.length >= 14 && compact.includes(title.slice(0, Math.min(36, title.length)));
}

function summaryPayload(item, mode = '') {
  const activeMode = summaryModeOf(item, mode) || 'auto';
  const description = stripHtml(item?.description).slice(0, 16_000);
  return {
    articleId: focusItemKey(item),
    url: item?.link,
    title: item?.title,
    description,
    source: item?.source || item?.feedName,
    category: categoryHeaderLabel(item),
    mode: activeMode,
    preferFullText: descriptionNeedsFullText(item, description, activeMode),
    forceJapanese: looksMostlyEnglish(`${item?.title || ''}\n${description}`),
    allowAi: true,
    fast: activeMode !== 'papers'
  };
}

async function fetchSummary(item, { force = false, mode = '', purpose = 'active' } = {}) {
  const activeMode = summaryModeOf(item, mode);
  const key = summaryKey(item, activeMode);
  const articleId = focusItemKey(item);
  if (!force && summaryCache.has(key)) {
    readerTrace('summary-cache-hit', { articleId, title: item?.title || '', mode: activeMode, purpose });
    return summaryCache.get(key);
  }
  if (!force && summaryPromises.has(key)) {
    readerTrace('summary-inflight-reuse', { articleId, title: item?.title || '', mode: activeMode, purpose });
    return summaryPromises.get(key);
  }

  const controller = new AbortController();
  const waitMs = activeMode === 'papers' ? 32_000 : 28_000;
  const timeout = setTimeout(() => controller.abort(), waitMs);
  const started = performance.now();
  readerTrace('summary-request-start', { articleId, title: item?.title || '', mode: activeMode, purpose, timeoutMs: waitMs });

  let request;
  request = fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    cache: 'no-store',
    body: JSON.stringify(summaryPayload(item, activeMode))
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    const usable = response.ok && isUsableSummary(data);
    readerTrace('summary-request-finish', {
      articleId,
      title: item?.title || '',
      mode: activeMode,
      purpose,
      status: response.status,
      provider: String(data?.provider || ''),
      model: String(data?.model || ''),
      usable,
      elapsedMs: Math.round(performance.now() - started),
      fallbackReason: String(data?.fallbackReason || '')
    });
    if (!usable) return unavailableSummary(item, data);
    storeSummary(item, activeMode, data);
    return data;
  }).catch(error => {
    readerTrace('summary-request-error', {
      articleId,
      title: item?.title || '',
      mode: activeMode,
      purpose,
      error: String(error?.name || 'Error') + ':' + String(error?.message || error),
      elapsedMs: Math.round(performance.now() - started)
    });
    return unavailableSummary(item);
  }).finally(() => {
    clearTimeout(timeout);
    if (summaryPromises.get(key) === request) summaryPromises.delete(key);
  });

  summaryPromises.set(key, request);
  return request;
}

// Kept as a public compatibility function because reader.js calls it.
// v2.19.5 intentionally limits prefetch to ONE article and uses the normal
// article-keyed single-summary path. No 10-item Gemini batch is created here.
export function prewarmSummaryChunk(items, { startIndex = 1, count = 1, summaryMode = '' } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const start = clampReaderIndex(startIndex, rows.length || 1);
  if (!rows.length || start >= rows.length || Number(count) <= 0) return Promise.resolve([]);
  const item = rows[start];
  const mode = summaryModeOf(item, summaryMode);
  readerTrace('summary-prefetch', { index: start, articleId: focusItemKey(item), title: item?.title || '', requestedCount: Number(count) || 0, actualCount: 1 });
  return Promise.all([fetchSummary(item, { mode, purpose: 'prefetch' })]);
}

readStoredSummaries();

function compactHeadline(item) {
  const original = plainText(item?.titleJa || item?.title || '記事');
  if (looksMostlyEnglish(original) && !plainText(item?.titleJa)) return '日本語タイトルを生成中…';
  if (Array.from(original).length <= 46) return original;
  const split = original.split(/\s*[｜|：:]\s*|\s+[—–-]\s+|[。！？!?]/).map(v => v.trim()).filter(Boolean);
  const natural = split.find(v => Array.from(v).length >= 12 && Array.from(v).length <= 46);
  if (natural) return natural;
  const bracketless = original.replace(/[（(][^）)]{1,40}[）)]\s*$/, '').trim();
  return Array.from(bracketless).length <= 50 ? bracketless : '記事の要点を整理中…';
}

const translatedTitleCache = new Map();
async function translateTitleToJapanese(item) {
  const original = plainText(item?.title || '');
  if (!looksMostlyEnglish(original)) return plainText(item?.titleJa || original);
  if (plainText(item?.titleJa) && !looksMostlyEnglish(item.titleJa)) return plainText(item.titleJa);
  if (translatedTitleCache.has(original)) return translatedTitleCache.get(original);
  try {
    const response = await fetch('/api/paper-titles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles: [original] }), signal: AbortSignal.timeout(7000)
    });
    const data = await response.json().catch(() => ({}));
    const row = Array.isArray(data?.translations) ? data.translations.find(entry => entry?.original === original) || data.translations[0] : null;
    const translated = plainText(row?.ja || '');
    if (!response.ok || !translated || looksMostlyEnglish(translated)) return '';
    translatedTitleCache.set(original, translated);
    return translated;
  } catch { return ''; }
}

function pendingSummary(item) {
  return {
    headline: compactHeadline(item),
    lines: [
      { label: '結論/事実', text: '本文から重要な事実を抽出しています…' },
      { label: '背景/特徴', text: '背景・方法・特徴を確認しています…' },
      { label: '影響/展望', text: '影響や今後の意味を整理しています…' }
    ],
    provider: 'pending', cacheable: false
  };
}

function unavailableSummary(item, serverResult = null) {
  return {
    headline: plainText(serverResult?.headline) || compactHeadline(item),
    lines: [
      { label: '結論/事実', text: '本文を十分に取得できず、正確な要約を作成できませんでした。' },
      { label: '背景/特徴', text: 'タイトルだけから内容を推測する表示は行わないようにしています。' },
      { label: '影響/展望', text: '元記事を開くと、取得できていない詳細を確認できます。' }
    ],
    provider: 'unavailable', cacheable: false,
    fallbackReason: String(serverResult?.fallbackReason || '')
  };
}

function gridIconSvg() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"></rect><rect x="14" y="3" width="7" height="7" rx="2"></rect><rect x="3" y="14" width="7" height="7" rx="2"></rect><rect x="14" y="14" width="7" height="7" rx="2"></rect></svg>`;
}
function appendHighlightedText(target, text = '', { strong = false } = {}) {
  if (!text) return;
  if (strong) { target.append(el('strong', { text })); return; }
  IMPORTANT_RE.lastIndex = 0;
  const matches = [...String(text).matchAll(IMPORTANT_RE)];
  if (!matches.length) { target.append(document.createTextNode(text)); return; }
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index > cursor) target.append(document.createTextNode(text.slice(cursor, index)));
    target.append(el('strong', { class: 'reader-summary-keyword', text: match[0] }));
    cursor = index + match[0].length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}
function setRichText(node, value = '') {
  node.replaceChildren();
  appendHighlightedText(node, String(value || ''));
}
function renderSummaryBlock(node, summary) {
  node.replaceChildren();
  node.classList.toggle('is-pending', summary?.provider === 'pending');
  node.classList.toggle('is-unavailable', summary?.provider === 'unavailable');
  summaryLines(summary).forEach(line => {
    const text = el('span', { class: 'reader-story-summary-text' });
    setRichText(text, line.text || '—');
    node.append(el('div', { class: 'reader-story-summary-row' }, [
      el('div', { class: 'reader-story-summary-copy' }, [
        el('span', { class: 'reader-story-summary-label', text: line.label || '' }), text
      ])
    ]));
  });
}
function sourceNameOf(item) { return String(item?.source || item?.feedName || 'RSS').trim() || 'RSS'; }
function faviconUrlOf(item) { try { return `${new URL(String(item?.link || item?.url || '')).origin}/favicon.ico`; } catch { return ''; } }
function sourceInitialOf(item) {
  const source = sourceNameOf(item).replace(/^www\./i, '');
  const words = source.match(/[A-Za-z0-9]+/g) || [];
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2).toUpperCase();
  return Array.from(source.replace(/[\s・:：]/g, ''))[0] || 'R';
}
function createSourceMark(item) {
  const mark = el('span', { class: 'reader-story-source-mark', text: sourceInitialOf(item) });
  const favicon = faviconUrlOf(item);
  if (!favicon) return mark;
  const logo = el('img', { class: 'reader-story-source-logo', src: favicon, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  logo.addEventListener('error', () => logo.remove(), { once: true });
  mark.append(logo);
  return mark;
}
function progressMarkup() {
  const wrap = el('div', { class: 'reader-ai-progress reader-ai-progress-inline', 'data-reader-progress': '1' });
  const bar = el('span', { class: 'reader-ai-progress-bar', 'data-reader-progress-bar': '1' });
  bar.style.width = '10%';
  wrap.append(
    el('div', { class: 'reader-ai-progress-top' }, [
      el('span', { class: 'reader-ai-loading-text', 'data-reader-loading-text': '1', text: '本文を取得しています' }),
      el('span', { class: 'reader-ai-progress-value', 'data-reader-progress-value': '1', text: '10%' })
    ]),
    el('div', { class: 'reader-ai-progress-track' }, [bar])
  );
  return wrap;
}
function stopProgress(card) {
  const state = summaryProgress.get(card);
  if (!state) return;
  state.timers.forEach(clearTimeout);
  summaryProgress.delete(card);
}
function setProgress(card, value, text) {
  const bar = card?.querySelector('[data-reader-progress-bar]');
  const label = card?.querySelector('[data-reader-loading-text]');
  const number = card?.querySelector('[data-reader-progress-value]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (label && text) label.textContent = text;
  if (number) number.textContent = `${Math.round(value)}%`;
}
function startProgress(card) {
  if (!card?.isConnected || summaryProgress.has(card)) return;
  const steps = [[180,20,'RSS本文を確認中'],[650,36,'元記事本文を取得中'],[1700,54,'具体的な事実を抽出中'],[3600,70,'結論・背景・影響へ整理中'],[6500,84,'日本語タイトルと要約を仕上げ中'],[10000,93,'品質を確認中']];
  summaryProgress.set(card, { timers: steps.map(([delay, value, text]) => setTimeout(() => setProgress(card, value, text), delay)) });
}
function setCardSummary(card, item, summary, expectedArticleId = focusItemKey(item)) {
  if (!card?.isConnected) return false;
  if (card.dataset.articleId && card.dataset.articleId !== expectedArticleId) {
    readerTrace('summary-apply-skipped', { expectedArticleId, cardArticleId: card.dataset.articleId, provider: String(summary?.provider || '') });
    return false;
  }
  stopProgress(card);
  const summaryNode = card.querySelector('[data-reader-summary]');
  const title = card.querySelector('[data-reader-title]');
  if (title) setRichText(title, summary?.headline || compactHeadline(item));
  if (summaryNode) renderSummaryBlock(summaryNode, summary);
  card.querySelector('[data-reader-progress]')?.remove();
  card.dataset.summaryProvider = String(summary?.provider || '');
  readerTrace('summary-applied', { articleId: expectedArticleId, title: item?.title || '', provider: String(summary?.provider || '') });
  return true;
}

function buildHero(item, index, label, onList, card) {
  const hero = el('section', { class: 'reader-story-hero', 'aria-label': '記事情報' });
  if (item?.image) {
    const image = el('img', { class: 'reader-story-hero-image', src: item.image, alt: '', loading: index <= 1 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    image.addEventListener('error', () => image.remove(), { once: true });
    hero.append(image);
  }
  hero.append(el('div', { class: 'reader-story-hero-mesh', 'aria-hidden': 'true' }));
  const grid = el('button', { class: 'reader-grid-fab reader-story-grid', type: 'button', title: 'Bento一覧', 'aria-label': 'Bento一覧へ', html: gridIconSvg(), onclick: () => onList?.({ index, item, card }) });
  hero.append(
    el('div', { class: 'reader-story-hero-top' }, [
      el('div', { class: 'reader-story-source' }, [createSourceMark(item), el('div', { class: 'reader-story-source-copy' }, [el('strong', { class: 'reader-story-source-name', text: sourceNameOf(item) }), el('span', { class: 'reader-story-time', text: itemDateLabel(item) })])]), grid
    ]),
    el('div', { class: 'reader-story-hero-bottom' }, [el('span', { class: 'reader-story-category-badge', text: categoryHeaderLabel(item, label) })])
  );
  return hero;
}

function buildFeedCard(item, index, { label, onList, summaryMode, sharedKey }) {
  const mode = summaryModeOf(item, summaryMode);
  const articleId = focusItemKey(item) || String(index);
  const card = el('section', { class: 'reader-swipe-card reader-story-card', 'data-index': String(index), 'data-key': articleId, 'data-article-id': articleId });
  if (sharedKey && sharedKey === focusItemKey(item)) card.style.viewTransitionName = 'reader-shared-card';
  const cached = cachedSummary(item, mode);
  const initial = cached || pendingSummary(item);
  const title = el('h2', { class: 'reader-swipe-title reader-story-title', 'data-reader-title': '1' });
  setRichText(title, initial.headline || compactHeadline(item));
  const summaryBox = el('div', { class: 'reader-ai-summary reader-story-summary', 'data-reader-summary': '1' });
  renderSummaryBlock(summaryBox, initial);
  const content = el('main', { class: 'reader-story-content' }, [title, summaryBox]);
  if (!cached) content.append(progressMarkup());
  const original = el('a', { class: 'reader-story-open', href: item?.link || '#', target: '_blank', rel: 'noopener noreferrer', text: '元記事を読む ↗' });
  card.append(buildHero(item, index, label, onList, card), content, el('footer', { class: 'reader-story-actions' }, [original]));
  card.dataset.summaryProvider = String(cached?.provider || (cached ? 'cache' : 'pending'));
  return card;
}

function loadCardSummary(card, item, mode) {
  if (!card?.isConnected) return Promise.resolve(null);
  const expectedArticleId = focusItemKey(item);
  card.dataset.articleId = expectedArticleId;
  const cached = cachedSummary(item, mode);
  if (cached) {
    setCardSummary(card, item, cached, expectedArticleId);
    return Promise.resolve(cached);
  }

  startProgress(card);
  if (looksMostlyEnglish(item?.title || '') && !plainText(item?.titleJa)) {
    translateTitleToJapanese(item).then(translated => {
      if (!translated || !card.isConnected || card.dataset.articleId !== expectedArticleId) return;
      if (card.dataset.summaryProvider && card.dataset.summaryProvider !== 'pending') return;
      const title = card.querySelector('[data-reader-title]');
      if (title) setRichText(title, compactHeadline({ ...item, titleJa: translated }));
    }).catch(() => {});
  }

  // The visible article ALWAYS uses its own article-keyed single-summary path.
  // It never waits for a batch/prewarm promise.
  return fetchSummary(item, { mode, purpose: 'active' }).then(summary => {
    if (!card.isConnected || card.dataset.articleId !== expectedArticleId) {
      readerTrace('summary-stale-result', { expectedArticleId, cardArticleId: card.dataset.articleId || '', title: item?.title || '' });
      return summary;
    }
    if (isUsableSummary(summary)) {
      setCardSummary(card, item, summary, expectedArticleId);
      return summary;
    }
    setProgress(card, 100, '本文取得を完了');
    setTimeout(() => {
      if (card.isConnected && card.dataset.articleId === expectedArticleId) setCardSummary(card, item, summary, expectedArticleId);
    }, 100);
    return summary;
  });
}

function nearestCardIndex(feed, cards) {
  if (!cards.length) return 0;
  const height = Number(feed.clientHeight || 0);
  if (height <= 1) return 0;
  const estimated = clampReaderIndex(Math.round(Math.max(0, feed.scrollTop) / height), cards.length);
  let best = estimated;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of [estimated - 1, estimated, estimated + 1]) {
    if (candidate < 0 || candidate >= cards.length) continue;
    const distance = Math.abs(Number(cards[candidate]?.offsetTop || 0) - Math.max(0, feed.scrollTop));
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

export function mountFocus(host, {
  items,
  initialIndex = 0,
  label = 'おすすめ',
  onList,
  onIndexChange,
  onPrevFeed,
  onNextFeed,
  summaryMode = '',
  sharedKey = ''
}) {
  const rows = Array.isArray(items) ? items : [];
  let index = clampReaderIndex(initialIndex, rows.length);
  let activeIndex = -1;
  let destroyed = false;
  let scrollRaf = 0;

  if (!rows.length) {
    host.replaceChildren(el('div', { class: 'empty', text: '記事がありません' }));
    return { destroy(){}, go(){} };
  }

  readerTrace('focus-mount', readerFlowSnapshot(rows, index));
  const feed = el('div', { class: 'reader-swipe-feed', tabindex: '0' });
  const cards = rows.map((item, i) => buildFeedCard(item, i, { label, onList, summaryMode, sharedKey: sharedKey || focusItemKey(rows[index]) }));
  cards.forEach(card => feed.append(card));
  host.replaceChildren(feed);

  const warmNext = currentIndex => {
    if (destroyed) return;
    const [nextIndex] = nextPrefetchIndices(currentIndex, rows.length, 1);
    if (nextIndex === undefined) return;
    prewarmSummaryChunk(rows, { startIndex: nextIndex, count: 1, summaryMode }).then(() => {
      if (destroyed) return;
      const item = rows[nextIndex];
      const summary = cachedSummary(item, summaryModeOf(item, summaryMode));
      if (summary) setCardSummary(cards[nextIndex], item, summary, focusItemKey(item));
    }).catch(() => {});
  };

  const setActive = next => {
    if (destroyed) return;
    const nextIndex = clampReaderIndex(next, rows.length);
    if (activeIndex === nextIndex) return;
    const previousIndex = activeIndex;
    activeIndex = nextIndex;
    index = nextIndex;
    cards.forEach((card, i) => card.classList.toggle('is-active', i === index));
    const activeItem = rows[index];
    readerTrace('swipe-index', {
      from: previousIndex,
      to: index,
      totalArticles: rows.length,
      currentArticleId: focusItemKey(activeItem),
      currentTitle: activeItem?.title || ''
    });
    onIndexChange?.(index, activeItem);

    const requestedIndex = index;
    loadCardSummary(cards[index], activeItem, summaryModeOf(activeItem, summaryMode))
      .finally(() => {
        if (!destroyed && activeIndex === requestedIndex) warmNext(requestedIndex);
      });
  };

  const syncFromScroll = () => {
    scrollRaf = 0;
    if (destroyed) return;
    setActive(nearestCardIndex(feed, cards));
  };
  const onScroll = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(syncFromScroll);
  };
  const onScrollEnd = () => syncFromScroll();

  feed.addEventListener('scroll', onScroll, { passive: true });
  if ('onscrollend' in feed) feed.addEventListener('scrollend', onScrollEnd, { passive: true });

  // No 10-item initial batch. The active article is loaded first; once it
  // settles, only the immediate next article is prefetched.
  requestAnimationFrame(() => {
    cards[index]?.scrollIntoView({ block: 'start', behavior: 'auto' });
    setActive(index);
  });

  return {
    destroy() {
      destroyed = true;
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      feed.removeEventListener('scroll', onScroll);
      if ('onscrollend' in feed) feed.removeEventListener('scrollend', onScrollEnd);
      cards.forEach(stopProgress);
    },
    go(nextIndex) {
      const next = clampReaderIndex(nextIndex, rows.length);
      cards[next]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActive(next);
    },
    getIndex(){ return index; },
    getItem(){ return rows[index]; }
  };
}
