// GA 比賽助手：對手英雄（2026-10-30 新增）
// 由 config.js 在主程式之後載入，不需要改 index.html。
// 資料來源：轉接 Worker 的 /api/decks?event=（Omnidex v2：每位參賽者的英雄、屬性、開賽 ELO）。
// 顯示位置：「這場比賽」卡片的對手下方、成績表每位玩家名字後面。
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k, d) => { try { const v = localStorage.getItem('ga.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const BUILTIN_API = 'https://ga-helper.william2923451.workers.dev';
  const apiBase = () => {
    const s = read('settings', {}) || {};
    const u = (read('api', '') || s.api || (window.GA_CONFIG || {}).api || BUILTIN_API).trim();
    return (/你的名稱/.test(u) ? BUILTIN_API : u).replace(/\/+$/, '');
  };

  const css = document.createElement('style');
  css.textContent = `
    .gx-deck{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;background:var(--panel2);font-size:13.5px}
    .gx-deck .gx-h{font-size:11.5px;letter-spacing:.12em;color:var(--muted)}
    .gx-deck .gx-path{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
    .gx-deck .gx-path .gx-arrow{color:var(--muted);font-size:12px}
    .gx-deck .gx-top{font-weight:700;font-size:15px}
    .gx-deck .gx-lv{font-family:var(--num);font-size:13px;color:var(--muted);margin-left:2px}
    .gx-deck .gx-meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--muted);font-size:12.5px}
    .gx-deck .gx-meta b{font-family:var(--num);font-size:16px;color:var(--fg);font-weight:600}
    .gx-ch{display:inline-flex;align-items:center;gap:4px;margin-left:6px;font-size:11.5px;color:var(--muted);font-weight:400;vertical-align:1px}
    .gx-ch i{width:7px;height:7px;border-radius:50%;background:var(--c,var(--other));flex:none}
  `;
  document.head.appendChild(css);

  // 英雄等級：用計血器已快取的英雄卡列表（沒有就照官方給的順序）
  const levels = () => { const m = {}; for (const c of read('champs', []) || []) if (c && c.name) m[c.name] = c.level ?? 0; return m; };
  const sortChamps = list => { const lv = levels(); return list.map((n, i) => ({ n, lv: lv[n], i })).sort((a, b) => ((a.lv ?? -1) - (b.lv ?? -1)) || (a.i - b.i)); };
  const EL = { FIRE: ['Fire', '火'], WATER: ['Water', '水'], WIND: ['Wind', '風'], NORM: ['Norm', '無'] };
  const elInfo = els => { const basic = (els || []).map(e => EL[e]).filter(Boolean); const adv = (els || []).filter(e => !EL[e]); return { cls: basic[0] ? 'el-' + basic[0][0] : '', zh: basic.map(x => x[1]).concat(adv.map(e => e[0] + e.slice(1).toLowerCase())).join('・') }; };
  const short = n => String(n || '').split(',')[0];

  // ---------- 資料 ----------
  const D = { event: null, data: null, at: 0, err: null, busy: null, seen: null };
  async function load(eventId, force) {
    if (!eventId) return null;
    if (!force && D.event === eventId && D.data && Date.now() - D.at < 45000) return D.data;
    if (D.busy && D.event === eventId) return D.busy;
    D.event = eventId;
    D.busy = (async () => {
      try {
        const r = await fetch(apiBase() + '/api/decks?event=' + eventId + (force ? '&fresh=1' : ''));
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || ('連線失敗 ' + r.status));
        if (!j.players) throw new Error('轉接 Worker 還沒更新（沒有 /api/decks）');
        D.data = j; D.at = Date.now(); D.err = null;
      } catch (e) { D.err = e.message || String(e); }
      finally { D.busy = null; }
      paint();
      return D.data;
    })();
    return D.busy;
  }

  // ---------- 畫面 ----------
  function deckHTML(entry, oppName) {
    if (!entry) return '';
    const ch = sortChamps(entry.champions || []);
    const el = elInfo(entry.elements);
    const elo = entry.initialElo != null ? `<span>開賽 ELO <b>${Math.round(entry.initialElo)}</b></span>` : '';
    if (ch.length) {
      const top = ch[ch.length - 1];
      const path = ch.map((c, i) => `${i ? '<span class="gx-arrow">→</span>' : ''}${i === ch.length - 1
        ? `<span class="pill ${el.cls} gx-top"><i></i>${esc(c.n)}</span>`
        : `<span>${esc(short(c.n))}</span>`}${c.lv != null ? `<span class="gx-lv">Lv${c.lv}</span>` : ''}`).join('');
      return `<div class="gx-deck" data-sig="${esc(top.n)}"><div class="gx-h">對手英雄</div><div class="gx-path">${path}</div>
        <div class="gx-meta">${el.zh ? `<span>屬性 ${esc(el.zh)}</span>` : ''}${elo}</div></div>`;
    }
    const msg = entry.submitted ? '對手已交牌表，官方還沒公開英雄。' : '對手還沒交牌表。';
    return `<div class="gx-deck" data-sig="none"><div class="gx-h">對手英雄</div><div class="muted">${msg}</div>${elo ? `<div class="gx-meta">${elo}</div>` : ''}</div>`;
  }

  let painting = false;
  function paint() {
    if (painting) return; painting = true;
    try {
      const d = D.data;
      // 這場比賽卡片
      const box = $('#evStatus');
      const m = read('lastMatch', null);
      const opp = m && m.current && m.current.opp;
      const old = box && box.querySelector('.gx-deck');
      const same = d && m && m.event && String(m.event.id) === String(d.event && d.event.id);
      const html = same && opp ? deckHTML(d.players[opp.id]) : '';
      if (box) {
        if (!html) { if (old) old.remove(); }
        else {
          const tmp = document.createElement('div'); tmp.innerHTML = html; const node = tmp.firstElementChild;
          if (!old || old.outerHTML !== node.outerHTML) {
            if (old) old.replaceWith(node);
            else { const mt = box.querySelector('.mt'); mt ? mt.after(node) : box.appendChild(node); }
          }
        }
      }
      // 成績表：名字後面加最高等級英雄
      const st = read('lastStand', null);
      const sb = $('#standBox');
      if (sb && st && st.rows && d && String(st.event && st.event.id) === String(d.event && d.event.id)) {
        const trs = sb.querySelectorAll('table.stand tbody tr');
        trs.forEach((tr, i) => {
          const row = st.rows[i]; if (!row) return;
          const e = d.players[row.id];
          const cell = tr.querySelector('td.nm'); if (!cell || cell.querySelector('.gx-ch')) return;
          if (!e || !(e.champions || []).length) return;
          const ch = sortChamps(e.champions); const top = ch[ch.length - 1];
          const el = elInfo(e.elements);
          cell.insertAdjacentHTML('beforeend', `<span class="gx-ch ${el.cls}"><i></i>${esc(short(top.n))}</span>`);
        });
      }
    } finally { painting = false; }
  }

  // ---------- 跟著主程式更新 ----------
  function sync() {
    if (painting) return;
    const m = read('lastMatch', null), st = read('lastStand', null);
    const ev = (m && m.event && m.event.id) || (st && st.event && st.event.id);
    if (!ev) return;
    const stamp = (m && m.fetchedAt) + '|' + (st && st.fetchedAt);
    const changed = stamp !== D.seen; D.seen = stamp;
    // 主程式重新抓配對或成績表時，順便更新英雄（至少間隔 20 秒）
    if (String(D.event) !== String(ev) || (changed && Date.now() - D.at > 20000)) load(String(ev));
    paint();
  }
  const mo = new MutationObserver(() => { if (!painting) sync(); });
  ['#evStatus', '#standBox'].forEach(s => { const el = $(s); if (el) mo.observe(el, { childList: true }); });
  // 按「重新整理」時跳過 Worker 快取
  const fresh = $('#evFresh'); if (fresh) fresh.addEventListener('click', () => { const m = read('lastMatch', null); if (m && m.event) setTimeout(() => load(String(m.event.id), true), 1500); });
  sync();
})();
