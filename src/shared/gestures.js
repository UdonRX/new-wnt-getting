export function attachSwipe(node, { up, down, left, right, threshold = 54, edgeRightOnly = false } = {}) {
  let startX = 0, startY = 0, tracking = false;
  const onStart = e => {
    const t = e.touches?.[0]; if (!t) return;
    startX = t.clientX; startY = t.clientY; tracking = true;
  };
  const onEnd = e => {
    if (!tracking) return; tracking = false;
    const t = e.changedTouches?.[0]; if (!t) return;
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0 && (!edgeRightOnly || startX < 36)) right?.();
      else if (dx < 0) left?.();
    } else {
      if (dy < 0) up?.(); else down?.();
    }
  };
  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchend', onEnd, { passive: true });
  return () => { node.removeEventListener('touchstart', onStart); node.removeEventListener('touchend', onEnd); };
}
