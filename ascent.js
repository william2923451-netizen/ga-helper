// GA 比賽助手：Ascent Day 1 晉級線（2026-10-30 新增、10-31 簡化）
// 由 config.js 在主程式之後載入，不需要改 index.html。
// Ascent 通常是 Day 1 打 9 輪，18 分以上進 Day 2。這是分數線，不是前 K 名，
// 所以只告訴使用者：Day 1 剩下的輪次還要拿幾分、有哪些勝／和組合可以達到。
// 戰績從晉級計算器的「我已贏（含輪空）／我已和／我已輸」讀取。
// 放在晉級計算器「計算」按鈕下方。
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const card = $('#calcCard'); if (!card) return;
  const read = (k, d) => { try { const v = localStorage.getItem('ga.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem('ga.' + k, JSON.stringify(v)); } catch (e) {} };
  const A = Object.assign({ rounds: 9, line: 18 }, read('ascent', {}));

  const css = document.createElement('style');
  css.textContent = `
    .asc{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;border:1px dashed var(--line)}
    .asc .asc-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .asc .asc-h b{font-size:15px}
    .asc .cgrid{grid-template-columns:repeat(2,1fr)}
    .asc .ok{color:var(--good)}.asc .no{color:var(--bad)}
    .asc .combo{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
    .asc .combo li{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:10px;background:var(--bg);font-size:14px}
    .asc .combo li span:last-child{color:var(--muted);font-size:12.5px;text-align:right}
  `;
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.className = 'asc';
  box.innerHTML = `
    <div class="asc-h"><b>Ascent Day 1 晉級線</b><button class="btn sm" id="aGo">計算 Day 1</button></div>
    <div class="cgrid">
      <label>Day 1 輪數<input id="aR" type="number" inputmode="numeric" min="1" value="${A.rounds}"></label>
      <label>晉級分數（以上進 Day 2）<input id="aT" type="number" inputmode="numeric" min="1" value="${A.line}"></label>
    </div>
    <div id="aOut" class="muted small">用上面的「我已贏／和／輸」計算 Day 1 還需要幾分。</div>`;
  // 放在「計算」按鈕正下方
  const go = $('#cGo');
  if (go) go.after(box); else card.appendChild(box);

  const g = id => Math.max(0, parseInt(($(id) || {}).value, 10) || 0);
  const desc = (w, d, l) => [w ? `贏 ${w}` : '', d ? `和 ${d}` : '', l ? `輸 ${l}` : ''].filter(Boolean).join('、') || '不用再打';

  function run() {
    const R1 = Math.max(1, g('#aR')), T = Math.max(1, g('#aT'));
    A.rounds = R1; A.line = T; save('ascent', A);
    const W = g('#cW'), D = g('#cD'), Lo = g('#cL');
    const out = $('#aOut'); out.className = '';
    const played = W + D + Lo, pts = W * 3 + D;
    if (played > R1) { out.innerHTML = `<div class="msg">已經打了 ${played} 輪，超過 Day 1 的 ${R1} 輪。</div>`; return; }
    const left = R1 - played, need = Math.max(0, T - pts);
    const head = `<div>Day 1 目前 <b>${W}-${Lo}-${D}</b>（勝-敗-和）＝ <b>${pts}</b> 分，還剩 <b>${left}</b> 輪。</div>`;
    if (need === 0) { out.innerHTML = `<div class="verdict">${head}<div class="ok">已經達到 ${T} 分，確定進 Day 2。</div></div>`; return; }
    if (pts + 3 * left < T) { out.innerHTML = `<div class="verdict">${head}<div class="no">剩下全勝也只有 ${pts + 3 * left} 分，到不了 ${T} 分。</div></div>`; return; }
    // 可以過線的最少組合：每多一場和局可以少贏多少；剩下的場次輸了也沒關係
    const combos = [];
    for (let w = Math.min(left, Math.ceil(need / 3)); w >= 0; w--) {
      const d = Math.max(0, need - 3 * w);
      if (w + d > left) continue;
      if (combos.some(c => c.w <= w && c.d <= d)) continue; // 有更省的組合就不列
      combos.push({ w, d, l: left - w - d });
    }
    const list = combos.map(c => `<li><span>${desc(c.w, c.d, 0)}</span><span>${c.l ? `其餘 ${c.l} 場可以輸` : '一場都不能輸'}</span></li>`).join('');
    out.innerHTML = `<div class="verdict">${head}
      <div>還需要 <b>${need}</b> 分（Day 1 結束時 ≥ ${T} 分）。以下任一組合就能進 Day 2：</div>
      <ul class="combo">${list}</ul></div>`;
  }

  $('#aGo').onclick = run;
  ['#aR', '#aT', '#cW', '#cD', '#cL'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', () => { if ($('#aOut .verdict')) run(); }); });
  // 按「帶入這場比賽」時，Ascent 賽事順便算 Day 1
  const fill = $('#cFill');
  if (fill) fill.addEventListener('click', () => setTimeout(() => {
    const m = read('lastMatch', null), st = read('lastStand', null);
    const name = (m && m.event && m.event.name) || (st && st.event && st.event.name) || '';
    if (/ascent/i.test(name)) run();
  }, 50));
})();
