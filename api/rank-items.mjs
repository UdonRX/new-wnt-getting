import { generateGemini, getGeminiModel } from '../lib/gemini.mjs';

function body(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

async function handleGeminiCheck(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const keyConfigured = Boolean(process.env.GEMINI_API_KEY);
  const model = getGeminiModel();
  const live = String(req.query?.live || '') === '1';

  if (!keyConfigured) {
    return res.status(500).json({
      ok: false,
      stage: 'environment',
      keyConfigured: false,
      model,
      message: 'Vercelに GEMINI_API_KEY が設定されていません。'
    });
  }

  if (!live) {
    return res.status(200).json({
      ok: true,
      stage: 'environment',
      keyConfigured: true,
      model,
      message: 'GEMINI_API_KEY をVercelが読み込めています。live=1 を付けると実通信を確認できます。'
    });
  }

  try {
    const result = await generateGemini({
      prompt: '「OK」とだけ返してください。',
      systemInstruction: '短い接続テストです。',
      maxOutputTokens: 10,
      timeoutMs: 15000
    });

    return res.status(200).json({
      ok: true,
      stage: 'gemini',
      keyConfigured: true,
      model: result.model,
      message: 'VercelからGemini APIへの接続に成功しました。',
      response: result.text
    });
  } catch (err) {
    const payload = err?.publicError || { error: err?.message || 'Gemini接続テストに失敗しました。' };
    return res.status(err?.statusCode || 500).json({
      ok: false,
      stage: 'gemini',
      keyConfigured: true,
      model,
      ...payload
    });
  }
}

export default async function handler(req, res) {
  // HobbyプランのFunction数を抑えるため、旧 /api/gemini-check をこのFunctionへ統合。
  if (req.method === 'GET' && String(req.query?.mode || '') === 'gemini-check') {
    return handleGeminiCheck(req, res);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!process.env.GEMINI_API_KEY) return res.status(200).json({ ranking: [], skipped: 'no-key' });

  const b = body(req);
  const allowed = ['news', 'knowledge', 'papers', 'papers-creative', 'papers-creative-all', 'papers-creative-applied', 'papers-creative-general'];
  const mode = allowed.includes(b.mode) ? b.mode : 'news';
  const items = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!items.length) return res.status(200).json({ ranking: [] });

  let criteria = '社会・業界への影響、新しさ、情報源の信頼性、一般ユーザーが今知る価値、重複しない多様性';
  let systemInstruction = '情報フィードの優先度を公平に評価する。煽りやクリックベイトは加点しない。';

  if (mode === 'papers') {
    criteria = '炊飯・真空断熱・蓄熱・対象製品・競合企業など現在の研究テーマとの一致、製品開発への応用性、新しさ、PDF全文の可能性、情報源の信頼性';
  }

  if (String(mode).startsWith('papers-creative')) {
    criteria = [
      '一見離れた分野を結ぶ明確な接点があること',
      '身近な疑問、または既存の常識を検証可能な問いへ落としていること',
      '実験・測定・機構モデル・シミュレーション・自然実験・因果推論など、結論を確かめる方法があること',
      '単に奇抜・珍しいだけのテーマを評価しないこと',
      '別の対象へ転用できる原理・方法・評価軸を含むこと',
      '新しさと情報源の信頼性。被引用数は補助材料であり古い論文だけを優遇しないこと',
      '同じ切り口に偏らず異なる独創研究軸を混ぜること'
    ].join('、');
    systemInstruction = '研究の独創性を「奇抜さ」ではなく、異分野接続・問いの鋭さ・検証性・転用可能性で評価する。タイトルだけで煽らず、抄録や説明に方法論が確認できる研究を優先する。';
  }

  if (mode === 'papers-creative-general') {
    criteria += '。特に、炊飯・断熱・家電など既存テーマとの関係は不要。摩擦×触覚、知覚心理×物理特性、幾何学×機能、統計物理×群集、ネットワーク×拡散、因果推論×日常行動、環境×認知、計算×安価センサ、生物構造×表面機能、液滴蒸発、Human-AI、複雑系など、一般論として質の高い異分野研究を優先する。';
  }

  if (mode === 'papers-creative-applied') {
    criteria += '。既存の製品・熱・食・家電テーマへ異分野の原理を持ち込める応用発想を優先する。';
  }

  if (mode === 'papers-creative-all') {
    criteria += '。応用発想と一般独創のどちらか一方に偏らず、両方から価値の高い候補を混ぜる。';
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ranking: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            score: { type: 'number' },
            reason: { type: 'string' }
          },
          required: ['id', 'score', 'reason']
        }
      }
    },
    required: ['ranking']
  };

  try {
    const result = await generateGemini({
      systemInstruction,
      prompt: `モード=${mode}\n評価軸=${criteria}\n次の候補から優先度上位を評価しJSONで返してください。\n${JSON.stringify(items)}`,
      responseSchema: schema,
      maxOutputTokens: 900,
      timeoutMs: 5000
    });
    const parsed = JSON.parse(String(result.text).replace(/^```json\s*|\s*```$/g, ''));
    res.status(200).json(parsed);
  } catch (err) {
    res.status(200).json({ ranking: [], error: err.message });
  }
}
