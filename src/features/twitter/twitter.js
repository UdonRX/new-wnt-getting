import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, collectionManager } from '../../shared/components.js';
import { parseFeed } from '../../shared/rss.js';
import { shortDate } from '../../shared/time.js';
import { openImageViewer } from './image-viewer.js';

let selected=Number(localStorage.getItem('pdv2:twitterIndex')||0);
let retryTimer=null;
let renderGeneration=0;

function stopRetry(){if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}}
window.addEventListener('pdv2:before-navigate',stopRetry);

function feedUrl(feed){if(feed.url)return feed.url;return `${state.settings.twitterRssBase}${feed.id}`;}
function proxied(url){
  if(url.startsWith('/'))return url;
  const q=new URLSearchParams({url,timeout:'4500'});
  return `/api/rss?${q}`;
}
async function load(feed){
  const url=feedUrl(feed);
  const r=await fetch(proxied(url),{cache:'no-store'});
  if(!r.ok){const detail=await r.text().catch(()=>'');throw new Error(`Twitter RSS取得エラー (${r.status})${detail?`: ${detail.slice(0,100)}`:''}`);}
  return parseFeed(await r.text(),feed.name);
}

function manage(onDone){
  let sheet;
  sheet=openSheet(collectionManager({items:state.twitterFeeds,fields:[
    {key:'name',label:'タブ名',placeholder:'リスト名'},
    {key:'id',label:'Twitter/X リストID',placeholder:'2087...'},
    {key:'url',label:'RSS URL（任意）',placeholder:'空ならRSSHubを使用'}
  ],onSave:d=>{update('twitterFeeds',d);sheet.close();selected=0;stopRetry();onDone();}}),{title:'Twitterリスト編集'});
}

function isTwitterUrl(href=''){
  try{const h=new URL(href).hostname.replace(/^www\./,'').toLowerCase();return h==='x.com'||h.endsWith('.x.com')||h==='twitter.com'||h.endsWith('.twitter.com');}catch{return false;}
}
function cleanDescription(html){
  const doc=new DOMParser().parseFromString(`<div id="tweet-root">${html||''}</div>`,'text/html');
  const root=doc.getElementById('tweet-root')||doc.body;
  root.querySelectorAll('script,style,iframe,video').forEach(n=>n.remove());
  const images=[...root.querySelectorAll('img')]
    .map(i=>i.getAttribute('src')||i.src)
    .filter(src=>/twimg\.com|pbs\.twimg/i.test(src||''))
    .map(src=>src.replace(/&amp;/g,'&'))
    .slice(0,4);
  root.querySelectorAll('img').forEach(n=>n.remove());

  const links=[];
  root.querySelectorAll('a[href]').forEach(a=>{
    const href=a.getAttribute('href')||'';
    const label=(a.textContent||'').trim();
    if(/^https?:\/\//i.test(href)&&!isTwitterUrl(href)){
      if(!links.some(x=>x.href===href))links.push({href,label:label||href});
    }
    a.replaceWith(doc.createTextNode(label));
  });
  const text=(root.textContent||'').replace(/\s+/g,' ').trim();
  return {text,images:[...new Set(images)],links};
}

function externalLabel(link){
  try{
    const host=new URL(link.href).hostname.replace(/^www\./,'');
    const label=link.label&&!/^https?:\/\//i.test(link.label)?link.label:host;
    return `${label}  ↗`;
  }catch{return '外部リンク ↗';}
}

function renderItems(host,items,feed){
  host.replaceChildren();
  items.slice(0,100).forEach(item=>{
    const c=cleanDescription(item.description);
    const tw=el('article',{class:'tweet'});
    const head=el('div',{class:'tweet-head'},[
      el('strong',{text:item.author||feed.name}),
      el('span',{text:shortDate(item.pubDate)})
    ]);
    tw.append(head,el('div',{class:'tweet-body',text:c.text||item.title}));

    if(c.images.length){
      const grid=el('div',{class:`tweet-images count-${c.images.length}`});
      c.images.forEach((src,i)=>{
        const button=el('button',{class:'tweet-image-button',type:'button','aria-label':`画像 ${i+1} を拡大`,onclick:()=>openImageViewer(c.images,i)});
        button.append(el('img',{src,alt:'ツイート画像',loading:'lazy'}));
        grid.append(button);
      });
      tw.append(grid);
    }

    if(c.links.length){
      const links=el('div',{class:'tweet-external-links'});
      c.links.slice(0,4).forEach(link=>links.append(el('a',{class:'tweet-external-link',href:link.href,target:'_blank',rel:'noopener noreferrer',text:externalLabel(link)})));
      tw.append(links);
    }

    if(item.link){
      tw.append(el('div',{class:'tweet-footer'},[
        el('a',{href:item.link,target:'_blank',rel:'noopener noreferrer',class:'tweet-open-x',text:'Xで開く ↗'})
      ]));
    }
    host.append(tw);
  });
}

export async function renderTwitter(root,{navigate,refresh=false}){
  stopRetry();
  const generation=++renderGeneration;
  if(selected>=state.twitterFeeds.length)selected=0;
  const feed=state.twitterFeeds[selected];
  const screen=el('section',{class:'screen'});
  screen.append(topbar('SNS',{subtitle:'Twitter / X リスト',actions:[
    {label:'＋',title:'追加/編集',onClick:()=>manage(()=>renderTwitter(root,{navigate,refresh:true}))},
    {label:'↻',title:'更新',onClick:()=>renderTwitter(root,{navigate,refresh:true})},
    {label:'⚙︎',title:'設定',onClick:()=>navigate('settings')}
  ]}));
  const chips=el('div',{class:'chips'});
  state.twitterFeeds.forEach((f,i)=>chips.append(el('button',{class:`chip ${i===selected?'active':''}`,type:'button',text:f.name,onclick:()=>{
    localStorage.setItem(`pdv2:twitterScroll:${selected}`,String(window.scrollY));
    selected=i;localStorage.setItem('pdv2:twitterIndex',String(i));renderTwitter(root,{navigate});
  }})));
  const host=el('div',{class:'card twitter-card'});
  screen.append(chips,host);
  root.replaceChildren(screen);
  if(!feed){host.replaceChildren(el('div',{class:'empty',text:'リストを追加してください'}));return;}

  let attempts=0;
  const run=async()=>{
    if(generation!==renderGeneration||!screen.isConnected)return;
    attempts++;
    host.replaceChildren(el('div',{class:'twitter-wake-status',html:`<strong>${attempts===1?'ツイートを読み込み中':'RSSHubの起動を待っています'}</strong><span>${attempts>1?'5秒ごとに自動確認中':''}</span>`}));
    try{
      const items=await load(feed);
      if(!items.length)throw new Error('RSSは取得できましたが、ツイートが0件でした');
      renderItems(host,items,feed);
      const saved=Number(localStorage.getItem(`pdv2:twitterScroll:${selected}`)||0);
      if(saved)setTimeout(()=>window.scrollTo(0,saved),0);
    }catch(err){
      if(generation!==renderGeneration||!screen.isConnected)return;
      host.replaceChildren(
        el('div',{class:'twitter-wake-status'},[
          el('strong',{text:'RSSHubの応答待ち'}),
          el('span',{text:`${err.message} / 5秒後に再試行します`})
        ])
      );
      retryTimer=setTimeout(run,5000);
    }
  };
  run();
}
