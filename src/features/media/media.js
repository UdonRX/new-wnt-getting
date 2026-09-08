import { state } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { openYouTubeChannelManager, renderYouTube } from '../youtube/youtube.js';
import { renderTwitch } from '../twitch/twitch.js';
import { iconSvg } from '../../shared/icons.js';

export async function renderMedia(root,{navigate,refresh=false}){
  const mode=state.mediaMode||'youtube';
  window.dispatchEvent(new CustomEvent('pdv2:before-navigate',{detail:{screen:'media',mediaMode:mode,internal:true}}));
  const screen=el('section',{class:`screen media-screen media-screen-${mode}`});
  let host=null;
  const actions=[];
  if(mode==='youtube')actions.push({html:iconSvg('plus',{size:20}),title:'YouTubeチャンネルを追加 / 編集',onClick:()=>openYouTubeChannelManager(()=>renderMedia(root,{navigate,refresh:true}))});
  actions.push(
    {html:iconSvg('refresh',{size:20}),title:'更新',onClick:()=>{
      if(mode==='twitch'&&host?.isConnected)return renderTwitch(host,{refresh:true});
      return renderMedia(root,{navigate,refresh:true});
    }},
    {html:iconSvg('settings',{size:20}),title:'設定',onClick:()=>navigate('settings')}
  );
  screen.append(topbar(mode==='twitch'?'Twitch':'YouTube',{
    subtitle:mode==='twitch'?'ライブ配信':'登録チャンネル',
    actions
  }));
  host=el('div',{class:'media-content-host'});
  screen.append(host);
  root.replaceChildren(screen);
  if(mode==='twitch')await renderTwitch(host,{refresh});
  else await renderYouTube(host,{refresh});
}
