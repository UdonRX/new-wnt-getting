const JMA_CODES = {
  '青森県':'020000','岩手県':'030000','宮城県':'040000','秋田県':'050000','山形県':'060000','福島県':'070000',
  '茨城県':'080000','栃木県':'090000','群馬県':'100000','埼玉県':'110000','千葉県':'120000','東京都':'130000','神奈川県':'140000',
  '新潟県':'150000','富山県':'160000','石川県':'170000','福井県':'180000','山梨県':'190000','長野県':'200000',
  '岐阜県':'210000','静岡県':'220000','愛知県':'230000','三重県':'240000','滋賀県':'250000','京都府':'260000','大阪府':'270000',
  '兵庫県':'280000','奈良県':'290000','和歌山県':'300000','鳥取県':'310000','島根県':'320000','岡山県':'330000','広島県':'340000','山口県':'350000',
  '徳島県':'360000','香川県':'370000','愛媛県':'380000','高知県':'390000','福岡県':'400000','佐賀県':'410000','長崎県':'420000',
  '熊本県':'430000','大分県':'440000','宮崎県':'450000','鹿児島県':'460100'
};

const PREFECTURE_CAPITALS = {
  '北海道':'札幌市','青森県':'青森市','岩手県':'盛岡市','宮城県':'仙台市','秋田県':'秋田市','山形県':'山形市','福島県':'福島市',
  '茨城県':'水戸市','栃木県':'宇都宮市','群馬県':'前橋市','埼玉県':'さいたま市','千葉県':'千葉市','東京都':'新宿区','神奈川県':'横浜市',
  '新潟県':'新潟市','富山県':'富山市','石川県':'金沢市','福井県':'福井市','山梨県':'甲府市','長野県':'長野市',
  '岐阜県':'岐阜市','静岡県':'静岡市','愛知県':'名古屋市','三重県':'津市','滋賀県':'大津市','京都府':'京都市','大阪府':'大阪市',
  '兵庫県':'神戸市','奈良県':'奈良市','和歌山県':'和歌山市','鳥取県':'鳥取市','島根県':'松江市','岡山県':'岡山市','広島県':'広島市','山口県':'山口市',
  '徳島県':'徳島市','香川県':'高松市','愛媛県':'松山市','高知県':'高知市','福岡県':'福岡市','佐賀県':'佐賀市','長崎県':'長崎市',
  '熊本県':'熊本市','大分県':'大分市','宮崎県':'宮崎市','鹿児島県':'鹿児島市','沖縄県':'那覇市'
};

const PREFECTURES = Object.keys(PREFECTURE_CAPITALS);
const MUNICIPALITY_CATALOG_URL = 'https://geolonia.github.io/japanese-addresses/api/ja.json';
let municipalityCatalogPromise = null;

const HOKKAIDO_SUB = [
  [/稚内|宗谷/, '011000'], [/旭川|留萌|上川/, '012000'], [/札幌|石狩|空知|後志|小樽/, '016000'],
  [/網走|北見|紋別/, '013000'], [/釧路|根室/, '014100'], [/帯広|十勝/, '014030'],
  [/室蘭|苫小牧|胆振|日高/, '015000'], [/函館|渡島|檜山/, '017000']
];

const OKINAWA_SUB = [[/宮古/, '473000'], [/石垣|八重山/, '474000'], [/久米島/, '472000']];

function normalize(value = '') {
  return String(value).normalize('NFKC').replace(/[\s　]+/g, '').trim();
}

function stripPrefSuffix(value = '') {
  return normalize(value).replace(/(?:都|道|府|県)$/u, '');
}

function stripMunicipalitySuffix(value = '') {
  return normalize(value).replace(/(?:市|区|町|村)$/u, '');
}

function canonicalPrefecture(input) {
  const q = normalize(input);
  if (!q) return '';
  return PREFECTURES.find(pref => q === pref || stripPrefSuffix(q) === stripPrefSuffix(pref)) || '';
}

export function jmaCodeForAdmin(admin1 = '', placeText = '') {
  if (/北海道/.test(admin1)) {
    const hit = HOKKAIDO_SUB.find(([re]) => re.test(placeText));
    return hit?.[1] || '016000';
  }
  if (/沖縄/.test(admin1)) {
    const hit = OKINAWA_SUB.find(([re]) => re.test(placeText));
    return hit?.[1] || '471000';
  }
  return JMA_CODES[admin1] || '';
}

async function openMeteoSearch(name, count = 20) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', name);
  url.searchParams.set('count', String(count));
  url.searchParams.set('language', 'ja');
  url.searchParams.set('format', 'json');
  url.searchParams.set('countryCode', 'JP');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('地域検索に失敗しました');
  return (await res.json()).results || [];
}

async function loadMunicipalityCatalog() {
  if (!municipalityCatalogPromise) {
    municipalityCatalogPromise = fetch(MUNICIPALITY_CATALOG_URL, { cache: 'force-cache' })
      .then(res => {
        if (!res.ok) throw new Error('市区町村データを取得できませんでした');
        return res.json();
      })
      .catch(err => {
        municipalityCatalogPromise = null;
        throw err;
      });
  }
  return municipalityCatalogPromise;
}

function municipalityMatches(catalog, input) {
  const q = normalize(input);
  const bare = stripMunicipalitySuffix(q);
  if (!q || !bare) return [];
  const out = [];
  const seen = new Set();

  const add = (prefecture, municipality) => {
    const key = `${prefecture}|${municipality}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ prefecture, municipality });
  };

  for (const [prefecture, municipalities] of Object.entries(catalog || {})) {
    for (const municipality of Array.isArray(municipalities) ? municipalities : []) {
      const name = normalize(municipality);
      if (name === q || stripMunicipalitySuffix(name) === bare) add(prefecture, name);

      // Geoloniaの一覧は政令指定都市を「京都市北区」のように区単位で持つため、
      // 「京都」「京都市」の検索でも親市を実在自治体として候補にする。
      const designated = name.match(/^(.+市).+区$/u)?.[1] || '';
      if (designated && (designated === q || stripMunicipalitySuffix(designated) === bare)) {
        add(prefecture, designated);
      }
    }
  }
  return out.slice(0, 20);
}

function resultScore(result, municipality, prefecture) {
  const resultName = normalize(result?.name || '');
  const admin1 = normalize(result?.admin1 || '');
  const admin2 = normalize(result?.admin2 || '');
  let score = 0;
  if (admin1 === normalize(prefecture)) score += 100;
  if (resultName === municipality) score += 80;
  if (stripMunicipalitySuffix(resultName) === stripMunicipalitySuffix(municipality)) score += 50;
  if (admin2 === municipality || stripMunicipalitySuffix(admin2) === stripMunicipalitySuffix(municipality)) score += 35;
  return score;
}

async function geocodeMunicipality(match) {
  const query = `${match.municipality}, ${match.prefecture}`;
  const results = await openMeteoSearch(query, 40);
  const ranked = results
    .filter(result => normalize(result.admin1 || '') === normalize(match.prefecture))
    .map(result => ({ result, score: resultScore(result, match.municipality, match.prefecture) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.result;
  if (!best) return null;
  return {
    name: match.municipality,
    displayName: `${match.municipality} / ${match.prefecture}`,
    lat: Number(best.latitude),
    lon: Number(best.longitude),
    admin1: match.prefecture,
    jmaCode: jmaCodeForAdmin(match.prefecture, `${match.municipality} ${best.admin2 || ''}`)
  };
}

async function geocodePrefecture(prefecture) {
  const capital = PREFECTURE_CAPITALS[prefecture];
  const results = await openMeteoSearch(`${capital}, ${prefecture}`, 30);
  const best = results.find(result => normalize(result.admin1 || '') === normalize(prefecture)) || results[0];
  if (!best) return [];
  return [{
    name: prefecture,
    displayName: prefecture,
    lat: Number(best.latitude),
    lon: Number(best.longitude),
    admin1: prefecture,
    jmaCode: jmaCodeForAdmin(prefecture, capital)
  }];
}

export async function geocodeJapan(name) {
  const q = normalize(name);
  if (!q) return [];

  // 1) 都道府県を先に完全判定。「香川」は必ず「香川県」になる。
  const prefecture = canonicalPrefecture(q);
  if (prefecture) return geocodePrefecture(prefecture);

  // 2) 都道府県以外は、日本に実在する市区町村だけを候補にする。
  const catalog = await loadMunicipalityCatalog();
  const matches = municipalityMatches(catalog, q);
  if (!matches.length) return [];

  const settled = await Promise.allSettled(matches.slice(0, 8).map(geocodeMunicipality));
  const found = settled
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);

  const seen = new Set();
  return found.filter(place => {
    const key = `${place.name}|${place.admin1}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function fetchHourlyJmaModel(location) {
  const url = new URL('https://api.open-meteo.com/v1/jma');
  url.searchParams.set('latitude', String(location.lat));
  url.searchParams.set('longitude', String(location.lon));
  url.searchParams.set('timezone', 'Asia/Tokyo');
  url.searchParams.set('forecast_hours', '96');
  url.searchParams.set('forecast_days', '7');
  url.searchParams.set('hourly', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,cloud_cover');
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`1時間予報の取得に失敗しました (${res.status})`);
  return res.json();
}

export async function fetchOfficialJma(code) {
  if (!code) return null;
  const res = await fetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(code)}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`気象庁予報の取得に失敗しました (${res.status})`);
  return res.json();
}

export function parseOfficialForecast(data) {
  if (!Array.isArray(data) || !data[0]) return [];
  const out = [];
  const shortSeries = data[0].timeSeries?.[0];
  if (shortSeries?.areas?.[0]) {
    const area = shortSeries.areas[0];
    (shortSeries.timeDefines || []).forEach((time, index) => out.push({
      date: time.slice(0, 10), weather: area.weathers?.[index] || '', code: area.weatherCodes?.[index] || '', official: true
    }));
  }
  const weeklySeries = data[1]?.timeSeries?.[0];
  if (weeklySeries?.areas?.[0]) {
    const area = weeklySeries.areas[0];
    (weeklySeries.timeDefines || []).forEach((time, index) => {
      const date = time.slice(0, 10);
      if (out.some(row => row.date === date)) return;
      out.push({ date, weather: '', code: area.weatherCodes?.[index] || '', pop: area.pops?.[index] || '', reliability: area.reliabilities?.[index] || '', official: true });
    });
  }
  return out.slice(0, 8);
}
