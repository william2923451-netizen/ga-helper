// GA 比賽助手：計血背景亮度（2026-10-30 新增）
// 由 config.js 在主程式之後載入，不需要改 index.html。
// 「設定」分頁的「計血」卡片多一條滑桿，調整英雄卡圖背景的亮度。
// 亮度同時控制卡圖本身的透明度和上面那層暗色漸層，越亮卡圖越清楚、數字對比越低。
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const read = (k, d) => { try { const v = localStorage.getItem('ga.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem('ga.' + k, JSON.stringify(v)); } catch (e) {} };
  const DEFAULT = 25; // 和原本的樣子相同（卡圖 26%、暗色漸層全開）

  const css = document.createElement('style');
  css.textContent = `
    .side .bg::after{opacity:var(--bg-dim,1)}
    .bgl{display:flex;flex-direction:column;gap:8px}
    .bgl .bgl-h{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;color:var(--muted)}
    .bgl .bgl-h b{font-family:var(--num);font-size:18px;color:var(--fg);font-weight:600}
    .bgl input[type=range]{width:100%;padding:0;border:0;background:none;accent-color:var(--accent);height:28px}
    .bgl .bgl-row{display:flex;gap:8px;align-items:center}
    .bgl .bgl-prev{position:relative;height:84px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:var(--bg);isolation:isolate;display:grid;place-items:center}
    .bgl .bgl-prev .pb{position:absolute;inset:0;z-index:-1;background-size:cover;background-position:center 22%;filter:saturate(.85)}
    .bgl .bgl-prev .pb::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(15,18,22,.35),rgba(15,18,22,.85) 75%);opacity:var(--bg-dim,1)}
    .bgl .bgl-prev b{font-family:var(--num);font-size:56px;font-weight:700;line-height:1;text-shadow:0 2px 18px rgba(0,0,0,.6)}
  `;
  document.head.appendChild(css);

  // 亮度 0–100 → 卡圖透明度 0.08–0.80；暗色漸層 1.00–0.40
  function apply(b) {
    const r = Math.max(0, Math.min(100, b)) / 100;
    const op = (0.08 + 0.72 * r).toFixed(3), dim = (1 - 0.6 * r).toFixed(3);
    document.documentElement.style.setProperty('--bg-op', op);
    document.documentElement.style.setProperty('--bg-dim', dim);
  }
  let level = +read('bgLevel', DEFAULT);
  if (!(level >= 0 && level <= 100)) level = DEFAULT;
  apply(level);

  function champImage() {
    const s = read('settings', {}) || {};
    const c = (s.champ || []).find(x => x && x.image);
    return c ? c.image : '';
  }

  function inject() {
    const body = $('#setBody'); if (!body || body.querySelector('.bgl')) return;
    // 放在「計血」卡片最後
    const cardEl = [...body.querySelectorAll('.card')].find(c => (c.querySelector('h2') || {}).textContent === '計血');
    if (!cardEl) return;
    const img = champImage();
    const wrap = document.createElement('div');
    wrap.className = 'bgl';
    wrap.innerHTML = `
      <div class="bgl-h"><span>英雄背景亮度</span><span><b id="bglVal">${level}</b>%</span></div>
      <div class="bgl-row"><input type="range" id="bglRange" min="0" max="100" step="5" value="${level}" aria-label="英雄背景亮度"><button class="btn sm" id="bglReset">預設</button></div>
      <div class="bgl-prev"><div class="pb" id="bglPb" style="${img ? `background-image:url('${img.replace(/'/g, '%27')}')` : ''};opacity:var(--bg-op,.26)"></div><b>20</b></div>
      <div class="muted small">${img ? '預覽用目前計血頁選的英雄卡圖。' : '計血頁還沒選英雄背景，選了之後這裡會出現預覽。'}越亮卡圖越清楚，但血量數字對比會變低。</div>`;
    cardEl.appendChild(wrap);
    const range = wrap.querySelector('#bglRange'), val = wrap.querySelector('#bglVal');
    const set = v => { level = v; val.textContent = v; range.value = v; apply(v); save('bgLevel', v); };
    range.addEventListener('input', () => set(+range.value));
    wrap.querySelector('#bglReset').addEventListener('click', () => set(DEFAULT));
  }

  // 設定分頁每次打開都會重畫，重畫後再補上滑桿
  const body = $('#setBody');
  if (body) new MutationObserver(inject).observe(body, { childList: true });
  inject();
})();
