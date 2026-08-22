/* Personal Dashboard v2.19.1
 * Safety wrapper for the temporary v2.19.0 Reader diagnostics.
 *
 * Root cause fixed here:
 * runtime-v2190 observes characterData/childList and also writes the diagnostic
 * box from inside that observer. On an unavailable-card transition this could
 * recursively observe its own diagnostic text update and starve Safari's paint
 * loop. We install a temporary MutationObserver constructor wrapper BEFORE
 * importing v2190. Observers created during that import ignore mutations whose
 * target is inside [data-reader-diagnostic], then the native constructor is
 * restored for the rest of the app.
 *
 * A second watchdog exposes RDR-CLIENT-PENDING-100 when a card reaches 100%
 * progress but remains in the pending UI for more than 1.2s.
 */

const NativeMutationObserver2191 = globalThis.MutationObserver;

function mutationInsideDiagnostic2191(mutation) {
  const target = mutation?.target;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return Boolean(element?.closest?.('[data-reader-diagnostic]'));
}

if (typeof NativeMutationObserver2191 === 'function') {
  function SafeMutationObserver2191(callback) {
    return new NativeMutationObserver2191((mutations, observer) => {
      const filtered = Array.from(mutations || []).filter(mutation => !mutationInsideDiagnostic2191(mutation));
      if (!filtered.length) return;
      callback(filtered, observer);
    });
  }
  SafeMutationObserver2191.prototype = NativeMutationObserver2191.prototype;
  try { globalThis.MutationObserver = SafeMutationObserver2191; } catch {}
}

try {
  await import('./runtime-v2190.js');
} finally {
  try { globalThis.MutationObserver = NativeMutationObserver2191; } catch {}
}

const DIAG_SESSION_KEY_2191 = 'pdv2:readerDiag:v2190';
const pendingSince2191 = new WeakMap();

function clean2191(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function href2191(value = '') {
  try { return new URL(value, location.href).href; }
  catch { return String(value || ''); }
}

function modeOfCard2191(card) {
  const category = clean2191(card?.querySelector('.reader-story-category-badge')?.textContent || '');
  if (category.startsWith('論文')) return 'papers';
  if (category.startsWith('知識')) return 'knowledge';
  return 'news';
}

function keyOfCard2191(card) {
  const url = href2191(card?.querySelector('.reader-story-open')?.href || '');
  return `${url}::${modeOfCard2191(card)}`;
}

function diagnosticRecord2191(card) {
  const wanted = keyOfCard2191(card);
  try {
    const rows = JSON.parse(sessionStorage.getItem(DIAG_SESSION_KEY_2191) || '[]');
    return (Array.isArray(rows) ? rows : []).find(row => row?.key === wanted && row?.text) || null;
  } catch {
    return null;
  }
}

function articleNumber2191(card) {
  const index = Number(card?.dataset?.index);
  return Number.isFinite(index) ? index + 1 : 0;
}

function chunkLabel2191(article) {
  if (!article) return '?';
  const start = Math.floor((article - 1) / 10) * 10 + 1;
  return `${start}-${start + 9}`;
}

function pendingAtHundred2191(card) {
  const progress = clean2191(card?.querySelector('[data-reader-progress-value]')?.textContent || '');
  const first = clean2191(card?.querySelector('.reader-story-summary-text')?.textContent || '');
  const pendingText = /(?:抽出しています|確認しています|整理しています)/.test(first);
  return progress === '100%' && pendingText;
}

function unavailable2191(card) {
  const first = clean2191(card?.querySelector('.reader-story-summary-text')?.textContent || '');
  return first.includes('本文を十分に取得できず、正確な要約を作成できませんでした');
}

function ensureDiagnosticBox2191(card, text) {
  if (!card?.isConnected || !text) return;
  let box = card.querySelector('[data-reader-diagnostic]');
  if (!box) {
    box = document.createElement('button');
    box.type = 'button';
    box.className = 'reader-summary-diagnostic';
    box.dataset.readerDiagnostic = '1';
    box.dataset.pendingWatchdog = '1';
    box.title = 'タップして診断コードをコピー';
    box.addEventListener('click', async () => {
      const value = box.dataset.diagText || box.textContent || '';
      try {
        await navigator.clipboard.writeText(value);
        box.dataset.copied = '1';
        setTimeout(() => delete box.dataset.copied, 1200);
      } catch {}
    });
    card.querySelector('[data-reader-summary]')?.after(box);
  }
  const rendered = `診断コード（ChatGPTへ送信・タップでコピー）\n${text}`;
  if (box.dataset.diagText !== text) box.dataset.diagText = text;
  if (box.textContent !== rendered) box.textContent = rendered;
}

function removeWatchdogBoxIfRecovered2191(card) {
  const box = card?.querySelector?.('[data-reader-diagnostic][data-pending-watchdog="1"]');
  if (box && !unavailable2191(card)) box.remove();
}

function scanPendingCards2191() {
  const now = Date.now();
  document.querySelectorAll('.reader-swipe-card').forEach(card => {
    if (!pendingAtHundred2191(card)) {
      pendingSince2191.delete(card);
      removeWatchdogBoxIfRecovered2191(card);
      return;
    }

    let since = pendingSince2191.get(card);
    if (!since) {
      since = now;
      pendingSince2191.set(card, since);
      return;
    }
    if (now - since < 1200) return;

    const record = diagnosticRecord2191(card);
    if (record?.text) {
      ensureDiagnosticBox2191(card, record.text);
      return;
    }

    const article = articleNumber2191(card);
    ensureDiagnosticBox2191(
      card,
      [
        'RDR-CLIENT-PENDING-100',
        `article=${article || '?'}`,
        `chunk=${chunkLabel2191(article)}`,
        'stage=card-await-result',
        'source=unknown',
        'chars=0',
        `detail=progress reached 100 but pending UI remained for ${Math.round((now - since) / 100) / 10}s`
      ].join(' | ')
    );
  });
}

setInterval(scanPendingCards2191, 350);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(scanPendingCards2191, 100);
});

try { localStorage.setItem('pdv2:runtime:v2191', '1'); } catch {}
