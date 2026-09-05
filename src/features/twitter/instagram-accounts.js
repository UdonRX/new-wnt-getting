import { el, openSheet } from '../../shared/dom.js';
import { load, save } from '../../shared/storage.js';

export const INSTAGRAM_ACCOUNTS_KEY = 'instagramAccounts';

export function instagramAccounts() {
  const raw = load(INSTAGRAM_ACCOUNTS_KEY, []);
  return Array.isArray(raw)
    ? [...new Set(raw.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))]
    : [];
}

export function storeInstagramAccounts(accounts) {
  const normalized = [...new Set((accounts || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  save(INSTAGRAM_ACCOUNTS_KEY, normalized);
  return normalized;
}

export function normalizeInstagramUsername(value) {
  let input = String(value || '').trim();
  if (!input) throw new Error('Instagramユーザー名を入力してください。');
  if (input.startsWith('@')) input = input.slice(1);

  if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i.test(input)) {
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    const url = new URL(input);
    input = url.pathname.split('/').filter(Boolean)[0] || '';
  }

  if (!/^[A-Za-z0-9._]+$/.test(input)) {
    throw new Error('ユーザー名 / @username / InstagramプロフィールURLを確認してください。');
  }
  return input.toLowerCase();
}

export function instagramProfileUrl(username) {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

export function openInstagramAccountManager({ onChanged } = {}) {
  let dirty = false;
  const content = el('div', { style: 'display:grid;gap:12px;padding-bottom:8px;' });
  const help = el('div', {
    class: 'setting-detail',
    text: '@username / username / InstagramプロフィールURLを登録できます。',
    style: 'font-size:13px;color:var(--muted);line-height:1.5;'
  });
  const fieldRow = el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;' });
  const input = el('input', {
    type: 'text',
    inputmode: 'text',
    autocapitalize: 'none',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '@username / username / profile URL',
    style: 'min-width:0;width:100%;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);color:var(--text);padding:11px 12px;font:inherit;'
  });
  const addButton = el('button', {
    class: 'soft-button',
    type: 'button',
    text: '追加',
    style: 'min-width:64px;'
  });
  fieldRow.append(input, addButton);

  const message = el('div', {
    role: 'status',
    'aria-live': 'polite',
    style: 'min-height:18px;font-size:12px;color:var(--muted);'
  });
  const list = el('div', { style: 'display:grid;gap:8px;' });

  const redraw = () => {
    const accounts = instagramAccounts();
    list.replaceChildren();
    if (!accounts.length) {
      list.append(el('div', {
        text: '登録中のInstagramアカウントはありません。',
        style: 'padding:12px;border:1px solid var(--line);border-radius:12px;color:var(--muted);font-size:13px;'
      }));
      return;
    }

    accounts.forEach(username => {
      const row = el('div', {
        style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);'
      });
      const accountLink = el('a', {
        href: instagramProfileUrl(username),
        target: '_blank',
        rel: 'noopener noreferrer',
        text: `@${username}`,
        style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;color:var(--text-strong);font-weight:750;'
      });
      const remove = el('button', {
        type: 'button',
        text: '削除',
        'aria-label': `@${username}を削除`,
        style: 'border:0;background:transparent;color:#ff6b6b;font:inherit;font-size:12px;font-weight:700;padding:6px;'
      });
      remove.addEventListener('click', () => {
        storeInstagramAccounts(instagramAccounts().filter(value => value !== username));
        dirty = true;
        message.textContent = `@${username} を削除しました`;
        redraw();
      });
      row.append(accountLink, remove);
      list.append(row);
    });
  };

  const add = () => {
    message.textContent = '';
    try {
      const username = normalizeInstagramUsername(input.value);
      const accounts = instagramAccounts();
      if (accounts.includes(username)) throw new Error('そのアカウントは登録済みです。');
      storeInstagramAccounts([...accounts, username]);
      dirty = true;
      input.value = '';
      try { input.blur(); } catch {}
      message.textContent = `@${username} を追加しました`;
      redraw();
    } catch (error) {
      message.textContent = error?.message || '追加できませんでした。';
    }
  };

  addButton.addEventListener('click', add);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') add();
  });

  content.append(help, fieldRow, message, list);
  redraw();
  return openSheet(content, {
    title: 'Instagramアカウント',
    onClose: () => {
      if (!dirty) return;
      requestAnimationFrame(() => requestAnimationFrame(() => onChanged?.()));
    }
  });
}
