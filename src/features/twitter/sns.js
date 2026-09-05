import { renderTwitter, warmTwitterFeeds } from './twitter.js';
import { el, showToast } from '../../shared/dom.js';
import { iconSvg } from '../../shared/icons.js';
import { load, save } from '../../shared/storage.js';
import { openInstagramAccountManager } from './instagram-accounts.js';
import { renderInstagramTimeline } from './instagram-timeline.js';
import { disposeInstagramImageFastPath, installInstagramImageFastPath } from './instagram-image-fast.js';

export { warmTwitterFeeds };

const SNS_MODE_KEY = 'lastSnsMode';
let snsRenderGeneration = 0;

function currentMode(explicit = '') {
  const value = String(explicit || load(SNS_MODE_KEY, 'x') || 'x').toLowerCase();
  return value === 'instagram' ? 'instagram' : 'x';
}

function makeModeSegment(root, options, activeMode) {
  const box = el('div', {
    class: 'sns-mode-segment',
    role: 'group',
    'aria-label': 'SNS切替',
    style: 'position:fixed;right:14px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:45;display:flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--surface) 88%,transparent);box-shadow:0 6px 22px rgba(0,0,0,.24);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
  });

  const switchMode = mode => {
    if (mode === activeMode) return;
    save(SNS_MODE_KEY, mode);
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
    renderSNS(root, { ...options, snsMode: mode, refresh: false }).catch(error => {
      console.error('[sns-switch]', error);
      showToast('SNS表示の切替に失敗しました');
    });
  };

  [
    ['x', 'X'],
    ['instagram', 'Instagram']
  ].forEach(([value, label]) => {
    const active = value === activeMode;
    box.append(el('button', {
      type: 'button',
      text: label,
      'aria-pressed': String(active),
      style: [
        'border:0;border-radius:10px;padding:7px 10px;font:inherit;font-size:12px;font-weight:750;line-height:1',
        'white-space:nowrap;cursor:pointer',
        active
          ? 'background:var(--feature-color);color:#fff'
          : 'background:transparent;color:var(--muted)'
      ].join(';'),
      onclick: () => switchMode(value)
    }));
  });
  return box;
}

function enhanceXChrome(root, options, generation) {
  if (generation !== snsRenderGeneration) return false;
  const screen = root.querySelector('.screen');
  const host = screen?.querySelector('.twitter-feed-host');
  if (!screen || !host) return false;

  const header = screen.querySelector('.topbar');
  const title = header?.querySelector('h1');
  const subtitle = header?.querySelector('.subtitle');
  if (title && title.textContent !== 'SNS') title.textContent = 'SNS';
  if (subtitle && subtitle.textContent !== 'Xタイムライン') subtitle.textContent = 'Xタイムライン';

  const actions = header?.querySelector('.topbar-actions');
  if (actions && !actions.querySelector('[data-sns-instagram-add]')) {
    const add = el('button', {
      class: 'icon-button',
      type: 'button',
      title: 'Instagramアカウントを追加・管理',
      'aria-label': 'Instagramアカウントを追加・管理',
      'data-sns-instagram-add': '1',
      html: iconSvg('plus', { size: 20 })
    });
    add.addEventListener('click', () => openInstagramAccountManager());
    actions.insertBefore(add, actions.firstChild);
  }

  if (!screen.querySelector('.sns-mode-segment')) {
    screen.append(makeModeSegment(root, options, 'x'));
  }
  return true;
}

export async function renderSNS(root, options = {}) {
  disposeInstagramImageFastPath(root);
  const generation = ++snsRenderGeneration;
  const mode = currentMode(options.snsMode);
  save(SNS_MODE_KEY, mode);

  if (mode === 'instagram') {
    renderInstagramTimeline(root, options, {
      generation,
      isCurrent: value => value === snsRenderGeneration,
      modeSegment: makeModeSegment(root, options, 'instagram')
    });
    installInstagramImageFastPath(root);
    return;
  }

  // Xは既存renderTwitterをそのまま使う。DOM監視はX本体が描画されるまでの一回だけに限定し、
  // SNS用タイトル/ボタンの書き換えをMutationObserver自身が再検知し続けないようにする。
  let observer = null;
  const enhanceOnce = () => {
    const done = enhanceXChrome(root, options, generation);
    if (done && observer) {
      observer.disconnect();
      observer = null;
    }
    return done;
  };

  if (!enhanceOnce()) {
    observer = new MutationObserver(() => enhanceOnce());
    observer.observe(root, { childList: true, subtree: true });
  }

  try {
    const job = renderTwitter(root, options);
    enhanceOnce();
    await job;
    enhanceOnce();
  } finally {
    observer?.disconnect();
    observer = null;
  }
}
