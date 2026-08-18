# V2.2.1 Vercel install warning fix

V2.2 の `jsdom: 26.1.0` は `whatwg-encoding ^3.1.1` に依存するため、npm install 時に deprecated warning が表示されます。

V2.2.1 では `jsdom: 27.4.0` へ更新しました。27.4.0 は `@exodus/bytes` を使用し、Node.js `^20.19.0 || ^22.12.0 || >=24.0.0` をサポートします。V2 は Node 22.x を指定しているため対象範囲です。

注意: `npm warn deprecated` は通常は Warning であり、それ単独で Vercel deployment を失敗させません。V2.2.1 でもデプロイが失敗する場合は、Vercel Build Logs の warning より後にある最初の `Error` / `npm error` / `ELIFECYCLE` 行を確認してください。
