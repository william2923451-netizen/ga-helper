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
document.addEventListener('DOMContentLoaded', () => {
  for (const f of ['deck.js?v=20261030d', 'ascent.js?v=20261030a', 'display.js?v=20261030a']) {
    const s = document.createElement('script');
    s.src = f;
    document.body.appendChild(s);
  }
});
