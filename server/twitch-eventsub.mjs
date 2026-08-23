export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method Not Allowed'});
  const clientId=String(process.env.TWITCH_CLIENT_ID||'').trim(); if(!clientId)return res.status(500).json({error:'TWITCH_CLIENT_ID が未設定です'});
  const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):req.body||{};
  const token=String(body.token||'').trim(), sessionId=String(body.sessionId||'').trim(), broadcasterId=String(body.broadcasterId||'').trim();
  if(!token||!sessionId||!broadcasterId)return res.status(400).json({error:'token / sessionId / broadcasterId が必要です'});
  try{
    const validate=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(10000)}); const vd=await validate.json();
    if(!validate.ok||!vd.user_id)return res.status(401).json({error:'Twitchログインが無効です'}); if(vd.client_id!==clientId)return res.status(403).json({error:'Twitch Client ID が一致しません'});
    const scope=new Set(vd.scopes||[]); if(!scope.has('user:read:chat'))return res.status(403).json({error:'user:read:chat 権限がありません'});
    const response=await fetch('https://api.twitch.tv/helix/eventsub/subscriptions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Client-Id':clientId,'Content-Type':'application/json'},body:JSON.stringify({type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:broadcasterId,user_id:vd.user_id},transport:{method:'websocket',session_id:sessionId}}),signal:AbortSignal.timeout(10000)});
    const data=await response.json().catch(()=>({})); if(!response.ok)return res.status(response.status).json({error:data?.message||'EventSub購読に失敗しました'});
    res.status(200).json({ok:true,userId:vd.user_id,login:vd.login||'',subscription:data.data?.[0]||null});
  }catch(err){console.error('[twitch-eventsub]',err);res.status(500).json({error:err.message||'EventSub接続エラー'});}
}
