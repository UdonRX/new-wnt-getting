const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const FAILURE_PROVIDERS = new Set(['pending', 'instant', 'insufficient', 'unavailable']);

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
    // v2.19.13: Google Newsのような「1文だけ」のRSSは、推測せず読点・区切りで抽出的に分ける。
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
  const source = cleanText(body?.source || '');
  const category = cleanText(body?.category || '');

  if (rows.length < 3 && (source || category)) {
    rows.push({
      label: '記事情報',
      text: [category, source].filter(Boolean).join(' ・ ')
    });
  }
  while (rows.length < 3) {
    rows.push({ label: 'AI確認中', text: '正式なAI要約を確認しています…' });
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
  node.dataset.instantPreview = 'v21913';

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

  // 即時要点が見えている間は大きな進捗率を見せず、「待つ」感覚を消す。
  card.querySelector('[data-reader-progress]')?.remove();
  try {
    node.animate?.([
      { opacity: 0.55, transform: 'translateY(2px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 120, easing: 'ease-out' });
  } catch {}
  return true;
}

if (upstreamFetch && typeof window !== 'undefined' && !window.__PDV2_SUMMARY_INSTANT_UX_INSTALLED) {
  window.__PDV2_SUMMARY_INSTANT_UX_INSTALLED = true;
  globalThis.fetch = function instantUxFetch(input, init = {}) {
    const parsed = parseSummaryPost(input, init);
    const response = upstreamFetch(input, init);
    // 既存summary gateの即時表示が同期実行された直後に、より情報量の多い3カードへ置き換える。
    if (parsed) queueMicrotask(() => renderInstantUx(parsed));
    return response;
  };
}
