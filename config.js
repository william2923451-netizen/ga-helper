// GA 比賽助手 設定檔
// 朋友打開 APP 時會直接使用這裡的轉接網址，只要輸入自己的 GA 編號。
window.GA_CONFIG = {
  api: 'https://ga-helper.william2923451.workers.dev',
  season: '2026-08-28',   // 本季開始日
  hiElo: 1384,            // 高手門檻
};

// 附加功能：主程式跑完後載入（不用改 index.html）
// deck.js：對手英雄、屬性、開賽 ELO（2026-10-30）
// ascent.js：晉級計算器的 Ascent Day 1 晉級線（2026-10-30）
// display.js：設定裡的英雄背景亮度（2026-10-30）
// 版本號：每次改版都要推進（日期＋英文字母），手機才不會卡在快取的舊版。
// 後面再加「每 10 分鐘換一次」的數字當保險：忘了推進時，最多 10 分鐘也會抓到新版。
const GA_VERSION = '20261031b';
document.addEventListener('DOMContentLoaded', () => {
  const v = GA_VERSION + '.' + Math.floor(Date.now() / 600000);
  for (const f of ['deck.js', 'ascent.js', 'display.js']) {
    const s = document.createElement('script');
    s.src = f + '?v=' + v;
    document.body.appendChild(s);
  }
});
