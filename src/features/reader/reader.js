import { state, update } from '../../app/store.js';
import { el, openSheet } from '../../shared/dom.js';
import { topbar, segmented, collectionManager, centerScrollItem } from '../../shared/components.js';
import { loadReader, feedsFor } from './reader-data.js';
import { chooseTop, requestAiRank } from './reader-rank.js';
import { mountFocus } from './reader-focus.js';
import { shortDate } from '../../shared/time.js';
import { attachSwipe } from '../../shared/gestures.js';

const READER_MODES = ['news','knowledge','papers'];
let view='focus';
let allItems=[];
let focusHandle=null;
let modeSwipeDetach=null;

const paperTrack=()=>state.paperTrack==='creative'?'creative':'core';
const creativeFamily=()=>['applied','general'].includes(state.creativePaperFamily)?state.creativePaperFamily:'all';
const contextId=(mode,track='core')=>mode==='papers'?`papers:${track}`:mode;
const readKey=(mode,track)=>`pdv2:read:${contextId(mode,track)}`;
const selectedFeedKey=mode=>`pdv2:readerSelectedFeed:${mode}`;
const getRead=(mode,track)=>new Set(JSON.parse(localStorage.getItem(readKey(mode,track))||'[]'));
const saveRead=(mode,track,set)=>localStorage.setItem(readKey(mode,track),JSON.stringify([...set].slice(-1500)));
const lastSeenKey=(mode,track,family='all')=>`pdv2:lastReaderSeen:${contextId(mode,track)}:${track==='creative'?family:'all'}`;
const rankKey=(mode,track,family='all')=>`pdv2:rank:${contextId(mode,track)}:${track==='creative'?family:'all'}`;

function modeLabel(mode){return mode==='papers'?'論文':mode==='knowledge'?'知識':'ニュース';}
function focusLabel(mode,track='core',family='all'){
  if(mode==='papers'){
    if(track!=='creative')return'注目論文';
    if(family==='general')return'一般独創ピックアップ';
    if(family==='applied')return'応用発想ピックアップ';
    return'独創研究ピックアップ';
  }
  return mode==='knowledge'?'いま読む5件':'いま押さえる5件';
}
function creativeFamiliesOf(item){const text=String(item?.description||'');const result=[];if(/独創区分:\s*[^\n]*応用発想/i.test(text))result.push('applied');if(/独創区分:\s*[^\n]*一般独創/i.test(text))result.push('general');if(!result.length)result.push('applied');return result;}
function filterCreativeItems(items,family){return family==='all'?items:items.filter(item=>creativeFamiliesOf(item).includes(family));}
function creativeRankMode(family){return family==='general'?'papers-creative-general':family==='applied'?'papers-creative-applied':'papers-creative-all';}
function getSelectedFeed(mode){return localStorage.getItem(selectedFeedKey(mode))||'';}
function setSelectedFeed(mode,name){localStorage.setItem(selectedFeedKey(mode),name||'');}

function manageFeeds(mode,rerender){
  const key=mode==='papers'?'paperFeeds':mode==='knowledge'?'knowledgeFeeds':'newsFeeds';
  const sheet=openSheet(collectionManager({items:state[key],fields:[{key:'name',label:'タブ名',placeholder:'名称'},{key:'url',label:'RSS URL',placeholder:'https://... または /api/...'}],onSave:draft=>{update(key,draft);sheet.close();setSelectedFeed(mode,'');rerender(true);}}),{title:`${modeLabel(mode)}のタブ編集`});
}
function centerActiveChip(chips){const active=chips?.querySelector('.chip.active');if(active)centerScrollItem(chips,active,{behavior:'smooth'});}
function buildFeedChips(mode,onChange){
  if(mode==='papers')return null;const feeds=feedsFor(mode);if(feeds.length<=1)return null;const selected=getSelectedFeed(mode);const chips=el('div',{class:'chips reader-feed-chips'});
  chips.append(el('button',{class:`chip ${!selected?'active':''}`,type:'button',text:'All',onclick:()=>{setSelectedFeed(mode,'');onChange();}}));
  feeds.forEach(feed=>chips.append(el('button',{class:`chip ${selected===feed.name?'active':''}`,type:'button',text:feed.name,onclick:()=>{setSelectedFeed(mode,feed.name);onChange();}})));
  centerActiveChip(chips);return chips;
}
function buildPaperTrackLevel(onChange){
  const wrap=el('div',{class:'paper-track-level'});
  wrap.append(segmented([{value:'core',label:'製品・熱研究'},{value:'creative',label:'独創研究'}],paperTrack(),onChange));
  return wrap;
}
function buildCreativeFamilyTabs(onChange){
  const family=creativeFamily();const row=el('div',{class:'paper-family-row chips'});
  [{value:'all',label:'すべて'},{value:'applied',label:'応用発想'},{value:'general',label:'一般独創'}].forEach(item=>row.append(el('button',{class:`chip ${family===item.value?'active':''}`,type:'button',text:item.label,onclick:()=>onChange(item.value)})));
  centerActiveChip(row);return row;
}
function renderList(host,mode,track,family,items,onOpen,onBack){
  const read=getRead(mode,track);const lastSeen=Number(localStorage.getItem(lastSeenKey(mode,track,family))||0);const newCount=items.filter(i=>new Date(i.pubDate).getTime()>lastSeen).length;
  const header=el('div',{class:'reader-list-toolbar'},[el('div',{},[el('strong',{text:newCount?`前回から ${newCount}件`:'全記事'}),el('small',{text:` ${items.length}件`})]),el('button',{class:'soft-button',type:'button',text:'おすすめ5件',onclick:onBack})]);
  const search=el('input',{class:'reader-search',placeholder:'タイトル・媒体を検索'});const list=el('div',{class:'list'});
  const draw=()=>{list.replaceChildren();const q=search.value.trim().toLowerCase();items.filter(i=>!q||`${i.title} ${i.titleJa||''} ${i.source}`.toLowerCase().includes(q)).forEach((item,index)=>{const unread=!read.has(item.id);const button=el('button',{class:'list-item',type:'button',onclick:()=>{read.add(item.id);saveRead(mode,track,read);onOpen(item,index);}});button.innerHTML=`<div class="list-item-title">${unread?'<span class="unread-dot"></span>':''}${item.titleJa||item.title}</div>${item.titleJa?`<div class="focus-original">${item.title}</div>`:''}<div class="list-meta"><span>${item.source||''}</span><span>${shortDate(item.pubDate)}</span></div>`;list.append(button);});};
  search.addEventListener('input',draw);draw();host.replaceChildren(header,search,list);localStorage.setItem(lastSeenKey(mode,track,family),String(Date.now()));
}
function cachedAiRanking(mode,track,family='all'){try{const data=JSON.parse(localStorage.getItem(rankKey(mode,track,family))||'null');if(!data?.ranking?.length||Date.now()-Number(data.at||0)>6*60*60*1000)return[];return data.ranking;}catch{return[];}}

export async function renderReader(root,{navigate,refresh=false}){
  view='focus';allItems=[];focusHandle?.destroy?.();focusHandle=null;modeSwipeDetach?.();modeSwipeDetach=null;
  const mode=state.readerMode||'news';const track=mode==='papers'?paperTrack():'core';const screen=el('section',{class:'screen reader-screen'});const rerender=(force=false)=>renderReader(root,{navigate,refresh:force});
  screen.append(topbar('読む',{subtitle:mode==='papers'?(track==='creative'?'論文・独創研究':'論文・製品／熱研究'):'ニュース・知識・論文',actions:[{label:'＋',title:'追加/編集',onClick:()=>manageFeeds(mode,rerender)},{label:'↻',title:'更新',onClick:()=>rerender(true)},{label:'⚙︎',title:'設定',onClick:()=>navigate('settings')}]}));

  const switchMode=value=>{if(!READER_MODES.includes(value)||value===mode)return;update('lastReaderMode',value);view='focus';renderReader(root,{navigate});};
  const cycleMode=delta=>{const i=READER_MODES.indexOf(mode);const next=Math.max(0,Math.min(READER_MODES.length-1,i+delta));if(next!==i)switchMode(READER_MODES[next]);};
  const modeNav=el('div',{class:'reader-mode-nav'});modeNav.append(segmented([{value:'news',label:'ニュース'},{value:'knowledge',label:'知識'},{value:'papers',label:'論文'}],mode,switchMode));screen.append(modeNav);modeSwipeDetach=attachSwipe(modeNav,{left:()=>cycleMode(1),right:()=>cycleMode(-1),threshold:40});

  if(mode==='papers')screen.append(buildPaperTrackLevel(value=>{update('paperTrack',value);view='focus';renderReader(root,{navigate});}));

  const sticky=el('div',{class:'reader-sticky-context'});const lowestTabsHost=el('div',{class:'reader-lowest-tabs-host'});const progressHost=el('div',{class:'reader-progress-host'});
  if(mode!=='papers'){
    const chips=buildFeedChips(mode,()=>{view='focus';renderReader(root,{navigate});});if(chips)lowestTabsHost.append(chips);
  }else if(track==='creative')lowestTabsHost.append(buildCreativeFamilyTabs(value=>{update('creativePaperFamily',value);view='focus';renderReader(root,{navigate});}));
  sticky.append(lowestTabsHost,progressHost);screen.append(sticky);

  const host=el('div',{class:'reader-content-host'});screen.append(host);root.replaceChildren(screen);host.append(el('div',{class:'card',html:'<div class="loading">読み込み中...</div>'}));
  if(mode==='papers')window.addEventListener('pdv2:paper-titles',()=>{try{const translated=JSON.parse(localStorage.getItem('pdv2:paperTitleJa')||'{}');allItems.forEach(item=>{if(translated[item.title])item.titleJa=translated[item.title];});if(allItems.length)renderContent();}catch{}},{once:true});

  let chosen=[];
  const cycleFeed=delta=>{const feeds=feedsFor(mode);if(feeds.length<=1)return;const names=['',...feeds.map(f=>f.name)];const current=getSelectedFeed(mode);const i=Math.max(0,names.indexOf(current));const next=Math.max(0,Math.min(names.length-1,i+delta));if(next===i)return;setSelectedFeed(mode,names[next]);view='focus';renderReader(root,{navigate});};
  const cyclePaperTrack=delta=>{const tracks=['core','creative'];const i=tracks.indexOf(track);const next=Math.max(0,Math.min(tracks.length-1,i+delta));if(next===i)return;update('paperTrack',tracks[next]);view='focus';renderReader(root,{navigate});};
  const cycleCreativeFamily=delta=>{const families=['all','applied','general'];const current=creativeFamily();const i=families.indexOf(current);const next=Math.max(0,Math.min(families.length-1,i+delta));if(next===i)return;update('creativePaperFamily',families[next]);view='focus';renderReader(root,{navigate});};
  const horizontalOptions=mode==='papers'?(track==='creative'?{onPrevFeed:()=>cycleCreativeFamily(-1),onNextFeed:()=>cycleCreativeFamily(1),horizontalHint:'独創研究タブ'}:{onPrevFeed:()=>cyclePaperTrack(-1),onNextFeed:()=>cyclePaperTrack(1),horizontalHint:'論文タブ'}):{onPrevFeed:()=>cycleFeed(-1),onNextFeed:()=>cycleFeed(1),horizontalHint:'RSSタブ'};

  const renderContent=()=>{
    focusHandle?.destroy?.();focusHandle=null;progressHost.replaceChildren();
    const family=mode==='papers'&&track==='creative'?creativeFamily():'all';const visibleItems=mode==='papers'&&track==='creative'?filterCreativeItems(allItems,family):allItems;const rankMode=mode==='papers'&&track==='creative'?creativeRankMode(family):mode;
    if(!visibleItems.length){host.innerHTML=`<div class="empty">${track==='creative'&&family==='general'?'一般独創の候補を取得中です。更新すると再検索します。':'記事がありません'}</div>`;return;}
    if(view==='list'){
      renderList(host,mode,track,family,visibleItems,(item,index)=>{view='focus';chosen=visibleItems;host.replaceChildren();focusHandle=mountFocus(host,{items:chosen,initialIndex:index,label:mode==='papers'&&track==='creative'?(family==='general'?'一般独創一覧':family==='applied'?'応用発想一覧':'独創研究一覧'):'全記事',progressHost,onList:()=>{view='list';renderContent();},onIndexChange:(_,it)=>{const r=getRead(mode,track);r.add(it.id);saveRead(mode,track,r);},...horizontalOptions});},()=>{view='focus';renderContent();});
      const detachListSwipe=attachSwipe(host,{left:horizontalOptions.onNextFeed,right:horizontalOptions.onPrevFeed,threshold:72});focusHandle={destroy:detachListSwipe};return;
    }
    const read=getRead(mode,track);chosen=chooseTop(visibleItems,rankMode,read,5,state.settings.rankWithAi?cachedAiRanking(mode,track,family):[]);host.replaceChildren();focusHandle=mountFocus(host,{items:chosen,label:focusLabel(mode,track,family),progressHost,onList:()=>{view='list';renderContent();},onIndexChange:(_,it)=>{read.add(it.id);saveRead(mode,track,read);},...horizontalOptions});
  };

  try{
    const selectedFeed=getSelectedFeed(mode);const result=await loadReader(mode,{force:refresh,selectedFeed,paperTrack:track,onProgress:items=>{if(!allItems.length&&items.length){allItems=items;renderContent();}}});allItems=result.items;renderContent();
    if(state.settings.rankWithAi&&allItems.length){const family=mode==='papers'&&track==='creative'?creativeFamily():'all';const visible=mode==='papers'&&track==='creative'?filterCreativeItems(allItems,family):allItems;const rankMode=mode==='papers'&&track==='creative'?creativeRankMode(family):mode;requestAiRank(visible,rankMode).then(data=>{if(data?.ranking?.length)localStorage.setItem(rankKey(mode,track,family),JSON.stringify({at:Date.now(),ranking:data.ranking}));}).catch(()=>{});}
  }catch(err){progressHost.replaceChildren();host.replaceChildren(el('div',{class:'error-box',text:err.message}));}
}
