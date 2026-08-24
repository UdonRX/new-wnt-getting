const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const FAILURE_PROVIDERS = new Set(['pending', 'instant', 'insufficient', 'unavailable']);
const INSTANT_RENDER_RETRY_MS = [0, 16, 48, 120, 260];
const INSTANT_PAYLOAD_LIMIT = 64;
const instantPayloads = new Map();
let activeObserver = null;
let activeRenderQueued = false;

function cleanText(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function normalizedKey(value = '') {
  return cleanText(value)
    .replace(/[\s。、，,.!！?？:：;；・｜|／/—–-]/g, '')
    .toLowerCase();
}

function likelyPublisher(value = '', body = {}) {
  const text = cleanText(value);
  if (!text) return true;
  const source = cleanText(body?.source || '');
  if (source && normalizedKey(text) === normalizedKey(source)) return true;
  return /^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)/.test(text)
    && Array.from(text).length <= 36;
}

function clip(value = '', limit = 88) {
  const chars = Array.from(cleanText(value));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}

function pushUnique(rows, seen, value, body = {}) {
  const text = cleanText(value);
  if (Array.from(text).length < 8 || likelyPublisher(text, body)) return;
  const key = normalizedKey(text);
  if (!key || seen.has(key)) return;
  seen.add(key);
  rows.push(clip(text));
}

function extractInstantContent(body = {}) {
  const description = cleanText(body?.description || '');
  const title = cleanText(body?.title || '');
  const rows = [];
  const seen = new Set();
  const descriptionSentences = description.match(/[^。！？!?]+[。！？!?]?/g) || [];

  if (descriptionSentences.length >= 2) {
    for (const sentence of descriptionSentences) {
      pushUnique(rows, seen, sentence, body);
      if (rows.length >= 3) break;
    }
  } else {
    // v2.19.15: 短いRSSも推測せず、本文・タイトル・カテゴリから即時3カードを作る。
    for (const part of description.split(/[、，,:：;；｜|／/・]|\s+[—–-]\s+/g)) {
      pushUnique(rows, seen, part, body);
      if (rows.length >= 2) break;
    }
    if (!rows.length) pushUnique(rows, seen, description, body);
  }

  if (rows.length < 2) {
    for (const part of title.split(/[、，,:：;；｜|／/・]|\s+[—–-]\s+/g)) {
      pushUnique(rows, seen, part, body);
      if (rows.length >= 2) break;
    }
  }
  if (!rows.length) pushUnique(rows, seen, title, body);
  return rows.slice(0, 3);
}

export function buildInstantUxRows(body = {}) {
  const content = extractInstantContent(body);
  const rows = content.map((text, index) => ({ label: `要点 ${index + 1}`, text }));
  const category = cleanText(body?.category || '');
  const source = cleanText(body?.source || '');
  const metadata = [
    { label: 'カテゴリ', text: category },
    { label: '媒体', text: source }
  ];

  for (const row of metadata) {
    if (rows.length >= 3) break;
    if (!row.text) continue;
    const duplicate = rows.some(existing => normalizedKey(existing.text) === normalizedKey(row.text));
    if (!duplicate) rows.push(row);
  }

  const title = cleanText(body?.title || '');
  if (rows.length < 3 && title) {
    const duplicate = rows.some(existing => normalizedKey(existing.text) === normalizedKey(title));
    if (!duplicate) rows.push({ label: '記事', text: clip(title) });
  }

  while (rows.length < 3) {
    const fallback = rows[0]?.text || title || source || category || '記事を読み込んでいます';
    rows.push({ label: `要点 ${rows.length + 1}`, text: fallback });
  }
  return rows.slice(0, 3);
}

function parseSummaryPost(input, init = {}) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || typeof init?.body !== 'string') return null;
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.href); }
  catch { return null; }
  if (url.pathname !== SUMMARY_PATH || url.searchParams.has('batch') || url.searchParams.has('stream')) return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  const articleId = String(body?.articleId || '').trim();
  return articleId ? { articleId, body } : null;
}

function rememberParsed(parsed) {
  const articleId = String(parsed?.articleId || '');
  if (!articleId) return;
  if (instantPayloads.has(articleId)) instantPayloads.delete(articleId);
  instantPayloads.set(articleId, parsed);
  while (instantPayloads.size > INSTANT_PAYLOAD_LIMIT) {
    instantPayloads.delete(instantPayloads.keys().next().value);
  }
}

function activeCardFor(articleId) {
  const card = document.querySelector('.reader-swipe-card.is-active[data-article-id]');
  return String(card?.dataset?.articleId || '') === String(articleId || '') ? card : null;
}

function providerUsable(card) {
  const provider = String(card?.dataset?.summaryProvider || '');
  return Boolean(provider) && !FAILURE_PROVIDERS.has(provider);
}

function renderInstantUx(parsed) {
  if (typeof document === 'undefined') return false;
  const card = activeCardFor(parsed?.articleId);
  if (!card || providerUsable(card)) return false;
  const node = card.querySelector('[data-reader-summary]');
  if (!node) return false;

  const rows = buildInstantUxRows(parsed.body);
  node.replaceChildren();
  node.classList.remove('is-pending', 'is-unavailable');
  node.dataset.instantPreview = 'v21915';

  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reader-story-summary-row';
    const copy = document.createElement('div');
    copy.className = 'reader-story-summary-copy';
    const label = document.createElement('span');
    label.className = 'reader-story-summary-label';
    label.textContent = row.label;
    const text = document.createElement('span');
    text.className = 'reader-story-summary-text';
    text.textContent = row.text;
    copy.append(label, text);
    wrapper.append(copy);
    node.append(wrapper);
  }

  // 即時要点が見えた時点で「待ち時間UI」を消す。正式AI要約は既存処理が同じ枠へ上書きする。
  card.querySelector('[data-reader-progress]')?.remove();
  try {
    node.animate?.([
      { opacity: 0.62, transform: 'translateY(2px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 110, easing: 'ease-out' });
  } catch {}
  return true;
}

function scheduleInstantUx(parsed) {
  let finished = false;
  for (const delay of INSTANT_RENDER_RETRY_MS) {
    const run = () => {
      if (finished) return;
      const card = activeCardFor(parsed?.articleId);
      if (card && providerUsable(card)) { finished = true; return; }
      if (renderInstantUx(parsed)) finished = true;
    };
    if (delay === 0) queueMicrotask(run);
    else setTimeout(run, delay);
  }
}

function renderStoredActiveUx() {
  if (typeof document === 'undefined') return false;
  const card = document.querySelector('.reader-swipe-card.is-active[data-article-id]');
  if (!card || providerUsable(card)) return false;
  const parsed = instantPayloads.get(String(card.dataset.articleId || ''));
  return parsed ? renderInstantUx(parsed) : false;
}

function queueStoredActiveUx() {
  if (activeRenderQueued) return;
  activeRenderQueued = true;
  queueMicrotask(() => {
    activeRenderQueued = false;
    renderStoredActiveUx();
  });
}

function installActiveObserver() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || activeObserver) return;
  const root = document.getElementById('app-main') || document.body;
  if (!root) return;
  activeObserver = new MutationObserver(mutations => {
    const activeCardChanged = mutations.some(mutation =>
      mutation.type === 'attributes'
      && mutation.attributeName === 'class'
      && mutation.target?.matches?.('.reader-swipe-card')
    );
    if (activeCardChanged) queueStoredActiveUx();
  });
  activeObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
  queueStoredActiveUx();
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_SUMMARY_INSTANT_UX_INSTALLED) {
  window.__PDV2_SUMMARY_INSTANT_UX_INSTALLED = true;
  globalThis.fetch = function instantUxFetch(input, init = {}) {
    const parsed = parseSummaryPost(input, init);
    const response = upstreamFetch(input, init);
    if (parsed) {
      rememberParsed(parsed);
      scheduleInstantUx(parsed);
    }
    return response;
  };
  installActiveObserver();
}