// All bottom-sheet based add/edit screens get an always-visible close control.
// Keep the control inside a real sticky header so iOS WebKit cannot clip a zero-height dock.
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

function makeCloseButton(sheet) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button pdv2-sheet-close-button';
  button.dataset.pdv2SheetClose = '1';
  button.setAttribute('aria-label', '閉じる');
  button.title = '閉じる';
  button.textContent = '×';
  button.style.cssText = [
    'flex:0 0 auto',
    'pointer-events:auto',
    'width:44px',
    'height:44px',
    'min-width:44px',
    'min-height:44px',
    'margin:0',
    'padding:0',
    'border-radius:50%',
    'font-size:28px',
    'font-weight:400',
    'line-height:1',
    'color:var(--text-strong)',
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
  return button;
}

function styleStickyHeader(header) {
  header.classList.add('pdv2-sheet-sticky-header');
  header.style.position = 'sticky';
  header.style.top = '0';
  header.style.zIndex = '32';
  header.style.minHeight = '52px';
  header.style.alignItems = 'center';
  header.style.margin = '0 -2px 10px';
  header.style.padding = '4px 2px';
  header.style.background = 'linear-gradient(180deg,var(--surface-solid) 78%,color-mix(in srgb,var(--surface-solid) 92%,transparent) 100%)';
  header.style.backdropFilter = 'blur(14px)';
  header.style.webkitBackdropFilter = 'blur(14px)';
}

function installClose(sheet) {
  if (!(sheet instanceof HTMLElement) || sheet.dataset[MARK] === '1') return;
  sheet.dataset[MARK] = '1';
  sheet.style.overscrollBehavior = 'contain';
  sheet.style.webkitOverflowScrolling = 'touch';

  // Put the close button in the sheet title whenever possible. This keeps the X visible
  // even when a long account/source list scrolls hundreds of pixels below it.
  const title = sheet.querySelector(':scope > .section-title');
  if (title) {
    styleStickyHeader(title);
    if (!title.querySelector('[data-pdv2-sheet-close="1"]')) title.append(makeCloseButton(sheet));
    return;
  }

  // Some sheets have no title. Give those a real-height sticky row instead of a
  // zero-height overlay, which iOS can clip when the sheet itself is the scroll container.
  const dock = document.createElement('div');
  dock.className = 'pdv2-sheet-close-dock pdv2-sheet-sticky-header';
  dock.style.cssText = [
    'position:sticky',
    'top:0',
    'z-index:32',
    'min-height:52px',
    'display:flex',
    'justify-content:flex-end',
    'align-items:center',
    'margin:0 -2px 8px',
    'padding:4px 2px',
    'background:linear-gradient(180deg,var(--surface-solid) 78%,color-mix(in srgb,var(--surface-solid) 92%,transparent) 100%)',
    'backdrop-filter:blur(14px)',
    '-webkit-backdrop-filter:blur(14px)'
  ].join(';');
  dock.append(makeCloseButton(sheet));

  const grabber = sheet.querySelector(':scope > .sheet-grabber');
  if (grabber?.nextSibling) sheet.insertBefore(dock, grabber.nextSibling);
  else if (grabber) sheet.append(dock);
  else sheet.prepend(dock);
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
