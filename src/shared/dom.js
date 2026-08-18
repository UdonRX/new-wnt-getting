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
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const sheet = el('section', { class: 'bottom-sheet', role: 'dialog', 'aria-modal': 'true' });
  sheet.append(el('div', { class: 'sheet-handle' }));
  if (title) sheet.append(el('div', { class: 'section-title' }, [el('h2', { text: title })]));
  sheet.append(content);
  backdrop.append(sheet);
  const close = () => { backdrop.remove(); onClose?.(); };
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  root.append(backdrop);
  return { backdrop, sheet, close };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
