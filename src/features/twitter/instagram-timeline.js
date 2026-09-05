import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { iconSvg } from '../../shared/icons.js';
import { relativeTime } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';
import { instagramAccounts, instagramProfileUrl, openInstagramAccountManager } from './instagram-accounts.js';
import { makeInstagramVideoLauncher } from './instagram-video.js';

function openExternal(url) {
  const target = String(url || '').trim();
  if (!target) return;
  const opened = window.open(target, '_blank');
  if (opened) {
    try { opened.opener = null; } catch {}
  } else {
    window.location.assign(target);
  }
}

function relativeInstagramTime(item) {
  const iso = item?.timestampIso || (
    Number.isFinite(Number(item?.timestamp))
      ? new Date(Number(item.timestamp) * 1000).toISOString()
      : ''
  );
  return iso ? relativeTime(iso) : '';
}

function absoluteInstagramTime(item) {
  const ms = item?.timestampIso
    ? Date.parse(item.timestampIso)
    : Number(item?.timestamp) * 1000;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

function mediaGallery(item) {
  const media = Array.isArray(item?.media) ? item.media.filter(entry => entry?.url || entry?.posterUrl) : [];
  if (!media.length) return null;

  const imageUrls = media
    .filter(entry => entry.kind !== 'video' && (entry.url || entry.posterUrl))
    .map(entry => entry.url || entry.posterUrl);

  const wrap = el('div', {
    class: 'instagram-media-gallery',
    style: 'position:relative;margin-top:9px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#0d0d0f;'
  });
  const strip = el('div', {
    style: 'display:flex;width:100%;overflow-x:auto;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none;'
  });

  media.forEach((entry, index) => {
    const slide = el('div', {
      style: 'position:relative;flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;display:grid;place-items:center;overflow:hidden;'
    });

    if (entry.kind === 'video') {
      slide.append(makeInstagramVideoLauncher(item, entry));
    } else {
      const src = entry.url || entry.posterUrl;
      const image = el('img', {
        src,
        alt: 'Instagram投稿画像',
        loading: 'lazy',
        decoding: 'async',
        style: 'display:block;width:100%;height:auto;max-height:68vh;object-fit:contain;background:#0d0d0f;'
      });
      image.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = Math.max(0, imageUrls.indexOf(src));
        if (imageUrls.length) openImageViewer(imageUrls, currentIndex);
      });
      slide.append(image);
    }

    if (media.length > 1) {
      slide.append(el('span', {
        text: `${index + 1}/${media.length}`,
        style: 'position:absolute;right:9px;top:9px;padding:4px 7px;border-radius:999px;background:rgba(0,0,0,.68);color:#fff;font-size:11px;font-weight:800;pointer-events:none;'
      }));
    }
    strip.append(slide);
  });

  wrap.append(strip);
  return wrap;
}

function instagramCard(item) {
  const username = String(item?.account?.username || '').trim();
  const profileUrl = item?.account?.profileUrl || instagramProfileUrl(username);
  const permalink = item?.permalink || profileUrl;
  const elapsed = relativeInstagramTime(item);

  const card = el('article', {
    class: 'tweet-card tweet-timeline-item instagram-timeline-item',
    role: 'link',
    tabindex: '0',
    'aria-label': 'Instagram投稿を開く',
    style: 'margin:0;padding:12px 14px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none;display:grid;grid-template-columns:42px minmax(0,1fr);column-gap:10px;align-items:start;cursor:pointer;'
  });

  const avatarLink = el('a', {
    href: profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': `@${username}のInstagramプロフィールを開く`,
    style: 'width:42px;height:42px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--surface-2);color:var(--text-strong);text-decoration:none;'
  });
  avatarLink.innerHTML = iconSvg('instagram', { size: 22, strokeWidth: 1.9 });

  const content = el('div', { style: 'min-width:0;' });
  const meta = el('div', {
    style: 'min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden;white-space:nowrap;line-height:1.25;'
  });
  const author = el('a', {
    href: profileUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    style: 'min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:5px;overflow:hidden;text-decoration:none;color:inherit;'
  }, [
    el('strong', {
      text: `@${username}`,
      style: 'min-width:0;max-width:72%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:780;color:var(--text-strong);'
    }),
    el('span', {
      html: iconSvg('instagram', { size: 13, strokeWidth: 1.9 }),
      'aria-hidden': 'true',
      style: 'flex:0 0 auto;display:inline-flex;color:var(--muted);'
    })
  ]);
  meta.append(author);
  if (elapsed) {
    meta.append(
      el('span', { text: '·', style: 'flex:0 0 auto;font-size:14px;color:var(--muted);' }),
      el('a', {
        href: permalink,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: elapsed,
        title: absoluteInstagramTime(item),
        style: 'flex:0 0 auto;font-size:14px;color:var(--muted);text-decoration:none;'
      })
    );
  }
  content.append(meta);

  if (item?.text) {
    content.append(el('div', {
      class: 'tweet-text',
      text: item.text,
      style: 'margin-top:3px;font-size:15.5px;line-height:1.45;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap;'
    }));
  }

  const gallery = mediaGallery(item);
  if (gallery) content.append(gallery);

  content.append(el('a', {
    href: permalink,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: 'Instagramで開く ↗',
    style: 'display:inline-block;margin-top:8px;color:var(--muted);font-size:11.5px;text-decoration:none;'
  }));

  card.append(avatarLink, content);
  const openPost = () => openExternal(permalink);
  card.addEventListener('click', event => {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('a,button,video,.instagram-media-gallery')) ||
      String(window.getSelection?.()?.toString() || '').trim()
    ) return;
    openPost();
  });
  card.addEventListener('keydown', event => {
    if ((event.key !== 'Enter' && event.key !== ' ') || (event.target instanceof Element && event.target.closest('a,button'))) return;
    event.preventDefault();
    openPost();
  });
  return card;
}

async function fetchInstagramAccount(username) {
  const started = performance.now();
  const response = await fetch(`/api/instagram-profile?username=${encodeURIComponent(username)}&t=${Date.now()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(13000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || !Array.isArray(data.items)) {
    throw new Error(data.error || `Instagram取得 HTTP ${response.status}`);
  }

  const items = data.items
    .slice(0, 6)
    .filter(item => item?.source === 'instagram')
    .map(item => ({
      source: 'instagram',
      account: item.account || { username, profileUrl: instagramProfileUrl(username) },
      id: item.id,
      externalId: item.externalId || null,
      shortcode: item.shortcode || null,
      text: String(item.text || ''),
      timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : null,
      timestampIso: item.timestampIso || null,
      media: Array.isArray(item.media) ? item.media : [],
      mediaType: item.mediaType || 'image',
      permalink: item.permalink || instagramProfileUrl(username),
      reelPermalink: item.reelPermalink || null
    }));

  return {
    username,
    items,
    ms: Math.round(performance.now() - started),
    diagnostics: data.diagnostics || null
  };
}

export function renderInstagramTimeline(root, options, { generation, isCurrent, modeSegment }) {
  let refreshNow = () => {};
  let refreshSerial = 0;
  const screen = el('section', { class: 'screen sns-screen instagram-screen' });
  const header = topbar('SNS', {
    subtitle: 'Instagramタイムライン',
    actions: [
      {
        html: iconSvg('plus', { size: 20 }),
        title: 'Instagramアカウントを追加・管理',
        onClick: () => openInstagramAccountManager({
          onChanged: () => {
            if (isCurrent(generation)) refreshNow();
          }
        })
      },
      {
        html: iconSvg('refresh', { size: 20 }),
        title: '更新',
        onClick: () => refreshNow()
      },
      {
        html: iconSvg('settings', { size: 20 }),
        title: '設定',
        onClick: () => options.navigate('settings')
      }
    ]
  });
  const status = el('div', {
    class: 'twitter-update-status media-meta',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
    style: 'min-height:16px;margin:0 4px 4px;opacity:.82;'
  });
  const host = el('div', {
    class: 'twitter-feed-host instagram-feed-host',
    style: 'display:block;margin:0 -14px;padding:0;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;overflow:visible;'
  });
  screen.append(header, status, host, modeSegment);
  root.replaceChildren(screen);

  const refreshFeed = async () => {
    const serial = ++refreshSerial;
    const accounts = instagramAccounts();
    status.textContent = '';
    if (!accounts.length) {
      host.replaceChildren(el('div', {
        style: 'margin:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--muted);line-height:1.55;'
      }, [
        el('strong', { text: 'Instagramアカウントを登録してください', style: 'display:block;color:var(--text-strong);margin-bottom:4px;' }),
        el('span', { text: '上部の＋から @username / username / profile URL を追加できます。' })
      ]));
      return;
    }

    host.replaceChildren(el('div', {
      class: 'twitter-wake-status',
      style: 'margin:12px 14px;'
    }, [
      el('strong', { text: `${accounts.length}アカウントを取得中…` }),
      el('span', { text: '各アカウント最新6投稿を読み込みます' })
    ]));
    status.textContent = '更新中…';

    const results = await Promise.allSettled(accounts.map(fetchInstagramAccount));
    if (!isCurrent(generation) || serial !== refreshSerial || !screen.isConnected) return;

    const merged = [];
    let ok = 0;
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        ok += 1;
        merged.push(...result.value.items);
      } else {
        console.warn('[instagram-account-fetch]', result.reason?.message || result.reason);
      }
    });

    const seen = new Set();
    const items = merged
      .filter(item => {
        const key = item.id || `${item.account?.username}:${item.shortcode}`;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

    if (!items.length) {
      host.replaceChildren(el('div', {
        style: 'margin:14px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--muted);line-height:1.55;'
      }, [
        el('strong', { text: 'Instagram投稿を取得できませんでした', style: 'display:block;color:var(--text-strong);margin-bottom:4px;' }),
        el('span', { text: '公開プロフィールか確認して、更新を試してください。' })
      ]));
      status.textContent = `0/${accounts.length}アカウント取得`;
      return;
    }

    host.replaceChildren(...items.map(instagramCard));
    const failed = accounts.length - ok;
    status.textContent = `${ok}/${accounts.length}アカウント · ${items.length}投稿${failed ? ` · ${failed}件失敗` : ''}`;
    if (!failed) {
      setTimeout(() => {
        if (status.isConnected && isCurrent(generation)) status.textContent = '';
      }, 1800);
    }
  };

  refreshNow = () => {
    if (!isCurrent(generation)) return;
    refreshFeed().catch(error => {
      if (!isCurrent(generation)) return;
      console.error('[instagram-refresh]', error);
      status.textContent = 'Instagramを更新できませんでした';
    });
  };

  refreshNow();
}
