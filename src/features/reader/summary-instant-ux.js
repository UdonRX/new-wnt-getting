const upstreamFetch = globalThis.fetch?.bind(globalThis);
const SUMMARY_PATH = '/api/summary';
const FAILURE_PROVIDERS = new Set(['pending', 'instant', 'insufficient', 'unavailable']);
const INSTANT_RENDER_RETRY_MS = [0, 16, 48, 120, 260];
const INSTANT_PAYLOAD_LIMIT = 64;
const instantPayloads = new Map();
let activeObserver = null;
let activeRenderQueued = false;
let finalHighlightQueued = false;

// v2.19.17: 正式AI要約の強調は「結論動作・数値・固有名詞/キーアイテム・変化」を優先し、
// 1文1〜2箇所、概ね10〜20%に抑える。AI生成内容自体は変更しない。
const FINAL_HIGHLIGHT_VERSION = '21917';
const NUMBER_RE = /[+＋\-−]?\d[\d,.]*(?:\.\d+)?\s*(?:%|％|倍|兆円|億円|万円|円|ドル|人|件|台|社|年|か月|ヶ月|日|時間|分|秒|nm|μm|mm|cm|km|℃|°C|GW|MW|kW|GWh|MWh|kWh|Wh|TB|GB|MB)/giu;
const ACTION_CORE_RE = /([^、。！？!?]{2,18}?)(を|と|に)(発表|開始|導入|締結|決定|閣議決定|廃止|発売|公開|設立|買収|売却|承認|可決|成立|改定|解除|停止|再開|実施|開発|採用|受注|発足|結んだ|結ぶ|合意|移行|転換|参入)(した|する|へ)?/gu;
const CHANGE_RE = /(?:世界初|国内初|業界初|史上初|初の試み|初めて|過去最大|過去最高|過去最低|前年比(?:で)?[^、。！？!?]{0,8}(?:増|減|上昇|下落)|大幅(?:増|減|増加|減少|上昇|下落|拡大|縮小)|急増|急減|倍増|半減|撤退|転換|刷新|廃止|再開)/gu;
const ORG_RE = /(?:株式会社)?[一-龯ァ-ヶA-Za-z0-9][一-龯ぁ-んァ-ヶA-Za-z0-9・＆&ー]{1,18}(?:社|銀行|政府|省|庁|大学|研究所|研究機構|委員会|協会|機構|自動車|電機|電気|製作所|鉄道|通信)/gu;
const LATIN_ENTITY_RE = /\b(?:OpenAI|NVIDIA|Google|Microsoft|Apple|Amazon|Meta|Tesla|Gemini|ChatGPT|[A-Z][A-Za-z0-9.+-]{2,14})\b/g;
const QUOTED_KEY_RE = /[「『][^」』\n]{2,14}[」』]/gu;
const KEY_ITEM_RE = /[一-龯ぁ-んァ-ヶA-Za-z0-9・ー]{2,18}(?:法案|政策|規制|計画|プロジェクト|システム|技術|モデル)/gu;
const GENERIC_SUBJECT_RE = /^(?:同社|同氏|政府|企業|市場|今回|これ|それ|一方|関係者|業界)$/u;

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

function sentenceSpans(text = '') {
  const spans = [];
  const re = /[^。！？!?]+[。！？!?]?/g;
  let match;
  while ((match = re.exec(String(text)))) {
    if (match[0]) spans.push({ start: match.index, text: match[0] });
  }
  return spans.length ? spans : [{ start: 0, text: String(text) }];
}

function addHighlightCandidate(rows, start, end, score, kind) {
  if (end > start) rows.push({ start, end, score, kind });
}

function addPatternMatches(rows, sentence, base, regex, score, kind) {
  regex.lastIndex = 0;
  for (const match of sentence.matchAll(regex)) {
    const raw = match[0];
    const local = match.index ?? 0;
    const leading = raw.match(/^\s*/)?.[0]?.length || 0;
    const trailing = raw.match(/\s*$/)?.[0]?.length || 0;
    addHighlightCandidate(rows, base + local + leading, base + local + raw.length - trailing, score, kind);
  }
}

function addActionMatches(rows, sentence, base) {
  ACTION_CORE_RE.lastIndex = 0;
  for (const match of sentence.matchAll(ACTION_CORE_RE)) {
    const prefix = match[1] || '';
    if (/[」』]/.test(prefix)) continue;
    const particle = match[2] || '';
    const verb = match[3] || '';
    const suffix = match[4] || '';
    const corePrefix = Array.from(prefix.trim()).slice(-4).join('');
    if (corePrefix.length < 2) continue;
    const core = `${corePrefix}${particle}${verb}${suffix}`;
    const offset = match[0].lastIndexOf(`${corePrefix}${particle}`);
    if (offset < 0) continue;
    addHighlightCandidate(rows, base + (match.index ?? 0) + offset, base + (match.index ?? 0) + offset + core.length, 124, 'action');
  }
}

function addSubjectMatch(rows, sentence, base) {
  const match = sentence.match(/^\s*([^、。！？!?]{2,12}?)(?:は|が)/u);
  if (!match) return;
  const subject = String(match[1] || '').trim().replace(/^[「『]|[」』]$/g, '');
  if (!subject || GENERIC_SUBJECT_RE.test(subject) || /^(?:この|その|同|ある)/.test(subject)) return;
  const local = sentence.indexOf(subject);
  if (local >= 0) addHighlightCandidate(rows, base + local, base + local + subject.length, 120, 'entity');
}

export function finalHighlightRanges(text = '') {
  const value = String(text || '');
  const result = [];
  for (const span of sentenceSpans(value)) {
    const sentence = span.text;
    const candidates = [];
    addActionMatches(candidates, sentence, span.start);
    addPatternMatches(candidates, sentence, span.start, NUMBER_RE, 116, 'number');
    addSubjectMatch(candidates, sentence, span.start);
    addPatternMatches(candidates, sentence, span.start, ORG_RE, 104, 'entity');
    addPatternMatches(candidates, sentence, span.start, LATIN_ENTITY_RE, 102, 'entity');
    addPatternMatches(candidates, sentence, span.start, CHANGE_RE, 98, 'change');
    addPatternMatches(candidates, sentence, span.start, QUOTED_KEY_RE, 94, 'key');
    addPatternMatches(candidates, sentence, span.start, KEY_ITEM_RE, 90, 'key');

    const semanticLength = Array.from(sentence.replace(/\s/g, '')).length;
    const maxBold = Math.max(4, Math.floor(semanticLength * 0.20));
    const selected = [];
    let used = 0;
    candidates.sort((a, b) => b.score - a.score || (a.end - a.start) - (b.end - b.start) || a.start - b.start);
    for (const candidate of candidates) {
      if (selected.length >= 2) break;
      if (selected.some(row => candidate.start < row.end && candidate.end > row.start)) continue;
      const length = Array.from(value.slice(candidate.start, candidate.end)).length;
      if (length > maxBold || (selected.length && used + length > maxBold)) continue;
      selected.push(candidate);
      used += length;
    }
    selected.sort((a, b) => a.start - b.start);
    result.push(...selected);
  }
  return result;
}

function applyHighlightToNode(node) {
  if (!(node instanceof Element) || node.dataset.pdv2FinalHighlight === FINAL_HIGHLIGHT_VERSION) return false;
  const text = String(node.textContent || '');
  const ranges = finalHighlightRanges(text);
  node.dataset.pdv2FinalHighlight = FINAL_HIGHLIGHT_VERSION;
  if (!ranges.length) return false;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, range.start)));
    const strong = document.createElement('strong');
    strong.className = 'reader-summary-keyword';
    strong.textContent = text.slice(range.start, range.end);
    fragment.append(strong);
    cursor = range.end;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  node.replaceChildren(fragment);
  return true;
}

function applyFinalHighlights(root = document) {
  root.querySelectorAll?.('.reader-swipe-card[data-summary-provider]').forEach(card => {
    if (!providerUsable(card)) return;
    card.querySelectorAll('.reader-story-summary-text').forEach(applyHighlightToNode);
  });
}

function queueFinalHighlights() {
  if (finalHighlightQueued) return;
  finalHighlightQueued = true;
  queueMicrotask(() => {
    finalHighlightQueued = false;
    applyFinalHighlights();
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
    const summaryChanged = mutations.some(mutation =>
      mutation.type === 'childList'
      || (mutation.type === 'attributes' && mutation.attributeName === 'data-summary-provider')
    );
    if (activeCardChanged) queueStoredActiveUx();
    if (summaryChanged) queueFinalHighlights();
  });
  activeObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-summary-provider']
  });
  queueStoredActiveUx();
  queueFinalHighlights();
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
