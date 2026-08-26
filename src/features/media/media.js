import { state, update } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar, segmented } from '../../shared/components.js';
import { openYouTubeChannelManager, renderYouTube } from '../youtube/youtube.js';
import { renderTwitch } from '../twitch/twitch.js';
import { applyTheme } from '../../app/router.js';
import { iconSvg } from '../../shared/icons.js';

export async function renderMedia(root,{navigate,refresh=false}){
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate',{detail:{screen:'media',internal:true}}));
  const mode=state.mediaMode||'youtube';
  const screen=el('section',{class:`screen media-screen media-screen-${mode}`});
  const actions=[];
  if(mode==='youtube')actions.push({html:iconSvg('plus',{size:20}),title:'YouTubeチャンネルを追加 / 編集',onClick:()=>openYouTubeChannelManager(()=>renderMedia(root,{navigate,refresh:true}))});
  actions.push(
    {html:iconSvg('refresh',{size:20}),title:'更新',onClick:()=>renderMedia(root,{navigate,refresh:true})},
    {html:iconSvg('settings',{size:20}),title:'設定',onClick:()=>navigate('settings')}
  );
  screen.append(topbar('動画',{
    subtitle:'YouTube / Twitch',
    actions
  }));
  const segHost=el('div',{class:'media-mode-nav'});
  const host=el('div',{class:'media-content-host'});
  screen.append(segHost,host);
  root.replaceChildren(screen);
  segHost.replaceChildren(segmented([
    {value:'youtube',label:'YouTube'},
    {value:'twitch',label:'Twitch'}
  ],mode,value=>{
    if(value===state.mediaMode)return;
    window.dispatchEvent(new CustomEvent('pdv2:before-navigate',{detail:{screen:'media',mediaMode:value,internal:true}}));
    update('lastMediaMode',value);
    applyTheme();
    renderMedia(root,{navigate});
  }));
  if(mode==='twitch')await renderTwitch(host,{refresh});
  else await renderYouTube(host,{refresh});
}
