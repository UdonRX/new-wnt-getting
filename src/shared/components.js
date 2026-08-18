import { el } from './dom.js';

export function topbar(title, { subtitle='', actions=[] } = {}) {
  const left = el('div');
  left.append(el('h1', { text:title }));
  if (subtitle) left.append(el('div', { class:'subtitle', text:subtitle }));
  const right = el('div', { class:'topbar-actions' });
  actions.forEach(action => right.append(el('button', {
    class: action.class || 'icon-button', type:'button', title:action.title || action.label || '', 'aria-label':action.title || action.label || '', onclick:action.onClick,
    html: action.html || action.label || '•••'
  })));
  return el('header', { class:'topbar' }, [left, right]);
}

export function segmented(items, active, onChange) {
  const box = el('div', { class:'segmented' });
  items.forEach(item => box.append(el('button', { type:'button', class:item.value===active?'active':'', text:item.label, onclick:()=>onChange(item.value) })));
  return box;
}

export function loadingLines() {
  const box = el('div', { class:'card' });
  [90,72,84,60].forEach(w => { const s=el('div',{class:'skeleton'}); s.style.cssText=`height:14px;width:${w}%;margin:10px 0`; box.append(s); });
  return box;
}

export function actionRow(actions = []) {
  const row = el('div', { class:'sheet-actions' });
  actions.forEach(action => row.append(el('button', {
    type:'button', class: action.primary ? 'primary-button' : 'soft-button', text: action.label, onclick: action.onClick
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
        const input = el(field.type === 'select' ? 'select' : 'input', { value:item[field.key] ?? '', type: field.type || 'text', placeholder:field.placeholder || '' });
        if (field.type === 'select') {
          (field.options || []).forEach(opt => input.append(el('option',{value:opt.value,text:opt.label})));
          input.value = item[field.key] ?? '';
        }
        input.addEventListener('input',()=>{ item[field.key] = field.type === 'number' ? Number(input.value) : input.value; if(field.key==='name') head.querySelector('strong').textContent=input.value || `項目 ${index+1}`; });
        box.append(input); card.append(box);
      });
      list.append(card);
    });
    wrap.append(list);
    if (allowAdd) wrap.append(el('button',{type:'button',class:'soft-button full-button',text:'＋ 追加',onclick:()=>{ const next={}; fields.forEach(f=>next[f.key]=f.default ?? ''); draft.push(next); render(); }}));
    wrap.append(actionRow([{label:'保存',primary:true,onClick:()=>onSave?.(draft)}]));
  };
  render();
  return wrap;
}
