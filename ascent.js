// GA 比賽助手：Ascent Day 1 晉級線（2026-10-30 新增）
// 由 config.js 在主程式之後載入，不需要改 index.html。
// Ascent 通常是 Day 1 打 9 輪，18 分以上（例如 6-3）進 Day 2。這是分數線，不是前 K 名，
// 所以不用模擬其他人：只看自己剩下幾輪、每輪的勝／和／敗機率。
// 戰績從晉級計算器的「我已贏（含輪空）／我已和／我已輸」讀取，和局率共用晉級計算器的設定。
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const card = $('#calcCard'); if (!card) return;
  const read = (k, d) => { try { const v = localStorage.getItem('ga.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem('ga.' + k, JSON.stringify(v)); } catch (e) {} };
  const A = Object.assign({ rounds: 9, line: 18, win: 50 }, read('ascent', {}));

  const css = document.createElement('style');
  css.textContent = `
    .asc{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px dashed var(--line)}
    .asc .asc-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .asc .asc-h b{font-size:15px}
    .asc .ok{color:var(--good)}.asc .no{color:var(--bad)}
    .asc table.paths td.l small{color:var(--muted);margin-left:6px}
  `;
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.className = 'asc';
  box.innerHTML = `
    <div class="asc-h"><b>Ascent Day 1 晉級線</b><button class="btn sm" id="aGo">計算 Day 1</button></div>
    <p class="muted small" style="margin:0">Day 1 打完達到分數線就進 Day 2（不看名次）。戰績用上面的「我已贏／和／輸」，和局率共用上面的設定。</p>
    <div class="cgrid">
      <label>Day 1 輪數<input id="aR" type="number" inputmode="numeric" min="1" value="${A.rounds}"></label>
      <label>晉級分數<input id="aT" type="number" inputmode="numeric" min="1" value="${A.line}"></label>
      <label>我每局勝率 %<input id="aP" type="number" inputmode="numeric" min="1" max="99" value="${A.win}"></label>
    </div>
    <div id="aOut"></div>`;
  card.appendChild(box);

  const fact = n => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
  const g = id => Math.max(0, parseInt($(id).value, 10) || 0);

  function run() {
    const R1 = Math.max(1, g('#aR')), T = Math.max(1, g('#aT')), P = Math.min(99, Math.max(1, g('#aP'))) / 100;
    A.rounds = R1; A.line = T; A.win = Math.round(P * 100); save('ascent', A);
    const W = g('#cW'), D = g('#cD'), Lo = g('#cL');
    const draw = Math.min(.6, g('#cDraw') / 100);
    const out = $('#aOut');
    const played = W + D + Lo, pts = W * 3 + D;
    if (played > R1) { out.innerHTML = `<div class="msg">已經打了 ${played} 輪，超過 Day 1 的 ${R1} 輪。Day 1 結束時的積分要看第 ${R1} 輪後的成績。</div>`; return; }
    const left = R1 - played, need = Math.max(0, T - pts);
    const pw = (1 - draw) * P, pl = (1 - draw) * (1 - P);
    const paths = [];
    for (let w = left; w >= 0; w--) for (let d = left - w; d >= 0; d--) {
      const l = left - w - d, fp = pts + 3 * w + d;
      const pr = fact(left) / (fact(w) * fact(d) * fact(l)) * Math.pow(pw, w) * Math.pow(draw, d) * Math.pow(pl, l);
      paths.push({ w, d, l, fp, pr, ok: fp >= T });
    }
    const chance = paths.filter(x => x.ok).reduce((a, x) => a + x.pr, 0);
    const desc = x => x.w + x.d + x.l === 0 ? '不用再打' : [x.w ? `贏 ${x.w}` : '', x.d ? `和 ${x.d}` : '', x.l ? `輸 ${x.l}` : ''].filter(Boolean).join('、');
    // 只靠贏和輸（不和局）時，最多還能輸幾場
    const winsNeeded = Math.ceil(need / 3);
    const maxLoss = left - winsNeeded;
    let head;
    if (need === 0) head = `<div class="ok">已經 <b>${pts}</b> 分，達到 ${T} 分，確定進 Day 2。</div>`;
    else if (maxLoss < 0 && pts + 3 * left < T) head = `<div class="no">剩下 ${left} 輪全勝也只有 <b>${pts + 3 * left}</b> 分，到不了 ${T} 分。</div>`;
    else head = `<div>還差 <b>${need}</b> 分：剩 ${left} 輪至少要 <b>贏 ${winsNeeded}</b>，最多還能輸 <b>${maxLoss}</b> 場（不算和局）。</div>`;
    const cls = p => p >= .95 ? 'c-safe' : p >= .6 ? 'c-likely' : p >= .2 ? 'c-maybe' : 'c-hard';
    const pct = p => p >= .995 ? '必進' : p < .005 ? '進不了' : Math.round(p * 100) + '%';
    out.innerHTML = `
      <div class="verdict">
        <div>Day 1 目前 <b>${W}-${Lo}-${D}</b>（勝-敗-和），<b>${pts}</b> 分，還剩 <b>${left}</b> 輪，晉級線 <b>${T}</b> 分。</div>
        ${head}
        ${need > 0 && left > 0 ? `<div>照每局勝率 ${Math.round(P * 100)}%、和局率 ${Math.round(draw * 100)}% 估計，進 Day 2 的機率 <span class="chance ${cls(chance)}">${pct(chance)}</span></div>` : ''}
        <div class="muted small">只看分數線，不看名次和 OMW%。主辦單位公告的晉級分數不同時，改上面的「晉級分數」。</div>
      </div>
      ${left ? `<table class="paths"><thead><tr><th class="l">剩下的結果</th><th>Day 1 積分</th><th>進 Day 2</th><th>機率</th></tr></thead><tbody>
        ${paths.map(x => `<tr><td class="l">${desc(x)}</td><td class="num">${x.fp}</td><td class="${x.ok ? 'ok' : 'no'}">${x.ok ? '進' : '不進'}</td><td class="num">${(x.pr * 100).toFixed(x.pr < .1 ? 1 : 0)}%</td></tr>`).join('')}
      </tbody></table>` : ''}`;
  }

  $('#aGo').onclick = run;
  ['#aR', '#aT', '#aP'].forEach(id => $(id).addEventListener('change', () => { if ($('#aOut').innerHTML) run(); }));
  // 按「帶入這場比賽」時，Ascent 賽事順便算 Day 1
  const fill = $('#cFill');
  if (fill) fill.addEventListener('click', () => setTimeout(() => {
    const m = read('lastMatch', null), st = read('lastStand', null);
    const name = (m && m.event && m.event.name) || (st && st.event && st.event.name) || '';
    if (/ascent/i.test(name)) run();
  }, 50));
})();
