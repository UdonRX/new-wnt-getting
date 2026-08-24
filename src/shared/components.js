import { el } from './dom.js';

export function topbar(title, { subtitle='', actions=[] } = {}) {
  const left = el('div', { class: 'topbar-copy' });
  left.append(el('h1', { text:title }));
  if (subtitle) left.append(el('div', { class:'subtitle', text:subtitle }));
  const right = el('div', { class:'topbar-actions' });
  actions.forEach(action => right.append(el('button', {
    class: action.class || 'icon-button',
    type:'button',
    title:action.title || action.label || '',
    'aria-label':action.title || action.label || '',
    onclick:action.onClick,
    html: action.html || action.label || '•••'
  })));
  return el('header', { class:'topbar' }, [left, right]);
}

export function installShrinkingHeader(target, {
  threshold = 44,
  className = 'is-compact',
  scrollRoot = window,
  range = 42,
  hysteresis = 14
} = {}) {
  if (!target) return () => {};

  let raf = 0;
  let destroyed = false;
  let compact = target.classList.contains(className);
  let lastProgress = -1;
  const enterAt = Math.max(0, Number(threshold) || 0);
  const exitAt = Math.max(0, enterAt - Math.max(4, Number(hysteresis) || 0));
  const motionRange = Math.max(16, Number(range) || 42);

  const scrollTop = () => {
    if (scrollRoot === window) {
      return Math.max(0, Number(window.scrollY || document.scrollingElement?.scrollTop || 0));
    }
    return Math.max(0, Number(scrollRoot?.scrollTop || 0));
  };

  const easeOut = value => {
    const p = Math.max(0, Math.min(1, value));
    // Close to cubic-bezier(.25,1,.5,1), but calculated once per animation frame.
    return 1 - Math.pow(1 - p, 3);
  };

  const paint = () => {
    raf = 0;
    if (destroyed || !target.isConnected) return;

    const top = scrollTop();
    const raw = (top - Math.max(0, enterAt - motionRange)) / motionRange;
    const progress = easeOut(raw);

    // Only custom properties consumed by transform/opacity are changed here.
    // This avoids layout/reflow work during scrolling on iOS Safari.
    if (Math.abs(progress - lastProgress) > 0.002) {
      target.style.setProperty('--pdv2-shrink-progress', progress.toFixed(4));
      target.style.setProperty('--pdv2-shrink-scale', (1 - progress * 0.14).toFixed(4));
      target.style.setProperty('--pdv2-shrink-y', `${(-progress * 5).toFixed(2)}px`);
      target.style.setProperty('--pdv2-shrink-fade', (1 - progress * 0.64).toFixed(4));
      lastProgress = progress;
    }

    if (!compact && top >= enterAt) {
      compact = true;
      target.classList.add(className);
    } else if (compact && top <= exitAt) {
      compact = false;
      target.classList.remove(className);
    }
  };

  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(paint);
  };

  scrollRoot.addEventListener('scroll', onScroll, { passive: true });
  paint();

  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    scrollRoot.removeEventListener('scroll', onScroll);
    target.style.removeProperty('--pdv2-shrink-progress');
    target.style.removeProperty('--pdv2-shrink-scale');
    target.style.removeProperty('--pdv2-shrink-y');
    target.style.removeProperty('--pdv2-shrink-fade');
    window.removeEventListener('pdv2:before-navigate', cleanup);
  };
  window.addEventListener('pdv2:before-navigate', cleanup, { once: true });
  return cleanup;
}

export function centerScrollItem(container, item, { behavior = 'smooth' } = {}) {
  if (!container || !item) return;
  const readerRailManaged = () => typeof window !== 'undefined'
    && window.__PDV2_READER_LIST_UX_INSTALLED
    && container.classList?.contains('reader-feed-chips')
    && Boolean(container.closest?.('.reader-source-dock'));
  // Readerの配信元タブはreader-list-ux.jsだけが位置を管理する。
  if (readerRailManaged()) return;
  let attempts = 0;
  const maxAttempts = 8;
  const center = () => {
    if (readerRailManaged()) return;
    attempts += 1;
    if (!container.isConnected || !item.isConnected || container.clientWidth <= 0 || item.offsetWidth <= 0) {
      if (attempts < maxAttempts) requestAnimationFrame(center);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const rawLeft = container.scrollLeft + (itemRect.left - containerRect.left) - (containerRect.width - itemRect.width) / 2;
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    container.scrollTo({ left: Math.min(maxLeft, Math.max(0, rawLeft)), behavior });
  };
  requestAnimationFrame(() => requestAnimationFrame(center));
}

export function segmented(items, active, onChange) {
  const box = el('div', { class:'segmented' });
  items.forEach(item => box.append(el('button', {
    type:'button',
    class:item.value===active?'active':'',
    text:item.label,
    onclick:()=>onChange(item.value)
  })));
  return box;
}

export function loadingLines() {
  const box = el('div', { class:'card' });
  [90,72,84,60].forEach(w => {
    const s=el('div',{class:'skeleton'});
    s.style.cssText=`height:14px;width:${w}%;margin:10px 0`;
    box.append(s);
  });
  return box;
}

export function actionRow(actions = []) {
  const row = el('div', { class:'sheet-actions' });
  actions.forEach(action => row.append(el('button', {
    type:'button',
    class: action.primary ? 'primary-button' : 'soft-button',
    text: action.label,
    onclick: action.onClick
  })));
  return row;
}

export function collectionManager({ title='編集', items=[], fields=[], onSave, allowAdd=true }) {
  const wrap = el('div');
  const draft = items.map(item => ({ ...item }));
  const render = () => {
    wrap.replaceChildren();
    const list = el('div', { class:'manager-list' });
    draft.forEach((item, index) => {
      const card = el('div', { class:'manager-item' });
      const head = el('div', { class:'manager-head' }, [
        el('strong', { text:item.name || `項目 ${index+1}` }),
        el('div', { class:'manager-buttons' }, [
          el('button',{type:'button',text:'↑',onclick:()=>{ if(index>0){ [draft[index-1],draft[index]]=[draft[index],draft[index-1]]; render(); } }}),
          el('button',{type:'button',text:'↓',onclick:()=>{ if(index<draft.length-1){ [draft[index+1],draft[index]]=[draft[index],draft[index+1]]; render(); } }}),
          el('button',{type:'button',class:'danger-mini',text:'削除',onclick:()=>{ draft.splice(index,1); render(); }})
        ])
      ]);
      card.append(head);
      fields.forEach(field => {
        const box = el('div',{class:'field'});
        box.append(el('label',{text:field.label}));
        const input = el(field.type === 'select' ? 'select' : 'input', {
          value:item[field.key] ?? '',
          type: field.type || 'text',
          placeholder:field.placeholder || ''
        });
        if (field.type === 'select') {
          (field.options || []).forEach(opt => input.append(el('option',{value:opt.value,text:opt.label})));
          input.value = item[field.key] ?? '';
        }
        input.addEventListener('input',()=>{
          item[field.key] = field.type === 'number' ? Number(input.value) : input.value;
          if(field.key==='name') head.querySelector('strong').textContent=input.value || `項目 ${index+1}`;
        });
        box.append(input);
        card.append(box);
      });
      list.append(card);
    });
    wrap.append(list);
    if (allowAdd) wrap.append(el('button',{
      type:'button',
      class:'soft-button full-button',
      text:'＋ 追加',
      onclick:()=>{
        const next={};
        fields.forEach(f=>next[f.key]=f.default ?? '');
        draft.push(next);
        render();
      }
    }));
    wrap.append(actionRow([{label:'保存',primary:true,onClick:()=>onSave?.(draft)}]));
  };
  render();
  return wrap;
}
