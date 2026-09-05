import { el } from '../../shared/dom.js';
import { instagramProfileUrl } from './instagram-accounts.js';

const VIDEO_CACHE_TTL_MS = 5 * 60 * 1000;
const instagramVideoResolverCache = new Map();

function resolveInstagramVideo(shortcode) {
  if (!shortcode) return Promise.reject(new Error('shortcodeがありません。'));

  const cached = instagramVideoResolverCache.get(shortcode);
  if (cached && Date.now() - cached.createdAt < VIDEO_CACHE_TTL_MS) return cached.promise;
  if (cached) instagramVideoResolverCache.delete(shortcode);

  const promise = fetch(`/api/instagram-video?shortcode=${encodeURIComponent(shortcode)}&kind=auto&t=${Date.now()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.videoUrl) {
      throw new Error(data.error || `動画URL解決 HTTP ${response.status}`);
    }
    return data;
  }).catch(error => {
    instagramVideoResolverCache.delete(shortcode);
    throw error;
  });

  instagramVideoResolverCache.set(shortcode, { createdAt: Date.now(), promise });
  return promise;
}

function pauseOtherInstagramVideos(activeVideo) {
  document.querySelectorAll('.instagram-timeline-item video').forEach(video => {
    if (video !== activeVideo && !video.paused) {
      try { video.pause(); } catch {}
    }
  });
}

function videoFallbackLink(item, posterUrl = '') {
  const href = item?.reelPermalink || item?.permalink || instagramProfileUrl(item?.account?.username || '');
  const link = el('a', {
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': 'Instagramで開く',
    style: 'position:relative;display:grid;place-items:center;width:100%;min-height:180px;background:#0d0d0f;text-decoration:none;overflow:hidden;'
  });
  if (posterUrl) {
    link.append(el('img', {
      src: posterUrl,
      alt: 'Instagram動画サムネイル',
      loading: 'lazy',
      decoding: 'async',
      style: 'display:block;width:100%;height:auto;max-height:68vh;object-fit:contain;opacity:.72;'
    }));
  }
  link.append(el('span', {
    text: 'Instagramで開く ↗',
    style: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:9px 12px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;font-size:12px;font-weight:800;white-space:nowrap;'
  }));
  return link;
}

export function makeInstagramVideoLauncher(item, media) {
  const shortcode = media?.shortcode || item?.shortcode || '';
  const posterUrl = media?.posterUrl || media?.url || '';
  const shell = el('div', {
    class: 'instagram-video-shell',
    style: 'position:relative;width:100%;min-height:180px;display:grid;place-items:center;background:#0d0d0f;overflow:hidden;'
  });
  const button = el('button', {
    type: 'button',
    'aria-label': 'Instagram動画を再生',
    style: 'position:relative;display:grid;place-items:center;width:100%;min-height:180px;border:0;padding:0;background:#0d0d0f;color:#fff;cursor:pointer;'
  });
  if (posterUrl) {
    button.append(el('img', {
      src: posterUrl,
      alt: 'Instagram動画サムネイル',
      loading: 'lazy',
      decoding: 'async',
      style: 'display:block;width:100%;height:auto;max-height:68vh;object-fit:contain;'
    }));
  }
  const mark = el('span', {
    text: '▶',
    'aria-hidden': 'true',
    style: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:rgba(0,0,0,.68);font-size:18px;padding-left:3px;'
  });
  button.append(mark);
  shell.append(button);

  const showFallback = () => {
    if (!shell.isConnected) return;
    shell.replaceChildren(videoFallbackLink(item, posterUrl));
  };

  const activate = async () => {
    if (!shortcode || button.disabled) {
      showFallback();
      return;
    }
    button.disabled = true;
    mark.textContent = '…';
    try {
      const data = await resolveInstagramVideo(shortcode);
      if (!shell.isConnected) return;
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = data.videoUrl;
      video.poster = data.posterUrl || posterUrl || '';
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.style.cssText = 'display:block;width:100%;height:auto;max-height:72vh;background:#000;object-fit:contain;';
      video.addEventListener('play', () => pauseOtherInstagramVideos(video));
      video.addEventListener('error', () => {
        instagramVideoResolverCache.delete(shortcode);
        showFallback();
      }, { once: true });
      shell.replaceChildren(video);
      try { await video.play(); } catch {}
    } catch (error) {
      console.warn('[instagram-video-resolver]', shortcode, error?.message || error);
      showFallback();
    }
  };

  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  });

  if ('IntersectionObserver' in window && shortcode) {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      resolveInstagramVideo(shortcode).catch(() => {});
    }, { rootMargin: '700px 0px' });
    observer.observe(shell);
  }

  return shell;
}
