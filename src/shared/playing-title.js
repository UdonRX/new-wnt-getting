let activeCleanup = null;

export function clearPlayingTitle() {
  activeCleanup?.();
  activeCleanup = null;
}

export function watchPlayingTitle(stage, initialTitle = '再生中') {
  clearPlayingTitle();
  if (!stage) return { destroy() {}, setTitle() {} };

  const bar = document.createElement('div');
  bar.className = 'media-now-playing-fixed';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.textContent = String(initialTitle || '再生中').trim() || '再生中';
  document.body.append(bar);

  const topInset = () => Math.max(0, Number(window.visualViewport?.offsetTop || 0));

  const update = () => {
    if (!stage.isConnected) {
      cleanup();
      return;
    }
    const rect = stage.getBoundingClientRect();
    // プレーヤーの下端まで画面上側へ抜けた時だけタイトルを固定表示。
    // iframe自体は一切移動・再生成しないため再生は止めない。
    const show = rect.bottom <= topInset() + 4;
    bar.classList.toggle('visible', show);
  };

  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) bar.classList.remove('visible');
        else update();
      }, { threshold: [0, 0.01] })
    : null;

  observer?.observe(stage);
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  window.visualViewport?.addEventListener?.('resize', update, { passive: true });
  requestAnimationFrame(update);

  function cleanup() {
    observer?.disconnect();
    window.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener?.('resize', update);
    bar.remove();
    if (activeCleanup === cleanup) activeCleanup = null;
  }

  activeCleanup = cleanup;
  return {
    destroy: cleanup,
    setTitle(value) {
      bar.textContent = String(value || '再生中').trim() || '再生中';
    }
  };
}
