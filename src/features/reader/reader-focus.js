import { el, openSheet, showToast, escapeHtml } from '../../shared/dom.js';
import { attachSwipe } from '../../shared/gestures.js';
import { shortDate } from '../../shared/time.js';

const summaryCache = new Map();
let controller = null;

function stripHtml(value='') {
  const d=document.createElement('div'); d.innerHTML=value; return (d.textContent||'').replace(/\s+/g,' ').trim();
}

async function fetchSummary(item) {
  const key=item.link||item.id;
  if(summaryCache.has(key)) return summaryCache.get(key);
  controller?.abort(); controller=new AbortController();
  const res=await fetch('/api/summary',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.link,title:item.title,description:stripHtml(item.description),source:item.source}),signal:controller.signal});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||data.detail||`要約エラー (${res.status})`);
  summaryCache.set(key,data); while(summaryCache.size>28) summaryCache.delete(summaryCache.keys().next().value);
  return data;
}

function chatSheet(item, summary) {
  const wrap=el('div'); const history=[];
  const log=el('div',{class:'chat-log'}); const field=el('div',{class:'field'}); field.append(el('label',{text:'この記事について質問'}));
  const input=el('textarea',{rows:'3',placeholder:'例：この研究を製品開発へ応用すると？'}); field.append(input);
  const send=el('button',{class:'primary-button full-button',type:'button',text:'送信'});
  send.onclick=async()=>{
    const q=input.value.trim(); if(!q)return; input.value='';
    log.append(el('div',{class:'chat-user',text:q})); send.disabled=true;
    try{
      const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.link,title:item.title,description:stripHtml(item.description),question:q,history,summary:summary?.points||[]})});
      const data=await res.json(); if(!res.ok)throw new Error(data.error||'回答エラー');
      const answer=data.answer||data.text||''; log.append(el('div',{class:'chat-ai',text:answer})); history.push({role:'user',content:q},{role:'assistant',content:answer});
    }catch(err){log.append(el('div',{class:'error-box',text:err.message}));}finally{send.disabled=false;}
  };
  wrap.append(log,field,send); openSheet(wrap,{title:'AIに質問'});
}

export function mountFocus(host, { items, initialIndex=0, label='いま押さえる', onList, onIndexChange, onPrevFeed, onNextFeed, horizontalHint='RSSタブ' }) {
  let index=Math.max(0,Math.min(initialIndex,items.length-1));
  let detach=()=>{};

  const render=()=>{
    controller?.abort();
    const item=items[index]; if(!item){host.innerHTML='<div class="empty">記事がありません</div>';return;}
    const card=el('article',{class:'card focus-card'});
    const progress=el('div',{class:'focus-progress'});
    const track=el('div',{class:'progress-track'},[el('div',{class:'progress-fill',style:`width:${((index+1)/items.length)*100}%`})]);
    progress.append(el('strong',{text:label}),track,el('span',{text:`${index+1} / ${items.length}`}));
    const body=el('div');
    body.append(el('div',{class:'focus-source',text:`${item.source||''} ・ ${shortDate(item.pubDate)}`}),el('h2',{class:'focus-title',text:item.titleJa||item.title}));
    if(item.titleJa) body.append(el('div',{class:'focus-original',text:item.title}));
    const summaryHost=el('div',{class:'summary-area'});
    summaryHost.append(el('div',{class:'summary-preview',text:stripHtml(item.description).slice(0,240) || 'AI要約を読み込み中...'}));
    body.append(summaryHost);
    const actions=el('div',{class:'focus-actions'});
    const listBtn=el('button',{class:'soft-button',type:'button',text:'≡ 一覧',onclick:onList});
    const chatBtn=el('button',{class:'soft-button',type:'button',text:'AIに質問',onclick:()=>chatSheet(item,summaryCache.get(item.link||item.id))});
    const original=el('a',{class:'soft-button',href:item.link||'#',target:'_blank',rel:'noopener noreferrer',text:'原文'});
    actions.append(listBtn,chatBtn,original);
    card.append(progress,body,actions,el('div',{class:'swipe-hint',text:`↑ 次の記事　↓ 前の記事　←→ ${horizontalHint}`}));
    host.replaceChildren(card); detach();
    detach=attachSwipe(card,{up:()=>move(1),down:()=>move(-1),left:onNextFeed,right:onPrevFeed});
    onIndexChange?.(index,item);

    fetchSummary(item).then(summary=>{
      if(items[index]!==item || !summaryHost.isConnected)return;
      summaryHost.replaceChildren();
      if(summary.short) summaryHost.append(el('div',{class:'summary-block'},[el('h3',{text:'5秒で分かる'}),el('div',{class:'summary-short',text:summary.short})]));
      if(summary.why) summaryHost.append(el('div',{class:'summary-block'},[el('h3',{text:'なぜ重要？'}),el('div',{class:'summary-why',text:summary.why})]));
      const points=Array.isArray(summary.points)?summary.points:[];
      if(points.length){const ul=el('ul');points.forEach(p=>ul.append(el('li',{text:p})));summaryHost.append(el('div',{class:'summary-block'},[el('h3',{text:'ポイント'}),ul]));}
      const note=summary.contentSource==='pdf'?`PDF本文から要約${summary.pdfPageCount?`（${summary.pdfPageCount}ページ）`:''}`:summary.contentSource==='article'?'リンク先本文から要約':`RSS本文から要約${summary.fallbackReason?`（${summary.fallbackReason.slice(0,70)}）`:''}`;
      summaryHost.append(el('div',{class:'source-note',text:note}));
    }).catch(err=>{
      if(err.name==='AbortError')return;
      if(summaryHost.isConnected) summaryHost.innerHTML=`<div class="error-box">${escapeHtml(err.message)}</div>`;
    });
  };
  const move=delta=>{
    const next=index+delta;
    if(next<0){showToast('最初の記事です');return;}
    if(next>=items.length){showToast(`${label}はここまで ✓`);return;}
    index=next;render();
  };
  render();
  return { destroy(){controller?.abort();detach();}, go(i){index=Math.max(0,Math.min(i,items.length-1));render();} };
}
