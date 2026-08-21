export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  list.filter(Boolean).forEach(child => node.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return node;
}

export function clear(node) { node?.replaceChildren(); }
export function qs(selector, root = document) { return root.querySelector(selector); }

export function showToast(message, ms = 2200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const toast = el('div', { class: 'toast', text: message });
  root.replaceChildren(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, ms);
}

export function openSheet(content, { title = '', onClose } = {}) {
  const root = document.getElementById('overlay-root');
  if (!root) throw new Error('overlay-root が見つかりません');

  const lockedScrollY = Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));
  document.documentElement.classList.add('sheet-open');
  document.body.classList.add('sheet-lock');
  document.body.style.top = `-${lockedScrollY}px`;

  const backdrop = el('div', { class: 'sheet-backdrop' });
  const sheet = el('section', { class: 'bottom-sheet', role: 'dialog', 'aria-modal': 'true' });
  const grabber = el('div', { class: 'sheet-grabber', 'aria-label': '下にスワイプして閉じる' });
  grabber.append(el('div', { class: 'sheet-handle' }));
  sheet.append(grabber);
  if (title) sheet.append(el('div', { class: 'section-title' }, [el('h2', { text: title })]));
  sheet.append(content);
  backdrop.append(sheet);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;

    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName)) {
      try { active.blur(); } catch {}
    }

    backdrop.remove();
    if (!root.querySelector('.sheet-backdrop')) {
      document.documentElement.classList.remove('sheet-open');
      document.body.classList.remove('sheet-lock');
      document.body.style.top = '';
      requestAnimationFrame(() => window.scrollTo({ top: lockedScrollY, behavior: 'auto' }));
    }
    onClose?.();
  };

  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close();
  });

  let startY = 0;
  let startX = 0;
  let dragging = false;
  const reset = () => {
    dragging = false;
    sheet.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)';
    sheet.style.transform = '';
    setTimeout(() => { if (sheet.isConnected) sheet.style.transition = ''; }, 190);
  };

  grabber.addEventListener('touchstart', event => {
    if (event.touches?.length !== 1) return;
    event.stopPropagation();
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  grabber.addEventListener('touchmove', event => {
    if (!dragging || event.touches?.length !== 1) return;
    event.stopPropagation();
    const dy = event.touches[0].clientY - startY;
    const dx = event.touches[0].clientX - startX;
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) return;
    if (event.cancelable) event.preventDefault();
    sheet.style.transform = `translate3d(0, ${Math.min(180, dy * .78)}px, 0)`;
  }, { passive: false });

  const endDrag = event => {
    if (!dragging) return;
    event.stopPropagation();
    const touch = event.changedTouches?.[0];
    const dy = touch ? touch.clientY - startY : 0;
    const dx = touch ? touch.clientX - startX : 0;
    dragging = false;
    if (dy >= 68 && Math.abs(dy) > Math.abs(dx) * 1.1) {
      sheet.style.transition = 'transform .16s ease';
      sheet.style.transform = 'translate3d(0, 115%, 0)';
      setTimeout(close, 145);
      return;
    }
    reset();
  };

  grabber.addEventListener('touchend', endDrag, { passive: true });
  grabber.addEventListener('touchcancel', reset, { passive: true });
  root.append(backdrop);
  return { backdrop, sheet, close };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}
