(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const state = { sequence: 0, last: null, history: [] };
  window.__PDV2_SUMMARY_DIAG = state;

  const GENERIC_RE = /(?:についての記事です|について紹介(?:する|しています)|背景や特徴.*(?:整理|確認)|影響や今後.*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?で確認|要約を(?:取得|作成)できません|詳しくは元記事|続報の確認が必要)/i;
  const BROKEN_EDGE_RE = /^(?:[」』）】〉》]|[\s]*[!?！？])|[「『（【〈《]\s*$/;

  function stripHtml(value = '') {
    try {
      const node = document.createElement('div');
      node.innerHTML = String(value || '');
      return (node.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    } catch {
      return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function summaryLines(summary) {
    const labels = ['結論/事実', '背景/特徴', '影響/展望'];
    if (Array.isArray(summary?.lines) && summary.lines.length) {
      return labels.map((label, index) => ({ label, text: summary.lines[index]?.text || '' }));
    }
    const points = Array.isArray(summary?.points) ? summary.points : [];
    return [
      { label: labels[0], text: summary?.short || '' },
      { label: labels[1], text: points[0] || '' },
      { label: labels[2], text: points[1] || '' }
    ];
  }

  function clientValidationReason(summary) {
    if (!summary) return 'EMPTY_RESPONSE';
    const provider = String(summary.provider || '');
    if (['pending', 'instant', 'insufficient', 'unavailable'].includes(provider)) return `PROVIDER_${provider.toUpperCase() || 'UNKNOWN'}`;
    const lines = summaryLines(summary).map(row => stripHtml(row.text));
    if (lines.length !== 3) return 'LINE_COUNT';
    if (lines.some(text => text.length < 12)) return 'LINE_TOO_SHORT';
    if (lines.some(text => GENERIC_RE.test(text))) return 'GENERIC_TEXT';
    if (lines.some(text => BROKEN_EDGE_RE.test(text))) return 'BROKEN_EDGE';
    if (lines.some(text => /(?:…|\.{3})\s*$/.test(text))) return 'ELLIPSIS_END';
    if (lines.some(text => !/[。！？!?][」』）】〉》]?$/.test(text))) return 'NO_SENTENCE_END';
    if (new Set(lines.map(text => text.replace(/[。、，,.!！?？\s]/g, '').toLowerCase())).size !== 3) return 'DUPLICATE_LINES';
    return 'OK';
  }

  function parseBody(init) {
    const raw = init?.body;
    if (!raw) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return {};
  }

  function asUrl(input) {
    try {
      const raw = typeof input === 'string' ? input : input?.url;
      return new URL(String(raw || ''), location.origin);
    } catch { return null; }
  }

  function isSummaryApi(url) {
    return Boolean(url && url.origin === location.origin && url.pathname === '/api/summary');
  }

  function diagnosticId() {
    state.sequence += 1;
    const time = Date.now().toString(36).slice(-4).toUpperCase();
    return `DIAG-${time}-${String(state.sequence).padStart(2, '0')}`;
  }

  function header(response, name) {
    try { return response.headers.get(name) || ''; } catch { return ''; }
  }

  function cleanReason(value = '', max = 100) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function actualSnapshot(response, data, elapsedMs) {
    return {
      status: Number(response?.status || 0),
      elapsedMs,
      provider: String(data?.provider || ''),
      model: String(data?.model || ''),
      contentSource: String(data?.contentSource || header(response, 'X-Summary-Content-Source') || ''),
      preparedSource: header(response, 'X-Summary-Prepared-Source'),
      preparedChars: Number(header(response, 'X-Summary-Prepared-Chars') || 0),
      prepareReason: header(response, 'X-Summary-Prepare-Reason') || String(data?.prepareReason || ''),
      prepareError: header(response, 'X-Summary-Prepare-Error') || String(data?.prepareError || ''),
      fallbackReason: String(data?.fallbackReason || header(response, 'X-Summary-Fallback-Reason') || ''),
      serverValidated: String(data?.validated ?? header(response, 'X-Summary-Validated') ?? ''),
      clientValidation: clientValidationReason(data)
    };
  }

  async function fixedGeminiTest() {
    const body = {
      title: '診断用の固定テキスト', source: 'DIAGNOSTIC_FIXED_TEXT', category: '診断', mode: 'diagnostic', preferFullText: false,
      description: '新しい加熱制御では温度センサーの測定値を用いてヒーター出力を細かく調整しました。試験では従来方式より消費電力が20％低下しました。量産評価でも同じ傾向が確認され、今後は複数製品への展開を検討しています。'
    };
    const started = performance.now();
    try {
      const response = await nativeFetch('/api/summary?diagnostic=fixed-gemini', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      const provider = String(data?.provider || '');
      return {
        ok: response.ok && provider.startsWith('gemini-') && clientValidationReason(data) === 'OK', status: response.status,
        provider, model: String(data?.model || ''), fallbackReason: String(data?.fallbackReason || ''),
        validation: clientValidationReason(data), elapsedMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      return { ok: false, status: 0, provider: '', model: '', fallbackReason: cleanReason(error?.message || error), validation: 'FETCH_ERROR', elapsedMs: Math.round(performance.now() - started) };
    }
  }

  async function articleOnlyTest(originalBody) {
    const started = performance.now();
    try {
      const response = await nativeFetch('/api/summary?diagnostic=article', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(originalBody || {})
      });
      const data = await response.json().catch(() => ({}));
      return {
        ok: Boolean(response.ok && data?.ok), status: response.status, preparedSource: String(data?.preparedSource || ''),
        preparedChars: Number(data?.preparedChars || 0), inputDescriptionChars: Number(data?.inputDescriptionChars || 0),
        prepareReason: String(data?.prepareReason || ''), prepareError: String(data?.prepareError || ''),
        elapsedMs: Number(data?.elapsedMs || Math.round(performance.now() - started))
      };
    } catch (error) {
      return { ok: false, status: 0, preparedSource: '', preparedChars: 0, prepareReason: 'diagnostic-fetch-error', prepareError: cleanReason(error?.message || error), elapsedMs: Math.round(performance.now() - started) };
    }
  }

  function deriveCause(diag) {
    const actual = diag.actual || {}, fixed = diag.fixedGemini || {}, article = diag.article || {};
    if (diag.networkError) return /abort/i.test(diag.networkError) ? 'CLIENT_TIMEOUT_OR_ABORT' : 'SUMMARY_NETWORK_ERROR';
    if (actual.status >= 400 || actual.status === 0) return `SUMMARY_HTTP_${actual.status || 'ERROR'}`;
    if (actual.clientValidation === 'OK') return 'DISPLAY_STATE_MISMATCH';
    if (!fixed.ok) {
      const reason = `${fixed.fallbackReason || ''}`;
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(reason)) return 'GEMINI_RATE_LIMIT_OR_QUOTA';
      if (/AbortError|timeout|timed out/i.test(reason)) return 'GEMINI_TIMEOUT';
      if (/404|not found|model/i.test(reason)) return 'GEMINI_MODEL_OR_ENDPOINT';
      return 'GEMINI_FIXED_TEST_FAILED';
    }
    if (actual.provider && actual.provider !== 'unavailable' && actual.clientValidation !== 'OK') return `CLIENT_VALIDATION_REJECTED_${actual.clientValidation}`;
    if (!article.ok && ['missing', 'rss-short', ''].includes(actual.preparedSource)) return 'ARTICLE_FETCH_FAILED_OR_SHORT';
    if (/prepared-text-too-short/i.test(actual.fallbackReason)) return 'SUMMARY_INPUT_TOO_SHORT';
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(actual.fallbackReason)) return 'GEMINI_RATE_LIMIT_OR_QUOTA';
    if (/AbortError|timeout/i.test(actual.fallbackReason)) return 'GEMINI_TIMEOUT_ON_ARTICLE';
    if (actual.provider === 'unavailable') return 'SERVER_RETURNED_UNAVAILABLE';
    return `CLIENT_${actual.clientValidation || 'UNKNOWN'}`;
  }

  function compactDiag(diag) {
    const actual = diag.actual || {}, fixed = diag.fixedGemini || {}, article = diag.article || {};
    return [
      diag.id, diag.cause || 'DIAGNOSING',
      `summary HTTP:${actual.status ?? '-'} provider:${actual.provider || '-'} validation:${actual.clientValidation || '-'}`,
      `prepared:${actual.preparedSource || '-'} chars:${actual.preparedChars || 0} reason:${cleanReason(actual.prepareReason || '-', 70)}`,
      `fixedGemini:${fixed.ok ? 'OK' : 'NG'} HTTP:${fixed.status ?? '-'} provider:${fixed.provider || '-'} model:${fixed.model || '-'}`,
      `article:${article.ok ? 'OK' : 'NG'} source:${article.preparedSource || '-'} chars:${article.preparedChars || 0} reason:${cleanReason(article.prepareReason || '-', 70)}`,
      `fallback:${cleanReason(actual.fallbackReason || fixed.fallbackReason || '-', 90)}`, 'prewarm:OFF'
    ].join('\n');
  }

  function ensureStyle() {
    if (document.getElementById('summary-diagnostic-style')) return;
    const style = document.createElement('style');
    style.id = 'summary-diagnostic-style';
    style.textContent = `.reader-summary-diagnostic{margin:12px 0 0;padding:12px 14px;border:1px solid rgba(255,170,30,.55);border-radius:14px;background:rgba(255,155,20,.08);color:#d7dce3;font-size:11px;line-height:1.55;overflow-wrap:anywhere}.reader-summary-diagnostic strong{display:block;color:#ffb43b;font-size:13px;margin-bottom:4px}.reader-summary-diagnostic code{display:block;white-space:pre-wrap;color:#aeb7c3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.reader-summary-diagnostic button{margin-top:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#f3f5f7;border-radius:10px;padding:7px 10px;font:inherit}`;
    document.head.append(style);
  }

  function renderPanel(card) {
    if (!card || !card.isConnected || !state.last) return;
    const diag = state.last;
    ensureStyle();
    let panel = card.querySelector('.reader-summary-diagnostic');
    if (!panel) {
      panel = document.createElement('div'); panel.className = 'reader-summary-diagnostic';
      (card.querySelector('.reader-story-content') || card).append(panel);
    }
    panel.replaceChildren();
    const title = document.createElement('strong'); title.textContent = diag.cause ? `診断コード ${diag.id}` : `診断中 ${diag.id}`;
    const code = document.createElement('code'); code.textContent = compactDiag(diag);
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '診断コードをコピー';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(compactDiag(diag)); copy.textContent = 'コピーしました'; setTimeout(() => { if (copy.isConnected) copy.textContent = '診断コードをコピー'; }, 1200); }
      catch { copy.textContent = '長押しで内容をコピー'; }
    });
    panel.append(title, code, copy);
  }

  function renderActiveFailure() {
    const card = document.querySelector('.reader-story-card.is-active[data-summary-provider="unavailable"]') || document.querySelector('.reader-story-card[data-summary-provider="unavailable"]');
    if (card) renderPanel(card);
  }

  async function finishDiagnostics(diag, originalBody) {
    const [fixedGemini, article] = await Promise.all([fixedGeminiTest(), articleOnlyTest(originalBody)]);
    diag.fixedGemini = fixedGemini; diag.article = article; diag.cause = deriveCause(diag); diag.finishedAt = new Date().toISOString();
    state.last = diag; state.history.push(diag); if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
    console.warn('[summary-diagnostic]', diag); renderActiveFailure();
  }

  const observer = new MutationObserver(() => renderActiveFailure());
  const startObserver = () => { if (document.body) observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-summary-provider', 'class'] }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true }); else startObserver();

  window.fetch = async function diagnosticFetch(input, init) {
    const url = asUrl(input);
    if (!isSummaryApi(url)) return nativeFetch(input, init);
    const isBatch = url.searchParams.get('batch') === '1';
    const diagnosticKind = url.searchParams.get('diagnostic') || '';
    const isPaperTitles = url.searchParams.get('paperTitles') === '1';

    if (isBatch) {
      return new Response(JSON.stringify({ results: [], batch: 'diagnostic-prewarm-disabled', generated: 0, failed: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json', 'X-Summary-Diagnostic-Prewarm': 'disabled' }
      });
    }
    if (diagnosticKind || isPaperTitles || (init?.method || 'GET').toUpperCase() !== 'POST') return nativeFetch(input, init);

    const originalBody = parseBody(init);
    const diag = { id: diagnosticId(), cause: '', startedAt: new Date().toISOString(), prewarm: 'OFF', actual: null, fixedGemini: null, article: null, networkError: '' };
    state.last = diag;
    const started = performance.now();
    try {
      const response = await nativeFetch(input, init);
      const clone = response.clone();
      const data = await clone.json().catch(() => ({}));
      diag.actual = actualSnapshot(response, data, Math.round(performance.now() - started));
      if (!response.ok || diag.actual.clientValidation !== 'OK') {
        finishDiagnostics(diag, originalBody).catch(error => { diag.cause = 'DIAGNOSTIC_RUN_FAILED'; diag.networkError = cleanReason(error?.message || error); state.last = diag; renderActiveFailure(); });
      }
      return response;
    } catch (error) {
      diag.networkError = `${error?.name || 'Error'}:${cleanReason(error?.message || error)}`;
      diag.actual = { status: 0, elapsedMs: Math.round(performance.now() - started), provider: '', clientValidation: 'FETCH_ERROR', preparedSource: '', preparedChars: 0, prepareReason: '', prepareError: '', fallbackReason: '' };
      finishDiagnostics(diag, originalBody).catch(() => {});
      throw error;
    }
  };
})();
