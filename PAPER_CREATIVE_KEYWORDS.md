# 独創研究：検索キーワードと狙い

このタブは、**珍しい題材そのものではなく、異分野の接続・鋭い問い・検証可能な方法**が揃う研究を優先します。

V2.2では独創研究を2種類に分けます。

- **応用発想**：炊飯・熱・家電など既存の関心領域へ異分野の考え方を持ち込む研究
- **一般独創**：既存の論文キーワードとの関係を一切必須にせず、一般論として質の高い独創研究を探す

Webアプリ上では `論文 → 独創研究 → すべて / 応用発想 / 一般独創` で切り替えられます。

---

## 応用発想

### 1. 音・振動 × 沸騰／調理状態

**なぜ面白い研究につながりやすいか**  
鍋やケトルの音・振動を「状態センサ」として使えるかを見る。非接触・低コストで沸騰、吹きこぼれ、調理進行を推定する研究につながりやすい。

**日本語キーワード**  
`沸騰 音響 状態推定` / `調理 音 振動 センシング` / `気泡 音響 沸騰 検知`

**英語キーワード**  
`acoustic emission + boiling + state estimation` / `sound-based sensing + cooking + monitoring` / `bubble acoustics + boiling + detection`

**Web of Science向け**

```text
TS=((acoustic OR sound OR vibration) AND (boiling OR bubble OR cooking) AND (sensing OR monitoring OR "state estimation" OR detection))
```

**Scopus向け**

```text
TITLE-ABS-KEY((acoustic OR sound OR vibration) AND (boiling OR bubble OR cooking) AND (sensing OR monitoring OR "state estimation" OR detection))
```

### 2. 流体・濡れ × 注ぎ／液だれ

**なぜ面白い研究につながりやすいか**  
「なぜ注ぐと垂れるのか」を流体力学と表面科学で解く。ケトル、ポット、コーヒーサーバーの注ぎやすさや液だれ低減へ直接転用しやすい。

**日本語キーワード**  
`注ぎ 液だれ 濡れ性` / `注ぎ口 流体 付着` / `液滴 接触角 注ぎやすさ`

**英語キーワード**  
`pouring dynamics + dripping + wettability` / `spout geometry + fluid dynamics + anti-drip` / `contact angle + liquid jet + pouring`

**Web of Science向け**

```text
TS=((pouring OR spout OR dripping OR droplet) AND (wettability OR "contact angle" OR "surface tension" OR "fluid dynamics"))
```

**Scopus向け**

```text
TITLE-ABS-KEY((pouring OR spout OR dripping OR droplet) AND (wettability OR "contact angle" OR "surface tension" OR "fluid dynamics"))
```

### 3. 表面科学 × 沸騰／汚れ／洗浄

**なぜ面白い研究につながりやすいか**  
ヒーター表面の微細形状や濡れ性が、沸騰効率・スケール付着・清掃性をどう変えるかを見る。省エネとメンテナンスを同時に扱える。

**日本語キーワード**  
`表面粗さ 沸騰 熱伝達` / `濡れ性 沸騰 気泡` / `スケール 付着 熱伝達 洗浄`

**英語キーワード**  
`surface roughness + nucleate boiling + heat transfer` / `wettability + bubble nucleation + boiling` / `limescale/fouling + heat transfer + cleaning`

**Web of Science向け**

```text
TS=(("surface roughness" OR wettability OR "surface texture") AND ("nucleate boiling" OR fouling OR limescale OR cleaning))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("surface roughness" OR wettability OR "surface texture") AND ("nucleate boiling" OR fouling OR limescale OR cleaning))
```

### 4. 多孔質・毛細管 × 食品吸水

**なぜ面白い研究につながりやすいか**  
米や食品を「多孔質材料」として扱う切り口。浸漬・吸水・加熱時の水分移動を材料科学や輸送現象のモデルで説明できる。

**日本語キーワード**  
`毛細管 米 吸水` / `多孔質 食品 水分拡散` / `米粒 水分移動 拡散`

**英語キーワード**  
`capillary transport + rice grain + hydration` / `porous media + food + moisture diffusion` / `water penetration + cereal grain + microstructure`

**Web of Science向け**

```text
TS=((capillary OR "porous media" OR "moisture diffusion" OR "water penetration") AND (rice OR cereal OR grain OR food))
```

**Scopus向け**

```text
TITLE-ABS-KEY((capillary OR "porous media" OR "moisture diffusion" OR "water penetration") AND (rice OR cereal OR grain OR food))
```

### 5. 微細構造 × 食感／官能

**なぜ面白い研究につながりやすいか**  
「おいしい・硬い・粘る」を主観だけでなく、微細構造やレオロジーと結びつける。炊飯条件と食感を機構でつなぐ研究を拾いやすい。

**日本語キーワード**  
`食品 微細構造 食感 官能` / `米飯 微細構造 粘弾性 食感` / `デンプン 構造 官能評価`

**英語キーワード**  
`food microstructure + texture + sensory` / `rice microstructure + rheology + eating quality` / `starch structure + mouthfeel + sensory evaluation`

**Web of Science向け**

```text
TS=((microstructure OR rheology OR viscoelasticity OR "starch structure") AND (texture OR mouthfeel OR sensory OR "eating quality") AND (food OR rice OR starch))
```

**Scopus向け**

```text
TITLE-ABS-KEY((microstructure OR rheology OR viscoelasticity OR "starch structure") AND (texture OR mouthfeel OR sensory OR "eating quality") AND (food OR rice OR starch))
```

### 6. 香り・揮発 × 熱履歴／物質移動

**なぜ面白い研究につながりやすいか**  
温度の上げ方・保温の仕方が香りの出方をどう変えるかを見る。コーヒーや米飯の「温度制御とおいしさ」を化学・輸送現象で橋渡しできる。

**日本語キーワード**  
`香気成分 温度履歴 放散` / `香り 揮発 熱 物質移動` / `コーヒー 香気 抽出温度`

**英語キーワード**  
`volatile release + temperature profile + mass transfer` / `aroma release + thermal history + food` / `coffee aroma + brewing temperature + volatile compounds`

**Web of Science向け**

```text
TS=((volatile OR "aroma release" OR "flavor release") AND ("temperature profile" OR "thermal history" OR "mass transfer" OR "brewing temperature") AND (food OR rice OR coffee OR beverage))
```

**Scopus向け**

```text
TITLE-ABS-KEY((volatile OR "aroma release" OR "flavor release") AND ("temperature profile" OR "thermal history" OR "mass transfer" OR "brewing temperature") AND (food OR rice OR coffee OR beverage))
```

### 7. 熱物性 × 触覚／持ちやすさ

**なぜ面白い研究につながりやすいか**  
同じ温度でも「熱い・冷たい」と感じ方が違う理由を、接触熱伝達と知覚で解く。ハンドル、ボトル、カップの材料選定に効く。

**日本語キーワード**  
`接触温度 触覚 材料` / `熱浸透率 握り 感覚` / `表面温度 人間 熱知覚`

**英語キーワード**  
`thermal effusivity + touch perception + material` / `contact temperature + haptics + grip` / `thermal perception + handle + material selection`

**Web of Science向け**

```text
TS=(("thermal effusivity" OR "contact temperature" OR "thermal conductivity") AND (haptic OR "touch perception" OR "thermal perception" OR grip OR handle))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("thermal effusivity" OR "contact temperature" OR "thermal conductivity") AND (haptic OR "touch perception" OR "thermal perception" OR grip OR handle))
```

### 8. 行動科学 × 家電省エネ

**なぜ面白い研究につながりやすいか**  
機器効率だけでなく「使い方が生むムダ」を定量化する。過剰注水、保温しっぱなし、設定ミスなど、設計で改善できる行動要因を探せる。

**日本語キーワード**  
`ユーザー行動 家電 省エネ` / `過剰注水 ケトル 消費電力` / `フィードバック 行動変容 家庭 エネルギー`

**英語キーワード**  
`user behavior + household appliance + energy consumption` / `overfilling + electric kettle + energy` / `feedback/nudge + appliance + energy saving`

**Web of Science向け**

```text
TS=(("user behavior" OR "behavior change" OR nudge OR feedback OR overfilling) AND (appliance OR "electric kettle" OR "water heating") AND (energy OR "power consumption"))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("user behavior" OR "behavior change" OR nudge OR feedback OR overfilling) AND (appliance OR "electric kettle" OR "water heating") AND (energy OR "power consumption"))
```

### 9. 認知人間工学 × 家電UI／安全

**なぜ面白い研究につながりやすいか**  
「分かりにくい」を見た目の好みではなく、認知負荷・エラー・高齢者特性から解く。UI、ボタン配置、安全設計に直結する。

**日本語キーワード**  
`認知人間工学 家電 操作ミス` / `高齢者 家電 UI ユーザビリティ` / `エラー防止 操作パネル 家電`

**英語キーワード**  
`cognitive ergonomics + appliance interface + error` / `older adults + household appliance + usability` / `error-proofing + control panel + human factors`

**Web of Science向け**

```text
TS=(("cognitive ergonomics" OR "human factors" OR "cognitive load" OR "error-proofing" OR "older adults") AND (appliance OR "control panel" OR "user interface" OR usability))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("cognitive ergonomics" OR "human factors" OR "cognitive load" OR "error-proofing" OR "older adults") AND (appliance OR "control panel" OR "user interface" OR usability))
```

### 10. 生物模倣・階層構造 × 断熱／熱制御

**なぜ面白い研究につながりやすいか**  
羽毛・植物・動物表皮などの階層構造を熱制御へ転用する研究を探す。真空断熱とは別方向の軽量・薄型・受動的な断熱アイデアにつながる。

**日本語キーワード**  
`生物模倣 断熱 多孔質` / `階層構造 熱伝導 断熱` / `バイオミメティクス 受動 熱制御`

**英語キーワード**  
`biomimetic insulation + hierarchical porous structure` / `bio-inspired thermal management + passive regulation` / `hierarchical structure + thermal conductivity + insulation`

**Web of Science向け**

```text
TS=((biomimetic OR "bio-inspired" OR "hierarchical structure") AND ("thermal insulation" OR "thermal management" OR "thermal conductivity" OR "passive thermal"))
```

**Scopus向け**

```text
TITLE-ABS-KEY((biomimetic OR "bio-inspired" OR "hierarchical structure") AND ("thermal insulation" OR "thermal management" OR "thermal conductivity" OR "passive thermal"))
```

### 11. 非接触センシング／デジタルツイン × 調理・熱機器

**なぜ面白い研究につながりやすいか**  
カメラ・赤外線・インピーダンス・複数センサやデジタルツインで「中を直接触らず状態を知る」研究を狙う。自動制御や品質推定へ展開しやすい。

**日本語キーワード**  
`赤外線 調理 状態推定` / `画像 調理 進行 推定` / `デジタルツイン 熱機器 最適化`

**英語キーワード**  
`infrared/vision + cooking + state estimation` / `sensor fusion + food process + monitoring` / `digital twin + thermal appliance + optimization`

**Web of Science向け**

```text
TS=((infrared OR "computer vision" OR "sensor fusion" OR impedance OR "digital twin" OR "surrogate model") AND (cooking OR "food process" OR "thermal appliance" OR "temperature control"))
```

**Scopus向け**

```text
TITLE-ABS-KEY((infrared OR "computer vision" OR "sensor fusion" OR impedance OR "digital twin" OR "surrogate model") AND (cooking OR "food process" OR "thermal appliance" OR "temperature control"))
```

## 一般独創

### 1. 音・振動 × 見えない状態推定

**なぜ面白い研究につながりやすいか**  
人や機器が出す音・振動を「見えない状態の代理センサ」にできるかを見る。追加センサを増やさず、状態・劣化・動作を推定する問いにつながりやすい。

**日本語キーワード**  
`生活音 状態推定 非接触` / `音響 センシング 状態認識` / `振動 信号 異常検知 低コスト`

**英語キーワード**  
`acoustic sensing + hidden state + non-contact monitoring` / `everyday sound + state recognition + sensing` / `vibroacoustic signal + condition monitoring + low-cost sensor`

**Web of Science向け**

```text
TS=((acoustic OR sound OR audio OR vibration) AND ("state estimation" OR "condition monitoring" OR "state recognition" OR "anomaly detection") AND (sensing OR monitoring OR non-contact))
```

**Scopus向け**

```text
TITLE-ABS-KEY((acoustic OR sound OR audio OR vibration) AND ("state estimation" OR "condition monitoring" OR "state recognition" OR "anomaly detection") AND (sensing OR monitoring OR non-contact))
```

### 2. 摩擦・接触力学 × 触覚／持ちやすさ

**なぜ面白い研究につながりやすいか**  
「なぜ同じ形でも滑る・持ちやすい・触り心地が違うのか」を摩擦と人間の感覚の両側から解く。材料・表面・操作性を結ぶ再利用性の高い研究を拾いやすい。

**日本語キーワード**  
`摩擦 触覚 把持 感覚` / `接触力学 指先 滑り` / `表面粗さ 触感 摩擦`

**英語キーワード**  
`tribology + haptics + grip perception` / `contact mechanics + fingertip + slip detection` / `surface roughness + tactile perception + friction`

**Web of Science向け**

```text
TS=((tribology OR friction OR "contact mechanics" OR "surface roughness") AND (haptic OR "tactile perception" OR grip OR fingertip OR slip))
```

**Scopus向け**

```text
TITLE-ABS-KEY((tribology OR friction OR "contact mechanics" OR "surface roughness") AND (haptic OR "tactile perception" OR grip OR fingertip OR slip))
```

### 3. 知覚心理 × 物理特性／錯覚

**なぜ面白い研究につながりやすいか**  
「実際の値」と「人が感じる値」がなぜズレるかを調べる。重さ、温度、質感、音、見た目の組み合わせから、設計や表示だけでは説明できない判断メカニズムを見つけやすい。

**日本語キーワード**  
`知覚 物理特性 錯覚 実験` / `重さ錯覚 材料 見た目` / `クロスモーダル 知覚 触覚 音`

**英語キーワード**  
`perception + physical properties + illusion + experiment` / `material perception + weight illusion + multisensory` / `crossmodal perception + touch + sound + material`

**Web of Science向け**

```text
TS=((perception OR psychophysics OR illusion OR crossmodal OR multisensory) AND (material OR weight OR temperature OR roughness OR sound OR appearance) AND (experiment OR measurement))
```

**Scopus向け**

```text
TITLE-ABS-KEY((perception OR psychophysics OR illusion OR crossmodal OR multisensory) AND (material OR weight OR temperature OR roughness OR sound OR appearance) AND (experiment OR measurement))
```

### 4. 幾何学・折り紙構造 × メタマテリアル／機能

**なぜ面白い研究につながりやすいか**  
素材そのものではなく「形・折り・配置」で剛性、吸音、変形、熱特性などを作る研究。材料置換とは違う設計自由度が得られ、他分野へ原理転用しやすい。

**日本語キーワード**  
`折り紙 構造 メタマテリアル 機械特性` / `切り紙 構造 可変 剛性` / `幾何学 構造 音響 熱 機能`

**英語キーワード**  
`origami kirigami + mechanical metamaterial + tunable property` / `geometry + metamaterial + programmable mechanics` / `architected material + acoustic thermal mechanical response`

**Web of Science向け**

```text
TS=((origami OR kirigami OR geometry OR "architected material") AND (metamaterial OR "programmable mechanics" OR "tunable stiffness" OR acoustic OR thermal))
```

**Scopus向け**

```text
TITLE-ABS-KEY((origami OR kirigami OR geometry OR "architected material") AND (metamaterial OR "programmable mechanics" OR "tunable stiffness" OR acoustic OR thermal))
```

### 5. 統計物理 × 群集／交通／列

**なぜ面白い研究につながりやすいか**  
渋滞、行列、出口の詰まりなど日常の集団現象を粒子・流れ・相互作用として扱う。個人の心理だけでは見えない「全体として突然起きる現象」を解明しやすい。

**日本語キーワード**  
`統計物理 群集 行動 実験` / `歩行者 流れ 混雑 モデル` / `待ち行列 人間行動 実測`

**英語キーワード**  
`statistical physics + collective behavior + pedestrian` / `crowd dynamics + experiment + bottleneck` / `queueing behavior + human movement + model`

**Web of Science向け**

```text
TS=(("statistical physics" OR "collective behavior" OR "crowd dynamics" OR queueing) AND (pedestrian OR traffic OR bottleneck OR congestion OR "human movement") AND (experiment OR model OR measurement))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("statistical physics" OR "collective behavior" OR "crowd dynamics" OR queueing) AND (pedestrian OR traffic OR bottleneck OR congestion OR "human movement") AND (experiment OR model OR measurement))
```

### 6. ネットワーク科学 × 情報／行動の拡散

**なぜ面白い研究につながりやすいか**  
「何が広がるか」だけでなく、誰と誰がつながる構造が拡散速度や偏りをどう変えるかを見る。口コミ、技術普及、行動変容などへ横展開しやすい。

**日本語キーワード**  
`ネットワーク科学 情報拡散 実証` / `社会ネットワーク 行動伝播 因果` / `イノベーション 拡散 ネットワーク 構造`

**英語キーワード**  
`network science + information diffusion + empirical` / `social network + behavioral contagion + causal` / `innovation diffusion + network topology + adoption`

**Web of Science向け**

```text
TS=(("network science" OR "social network" OR "network topology") AND ("information diffusion" OR contagion OR "innovation diffusion" OR adoption OR cascade) AND (empirical OR experiment OR causal OR model))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("network science" OR "social network" OR "network topology") AND ("information diffusion" OR contagion OR "innovation diffusion" OR adoption OR cascade) AND (empirical OR experiment OR causal OR model))
```

### 7. 因果推論 × 日常行動／小さな介入

**なぜ面白い研究につながりやすいか**  
単なる相関ではなく「これを変えたから本当に行動が変わったのか」を切り分ける研究。表示、通知、価格、配置、習慣など身近な介入の本当の効果を見つけやすい。

**日本語キーワード**  
`因果推論 日常行動 自然実験` / `ランダム化 介入 行動変容 実証` / `差の差 行動 デジタル環境`

**英語キーワード**  
`causal inference + everyday behavior + natural experiment` / `randomized intervention + behavior change + field experiment` / `difference-in-differences + digital behavior + intervention`

**Web of Science向け**

```text
TS=(("causal inference" OR "natural experiment" OR randomized OR "difference-in-differences") AND (behavior OR intervention OR habit OR choice) AND (field OR digital OR everyday))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("causal inference" OR "natural experiment" OR randomized OR "difference-in-differences") AND (behavior OR intervention OR habit OR choice) AND (field OR digital OR everyday))
```

### 8. 光・音・温熱環境 × 集中／睡眠／判断

**なぜ面白い研究につながりやすいか**  
日常環境の小さな差が集中、眠気、判断、睡眠へどの程度効くかを定量化する。快適性の主観評価だけでなく、認知・生理・環境工学を結ぶ研究を拾いやすい。

**日本語キーワード**  
`照明 温度 騒音 集中 認知 実験` / `室内環境 睡眠 光 温熱` / `環境条件 判断能力 生産性 測定`

**英語キーワード**  
`light temperature noise + cognitive performance + experiment` / `indoor environment + sleep + thermal light exposure` / `environmental conditions + decision performance + controlled study`

**Web of Science向け**

```text
TS=((light OR temperature OR noise OR "indoor environment" OR "thermal environment") AND ("cognitive performance" OR attention OR sleep OR decision OR productivity) AND (experiment OR measurement OR controlled))
```

**Scopus向け**

```text
TITLE-ABS-KEY((light OR temperature OR noise OR "indoor environment" OR "thermal environment") AND ("cognitive performance" OR attention OR sleep OR decision OR productivity) AND (experiment OR measurement OR controlled))
```

### 9. 計算処理 × 安価なセンサ／スマートフォン

**なぜ面白い研究につながりやすいか**  
高価な専用ハードを増やす代わりに、計算・補正・推定で安価なセンサの限界を超える研究。身近な端末を計測器へ変える発想につながりやすい。

**日本語キーワード**  
`スマートフォン センサ 計測 推定 検証` / `低コスト センサ 補正 機械学習` / `計算イメージング 安価 センサ 再構成`

**英語キーワード**  
`smartphone sensor + measurement + validation` / `low-cost sensor + calibration + machine learning` / `computational imaging + inexpensive sensor + reconstruction`

**Web of Science向け**

```text
TS=((smartphone OR "low-cost sensor" OR "inexpensive sensor" OR "computational imaging") AND (calibration OR reconstruction OR estimation OR measurement OR "machine learning") AND (validation OR experiment))
```

**Scopus向け**

```text
TITLE-ABS-KEY((smartphone OR "low-cost sensor" OR "inexpensive sensor" OR "computational imaging") AND (calibration OR reconstruction OR estimation OR measurement OR "machine learning") AND (validation OR experiment))
```

### 10. 生物構造 × 自己洗浄／集水／摩擦制御

**なぜ面白い研究につながりやすいか**  
蓮の葉、昆虫、皮膚などの構造を「見た目」ではなく機能原理として転用する。自己洗浄、集水、摩擦、付着など複数課題を一つの表面で解く研究につながる。

**日本語キーワード**  
`生物模倣 表面 自己洗浄 撥水` / `生物構造 集水 表面設計` / `バイオミメティクス 摩擦 制御 表面`

**英語キーワード**  
`bio-inspired surface + self-cleaning + wettability` / `biomimetic surface + water harvesting + structure` / `biological surface + friction control + multifunctional`

**Web of Science向け**

```text
TS=(("bio-inspired" OR biomimetic OR "biological surface" OR "hierarchical surface") AND ("self-cleaning" OR "water harvesting" OR wettability OR friction OR adhesion) AND (experiment OR characterization))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("bio-inspired" OR biomimetic OR "biological surface" OR "hierarchical surface") AND ("self-cleaning" OR "water harvesting" OR wettability OR friction OR adhesion) AND (experiment OR characterization))
```

### 11. 液滴蒸発 × 乾燥模様／粒子輸送

**なぜ面白い研究につながりやすいか**  
コーヒーの輪染みのような身近な現象を、蒸発・毛細管流・粒子移動で解く。塗布、印刷、検査、汚れ、診断など幅広い応用へつながる基礎現象を拾いやすい。

**日本語キーワード**  
`液滴 蒸発 コーヒーリング 粒子輸送` / `乾燥模様 表面張力 流れ 実験` / `蒸発 液滴 堆積 パターン 制御`

**英語キーワード**  
`droplet evaporation + coffee-ring effect + particle transport` / `drying pattern + capillary flow + surface tension` / `evaporating droplet + deposition pattern + control`

**Web of Science向け**

```text
TS=(("droplet evaporation" OR "evaporating droplet" OR "coffee-ring effect" OR "drying pattern") AND ("particle transport" OR deposition OR "capillary flow" OR Marangoni OR "surface tension"))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("droplet evaporation" OR "evaporating droplet" OR "coffee-ring effect" OR "drying pattern") AND ("particle transport" OR deposition OR "capillary flow" OR Marangoni OR "surface tension"))
```

### 12. Human-AI × 信頼／認知負荷／判断品質

**なぜ面白い研究につながりやすいか**  
AIが当たるかだけでなく、人間がAIをどう信じ、いつ過信し、判断が本当に良くなるかを測る。UIや業務支援へ直接転用できる実験研究を拾いやすい。

**日本語キーワード**  
`人間 AI 協働 判断品質 実験` / `AI 助言 信頼 自動化バイアス` / `生成AI 認知負荷 意思決定 実証`

**英語キーワード**  
`human AI collaboration + decision quality + experiment` / `AI advice + trust + automation bias` / `generative AI + cognitive load + decision making + controlled study`

**Web of Science向け**

```text
TS=(("human AI" OR "human-AI" OR "AI advice" OR "generative AI") AND ("decision quality" OR trust OR "automation bias" OR "cognitive load" OR "decision making") AND (experiment OR controlled OR empirical))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("human AI" OR "human-AI" OR "AI advice" OR "generative AI") AND ("decision quality" OR trust OR "automation bias" OR "cognitive load" OR "decision making") AND (experiment OR controlled OR empirical))
```

### 13. 複雑系 × 連鎖故障／レジリエンス

**なぜ面白い研究につながりやすいか**  
一つの小さな故障がなぜ全体障害へ広がるのか、どこを守れば回復力が上がるのかを見る。インフラ、供給網、組織など異なる対象に共通する構造原理を探せる。

**日本語キーワード**  
`複雑ネットワーク 連鎖故障 レジリエンス` / `相互依存 システム 故障 伝播 モデル` / `サプライチェーン ネットワーク 回復力 シミュレーション`

**英語キーワード**  
`complex network + cascading failure + resilience` / `interdependent systems + failure propagation + model` / `supply network + disruption propagation + resilience simulation`

**Web of Science向け**

```text
TS=(("complex network" OR "interdependent system" OR "supply network") AND ("cascading failure" OR "failure propagation" OR disruption OR resilience OR recovery) AND (model OR simulation OR empirical))
```

**Scopus向け**

```text
TITLE-ABS-KEY(("complex network" OR "interdependent system" OR "supply network") AND ("cascading failure" OR "failure propagation" OR disruption OR resilience OR recovery) AND (model OR simulation OR empirical))
```

---

## 採用ロジック

- タイトル・抄録・説明から、各研究軸を構成する**2つの概念群が同時に確認できること**
- 実験、測定、モデル、シミュレーション、自然実験、因果推論、心理物理、検証、最適化など**結論を確かめる方法**が確認できること
- **一般独創は応用発想より厳しく**、概念接続が濃いか、方法論が複数確認できない候補を落とすこと
- Semantic Scholarでは公開PDFを優先し、被引用数・影響度付き引用は補助点として扱うこと
- 新しい論文が被引用数で不利になりすぎないよう、引用は年数補正した補助評価に留めること
- 「珍しい」「意外」という表現そのものには加点しないこと
- 独創研究の「すべて」ピックアップでは、候補がある限り**応用発想と一般独創を最低1件ずつ**混ぜること
