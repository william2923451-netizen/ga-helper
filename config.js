// GA 比賽助手 設定檔
// 把下面的網址換成你自己的 Cloudflare Worker 網址（安裝說明第 1 步），
// 朋友打開 APP 時就不用自己設定，只要輸入自己的 GA 編號。
window.GA_CONFIG = {
  api: 'https://ga-helper.你的名稱.workers.dev',
  season: '2026-08-28',   // 本季開始日
  hiElo: 1384,            // 高手門檻
};
