// All bottom-sheet based add/edit screens get an always-visible close control.
const OVERLAY_ID = 'overlay-root';
const MARK = 'pdv2SheetCloseInstalled';

function closeSheet(sheet) {
  const backdrop = sheet?.closest('.sheet-backdrop');
  if (!backdrop) return;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName)) {
    try { active.blur(); } catch {}
  }
  // openSheet owns cleanup/scroll restoration. A backdrop click calls that existing close() path.
  backdrop.click();
}

function installClose(sheet) {
  if (!(sheet instanceof HTMLElement) || sheet.dataset[MARK] === '1') return;
  sheet.dataset[MARK] = '1';
  sheet.style.overscrollBehavior = 'contain';
  sheet.style.webkitOverflowScrolling = 'touch';

  const dock = document.createElement('div');
  dock.className = 'pdv2-sheet-close-dock';
  dock.style.cssText = [
    'position:sticky',
    'top:0',
    'z-index:30',
    'height:0',
    'display:flex',
    'justify-content:flex-end',
    'align-items:flex-start',
    'pointer-events:none',
    'overflow:visible'
  ].join(';');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button pdv2-sheet-close-button';
  button.setAttribute('aria-label', '閉じる');
  button.title = '閉じる';
  button.textContent = '×';
  button.style.cssText = [
    'pointer-events:auto',
    'width:44px',
    'height:44px',
    'min-width:44px',
    'min-height:44px',
    'margin:4px 2px 0 0',
    'padding:0',
    'border-radius:50%',
    'font-size:28px',
    'font-weight:400',
    'line-height:1',
    'background:color-mix(in srgb,var(--surface-solid) 94%,transparent)',
    'border:1px solid var(--line)',
    'box-shadow:0 4px 16px rgba(0,0,0,.28)',
    'backdrop-filter:blur(12px)',
    '-webkit-backdrop-filter:blur(12px)'
  ].join(';');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeSheet(sheet);
  });
  dock.append(button);
  sheet.prepend(dock);
}

function scan(root) {
  root?.querySelectorAll?.('.bottom-sheet').forEach(installClose);
}

function boot() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  scan(overlay);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        if (node.matches('.bottom-sheet')) installClose(node);
        scan(node);
      });
    }
  });
  observer.observe(overlay, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
