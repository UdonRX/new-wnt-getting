const JMA_CODES = {
  '青森県':'020000','岩手県':'030000','宮城県':'040000','秋田県':'050000','山形県':'060000','福島県':'070000',
  '茨城県':'080000','栃木県':'090000','群馬県':'100000','埼玉県':'110000','千葉県':'120000','東京都':'130000','神奈川県':'140000',
  '新潟県':'150000','富山県':'160000','石川県':'170000','福井県':'180000','山梨県':'190000','長野県':'200000',
  '岐阜県':'210000','静岡県':'220000','愛知県':'230000','三重県':'240000','滋賀県':'250000','京都府':'260000','大阪府':'270000',
  '兵庫県':'280000','奈良県':'290000','和歌山県':'300000','鳥取県':'310000','島根県':'320000','岡山県':'330000','広島県':'340000','山口県':'350000',
  '徳島県':'360000','香川県':'370000','愛媛県':'380000','高知県':'390000','福岡県':'400000','佐賀県':'410000','長崎県':'420000',
  '熊本県':'430000','大分県':'440000','宮崎県':'450000','鹿児島県':'460100'
};

const HOKKAIDO_SUB = [
  [/稚内|宗谷/, '011000'],
  [/旭川|留萌|上川/, '012000'],
  [/札幌|石狩|空知|後志|小樽/, '016000'],
  [/網走|北見|紋別/, '013000'],
  [/釧路|根室/, '014100'],
  [/帯広|十勝/, '014030'],
  [/室蘭|苫小牧|胆振|日高/, '015000'],
  [/函館|渡島|檜山/, '017000']
];

const OKINAWA_SUB = [
  [/宮古/, '473000'],
  [/石垣|八重山/, '474000'],
  [/久米島/, '472000']
];

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

export async function geocodeJapan(name) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', name);
  url.searchParams.set('count', '8');
  url.searchParams.set('language', 'ja');
  url.searchParams.set('format', 'json');
  url.searchParams.set('countryCode', 'JP');

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('地域検索に失敗しました');

  const data = await res.json();
  return (data.results || []).map(result => ({
    name: result.name,
    displayName: [result.name, result.admin2, result.admin1].filter(Boolean).join(' / '),
    lat: Number(result.latitude),
    lon: Number(result.longitude),
    admin1: result.admin1 || '',
    jmaCode: jmaCodeForAdmin(result.admin1 || '', `${result.name || ''} ${result.admin2 || ''}`)
  }));
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
  const res = await fetch(
    `https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(code)}.json`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`気象庁予報の取得に失敗しました (${res.status})`);
  return res.json();
}

export function parseOfficialForecast(data) {
  if (!Array.isArray(data) || !data[0]) return [];

  const out = [];
  const short = data[0];
  const shortSeries = short.timeSeries?.[0];

  if (shortSeries?.areas?.[0]) {
    const area = shortSeries.areas[0];
    (shortSeries.timeDefines || []).forEach((time, index) => {
      out.push({
        date: time.slice(0, 10),
        weather: area.weathers?.[index] || '',
        code: area.weatherCodes?.[index] || '',
        official: true
      });
    });
  }

  const weeklySeries = data[1]?.timeSeries?.[0];
  if (weeklySeries?.areas?.[0]) {
    const area = weeklySeries.areas[0];
    (weeklySeries.timeDefines || []).forEach((time, index) => {
      const date = time.slice(0, 10);
      if (out.some(row => row.date === date)) return;

      // 週間側には「週間予報」という固定文言を入れない。
      // weather は空にして、表示側で日別 weather_code の短い表現へフォールバックさせる。
      out.push({
        date,
        weather: '',
        code: area.weatherCodes?.[index] || '',
        pop: area.pops?.[index] || '',
        reliability: area.reliabilities?.[index] || '',
        official: true
      });
    });
  }

  return out.slice(0, 8);
}
