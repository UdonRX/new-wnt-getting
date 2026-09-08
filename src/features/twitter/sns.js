import { renderTwitter, warmTwitterFeeds } from './twitter.js';
import { load, save } from '../../shared/storage.js';
import { renderInstagramTimeline } from './instagram-timeline.js';
import { disposeInstagramImageFastPath, installInstagramImageFastPath } from './instagram-image-fast.js';
import { disposeInstagramStability, installInstagramStability } from './instagram-stability.js';
import { disposeInstagramStories, installInstagramStories } from './instagram-stories.js';

export { warmTwitterFeeds };

const SNS_MODE_KEY = 'lastSnsMode';
let snsRenderGeneration = 0;

function currentMode(explicit = '') {
  const value = String(explicit || load(SNS_MODE_KEY, 'x') || 'x').toLowerCase();
  return value === 'instagram' ? 'instagram' : 'x';
}

function enhanceXChrome(root, generation) {
  if (generation !== snsRenderGeneration) return false;
  const screen = root.querySelector('.screen');
  const host = screen?.querySelector('.twitter-feed-host');
  if (!screen || !host) return false;

  screen.querySelectorAll('.sns-mode-segment').forEach(node => node.remove());
  const header = screen.querySelector('.topbar');
  const title = header?.querySelector('h1');
  const subtitle = header?.querySelector('.subtitle');
  if (title) title.textContent = 'Twitter';
  if (subtitle) subtitle.textContent = 'タイムライン';
  return true;
}

export async function renderSNS(root, options = {}) {
  disposeInstagramStories(root);
  disposeInstagramImageFastPath(root);
  disposeInstagramStability(root);
  const generation = ++snsRenderGeneration;
  const mode = currentMode(options.snsMode);
  save(SNS_MODE_KEY, mode);

  if (mode === 'instagram') {
    installInstagramStability(root);
    renderInstagramTimeline(root, options, {
      generation,
      isCurrent: value => value === snsRenderGeneration,
      modeSegment: document.createDocumentFragment()
    });
    installInstagramStories(root, {
      generation,
      isCurrent: value => value === snsRenderGeneration
    });
    installInstagramImageFastPath(root);
    return;
  }

  let observer = null;
  const enhanceOnce = () => {
    const done = enhanceXChrome(root, generation);
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
