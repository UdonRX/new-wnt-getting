export const CREATIVE_PAPER_FAMILIES = {
  applied: { id: 'applied', label: '応用発想', shortLabel: '応用', description: '炊飯・熱・家電など既存の関心領域へ異分野の考え方を持ち込む独創研究。' },
  general: { id: 'general', label: '一般独創', shortLabel: '一般', description: '既存の製品キーワードに依存せず、異分野接続・身近な疑問・検証性から探す独創研究。' }
};

export const CREATIVE_PAPER_GROUPS = [
  {
    family: 'applied',
    id: 'acoustic-cooking',
    label: '音・振動 × 沸騰／調理状態',
    jaKeywords: ['沸騰 音響 状態推定', '調理 音 振動 センシング', '気泡 音響 沸騰 検知'],
    enKeywords: ['acoustic emission + boiling + state estimation', 'sound-based sensing + cooking + monitoring', 'bubble acoustics + boiling + detection'],
    intent: '鍋やケトルの音・振動を「状態センサ」として使えるかを見る。非接触・低コストで沸騰、吹きこぼれ、調理進行を推定する研究につながりやすい。',
    conceptA: ['acoustic', 'sound', 'audio', 'vibration', '音響', '音', '振動'],
    conceptB: ['boiling', 'bubble', 'cooking', 'doneness', 'state estimation', '沸騰', '気泡', '調理', '状態推定'],
    semanticQuery: '(acoustic OR sound OR vibration) + (boiling OR bubble OR cooking) + (sensing OR monitoring OR "state estimation" OR detection)'
  },
  {
    family: 'applied',
    id: 'pouring-wetting',
    label: '流体・濡れ × 注ぎ／液だれ',
    jaKeywords: ['注ぎ 液だれ 濡れ性', '注ぎ口 流体 付着', '液滴 接触角 注ぎやすさ'],
    enKeywords: ['pouring dynamics + dripping + wettability', 'spout geometry + fluid dynamics + anti-drip', 'contact angle + liquid jet + pouring'],
    intent: '「なぜ注ぐと垂れるのか」を流体力学と表面科学で解く。ケトル、ポット、コーヒーサーバーの注ぎやすさや液だれ低減へ直接転用しやすい。',
    conceptA: ['pouring', 'spout', 'drip', 'droplet', 'jet', '注ぎ', '注ぎ口', '液だれ', '液滴'],
    conceptB: ['wettability', 'contact angle', 'surface tension', 'fluid dynamics', 'wetting', '濡れ性', '接触角', '表面張力', '流体'],
    semanticQuery: '(pouring OR spout OR dripping OR droplet) + (wettability OR "contact angle" OR "surface tension" OR "fluid dynamics")'
  },
  {
    family: 'applied',
    id: 'surface-boiling-fouling',
    label: '表面科学 × 沸騰／汚れ／洗浄',
    jaKeywords: ['表面粗さ 沸騰 熱伝達', '濡れ性 沸騰 気泡', 'スケール 付着 熱伝達 洗浄'],
    enKeywords: ['surface roughness + nucleate boiling + heat transfer', 'wettability + bubble nucleation + boiling', 'limescale/fouling + heat transfer + cleaning'],
    intent: 'ヒーター表面の微細形状や濡れ性が、沸騰効率・スケール付着・清掃性をどう変えるかを見る。省エネとメンテナンスを同時に扱える。',
    conceptA: ['surface roughness', 'surface texture', 'wettability', 'contact angle', 'microstructure', '表面粗さ', '表面構造', '濡れ性'],
    conceptB: ['nucleate boiling', 'boiling heat transfer', 'fouling', 'limescale', 'scale deposition', 'cleaning', '沸騰', '熱伝達', 'スケール', '付着', '洗浄'],
    semanticQuery: '("surface roughness" OR wettability OR "surface texture") + ("nucleate boiling" OR fouling OR limescale OR cleaning)'
  },
  {
    family: 'applied',
    id: 'capillary-food',
    label: '多孔質・毛細管 × 食品吸水',
    jaKeywords: ['毛細管 米 吸水', '多孔質 食品 水分拡散', '米粒 水分移動 拡散'],
    enKeywords: ['capillary transport + rice grain + hydration', 'porous media + food + moisture diffusion', 'water penetration + cereal grain + microstructure'],
    intent: '米や食品を「多孔質材料」として扱う切り口。浸漬・吸水・加熱時の水分移動を材料科学や輸送現象のモデルで説明できる。',
    conceptA: ['capillary', 'porous media', 'moisture diffusion', 'water penetration', 'mass transfer', '毛細管', '多孔質', '水分拡散', '水分移動'],
    conceptB: ['rice', 'cereal', 'grain', 'food', 'starch', '米', '米粒', '穀物', '食品', 'でんぷん', '澱粉'],
    semanticQuery: '(capillary OR "porous media" OR "moisture diffusion" OR "water penetration") + (rice OR cereal OR grain OR food)'
  },
  {
    family: 'applied',
    id: 'microstructure-sensory',
    label: '微細構造 × 食感／官能',
    jaKeywords: ['食品 微細構造 食感 官能', '米飯 微細構造 粘弾性 食感', 'デンプン 構造 官能評価'],
    enKeywords: ['food microstructure + texture + sensory', 'rice microstructure + rheology + eating quality', 'starch structure + mouthfeel + sensory evaluation'],
    intent: '「おいしい・硬い・粘る」を主観だけでなく、微細構造やレオロジーと結びつける。炊飯条件と食感を機構でつなぐ研究を拾いやすい。',
    conceptA: ['microstructure', 'rheology', 'viscoelastic', 'starch structure', '微細構造', 'レオロジー', '粘弾性', '構造'],
    conceptB: ['texture', 'mouthfeel', 'sensory', 'eating quality', '食感', '口当たり', '官能', '食味'],
    semanticQuery: '(microstructure OR rheology OR viscoelasticity OR "starch structure") + (texture OR mouthfeel OR sensory OR "eating quality") + (food OR rice OR starch)'
  },
  {
    family: 'applied',
    id: 'aroma-thermal-history',
    label: '香り・揮発 × 熱履歴／物質移動',
    jaKeywords: ['香気成分 温度履歴 放散', '香り 揮発 熱 物質移動', 'コーヒー 香気 抽出温度'],
    enKeywords: ['volatile release + temperature profile + mass transfer', 'aroma release + thermal history + food', 'coffee aroma + brewing temperature + volatile compounds'],
    intent: '温度の上げ方・保温の仕方が香りの出方をどう変えるかを見る。コーヒーや米飯の「温度制御とおいしさ」を化学・輸送現象で橋渡しできる。',
    conceptA: ['volatile', 'aroma release', 'flavor release', 'headspace', '香気', '香り', '揮発'],
    conceptB: ['temperature profile', 'thermal history', 'mass transfer', 'brewing temperature', '温度履歴', '温度制御', '物質移動', '抽出温度'],
    semanticQuery: '(volatile OR "aroma release" OR "flavor release") + ("temperature profile" OR "thermal history" OR "mass transfer" OR "brewing temperature") + (food OR rice OR coffee OR beverage)'
  },
  {
    family: 'applied',
    id: 'thermal-touch',
    label: '熱物性 × 触覚／持ちやすさ',
    jaKeywords: ['接触温度 触覚 材料', '熱浸透率 握り 感覚', '表面温度 人間 熱知覚'],
    enKeywords: ['thermal effusivity + touch perception + material', 'contact temperature + haptics + grip', 'thermal perception + handle + material selection'],
    intent: '同じ温度でも「熱い・冷たい」と感じ方が違う理由を、接触熱伝達と知覚で解く。ハンドル、ボトル、カップの材料選定に効く。',
    conceptA: ['thermal effusivity', 'contact temperature', 'thermal conductivity', 'heat transfer', '熱浸透率', '接触温度', '熱伝導'],
    conceptB: ['touch perception', 'haptic', 'thermal perception', 'grip', 'handle', '触覚', '熱知覚', '握り', 'ハンドル'],
    semanticQuery: '("thermal effusivity" OR "contact temperature" OR "thermal conductivity") + (haptic OR "touch perception" OR "thermal perception" OR grip OR handle)'
  },
  {
    family: 'applied',
    id: 'behavior-energy',
    label: '行動科学 × 家電省エネ',
    jaKeywords: ['ユーザー行動 家電 省エネ', '過剰注水 ケトル 消費電力', 'フィードバック 行動変容 家庭 エネルギー'],
    enKeywords: ['user behavior + household appliance + energy consumption', 'overfilling + electric kettle + energy', 'feedback/nudge + appliance + energy saving'],
    intent: '機器効率だけでなく「使い方が生むムダ」を定量化する。過剰注水、保温しっぱなし、設定ミスなど、設計で改善できる行動要因を探せる。',
    conceptA: ['user behavior', 'behavior change', 'nudge', 'feedback', 'overfilling', 'human factors', 'ユーザー行動', '行動変容', 'ナッジ', '過剰注水'],
    conceptB: ['appliance', 'electric kettle', 'water heating', 'energy consumption', 'energy saving', '家電', 'ケトル', '消費電力', '省エネ'],
    semanticQuery: '("user behavior" OR "behavior change" OR nudge OR feedback OR overfilling) + (appliance OR "electric kettle" OR "water heating") + (energy OR "power consumption")'
  },
  {
    family: 'applied',
    id: 'cognitive-appliance-ui',
    label: '認知人間工学 × 家電UI／安全',
    jaKeywords: ['認知人間工学 家電 操作ミス', '高齢者 家電 UI ユーザビリティ', 'エラー防止 操作パネル 家電'],
    enKeywords: ['cognitive ergonomics + appliance interface + error', 'older adults + household appliance + usability', 'error-proofing + control panel + human factors'],
    intent: '「分かりにくい」を見た目の好みではなく、認知負荷・エラー・高齢者特性から解く。UI、ボタン配置、安全設計に直結する。',
    conceptA: ['cognitive ergonomics', 'human factors', 'cognitive load', 'error-proofing', 'older adults', '認知人間工学', '認知負荷', '高齢者', 'エラー防止'],
    conceptB: ['appliance', 'control panel', 'user interface', 'usability', 'safety', '家電', '操作パネル', 'ユーザーインターフェース', '操作性', '安全'],
    semanticQuery: '("cognitive ergonomics" OR "human factors" OR "cognitive load" OR "error-proofing" OR "older adults") + (appliance OR "control panel" OR "user interface" OR usability)'
  },
  {
    family: 'applied',
    id: 'biomimetic-thermal',
    label: '生物模倣・階層構造 × 断熱／熱制御',
    jaKeywords: ['生物模倣 断熱 多孔質', '階層構造 熱伝導 断熱', 'バイオミメティクス 受動 熱制御'],
    enKeywords: ['biomimetic insulation + hierarchical porous structure', 'bio-inspired thermal management + passive regulation', 'hierarchical structure + thermal conductivity + insulation'],
    intent: '羽毛・植物・動物表皮などの階層構造を熱制御へ転用する研究を探す。真空断熱とは別方向の軽量・薄型・受動的な断熱アイデアにつながる。',
    conceptA: ['biomimetic', 'bio-inspired', 'hierarchical structure', 'porous structure', '生物模倣', 'バイオミメティクス', '階層構造'],
    conceptB: ['thermal insulation', 'thermal management', 'thermal conductivity', 'passive thermal', 'heat transfer', '断熱', '熱制御', '熱伝導'],
    semanticQuery: '(biomimetic OR "bio-inspired" OR "hierarchical structure") + ("thermal insulation" OR "thermal management" OR "thermal conductivity" OR "passive thermal")'
  },
  {
    family: 'applied',
    id: 'noncontact-digital-twin',
    label: '非接触センシング／デジタルツイン × 調理・熱機器',
    jaKeywords: ['赤外線 調理 状態推定', '画像 調理 進行 推定', 'デジタルツイン 熱機器 最適化'],
    enKeywords: ['infrared/vision + cooking + state estimation', 'sensor fusion + food process + monitoring', 'digital twin + thermal appliance + optimization'],
    intent: 'カメラ・赤外線・インピーダンス・複数センサやデジタルツインで「中を直接触らず状態を知る」研究を狙う。自動制御や品質推定へ展開しやすい。',
    conceptA: ['infrared', 'computer vision', 'sensor fusion', 'impedance', 'digital twin', 'surrogate model', '赤外線', '画像', 'センサフュージョン', 'インピーダンス', 'デジタルツイン'],
    conceptB: ['cooking', 'food process', 'thermal appliance', 'temperature control', 'state estimation', '調理', '食品プロセス', '熱機器', '温度制御', '状態推定'],
    semanticQuery: '(infrared OR "computer vision" OR "sensor fusion" OR impedance OR "digital twin" OR "surrogate model") + (cooking OR "food process" OR "thermal appliance" OR "temperature control")'
  },
  {
    family: 'general',
    id: 'hidden-state-acoustics',
    label: '音・振動 × 見えない状態推定',
    jaKeywords: ['生活音 状態推定 非接触', '音響 センシング 状態認識', '振動 信号 異常検知 低コスト'],
    enKeywords: ['acoustic sensing + hidden state + non-contact monitoring', 'everyday sound + state recognition + sensing', 'vibroacoustic signal + condition monitoring + low-cost sensor'],
    intent: '人や機器が出す音・振動を「見えない状態の代理センサ」にできるかを見る。追加センサを増やさず、状態・劣化・動作を推定する問いにつながりやすい。',
    conceptA: ['acoustic sensing', 'sound', 'audio', 'vibroacoustic', 'vibration', '音響', '生活音', '音', '振動'],
    conceptB: ['hidden state', 'state recognition', 'condition monitoring', 'state estimation', 'anomaly detection', 'non-contact', '状態推定', '状態認識', '異常検知', '非接触'],
    semanticQuery: '(acoustic OR sound OR audio OR vibration) + ("state estimation" OR "condition monitoring" OR "state recognition" OR "anomaly detection") + (sensing OR monitoring OR non-contact)'
  },
  {
    family: 'general',
    id: 'tribology-haptics',
    label: '摩擦・接触力学 × 触覚／持ちやすさ',
    jaKeywords: ['摩擦 触覚 把持 感覚', '接触力学 指先 滑り', '表面粗さ 触感 摩擦'],
    enKeywords: ['tribology + haptics + grip perception', 'contact mechanics + fingertip + slip detection', 'surface roughness + tactile perception + friction'],
    intent: '「なぜ同じ形でも滑る・持ちやすい・触り心地が違うのか」を摩擦と人間の感覚の両側から解く。材料・表面・操作性を結ぶ再利用性の高い研究を拾いやすい。',
    conceptA: ['tribology', 'friction', 'contact mechanics', 'surface roughness', '摩擦', '接触力学', '表面粗さ'],
    conceptB: ['haptic', 'tactile perception', 'grip', 'fingertip', 'slip detection', '触覚', '触感', '把持', '指先', '滑り'],
    semanticQuery: '(tribology OR friction OR "contact mechanics" OR "surface roughness") + (haptic OR "tactile perception" OR grip OR fingertip OR slip)'
  },
  {
    family: 'general',
    id: 'perception-physics',
    label: '知覚心理 × 物理特性／錯覚',
    jaKeywords: ['知覚 物理特性 錯覚 実験', '重さ錯覚 材料 見た目', 'クロスモーダル 知覚 触覚 音'],
    enKeywords: ['perception + physical properties + illusion + experiment', 'material perception + weight illusion + multisensory', 'crossmodal perception + touch + sound + material'],
    intent: '「実際の値」と「人が感じる値」がなぜズレるかを調べる。重さ、温度、質感、音、見た目の組み合わせから、設計や表示だけでは説明できない判断メカニズムを見つけやすい。',
    conceptA: ['perception', 'psychophysics', 'illusion', 'crossmodal', 'multisensory', '知覚', '心理物理', '錯覚', 'クロスモーダル'],
    conceptB: ['material', 'weight', 'temperature', 'roughness', 'sound', 'appearance', '物理特性', '重さ', '温度', '質感', '見た目'],
    semanticQuery: '(perception OR psychophysics OR illusion OR crossmodal OR multisensory) + (material OR weight OR temperature OR roughness OR sound OR appearance) + (experiment OR measurement)'
  },
  {
    family: 'general',
    id: 'geometry-metamaterials',
    label: '幾何学・折り紙構造 × メタマテリアル／機能',
    jaKeywords: ['折り紙 構造 メタマテリアル 機械特性', '切り紙 構造 可変 剛性', '幾何学 構造 音響 熱 機能'],
    enKeywords: ['origami kirigami + mechanical metamaterial + tunable property', 'geometry + metamaterial + programmable mechanics', 'architected material + acoustic thermal mechanical response'],
    intent: '素材そのものではなく「形・折り・配置」で剛性、吸音、変形、熱特性などを作る研究。材料置換とは違う設計自由度が得られ、他分野へ原理転用しやすい。',
    conceptA: ['origami', 'kirigami', 'geometry', 'architected material', '折り紙', '切り紙', '幾何学', '構造設計'],
    conceptB: ['metamaterial', 'programmable mechanics', 'tunable stiffness', 'acoustic response', 'thermal response', 'メタマテリアル', '可変剛性', '音響特性', '熱特性'],
    semanticQuery: '(origami OR kirigami OR geometry OR "architected material") + (metamaterial OR "programmable mechanics" OR "tunable stiffness" OR acoustic OR thermal)'
  },
  {
    family: 'general',
    id: 'collective-behavior-physics',
    label: '統計物理 × 群集／交通／列',
    jaKeywords: ['統計物理 群集 行動 実験', '歩行者 流れ 混雑 モデル', '待ち行列 人間行動 実測'],
    enKeywords: ['statistical physics + collective behavior + pedestrian', 'crowd dynamics + experiment + bottleneck', 'queueing behavior + human movement + model'],
    intent: '渋滞、行列、出口の詰まりなど日常の集団現象を粒子・流れ・相互作用として扱う。個人の心理だけでは見えない「全体として突然起きる現象」を解明しやすい。',
    conceptA: ['statistical physics', 'collective behavior', 'crowd dynamics', 'queueing', '統計物理', '集団行動', '群集', '待ち行列'],
    conceptB: ['pedestrian', 'traffic', 'bottleneck', 'congestion', 'human movement', '歩行者', '交通', 'ボトルネック', '混雑', '人流'],
    semanticQuery: '("statistical physics" OR "collective behavior" OR "crowd dynamics" OR queueing) + (pedestrian OR traffic OR bottleneck OR congestion OR "human movement") + (experiment OR model OR measurement)'
  },
  {
    family: 'general',
    id: 'network-diffusion',
    label: 'ネットワーク科学 × 情報／行動の拡散',
    jaKeywords: ['ネットワーク科学 情報拡散 実証', '社会ネットワーク 行動伝播 因果', 'イノベーション 拡散 ネットワーク 構造'],
    enKeywords: ['network science + information diffusion + empirical', 'social network + behavioral contagion + causal', 'innovation diffusion + network topology + adoption'],
    intent: '「何が広がるか」だけでなく、誰と誰がつながる構造が拡散速度や偏りをどう変えるかを見る。口コミ、技術普及、行動変容などへ横展開しやすい。',
    conceptA: ['network science', 'social network', 'network topology', 'ネットワーク科学', '社会ネットワーク', 'ネットワーク構造'],
    conceptB: ['information diffusion', 'behavioral contagion', 'innovation diffusion', 'adoption', 'cascade', '情報拡散', '行動伝播', 'イノベーション拡散', '普及'],
    semanticQuery: '("network science" OR "social network" OR "network topology") + ("information diffusion" OR contagion OR "innovation diffusion" OR adoption OR cascade) + (empirical OR experiment OR causal OR model)'
  },
  {
    family: 'general',
    id: 'causal-everyday-behavior',
    label: '因果推論 × 日常行動／小さな介入',
    jaKeywords: ['因果推論 日常行動 自然実験', 'ランダム化 介入 行動変容 実証', '差の差 行動 デジタル環境'],
    enKeywords: ['causal inference + everyday behavior + natural experiment', 'randomized intervention + behavior change + field experiment', 'difference-in-differences + digital behavior + intervention'],
    intent: '単なる相関ではなく「これを変えたから本当に行動が変わったのか」を切り分ける研究。表示、通知、価格、配置、習慣など身近な介入の本当の効果を見つけやすい。',
    conceptA: ['causal inference', 'natural experiment', 'randomized intervention', 'difference-in-differences', 'instrumental variable', '因果推論', '自然実験', 'ランダム化', '差の差'],
    conceptB: ['behavior', 'intervention', 'digital behavior', 'habit', 'choice', '行動', '介入', '習慣', '選択'],
    semanticQuery: '("causal inference" OR "natural experiment" OR randomized OR "difference-in-differences") + (behavior OR intervention OR habit OR choice) + (field OR digital OR everyday)'
  },
  {
    family: 'general',
    id: 'environment-cognition-sleep',
    label: '光・音・温熱環境 × 集中／睡眠／判断',
    jaKeywords: ['照明 温度 騒音 集中 認知 実験', '室内環境 睡眠 光 温熱', '環境条件 判断能力 生産性 測定'],
    enKeywords: ['light temperature noise + cognitive performance + experiment', 'indoor environment + sleep + thermal light exposure', 'environmental conditions + decision performance + controlled study'],
    intent: '日常環境の小さな差が集中、眠気、判断、睡眠へどの程度効くかを定量化する。快適性の主観評価だけでなく、認知・生理・環境工学を結ぶ研究を拾いやすい。',
    conceptA: ['light exposure', 'temperature', 'noise', 'indoor environment', 'thermal environment', '照明', '光', '温度', '騒音', '室内環境'],
    conceptB: ['cognitive performance', 'attention', 'sleep', 'decision performance', 'productivity', '集中', '認知', '睡眠', '判断', '生産性'],
    semanticQuery: '(light OR temperature OR noise OR "indoor environment" OR "thermal environment") + ("cognitive performance" OR attention OR sleep OR decision OR productivity) + (experiment OR measurement OR controlled)'
  },
  {
    family: 'general',
    id: 'lowcost-computational-sensing',
    label: '計算処理 × 安価なセンサ／スマートフォン',
    jaKeywords: ['スマートフォン センサ 計測 推定 検証', '低コスト センサ 補正 機械学習', '計算イメージング 安価 センサ 再構成'],
    enKeywords: ['smartphone sensor + measurement + validation', 'low-cost sensor + calibration + machine learning', 'computational imaging + inexpensive sensor + reconstruction'],
    intent: '高価な専用ハードを増やす代わりに、計算・補正・推定で安価なセンサの限界を超える研究。身近な端末を計測器へ変える発想につながりやすい。',
    conceptA: ['smartphone sensor', 'low-cost sensor', 'inexpensive sensor', 'computational imaging', 'スマートフォン', '低コストセンサ', '安価なセンサ', '計算イメージング'],
    conceptB: ['calibration', 'reconstruction', 'estimation', 'machine learning', 'measurement', '補正', '再構成', '推定', '計測', '機械学習'],
    semanticQuery: '(smartphone OR "low-cost sensor" OR "inexpensive sensor" OR "computational imaging") + (calibration OR reconstruction OR estimation OR measurement OR "machine learning") + (validation OR experiment)'
  },
  {
    family: 'general',
    id: 'bioinspired-multifunctional-surfaces',
    label: '生物構造 × 自己洗浄／集水／摩擦制御',
    jaKeywords: ['生物模倣 表面 自己洗浄 撥水', '生物構造 集水 表面設計', 'バイオミメティクス 摩擦 制御 表面'],
    enKeywords: ['bio-inspired surface + self-cleaning + wettability', 'biomimetic surface + water harvesting + structure', 'biological surface + friction control + multifunctional'],
    intent: '蓮の葉、昆虫、皮膚などの構造を「見た目」ではなく機能原理として転用する。自己洗浄、集水、摩擦、付着など複数課題を一つの表面で解く研究につながる。',
    conceptA: ['bio-inspired surface', 'biomimetic surface', 'biological surface', 'hierarchical surface', '生物模倣', 'バイオミメティクス', '生物構造', '階層表面'],
    conceptB: ['self-cleaning', 'water harvesting', 'wettability', 'friction control', 'adhesion', '自己洗浄', '集水', '撥水', '摩擦制御', '付着'],
    semanticQuery: '("bio-inspired" OR biomimetic OR "biological surface" OR "hierarchical surface") + ("self-cleaning" OR "water harvesting" OR wettability OR friction OR adhesion) + (experiment OR characterization)'
  },
  {
    family: 'general',
    id: 'droplet-evaporation-patterns',
    label: '液滴蒸発 × 乾燥模様／粒子輸送',
    jaKeywords: ['液滴 蒸発 コーヒーリング 粒子輸送', '乾燥模様 表面張力 流れ 実験', '蒸発 液滴 堆積 パターン 制御'],
    enKeywords: ['droplet evaporation + coffee-ring effect + particle transport', 'drying pattern + capillary flow + surface tension', 'evaporating droplet + deposition pattern + control'],
    intent: 'コーヒーの輪染みのような身近な現象を、蒸発・毛細管流・粒子移動で解く。塗布、印刷、検査、汚れ、診断など幅広い応用へつながる基礎現象を拾いやすい。',
    conceptA: ['droplet evaporation', 'evaporating droplet', 'coffee-ring effect', 'drying pattern', '液滴', '蒸発', 'コーヒーリング', '乾燥模様'],
    conceptB: ['particle transport', 'deposition pattern', 'capillary flow', 'Marangoni', 'surface tension', '粒子輸送', '堆積', '毛細管流', '表面張力'],
    semanticQuery: '("droplet evaporation" OR "evaporating droplet" OR "coffee-ring effect" OR "drying pattern") + ("particle transport" OR deposition OR "capillary flow" OR Marangoni OR "surface tension")'
  },
  {
    family: 'general',
    id: 'human-ai-decision',
    label: 'Human-AI × 信頼／認知負荷／判断品質',
    jaKeywords: ['人間 AI 協働 判断品質 実験', 'AI 助言 信頼 自動化バイアス', '生成AI 認知負荷 意思決定 実証'],
    enKeywords: ['human AI collaboration + decision quality + experiment', 'AI advice + trust + automation bias', 'generative AI + cognitive load + decision making + controlled study'],
    intent: 'AIが当たるかだけでなく、人間がAIをどう信じ、いつ過信し、判断が本当に良くなるかを測る。UIや業務支援へ直接転用できる実験研究を拾いやすい。',
    conceptA: ['human-ai', 'human ai collaboration', 'AI advice', 'generative AI', '人間 AI', 'AI協働', 'AI助言', '生成AI'],
    conceptB: ['decision quality', 'trust', 'automation bias', 'cognitive load', 'decision making', '判断品質', '信頼', '自動化バイアス', '認知負荷', '意思決定'],
    semanticQuery: '("human AI" OR "human-AI" OR "AI advice" OR "generative AI") + ("decision quality" OR trust OR "automation bias" OR "cognitive load" OR "decision making") + (experiment OR controlled OR empirical)'
  },
  {
    family: 'general',
    id: 'complex-resilience-cascades',
    label: '複雑系 × 連鎖故障／レジリエンス',
    jaKeywords: ['複雑ネットワーク 連鎖故障 レジリエンス', '相互依存 システム 故障 伝播 モデル', 'サプライチェーン ネットワーク 回復力 シミュレーション'],
    enKeywords: ['complex network + cascading failure + resilience', 'interdependent systems + failure propagation + model', 'supply network + disruption propagation + resilience simulation'],
    intent: '一つの小さな故障がなぜ全体障害へ広がるのか、どこを守れば回復力が上がるのかを見る。インフラ、供給網、組織など異なる対象に共通する構造原理を探せる。',
    conceptA: ['complex network', 'interdependent system', 'network resilience', 'supply network', '複雑ネットワーク', '相互依存', 'ネットワーク', '供給網'],
    conceptB: ['cascading failure', 'failure propagation', 'disruption propagation', 'resilience', 'recovery', '連鎖故障', '故障伝播', '障害伝播', 'レジリエンス', '回復'],
    semanticQuery: '("complex network" OR "interdependent system" OR "supply network") + ("cascading failure" OR "failure propagation" OR disruption OR resilience OR recovery) + (model OR simulation OR empirical)'
  }

];

export function webOfScienceQuery(group) {
  return `TS=(${group.semanticQuery.replace(/\s\+\s/g, ' AND ')})`;
}

export function scopusQuery(group) {
  return `TITLE-ABS-KEY(${group.semanticQuery.replace(/\s\+\s/g, ' AND ')})`;
}

export const CREATIVE_PAPER_METHOD_TERMS = [
  'experiment', 'experimental', 'measurement', 'measured', 'mechanism', 'model', 'modeling', 'modelling',
  'simulation', 'validation', 'validated', 'quantitative', 'optimization', 'optimisation', 'prototype',
  'characterization', 'characterisation', 'microscopy', 'spectroscopy', 'imaging', 'finite element', 'cfd',
  'computational fluid dynamics', 'regression', 'machine learning', 'sensor', 'controlled study', 'comparative',
  'randomized', 'randomised', 'field experiment', 'natural experiment', 'causal inference', 'difference-in-differences',
  'instrumental variable', 'psychophysics', 'eye tracking', 'longitudinal', 'empirical study', 'network analysis', 'field study',
  '実験', '測定', '機構', 'モデル', 'シミュレーション', '検証', '定量', '最適化', '試作', '評価', '解析', '計測',
  '介入', 'ランダム化', '自然実験', '因果推論', '差の差', '実証', 'フィールド実験', '心理物理', '視線計測', '縦断研究'
];
