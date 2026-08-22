/* TEMP v2.19.0 Reader summary end-to-end diagnostics.
 * Remove after the 10th-card-and-later failure is identified.
 * Captures: batch content/Gemini result -> client transport -> LocalStorage -> final unavailable card.
 */

const nativeFetch2190 = window.fetch.bind(window);
const DIAG_SESSION_KEY_2190 = 'pdv2:readerDiag:v2190';
const SUMMARY_STORAGE_KEY_2190 = 'reader-summary-cache-v2180';
const diagnosticMap2190 = new Map();

function clean2190(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function href2190(value = '') { try { return new URL(value, location.href).href; } catch { return String(value || ''); } }
function parseBody2190(init) { try { return typeof init?.body === 'string' ? JSON.parse(init.body) : {}; } catch { return {}; } }
function key2190(url, mode = 'auto') { return `${href2190(url)}::${clean2190(mode) || 'auto'}`; }
function safeDetail2190(value = '') { return clean2190(value).replace(/[|\n\r]/g, '/').slice(0, 150); }
function loadDiagnostics2190() {
  try {
    const rows = JSON.parse(sessionStorage.getItem(DIAG_SESSION_KEY_2190) || '[]');
    for (const row of Array.isArray(rows) ? rows : []) if (row?.key && row?.text) diagnosticMap2190.set(row.key, row);
  } catch {}
}
function saveDiagnostics2190() {
  try {
    const rows = [...diagnosticMap2190.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 80);
    sessionStorage.setItem(DIAG_SESSION_KEY_2190, JSON.stringify(rows));
  } catch {}
}
loadDiagnostics2190();

function articleNumber2190(url) {
  const wanted = href2190(url);
  for (const card of document.querySelectorAll('.reader-swipe-card')) {
    if (href2190(card.querySelector('.reader-story-open')?.href || '') !== wanted) continue;
    const index = Number(card.dataset.index);
    if (Number.isFinite(index)) return index + 1;
  }
  return 0;
}
function chunkLabel2190(article) {
  if (!article) return '?';
  const start = Math.floor((article - 1) / 10) * 10 + 1;
  return `${start}-${start + 9}`;
}
function diagnosticText2190(diag = {}, context = {}) {
  const article = Number(context.article || 0);
  const fields = [
    clean2190(diag.code || context.code || 'RDR-UNKNOWN'),
    `article=${article || '?'}`,
    `chunk=${context.chunk || chunkLabel2190(article)}`,
    `stage=${clean2190(diag.stage || context.stage || 'unknown')}`,
    `source=${clean2190(diag.source || context.source || 'unknown')}`,
    `chars=${Number(diag.chars ?? diag.charCount ?? context.chars ?? 0)}`
  ];
  const status = Number(diag.status || 0); if (status) fields.push(`http=${status}`);
  if (diag.model) fields.push(`model=${safeDetail2190(diag.model)}`);
  if (diag.prior) fields.push(`prior=${safeDetail2190(diag.prior)}`);
  const detail = safeDetail2190(diag.detail || diag.fetchError || context.detail || '');
  if (detail) fields.push(`detail=${detail}`);
  return fields.join(' | ');
}
function rememberDiagnostic2190(url, mode, diag, context = {}) {
  const key = key2190(url, mode), article = Number(context.article || articleNumber2190(url) || 0);
  const previous = diagnosticMap2190.get(key);
  const text = diagnosticText2190(diag, { ...context, article });
  diagnosticMap2190.set(key, { key, url: href2190(url), mode: clean2190(mode) || 'auto', text, ts: Date.now(), seen: Number(previous?.seen || 0) + 1 });
  saveDiagnostics2190();
  setTimeout(paintAllDiagnostics2190, 0);
  return text;
}

function deriveBatchDiagnostic2190(result = {}) {
  if (result?.diagnostic?.code) return result.diagnostic;
  const dev = result?.devError?.devError;
  if (dev?.code) return { code: `RDR-CONTENT-${dev.code}`, stage: dev.stage || 'prepare', source: result.preparedSource || dev.stage || 'missing', chars: dev.charCount || 0, detail: dev.fetchError || '' };
  return { code: 'RDR-CLIENT-BATCH-NO-REASON', stage: 'batch-response', source: result?.preparedSource || 'unknown', chars: 0 };
}

function verifyStorage2190(item, result) {
  if (!result?.summary || !item?.url) return;
  setTimeout(() => {
    const mode = clean2190(item.mode || 'auto');
    const storageKey = `${item.url || item.link || item.title || ''}::${mode}::v2180`;
    try {
      const raw = JSON.parse(localStorage.getItem(SUMMARY_STORAGE_KEY_2190) || '{}');
      if (raw?.[storageKey]?.value) return;
      let code = 'RDR-STORAGE-NOT-SAVED', detail = 'batch summary succeeded but summary key is absent';
      try {
        const probeKey = 'pdv2:readerDiagProbe:v2190';
        localStorage.setItem(probeKey, 'x'.repeat(256)); localStorage.removeItem(probeKey);
      } catch (error) {
        code = /quota/i.test(String(error?.name || error?.message || error)) ? 'RDR-STORAGE-QUOTA' : 'RDR-STORAGE-WRITE';
        detail = String(error?.name || error?.message || error);
      }
      rememberDiagnostic2190(item.url, mode, { code, stage: 'localStorage', source: result?.summary?.contentSource || result?.preparedSource || 'unknown', chars: 500, detail });
    } catch (error) {
      rememberDiagnostic2190(item.url, mode, { code: 'RDR-STORAGE-READ', stage: 'localStorage', source: result?.summary?.contentSource || 'unknown', chars: 0, detail: String(error?.name || error?.message || error) });
    }
  }, 350);
}

function classifyTransportError2190(error, prefix = 'RDR-CLIENT') {
  const message = clean2190(error?.message || error);
  if (error?.name === 'AbortError' || /abort|timeout/i.test(message)) return { code: `${prefix}-TIMEOUT`, stage: 'client-fetch', detail: message };
  return { code: `${prefix}-NETWORK`, stage: 'client-fetch', detail: message };
}

/* Installed before v2.18.9 so its raw batch fetch is observable here. */
window.fetch = async function pdv2190PreFetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return nativeFetch2190(input, init); }
  const isBatch = url.origin === location.origin && url.pathname === '/api/summary' && url.searchParams.get('batch') === '1' && String(init?.method || 'GET').toUpperCase() === 'POST';
  if (!isBatch) return nativeFetch2190(input, init);

  const body = parseBody2190(init), items = Array.isArray(body?.items) ? body.items : [];
  let response;
  try { response = await nativeFetch2190(input, init); }
  catch (error) {
    const diag = classifyTransportError2190(error, 'RDR-CLIENT-BATCH');
    items.forEach(item => rememberDiagnostic2190(item.url || item.link, item.mode, diag));
    error.readerDiagnostic = diagnosticText2190(diag, {});
    throw error;
  }

  response.clone().json().then(data => {
    if (!response.ok) {
      items.forEach(item => rememberDiagnostic2190(item.url || item.link, item.mode, { code: `RDR-CLIENT-BATCH-HTTP${response.status}`, stage: 'batch-http', status: response.status, detail: data?.error || '' }));
      return;
    }
    if (!Array.isArray(data?.results)) {
      items.forEach(item => rememberDiagnostic2190(item.url || item.link, item.mode, { code: 'RDR-CLIENT-BATCH-MALFORMED', stage: 'batch-response', detail: 'results array missing' }));
      return;
    }
    data.results.forEach((result, position) => {
      const item = items[Number.isInteger(result?.index) ? result.index : position] || items[position];
      if (!item) return;
      if (result?.summary) verifyStorage2190(item, result);
      else rememberDiagnostic2190(item.url || item.link, item.mode, deriveBatchDiagnostic2190(result));
    });
  }).catch(error => {
    items.forEach(item => rememberDiagnostic2190(item.url || item.link, item.mode, { code: 'RDR-CLIENT-BATCH-JSON', stage: 'batch-response', detail: String(error?.message || error) }));
  });
  return response;
};

await import('./runtime-v2189.js');
const inheritedFetch2190 = window.fetch.bind(window);

function deriveSingleDiagnostic2190(data = {}, response = null) {
  if (data?.devError?.code) return { code: `RDR-CONTENT-${data.devError.code}`, stage: data.devError.stage || 'single', source: data.contentSource || data.devError.stage || 'unknown', chars: data.devError.charCount || 0, detail: data.devError.fetchError || '' };
  const reason = clean2190(data?.fallbackReason || data?.error || '');
  const source = clean2190(data?.contentSource || 'unknown');
  const status = Number(response?.status || 0);
  if (status >= 400) return { code: `RDR-CLIENT-SINGLE-HTTP${status}`, stage: 'single-http', source, status, detail: reason };
  if (/429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(reason)) return { code: 'RDR-GEMINI-429', stage: 'single-gemini', source, chars: 500, detail: reason };
  if (/403|PERMISSION_DENIED/i.test(reason)) return { code: 'RDR-GEMINI-403', stage: 'single-gemini', source, chars: 500, detail: reason };
  if (/401|UNAUTHENTICATED/i.test(reason)) return { code: 'RDR-GEMINI-401', stage: 'single-gemini', source, chars: 500, detail: reason };
  if (/abort|timeout/i.test(reason)) return { code: 'RDR-GEMINI-TIMEOUT', stage: 'single-gemini', source, chars: 500, detail: reason };
  if (/JSON|parse|短すぎ|重複|日本語/i.test(reason)) return { code: 'RDR-GEMINI-INVALID-SUMMARY', stage: 'single-gemini-validate', source, chars: 500, detail: reason };
  if (source === 'title') return { code: 'RDR-CONTENT-NONE', stage: 'single-input', source, chars: 0, detail: reason };
  return { code: 'RDR-SINGLE-UNAVAILABLE', stage: 'single-final', source, chars: source === 'title' ? 0 : 500, detail: reason };
}

window.fetch = async function pdv2190Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2190(input, init); }
  const isSingle = url.origin === location.origin && url.pathname === '/api/summary' && url.searchParams.get('batch') !== '1' && String(init?.method || 'GET').toUpperCase() === 'POST';
  if (!isSingle) return inheritedFetch2190(input, init);
  const body = parseBody2190(init), targetUrl = body.url || body.link || '', mode = clean2190(body.mode || 'auto');
  let response;
  try { response = await inheritedFetch2190(input, init); }
  catch (error) {
    const diag = classifyTransportError2190(error, 'RDR-CLIENT-SINGLE');
    const prior = diagnosticMap2190.get(key2190(targetUrl, mode))?.text || '';
    const text = rememberDiagnostic2190(targetUrl, mode, { ...diag, detail: `${diag.detail || ''}${prior ? ` / prior=${prior}` : ''}` });
    error.readerDiagnostic = text;
    throw error;
  }
  response.clone().json().then(data => {
    const unavailable = data?.provider === 'unavailable' || (!Array.isArray(data?.lines) && !data?.short) || response.status >= 400;
    if (!unavailable) return;
    const single = deriveSingleDiagnostic2190(data, response);
    const prior = diagnosticMap2190.get(key2190(targetUrl, mode))?.text || '';
    rememberDiagnostic2190(targetUrl, mode, { ...single, detail: `${single.detail || ''}${prior ? ` / prior=${prior}` : ''}` });
  }).catch(error => {
    rememberDiagnostic2190(targetUrl, mode, { code: 'RDR-CLIENT-SINGLE-JSON', stage: 'single-response', detail: String(error?.message || error) });
  });
  return response;
};

function isUnavailableCard2190(card) {
  const first = clean2190(card?.querySelector('.reader-story-summary-text')?.textContent || '');
  return first.includes('本文を十分に取得できず、正確な要約を作成できませんでした');
}
function modeOfCard2190(card) {
  const category = clean2190(card?.querySelector('.reader-story-category-badge')?.textContent || '');
  if (category.startsWith('論文')) return 'papers';
  if (category.startsWith('知識')) return 'knowledge';
  return 'news';
}
function paintDiagnostic2190(card) {
  if (!card?.isConnected || !isUnavailableCard2190(card)) return;
  const url = card.querySelector('.reader-story-open')?.href || '', mode = modeOfCard2190(card);
  const article = Number(card.dataset.index || 0) + 1;
  const record = diagnosticMap2190.get(key2190(url, mode));
  const text = record?.text || diagnosticText2190({ code: 'RDR-CLIENT-NO-TRACE', stage: 'card-render', source: 'unknown', chars: 0, detail: 'unavailable card rendered without captured batch/single diagnostic' }, { article });
  let box = card.querySelector('[data-reader-diagnostic]');
  if (!box) {
    box = document.createElement('button');
    box.type = 'button'; box.className = 'reader-summary-diagnostic'; box.dataset.readerDiagnostic = '1';
    box.title = 'タップして診断コードをコピー';
    box.addEventListener('click', async () => {
      const value = box.dataset.diagText || box.textContent || '';
      try { await navigator.clipboard.writeText(value); box.dataset.copied = '1'; setTimeout(() => delete box.dataset.copied, 1200); } catch {}
    });
    card.querySelector('[data-reader-summary]')?.after(box);
  }
  box.dataset.diagText = text;
  box.textContent = `診断コード（ChatGPTへ送信・タップでコピー）\n${text}`;
}
function paintAllDiagnostics2190(root = document) { root.querySelectorAll?.('.reader-swipe-card').forEach(paintDiagnostic2190); }

new MutationObserver(() => paintAllDiagnostics2190()).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
setInterval(() => paintAllDiagnostics2190(), 900);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(paintAllDiagnostics2190, 80); });

try { localStorage.setItem('pdv2:runtime:v2190', '1'); } catch {}
