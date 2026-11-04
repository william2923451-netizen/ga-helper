// GA 比賽助手 — Cloudflare Worker（免費方案即可）
// 功能：轉接 Omnidex 配對與 grandarchivestats 玩家資料，加上 CORS 讓手機網頁可以讀。
//
// 路由：
//   /api/match?event=<賽事編號>&pid=<你的 GA 編號>   目前這輪的對手＋對手資料（10/31：每一輪加上 ELO 變化）
//   /api/decks?event=<賽事編號>                     每位參賽者的英雄、屬性、開賽 ELO（Omnidex v2，10/30 新增）
//   /api/report?event=<賽事編號>&pid=<GA 編號>       這一輪的結果回報狀態（Omnidex v2，11/02 新增，實驗中）
//   /api/player?pid=<GA 編號>                       用編號查玩家
//   /api/player?name=<GAS 玩家名稱>                 用名稱查玩家
//   /api/search?q=<關鍵字>                          搜尋玩家（名稱或編號）
//   /api/standings?event=<賽事編號>                 成績表（瑞士輪排名、積分、OMW% 等）
//   /api/champions                                  英雄卡列表（名稱、等級、生命、卡圖網址）
//   任何路由加 &fresh=1 會跳過快取，重新向 Omnidex／grandarchivestats 抓取
//
// 邀請碼制（11/02 新增）：
//   Worker 綁了 KV（變數名稱 GA_KV）並設定祕密 ADMIN_KEY 之後才會啟用；沒設定時跟以前一樣人人可用。
//   啟用後，資料路由（match、decks、report、standings、player、search）要帶 X-GA-Key（會員金鑰）或 X-GA-Admin（管理員金鑰）。
//   /api/status                 公開：是否需要邀請碼
//   /api/join     POST          {code, pid, name} 用邀請碼換會員金鑰（第一次輸入時綁定 GA 編號）
//   /api/me                     查自己的會員狀態
//   /api/admin/list|create|update|delete   管理員：列出、產生、停用／啟用／解除綁定、刪除邀請碼

const OMNI = 'https://api.gatcg.com/omnidex/events/';
const GAS = 'https://grandarchivestats.com';
const HEADERS = { 'User-Agent': 'GA-Match-Helper/1.0 (personal tournament companion)' };

// ---------- 小工具 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', rarr: '→' };
function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
const stripTags = s => decode((s || '').replace(/<[^>]*>/g, ' '));
const pick = (s, re) => { const m = s.match(re); return m ? decode(m[1]) : ''; };

// 5xx、429 或網路錯誤時重試兩次；其他 4xx 直接回報
async function get(url, opts, label) {
  let last;
  for (let t = 0; t < 3; t++) {
    let r;
    try { r = await fetch(url, opts); } catch (e) { last = e; }
    if (r) {
      if (r.status === 404) return null;
      if (r.ok) return r;
      last = new Error(label + ' 回應 ' + r.status);
      if (r.status < 500 && r.status !== 429) throw last;
    }
    await new Promise(res => setTimeout(res, 600 * (t + 1)));
  }
  throw last;
}

// 記憶體快取：同一台 Cloudflare 機器上的請求共用，減少對 Omnidex／grandarchivestats 的負擔。
// 多人在同一場比賽時，配對只會被抓一次。
const MEM = new Map();
let FRESH = false; // 這次請求要不要跳過快取（重新整理按鈕）
function memGet(k) { if (FRESH) return undefined; const v = MEM.get(k); if (!v) return undefined; if (v.exp < Date.now()) { MEM.delete(k); return undefined; } return v.val; }
function memSet(k, val, sec) {
  if (MEM.size > 400) for (const [key, v] of MEM) { if (v.exp < Date.now() || MEM.size > 300) MEM.delete(key); }
  MEM.set(k, { val, exp: Date.now() + sec * 1000 });
}

// ttl 可以是秒數，或依結果決定秒數的函式
async function getJSON(url, ttl) {
  const hit = memGet(url); if (hit !== undefined) return hit;
  const r = await get(url, { headers: HEADERS }, 'Omnidex');
  const j = r ? await r.json() : null;
  const sec = typeof ttl === 'function' ? ttl(j) : ttl;
  if (sec) memSet(url, j, sec);
  return j;
}
async function getText(url, ttl) {
  const hit = memGet(url); if (hit !== undefined) return hit;
  const r = await get(url, { headers: HEADERS }, 'grandarchivestats');
  const t = r ? await r.text() : null;
  if (ttl && t) memSet(url, t, ttl);
  return t;
}

// ---------- grandarchivestats 玩家頁 ----------
function parseProfile(html, slug) {
  const name = pick(html, /<title>([^<]*?)\s*-\s*Grand Archive Player Profile/) || decodeURIComponent(slug || '');
  const eloRaw = pick(html, /id="ptc-stat-num"[^>]*>\s*([\d,\.]+)/);
  const events = html.split(/<details class="pl-event/).slice(1).map(chunk => {
    const head = chunk.split('</summary>')[0];
    const rec = pick(head, /class="pl-rec"[^>]*>([^<]*)/);
    const recTitle = pick(head, /class="pl-rec"\s+title="([^"]*)"/);
    const ids = +((recTitle.match(/(\d+)\s*ID/) || [])[1] || 0);
    const deck = pick(head, /pl-event-deck-name[^"]*"[^>]*>([^<]*)/) || pick(head, /deck-pill[^"]*"[^>]*>([^<]*)/);
    const el = (head.match(/deck-pill-([A-Za-z]+)/) || [])[1] || '';
    return {
      event: pick(head, /class="pl-event-name"[^>]*>([^<]*)/),
      eventId: (chunk.match(/href="\/events\/(\d+)"/) || [])[1] || '',
      date: (head.match(/class="pl-event-sub"[^>]*>\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
      deck, element: el, rec, ids,
      cut: pick(head, /class="pl-event-cut"[^>]*>([^<]*)/).replace(/^Top Cut\s*·\s*/, ''),
    };
  });
  const elo = eloRaw ? parseFloat(eloRaw.replace(/,/g, '')) : null;
  const pid = +((html.match(/Omnidex\s*#\s*(\d+)/) || [])[1] || 0) || null; // 手動查詢用名字查到的人也有 GA 編號（交手履歷比對用）
  return { name, slug, pid, elo, events, featured: (events.find(e => e.deck) || {}).deck || '' };
}

function parseSearch(html) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="\/players\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = stripTags(m[2]);
    const elo = (text.match(/(\d[\d,]*)\s*Elo/i) || [])[1];
    const evs = (text.match(/(\d+)\s*evs?/i) || [])[1];
    const name = decodeURIComponent(m[1]);
    const deck = text.replace(name, '').replace(/\d+\s*evs?[\s\S]*$/i, '').trim();
    out.push({ slug: m[1], name, deck, elo: elo ? +elo.replace(/,/g, '') : null, events: evs ? +evs : null });
  }
  return out;
}

async function playerBySlug(slug) {
  const html = await getText(GAS + '/players/' + slug, 600);
  if (!html) return null;
  return parseProfile(html, slug);
}
async function search(q) {
  const html = await getText(GAS + '/players?q=' + encodeURIComponent(q), 600);
  return html ? parseSearch(html) : [];
}
async function playerByPid(pid) {
  const hits = await search(String(pid));
  if (!hits.length) return null;
  const p = await playerBySlug(hits[0].slug);
  if (p) p.pid = +pid;
  return p;
}

// ---------- Omnidex 配對 ----------
async function findMatch(eventId, pid) {
  pid = +pid;
  const ev = await getJSON(OMNI + eventId, 30);
  if (!ev) return { error: '找不到這個賽事編號' };
  const stages = ev.stages && ev.stages.length ? ev.stages : [{ id: 1 }];
  const rounds = [];
  let timer = null;
  for (const sg of stages) {
    for (let r = 1; r <= 20; r++) {
      // 一定要帶 stage：不帶的話 Omnidex 會回傳最後一個階段（決賽淘汰賽）的配對
      const p = await getJSON(OMNI + eventId + '/pairings?round=' + r + '&stage=' + sg.id,
        j => (j && j.round && j.round.status === 'complete' ? 6 * 3600 : 15));
      if (!p || !p.pairings || !p.pairings.length) break;
      const m = p.pairings.find(x => x.pairing.some(y => y.id === pid));
      if (m) {
        const me = m.pairing.find(y => y.id === pid);
        const opp = m.pairing.find(y => y.id !== pid) || null;
        rounds.push({
          stage: (p.stage && p.stage.type) || sg.type || 'swiss',
          round: r,
          table: m.id,
          status: m.status,
          roundStatus: p.round && p.round.status,
          // elo：這一輪的 ELO 變化（Omnidex 的 eloChange，輪次結束後才有）
          me: { score: me.score, status: me.status, elo: me.eloChange ?? null },
          opp: opp ? { id: opp.id, score: opp.score, status: opp.status, elo: opp.eloChange ?? null } : null,
        });
        timer = (p.round && p.round.timer) || null;
      }
      const tot = p.round && p.round.total;
      if (tot && r >= tot) break;
    }
  }
  const rec = { w: 0, l: 0, d: 0 };
  for (const x of rounds) {
    if (!x.opp) { if (x.status === 'complete') rec.w++; continue; } // BYE
    if (x.status !== 'complete') continue;
    if (x.me.status === 'winner') rec.w++;
    else if (x.me.status === 'loser') rec.l++;
    else rec.d++;
  }
  const current = rounds.at(-1) || null;
  // 參賽者名單（名字、國家），grandarchivestats 還沒收錄的比賽也有
  let names = {};
  try { for (const x of (await getJSON(OMNI + eventId + '/players', 60)) || []) names[x.id] = { name: x.username, country: x.country }; } catch (e) {}
  for (const x of rounds) if (x.opp) x.opp.name = (names[x.opp.id] || {}).name || '';
  let opponent = null;
  if (current && current.opp) {
    try { opponent = await playerByPid(current.opp.id); } catch (e) { opponent = { error: e.message }; }
    if (!opponent) opponent = { pid: current.opp.id, notFound: true };
    if (!opponent.name && names[current.opp.id]) opponent.name = names[current.opp.id].name;
    if (names[current.opp.id]) opponent.country = names[current.opp.id].country;
  }
  return {
    event: { id: ev.id, name: ev.name, status: ev.status, date: ev.date, swissRounds: ev.swissRounds, players: (ev.players || []).length },
    record: rec, rounds, current, timer, opponent,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- 英雄與屬性（Omnidex v2 賽事資料）----------
// omni.gatcg.com/api/v2/events?id= 每位參賽者有 decklist { submitted, revealed, champions[], elements[] } 與 initialElo（開賽時的 ELO）。
// 牌表公開（revealed）後 champions 才有內容；比賽中若官方提前公開英雄，這裡會直接帶出來。
// 參賽者用 uuid 記錄，要用 /api/v2/events/users 對回 GA 編號。
const OMNI2 = 'https://omni.gatcg.com/api/v2/events';
async function decks(eventId) {
  const key = 'decks:' + eventId;
  const hit = memGet(key); if (hit !== undefined) return hit;
  const ev = await getJSON(OMNI2 + '?id=' + eventId, 0);
  if (!ev) return { error: '找不到這個賽事編號' };
  // 名單（uuid → GA 編號）很少變，快取 20 分鐘；只留需要的欄位，節省記憶體
  const mapKey = 'uuidmap:' + eventId;
  let map = memGet(mapKey);
  const need = (ev.players || []).some(p => map === undefined || !map[p.uuid]);
  if (need) {
    const us = (await getJSON(OMNI2 + '/users?id=' + eventId, 0)) || [];
    map = {};
    for (const u of us) if (u && u.uuid) map[u.uuid] = +u.id;
    memSet(mapKey, map, 1200);
  }
  const players = {};
  let revealed = 0, submitted = 0;
  for (const p of ev.players || []) {
    const id = map[p.uuid]; if (!id) continue;
    const d = p.decklist || {};
    if (d.submitted) submitted++;
    if ((d.champions || []).length) revealed++;
    players[id] = {
      champions: d.champions || [],
      elements: d.elements || [],
      submitted: !!d.submitted,
      revealed: !!d.revealed,
      initialElo: p.initialElo ?? null,
      dropped: !!p.dropped,
    };
  }
  const out = {
    event: { id: ev.id, name: ev.name, status: ev.status, decklistsRequired: !!ev.decklistsRequired },
    counts: { players: Object.keys(players).length, submitted, revealed },
    players,
    fetchedAt: new Date().toISOString(),
  };
  // 已結束的比賽 6 小時，進行中 60 秒
  memSet(key, out, ev.status === 'complete' ? 6 * 3600 : 60);
  return out;
}

// ---------- 這一輪的回報狀態（Omnidex v2）----------
// v2 每一桌有 status，雙方各有 score、status、datePlaced；一方回報後這些欄位會先變，雙方確認後整桌才 complete。
// 參賽者在 v2 用 players[].id（entityId）記錄，要經 uuid 對回 GA 編號。
async function uuidMap(eventId, ev) {
  const mapKey = 'uuidmap:' + eventId;
  let map = memGet(mapKey);
  if (map === undefined || (ev.players || []).some(p => !map[p.uuid])) {
    const us = (await getJSON(OMNI2 + '/users?id=' + eventId, 0)) || [];
    map = {};
    for (const u of us) if (u && u.uuid) map[u.uuid] = +u.id;
    memSet(mapKey, map, 1200);
  }
  return map;
}
async function report(eventId, pid) {
  pid = +pid;
  const key = 'v2ev:' + eventId;
  let ev = memGet(key);
  if (ev === undefined) { ev = await getJSON(OMNI2 + '?id=' + eventId, 0); if (ev) memSet(key, ev, 15); }
  if (!ev) return { error: '找不到這個賽事編號' };
  const map = await uuidMap(eventId, ev);
  const ent = {}; // entityId → GA 編號
  for (const p of ev.players || []) if (map[p.uuid]) ent[p.id] = map[p.uuid];
  const stages = ev.stages || [];
  for (let si = stages.length - 1; si >= 0; si--) {
    const st = stages[si], rounds = st.rounds || [];
    for (let ri = rounds.length - 1; ri >= 0; ri--) {
      const r = rounds[ri];
      for (const m of r.matches || []) {
        const ps = m.pairings || [];
        const me = ps.find(x => ent[x.entityId] === pid);
        if (!me) continue;
        const op = ps.find(x => x !== me) || null;
        const side = x => x ? { id: ent[x.entityId] ?? null, score: x.score ?? 0, status: x.status || '', placed: x.datePlaced || null, dropped: !!x.dropped } : null;
        return {
          stage: st.type, bestOf: st.bestOf || null, round: r.number, roundStatus: r.status,
          table: m.table, status: m.status, started: m.dateStarted || null, completed: m.dateCompleted || null,
          me: side(me), opp: side(op), fetchedAt: new Date().toISOString(),
        };
      }
    }
  }
  return { none: true };
}

// ---------- 成績表 ----------
async function standings(eventId) {
  const ev = await getJSON(OMNI + eventId, 30);
  if (!ev) return { error: '找不到這個賽事編號' };
  const [st, pl] = await Promise.all([
    getJSON(OMNI + eventId + '/standings?stage=1', 30),
    getJSON(OMNI + eventId + '/players', 60),
  ]);
  const names = {};
  for (const x of pl || []) names[x.id] = x;
  const rows = ((st && st.standings) || []).map((x, i) => ({
    rank: i + 1, id: x.id, name: (names[x.id] || {}).username || '#' + x.id, country: (names[x.id] || {}).country || '',
    cp: (names[x.id] || {}).cp ?? null,
    score: x.statsScore, w: x.statsWins, l: x.statsLosses, t: x.statsTies, byes: x.statsByes,
    mw: x.statsPercentMW, gw: x.statsPercentGW, omw: x.statsPercentOMW, ogw: x.statsPercentOGW,
    place: x.finalPlacement ?? null, status: x.status || '',
  }));
  return {
    event: { id: ev.id, name: ev.name, status: ev.status, swissRounds: ev.swissRounds, cut: ev.singleEliminationCutSize || null },
    rounds: (st && st.rounds) || null, rows, fetchedAt: new Date().toISOString(),
  };
}

// ---------- 英雄卡（計血器背景）----------
async function champions() {
  const key = 'champions';
  const hit = memGet(key); if (hit) return hit;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await getJSON('https://api.gatcg.com/cards/search?type=champion&page_size=50&page=' + page);
    if (!j || !j.data) break;
    for (const c of j.data) {
      const ed = (c.editions || []).find(e => e.uuid === c.default_edition) || (c.editions || [])[0] || {};
      out.push({ name: c.name, level: c.level, life: c.life, element: (c.elements || [c.element] || [])[0] || c.element || '', image: ed.image ? 'https://api.gatcg.com' + ed.image : '' });
    }
    if (!j.has_more) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || (a.level ?? 0) - (b.level ?? 0));
  memSet(key, out, 24 * 3600);
  return out;
}

// ---------- 邀請碼與會員 ----------
// KV 內容：code:<邀請碼> → 會員資料；tok:<會員金鑰> → 邀請碼
// 為了不超過免費方案每天 1,000 次寫入：使用次數先記在記憶體，累積 50 次或超過 30 分鐘才寫回一次。
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0 O 1 I
const randCode = () => { const a = new Uint8Array(8); crypto.getRandomValues(a); const c = [...a].map(x => ALPH[x % ALPH.length]).join(''); return c.slice(0, 4) + '-' + c.slice(4); };
const randTok = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); };
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
const gated = env => !!(env && env.GA_KV && env.ADMIN_KEY);
const isAdmin = (req, env) => !!(env && env.ADMIN_KEY) && req.headers.get('X-GA-Admin') === env.ADMIN_KEY;
const AUTH = new Map(); // 會員金鑰 → { code, m, at, pending, flushed }
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣日期
async function member(env, tok) {
  if (!tok) return null;
  let a = AUTH.get(tok);
  if (!a || Date.now() - a.at > 5 * 60e3) {
    const code = await env.GA_KV.get('tok:' + tok);
    const m = code ? await env.GA_KV.get('code:' + code, 'json') : null;
    a = { code, m, at: Date.now(), pending: a ? a.pending : 0, flushed: a ? a.flushed : Date.now() };
    AUTH.set(tok, a);
    if (AUTH.size > 500) AUTH.delete(AUTH.keys().next().value);
  }
  if (!a.m || a.m.disabled) return null;
  // 記使用次數（延後寫回）
  a.pending++;
  if (!kvFull() && (a.pending >= 50 || Date.now() - a.flushed > 30 * 60e3)) {
    const m = (await env.GA_KV.get('code:' + a.code, 'json')) || a.m;
    const d = today();
    if (!m.usage || m.usage.d !== d) m.usage = { d, n: 0 };
    m.usage.n += a.pending; m.total = (m.total || 0) + a.pending; m.seen = new Date().toISOString();
    await env.GA_KV.put('code:' + a.code, JSON.stringify(m));
    a.m = m; a.pending = 0; a.flushed = Date.now();
  }
  return a.m;
}
// 暱稱索引：nick:<GA 編號> → 加入時填的暱稱（記憶體快取 10 分鐘，省 KV 讀取）
async function nickOf(env, pid) {
  const k = 'nick:' + pid; const hit = memGet(k); if (hit !== undefined) return hit;
  let v = ''; try { v = (await env.GA_KV.get(k)) || ''; } catch (e) {}
  memSet(k, v, 600); return v;
}
async function gaNameOf(pid) { try { const h = await search(String(pid)); return (h && h[0] && h[0].name) || ''; } catch (e) { return ''; } }
async function readBody(req) { try { return await req.json(); } catch (e) { return {}; } }
const pub = m => ({ code: m.code, note: m.note || '', pid: m.pid || null, name: m.name || '', gaName: m.gaName || '', disabled: !!m.disabled, created: m.created, bound: m.bound || null, seen: m.seen || null, today: m.usage && m.usage.d === today() ? m.usage.n : 0, total: m.total || 0, devices: (m.tokens || []).length });
async function join(env, body) {
  const code = normCode(body.code), pid = String(body.pid || '').replace(/\D/g, '');
  if (!code) return json({ error: '請輸入邀請碼' }, 400);
  if (!pid) return json({ error: '請填你的 GA 編號' }, 400);
  if (!String(body.name || '').trim()) return json({ error: '請填暱稱' }, 400);
  const m = await env.GA_KV.get('code:' + code, 'json');
  if (!m) return json({ error: '找不到這個邀請碼，請確認有沒有打錯' }, 404);
  if (m.disabled) return json({ error: '這個邀請碼已經停用，請聯絡管理員' }, 403);
  if (m.pid && m.pid !== pid) return json({ error: `這個邀請碼已經綁定 GA #${m.pid}，請跟管理員要一組新的` }, 403);
  if (!m.pid) { m.pid = pid; m.bound = new Date().toISOString(); }
  if (!m.gaName) m.gaName = await gaNameOf(pid); // GA 帳號名稱（grandarchivestats），管理清單顯示「名稱#編號」
  m.name = String(body.name).trim().slice(0, 40);
  m.seen = new Date().toISOString();
  const tok = randTok();
  m.tokens = (m.tokens || []).concat(tok);
  while (m.tokens.length > 3) { const old = m.tokens.shift(); await env.GA_KV.delete('tok:' + old); AUTH.delete(old); } // 最多 3 支裝置
  if (!(await env.GA_KV.put('tok:' + tok, code))) return json({ error: '伺服器今天的儲存額度用完了，請明天早上 8 點後再加入（已加入的人不受影響）' }, 503);
  await env.GA_KV.put('code:' + code, JSON.stringify(m));
  await env.GA_KV.put('nick:' + pid, m.name); MEM.delete('nick:' + pid);
  return json({ ok: true, token: tok, member: pub(m) });
}
async function admin(env, path, req) {
  const KV = env.GA_KV;
  if (path === 'list') {
    const out = []; let cursor;
    let fill = 8; // 舊資料沒有 GA 帳號名稱的，每次補幾筆（避免超過子請求上限）
    do { const r = await KV.list({ prefix: 'code:', cursor }); for (const k of r.keys) { const m = await KV.get(k.name, 'json'); if (!m) continue;
      if (m.pid && !m.gaName && fill > 0) { fill--; const n = await gaNameOf(m.pid); if (n) { m.gaName = n; await KV.put(k.name, JSON.stringify(m)); } }
      out.push(pub(m)); } cursor = r.list_complete ? null : r.cursor; } while (cursor);
    out.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return json({ ok: true, members: out });
  }
  const body = await readBody(req);
  if (path === 'create') {
    // 一次可以產生好幾組（最多 20）
    const n = Math.max(1, Math.min(20, parseInt(body.count, 10) || 1));
    const made = [];
    for (let i = 0; i < n; i++) {
      let code; do { code = randCode(); } while (await KV.get('code:' + code));
      const m = { code, note: String(body.note || '').slice(0, 40), created: new Date().toISOString(), tokens: [] };
      if (!(await KV.put('code:' + code, JSON.stringify(m)))) return json({ error: '伺服器今天的儲存額度用完了，明天早上 8 點後再產生', members: made }, 503);
      made.push(pub(m));
    }
    return json({ ok: true, member: made[0], members: made });
  }
  const code = normCode(body.code);
  const m = await KV.get('code:' + code, 'json');
  if (!m) return json({ error: '找不到這個邀請碼' }, 404);
  const dropTokens = async () => { for (const t of m.tokens || []) { await KV.delete('tok:' + t); AUTH.delete(t); } m.tokens = []; if (m.pid) { await KV.delete('nick:' + m.pid); MEM.delete('nick:' + m.pid); } };
  if (path === 'update') {
    if ('disabled' in body) { m.disabled = !!body.disabled; for (const t of m.tokens || []) AUTH.delete(t); }
    if ('note' in body) m.note = String(body.note || '').slice(0, 40);
    if (body.unbind) { await dropTokens(); m.pid = null; m.name = ''; m.gaName = ''; m.bound = null; }
    await KV.put('code:' + code, JSON.stringify(m));
    return json({ ok: true, member: pub(m) });
  }
  if (path === 'delete') { await dropTokens(); await KV.delete('code:' + code); return json({ ok: true }); }
  return json({ error: '不支援的操作' }, 400);
}


// ---------- 賽事索引與自動找比賽（11/04）----------
// KV：idx:meta → {ready, lastId, updated, cronAt, open, countries:{TW:41,…}}
//     idx:cc:<國家> → [{id, name, host, cc, date, status, chk}]（只留報名中、進行中）
// 賽事編號照建立時間排，比賽日期可能在幾週後，所以第一次要往回掃約 8 週；之後每小時排程掃新編號。
// 免費方案每次最多 50 個對外請求：掃描每批 40 個。
const IDX_BASE = 67830;          // 11/04 時的最新編號附近（第一次建立索引的起點參考）
const IDX_BACK = 5600;           // 往回掃幾個編號（約 8 週）
const SCAN_BATCH = 40;
const OPEN = new Set(['rsvp', 'started', 'completable']);
async function rawEvent(id) {
  try {
    const r = await fetch(OMNI + id, { headers: HEADERS });
    if (!r.ok) return r.status === 404 ? 0 : null;   // 0 = 沒有這個編號；null = 暫時失敗
    const e = await r.json();
    return {
      id: e.id, name: String(e.name || '').slice(0, 80), status: e.status || '', date: e.date || e.startAt || null,
      host: e.host ? String(e.host.name || '').slice(0, 60) : '', cc: (e.host && e.host.addressCountryCode) || (e.setting === 'online' ? 'ONLINE' : '??'),
      players: Array.isArray(e.players) ? e.players : [],
    };
  } catch (err) { return null; }
}
const slimEv = e => ({ id: e.id, name: e.name, host: e.host, cc: e.cc, date: e.date, status: e.status, chk: Date.now() });
async function idxMeta(env) { return (await env.GA_KV.get('idx:meta', 'json')) || { ready: false, lastId: 0, countries: {}, open: 0 }; }
async function idxGet(env, cc) { return (await env.GA_KV.get('idx:cc:' + cc, 'json')) || []; }
async function idxPut(env, cc, list, meta) {
  if (list.length) await env.GA_KV.put('idx:cc:' + cc, JSON.stringify(list)); else await env.GA_KV.delete('idx:cc:' + cc);
  if (list.length) meta.countries[cc] = list.length; else delete meta.countries[cc];
}
const recount = meta => { meta.open = Object.values(meta.countries || {}).reduce((a, b) => a + b, 0); };
// 過期：比賽日期超過 2 天前、還停在報名中的（店家沒開打就放著）
const stale = e => e.date && Date.now() - new Date(e.date).getTime() > 2 * 864e5;
// 掃一段編號：回傳找到的未完賽賽事、最後一個存在的編號、連續沒有的數量
async function scanRange(from, n) {
  const ids = []; for (let i = 0; i < n; i++) ids.push(from + i);
  const res = await Promise.all(ids.map(rawEvent));
  const found = []; let lastSeen = 0, misses = 0, fails = 0;
  res.forEach((e, i) => {
    if (e === null) { fails++; return; }
    if (e === 0) { misses++; return; }
    misses = 0; lastSeen = ids[i];
    if (OPEN.has(e.status) && !stale(e)) found.push(slimEv(e));
  });
  return { found, lastSeen, tailMisses: misses, fails };
}
async function mergeFound(env, meta, found) {
  const by = {}; for (const e of found) (by[e.cc] = by[e.cc] || []).push(e);
  for (const cc of Object.keys(by)) {
    const list = await idxGet(env, cc), map = new Map(list.map(x => [x.id, x]));
    for (const e of by[cc]) map.set(e.id, e);
    await idxPut(env, cc, [...map.values()].filter(x => !stale(x)), meta);
  }
}
// 每小時排程：掃新編號（最多 40 個）＋把過期的移掉＋重新確認幾場最近的賽事
async function cronRun(env) {
  if (kvFull()) return;
  if (!gated(env) && !(env && env.GA_KV)) return;
  const meta = await idxMeta(env); if (!meta.ready) return;
  // 11/04：新編號一次看 8 個，整批都不存在就停（每小時新賽事通常不到 10 場，省下大量 404 請求）
  let used = 0;
  for (let next = meta.lastId + 1; used < SCAN_BATCH; next += 8) {
    const r = await scanRange(next, 8); used += 8;
    if (r.found.length) await mergeFound(env, meta, r.found);
    if (!r.lastSeen) break;
    meta.lastId = r.lastSeen;
  }
  // 剩下的額度：重新確認日期在前後 3 天內、最久沒檢查的幾場（店家可能改日期或已完賽），最多 12 場
  let budget = Math.min(12, 50 - used - 2);
  if (budget > 0) {
    const cands = [];
    for (const cc of Object.keys(meta.countries || {})) for (const e of await idxGet(env, cc)) {
      const dt = e.date ? Math.abs(new Date(e.date).getTime() - Date.now()) : 0;
      if (dt < 3 * 864e5) cands.push(e);
    }
    cands.sort((a, b) => (a.chk || 0) - (b.chk || 0));
    const pick = cands.slice(0, budget);
    const fresh = await Promise.all(pick.map(e => rawEvent(e.id)));
    const touched = new Set();
    pick.forEach((e, i) => { const f = fresh[i]; if (f === null) return; e._new = f ? slimEv(f) : null; touched.add(e.cc); });
    for (const cc of touched) {
      const list = await idxGet(env, cc), upd = new Map(pick.filter(e => e.cc === cc && '_new' in e).map(e => [e.id, e._new]));
      const out = []; const moved = [];
      for (const x of list) {
        if (!upd.has(x.id)) { if (!stale(x)) out.push(x); continue; }
        const n = upd.get(x.id); if (!n || !OPEN.has(n.status) || stale(n)) continue;
        if (n.cc !== cc) moved.push(n); else out.push(n);
      }
      await idxPut(env, cc, out, meta);
      if (moved.length) await mergeFound(env, meta, moved);
    }
  }
  recount(meta); meta.updated = new Date().toISOString(); meta.cronAt = meta.updated;
  await env.GA_KV.put('idx:meta', JSON.stringify(meta));
}
// 管理員：分批建立索引。start → 決定範圍；之後每次帶 cursor 掃 40 個，掃到最新（連續 30 個沒有）就完成
async function idxBuild(env, body) {
  const meta = await idxMeta(env);
  if (body.start) {
    const top = Math.max(meta.lastId || 0, IDX_BASE);
    const from = top - IDX_BACK;
    const b0 = { from, next: from, top, found: [], lastSeen: 0 }; await env.GA_KV.put('idx:build', JSON.stringify(b0)); memSet('idxb', b0, 600);
    return json({ ok: true, total: top + 60 - from, cursor: String(from) });
  }
  const mb = memGet('idxb'); const b = mb || await env.GA_KV.get('idx:build', 'json');
  if (!b) return json({ error: '請重新按「建立賽事索引」' }, 400);
  const r = await scanRange(b.next, SCAN_BATCH);
  b.found.push(...r.found); if (r.lastSeen) b.lastSeen = r.lastSeen;
  b.next += SCAN_BATCH;
  const done = b.next > b.top && r.tailMisses >= 30 || b.next > b.top + 2000;
  if (!done) {
    // 每 5 批寫一次暫存，省 KV 寫入（中斷時最多重掃 200 個）
    if (((b.next - b.from) / SCAN_BATCH) % 5 === 0) await env.GA_KV.put('idx:build', JSON.stringify(b));
    memSet('idxb', b, 600);
    return json({ ok: true, done: b.next - b.from, total: Math.max(b.top + 60, b.next) - b.from, found: b.found.length, cursor: String(b.next) });
  }
  // 完成：照國家分好寫入（先清掉舊的）
  for (const cc of Object.keys(meta.countries || {})) await env.GA_KV.delete('idx:cc:' + cc);
  const m2 = { ready: true, lastId: b.lastSeen || b.top, countries: {}, open: 0, cronAt: meta.cronAt || null };
  await mergeFound(env, m2, b.found);
  recount(m2); m2.updated = new Date().toISOString();
  await env.GA_KV.put('idx:meta', JSON.stringify(m2));
  await env.GA_KV.delete('idx:build'); MEM.delete('idxb');
  return json({ ok: true, done: b.next - b.from, total: b.next - b.from, found: b.found.length, cursor: null });
}
// 找比賽：只看這個國家（或全部）在現在前後 14 小時內的賽事，查名單裡有沒有這個 GA 編號
async function findEvents(env, pid, cc, netCC, page = 0) {
  const meta = await idxMeta(env);
  if (!meta.ready) return { indexReady: false, netCC };
  pid = +pid;
  // 順便看最新幾個編號（店家當天早上才建的比賽）
  // 新編號只在上次看超過 10 分鐘才看（每小時排程本來就會掃），省請求
  const headDue = !page && !memGet('findHead');
  const head = headDue ? await scanRange(meta.lastId + 1, 6) : { lastSeen: 0, found: [] };
  if (headDue) memSet('findHead', 1, 600);
  if (head.lastSeen) { meta.lastId = head.lastSeen; if (head.found.length) await mergeFound(env, meta, head.found); recount(meta); await env.GA_KV.put('idx:meta', JSON.stringify(meta)); }
  const ccs = cc === 'ALL' ? Object.keys(meta.countries || {}) : [cc];
  const W = 14 * 3600e3, now = Date.now(), cands = [];
  for (const c of ccs) for (const e of await idxGet(env, c)) {
    const t = e.date ? new Date(e.date).getTime() : now;
    if (Math.abs(t - now) <= W || e.status === 'started' || e.status === 'completable') cands.push(e);
  }
  // 進行中的先查，再依開始時間跟現在的距離
  const live = e => e.status === 'started' || e.status === 'completable';
  cands.sort((a, b) => live(b) - live(a) || Math.abs(new Date(a.date || now) - now) - Math.abs(new Date(b.date || now) - now));
  const per = page ? 46 : 40; // 第一頁另外掃 8 個新編號，加起來不超過 50 個對外請求
  const off = page ? 40 + (page - 1) * 46 : 0;
  const pick = cands.slice(off, off + per);
  // 11/04：大家共用的參賽名單（KV fp:<國家>）：名單裡已經有你就不用再問 Omnidex；名單 2 分鐘內抓過的也直接用
  const shareKey = cc === 'ALL' ? null : 'fp:' + cc;
  const shared = (shareKey && ((memGet(shareKey)) || (await env.GA_KV.get(shareKey, 'json')))) || { ev: {}, w: 0 };
  let fetched = 0;
  const det = await Promise.all(pick.map(async e => {
    const k = 'evp:' + e.id; const hit = memGet(k); if (hit !== undefined) return hit;
    const sh = shared.ev[e.id];
    if (sh && (Date.now() - sh.at < 2 * 60e3 || (sh.players.includes(pid) && Date.now() - sh.at < 6 * 3600e3))) return { ...sh, id: e.id, name: e.name, host: e.host, date: e.date };
    const f = await rawEvent(e.id); fetched++;
    if (f) { memSet(k, f, 90); if (shareKey) shared.ev[e.id] = { at: Date.now(), status: f.status, players: f.players }; }
    return f;
  }));
  if (shareKey && fetched) {
    for (const id in shared.ev) if (Date.now() - shared.ev[id].at > 24 * 3600e3) delete shared.ev[id];
    memSet(shareKey, shared, 120);
    if (Date.now() - (shared.w || 0) > 5 * 60e3 && !kvFull()) { shared.w = Date.now(); await env.GA_KV.put(shareKey, JSON.stringify(shared), { expirationTtl: 2 * 86400 }); }
  }
  const out = [], gone = new Set();
  pick.forEach((e, i) => {
    const f = det[i]; if (!f) { if (f === 0) gone.add(e.id); return; }
    if (!OPEN.has(f.status)) gone.add(e.id);
    else if (f.players.includes(pid)) out.push({ id: f.id, name: f.name, host: f.host, date: f.date, status: f.status, players: f.players.length });
  });
  // 已經完賽或刪除的順手從索引移掉
  if (gone.size) {
    const byCc = {}; pick.filter(e => gone.has(e.id)).forEach(e => { byCc[e.cc] = 1; });
    for (const c of Object.keys(byCc)) await idxPut(env, c, (await idxGet(env, c)).filter(x => !gone.has(x.id)), meta);
    recount(meta); await env.GA_KV.put('idx:meta', JSON.stringify(meta));
  }
  out.sort((a, b) => (b.status === 'started') - (a.status === 'started') || String(a.date).localeCompare(String(b.date)));
  return { indexReady: true, cc, netCC, checked: off + pick.length, total: cands.length, more: off + pick.length < cands.length, page, events: out };
}


// ---------- 戰績備份與問題回報（11/04 d）----------
// hist:<GA 編號> → 戰績資料（APP 每 5 分鐘或關掉 APP 時存一次）
// bug:<30 分鐘時段>:<雜湊> → 問題回報（同一個錯誤 30 分鐘內合併），保留 30 天
const hashStr = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
async function saveBug(env, body, who) {
  if (kvFull()) return { ok: true, skipped: true };
  const kind = String(body.kind || 'api').slice(0, 20), msg = String(body.msg || '').slice(0, 200), path = String(body.path || '').slice(0, 60);
  const bucket = String(Math.floor(Date.now() / 1800e3)).padStart(10, '0');
  const id = 'bug:' + bucket + ':' + hashStr(kind + msg + path);
  const b = (await env.GA_KV.get(id, 'json')) || { id, at: new Date().toISOString(), kind, msg, path, status: body.status || 0, who: [], count: 0, read: false, done: false };
  b.count++; b.last = new Date().toISOString();
  if (who && !b.who.some(w => w.pid === who.pid)) b.who.push(who); b.who = b.who.slice(0, 20);
  if (body.ctx) b.ctx = String(body.ctx).slice(0, 1500);
  if (body.note) b.note = String(body.note).slice(0, 200);
  if (b.count <= 30 || b.count % 10 === 0) await env.GA_KV.put(id, JSON.stringify(b), { expirationTtl: 30 * 86400 });
  return { ok: true };
}
async function listBugs(env) {
  const out = []; let cursor;
  do { const r = await env.GA_KV.list({ prefix: 'bug:', cursor }); for (const k of r.keys.slice(-100)) { const b = await env.GA_KV.get(k.name, 'json'); if (b) out.push(b); } cursor = r.list_complete ? null : r.cursor; } while (cursor && out.length < 100);
  return out.sort((a, b) => String(b.last || b.at).localeCompare(String(a.last || a.at))).slice(0, 100);
}


// ---------- 11/04：會員資料每週自動備份（KV backup:<日期>，留最近 4 份）＋管理員匯出／匯回 ----------
async function allCodes(env) {
  const out = []; let cursor;
  do { const r = await env.GA_KV.list({ prefix: 'code:', cursor }); for (const k of r.keys) { const m = await env.GA_KV.get(k.name, 'json'); if (m) out.push(m); } cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}
async function weeklyBackup(env, force) {
  if (!env || !env.GA_KV || (kvFull() && !force)) return null;
  const last = await env.GA_KV.get('backup:last');
  if (!force && last && Date.now() - new Date(last).getTime() < 7 * 864e5) return null;
  const codes = await allCodes(env), day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const ok = await env.GA_KV.put('backup:' + day, JSON.stringify({ at: new Date().toISOString(), codes }));
  if (!ok) return null;
  await env.GA_KV.put('backup:last', new Date().toISOString());
  const r = await env.GA_KV.list({ prefix: 'backup:2' }); const old = r.keys.map(k => k.name).sort().slice(0, -4);
  for (const k of old) await env.GA_KV.delete(k);
  return { day, n: codes.length };
}
// 匯回：只補上不存在的邀請碼（不覆蓋現有的），會員金鑰一併恢復
async function restoreCodes(env, codes) {
  let add = 0, skip = 0;
  for (const m of codes || []) {
    if (!m || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(m.code || '')) { skip++; continue; }
    if (await env.GA_KV.get('code:' + m.code)) { skip++; continue; }
    if (!(await env.GA_KV.put('code:' + m.code, JSON.stringify(m)))) return { add, skip, full: true };
    for (const t of m.tokens || []) await env.GA_KV.put('tok:' + t, m.code);
    if (m.pid && m.name) await env.GA_KV.put('nick:' + m.pid, m.name);
    add++;
  }
  return { add, skip };
}

// ---------- 路由 ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-GA-Key, X-GA-Admin',
  'Access-Control-Expose-Headers': 'X-GA-Slug',
  'Access-Control-Max-Age': '86400',
};
const DATA_ROUTES = ['/api/match', '/api/decks', '/api/report', '/api/standings', '/api/player', '/api/search', '/api/find'];
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// ---------- 11/04：雲端儲存寫入失敗不擋人 ----------
// 免費方案每天 1,000 次寫入／刪除；用完時 put 會丟錯誤。包一層：失敗只記下來，回傳 false，讀取照常。
// 寫入失敗後 10 分鐘內，非必要的寫入（使用次數、戰績備份、問題回報、索引）先跳過。
let KV_FULL_UNTIL = 0;
const kvFull = () => Date.now() < KV_FULL_UNTIL;
function wrapKV(kv) {
  if (!kv || kv.__safe) return kv;
  const w = Object.create(kv);
  w.__safe = true;
  w.get = (...a) => kv.get(...a);
  w.list = (...a) => kv.list(...a);
  w.put = async (...a) => { try { await kv.put(...a); return true; } catch (e) { KV_FULL_UNTIL = Date.now() + 10 * 60e3; console.log('KV put failed', String(e)); return false; } };
  w.delete = async (...a) => { try { await kv.delete(...a); return true; } catch (e) { KV_FULL_UNTIL = Date.now() + 10 * 60e3; return false; } };
  return w;
}
const safeEnv = env => (env && env.GA_KV && !env.GA_KV.__safe) ? Object.assign(Object.create(env), { GA_KV: wrapKV(env.GA_KV), ADMIN_KEY: env.ADMIN_KEY }) : env;
// ---------- 11/04：防亂試（同一個網路位置每分鐘次數）----------
function tooMany(req, kind, max) {
  const ip = req.headers.get('CF-Connecting-IP') || 'x', k = 'rl:' + kind + ':' + ip + ':' + Math.floor(Date.now() / 60e3);
  const n = (memGet(k) || 0) + 1; memSet(k, n, 70); return n > max;
}

export default {
  async fetch(req, env) {
    env = safeEnv(env);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const q = u.searchParams;
    FRESH = q.get('fresh') === '1';
    try {
      // ---------- 邀請碼 ----------
      if (u.pathname === '/api/status') return json({ ok: true, inviteRequired: gated(env) });
      if (u.pathname === '/api/join') {
        if (!gated(env)) return json({ ok: true, open: true });
        if (tooMany(req, 'join', 5)) return json({ error: '試太多次了，請 1 分鐘後再試' }, 429);
        if (req.method !== 'POST') return json({ error: '要用 POST' }, 405);
        return await join(env, await readBody(req));
      }
      if (u.pathname.startsWith('/api/admin/')) {
        if (!gated(env)) return json({ error: '還沒設定 GA_KV 和 ADMIN_KEY，邀請碼制沒有啟用' }, 400);
        if (!isAdmin(req, env)) { if (tooMany(req, 'adm', 10)) return json({ error: '試太多次了，請 1 分鐘後再試' }, 429); return json({ error: '管理員金鑰不對', code: 'not-admin' }, 401); }
        if (u.pathname === '/api/admin/backups') { const r = await env.GA_KV.list({ prefix: 'backup:2' }); return json({ ok: true, last: await env.GA_KV.get('backup:last'), list: r.keys.map(k => k.name.slice(7)).sort().reverse(), full: kvFull() }); }
        if (u.pathname === '/api/admin/backup') { const b0 = await readBody(req); if (b0.day) { const t = await env.GA_KV.get('backup:' + String(b0.day).replace(/[^\d-]/g, '')); return t ? new Response(t, { headers: { ...CORS, 'Content-Type': 'application/json' } }) : json({ error: '找不到這份備份' }, 404); } const r = await weeklyBackup(env, true); return r ? json({ ok: true, ...r }) : json({ error: '備份失敗（儲存額度可能用完了）' }, 503); }
        if (u.pathname === '/api/admin/export') return new Response(JSON.stringify({ at: new Date().toISOString(), codes: await allCodes(env) }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
        if (u.pathname === '/api/admin/restore') { const b0 = await readBody(req); return json({ ok: true, ...(await restoreCodes(env, b0.codes)) }); }
        if (u.pathname === '/api/admin/bugs') return json({ ok: true, bugs: await listBugs(env) });
        if (u.pathname === '/api/admin/bugupd') { const b0 = await readBody(req); const b = await env.GA_KV.get(String(b0.id || ''), 'json'); if (!b) return json({ error: '找不到這筆回報' }, 404); if ('read' in b0) b.read = !!b0.read; if ('done' in b0) b.done = !!b0.done; await env.GA_KV.put(b.id, JSON.stringify(b), { expirationTtl: 30 * 86400 }); return json({ ok: true }); }
        if (u.pathname === '/api/admin/bugdel') { const b0 = await readBody(req);
          if (b0.done) { for (const b of await listBugs(env)) if (b.done) await env.GA_KV.delete(b.id); return json({ ok: true }); }
          if (!String(b0.id || '').startsWith('bug:')) return json({ error: '需要 id' }, 400); await env.GA_KV.delete(b0.id); return json({ ok: true }); }
        return await admin(env, u.pathname.slice('/api/admin/'.length), req);
      }
      if (u.pathname === '/api/me') {
        if (!gated(env)) return json({ ok: true, open: true });
        if (isAdmin(req, env)) return json({ ok: true, admin: true });
        const m = await member(env, req.headers.get('X-GA-Key'));
        return m ? json({ ok: true, member: pub(m) }) : json({ error: '需要邀請碼', code: 'need-invite' }, 401);
      }
      if (u.pathname === '/api/bug') {
        if (req.method !== 'POST') return json({ error: '要用 POST' }, 405);
        if (!env || !env.GA_KV) return json({ ok: true, skipped: true });
        const body = await readBody(req); let who = null;
        if (isAdmin(req, env)) who = { pid: 'admin', name: '管理員' };
        else if (gated(env)) { const m = await member(env, req.headers.get('X-GA-Key')); if (!m) return json({ error: '需要邀請碼', code: 'need-invite' }, 401); who = { pid: m.pid, name: m.gaName || m.name }; }
        else who = { pid: '?', name: String(body.name || '').slice(0, 30) };
        return json(await saveBug(env, body, who));
      }
      if (u.pathname === '/api/gasraw') {
        // 戰績同步：轉送 grandarchivestats 玩家頁原始 HTML，由手機解析（省 Worker 運算時間）
        let pid = (q.get('pid') || '').replace(/\D/g, '');
        if (gated(env) && !isAdmin(req, env)) { const m = await member(env, req.headers.get('X-GA-Key')); if (!m) return json({ error: '需要邀請碼', code: 'need-invite' }, 401); pid = String(m.pid); }
        if (!pid) return json({ error: '需要 pid' }, 400);
        const hits = await search(pid); const h = (hits || []).find(x => String(x.pid || '') === pid) || (hits || [])[0];
        if (!h || !h.slug) return json({ notFound: true });
        const html = await getText(GAS + '/players/' + h.slug, 1800);
        return new Response(html || '', { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-GA-Slug': encodeURIComponent(h.slug) } });
      }
      if (u.pathname === '/api/hist') {
        if (!env || !env.GA_KV) return json({ error: '伺服器沒有設定儲存空間' }, 400);
        let pid = (q.get('pid') || '').replace(/\D/g, '');
        if (!isAdmin(req, env)) { const m = gated(env) ? await member(env, req.headers.get('X-GA-Key')) : null; if (!m) return json({ error: '需要邀請碼', code: 'need-invite' }, 401); pid = String(m.pid); }
        if (!pid) return json({ error: '需要 pid' }, 400);
        if (req.method === 'POST') { const t = await req.text(); if (t.length > 2e6) return json({ error: '資料太大' }, 413); if (kvFull()) return json({ ok: false, later: true }); const ok = await env.GA_KV.put('hist:' + pid, t); return json({ ok, later: !ok }); }
        const t = await env.GA_KV.get('hist:' + pid); return json({ ok: true, data: t ? JSON.parse(t) : null });
      }
      if (DATA_ROUTES.includes(u.pathname) && gated(env) && !isAdmin(req, env)) {
        const m = await member(env, req.headers.get('X-GA-Key'));
        if (!m) return json({ error: '需要邀請碼：到「設定 → 會員」輸入邀請碼', code: 'need-invite' }, 401);
        // 11/02：會員只能查自己綁定的 GA 編號的配對（管理員不受限）
        const qp = (q.get('pid') || '').replace(/\D/g, '');
        if ((u.pathname === '/api/match' || u.pathname === '/api/report' || u.pathname === '/api/find') && m.pid && qp && qp !== String(m.pid))
          return json({ error: `你的邀請碼綁定 GA #${m.pid}，只能查自己的配對`, code: 'pid-locked', pid: m.pid }, 403);
      }
      if (u.pathname === '/api/season') {
        // 本季：拿最新一場賽事的 season（名稱、開始、結束），快取 12 小時
        const hit = memGet('season'); if (hit) return json(hit);
        let top = IDX_BASE; try { if (env && env.GA_KV) { const m = await idxMeta(env); if (m.lastId) top = m.lastId; } } catch (e) {}
        for (let id = top; id > top - 15; id--) {
          const e = await getJSON(OMNI + id, 0).catch(() => null);
          if (e && e.season && e.season.dateStart) { const out = { name: e.season.name || '', dateStart: e.season.dateStart, dateEnd: e.season.dateEnd || null, id: e.season.id || null }; memSet('season', out, 12 * 3600); return json(out); }
        }
        return json({ error: '抓不到本季資料' }, 502);
      }
      if (u.pathname === '/api/find') {
        if (!env || !env.GA_KV) return json({ indexReady: false });
        const pid = (q.get('pid') || '').replace(/\D/g, ''); if (!pid) return json({ error: '需要 pid' }, 400);
        const cc = (q.get('cc') || 'TW').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'TW';
        return json(await findEvents(env, pid, cc, (req.cf && req.cf.country) || '', Math.min(10, +(q.get('page') || 0) || 0)));
      }
      if (u.pathname === '/api/index/status' || u.pathname === '/api/index/build') {
        if (!env || !env.GA_KV) return json({ error: '還沒設定 GA_KV' }, 400);
        if (!isAdmin(req, env)) return json({ error: '管理員金鑰不對', code: 'not-admin' }, 401);
        if (u.pathname === '/api/index/status') { const m = await idxMeta(env); return json({ ...m, cron: !!(m.cronAt && Date.now() - new Date(m.cronAt).getTime() < 3 * 3600e3) }); }
        if (req.method !== 'POST') return json({ error: '要用 POST' }, 405);
        return await idxBuild(env, await readBody(req));
      }
      if (u.pathname === '/api/champions') {
        const r = json(await champions());
        r.headers.set('Cache-Control', 'public, max-age=86400');
        return r;
      }
      if (u.pathname === '/api/match') {
        const ev = (q.get('event') || '').match(/\d+/), pid = (q.get('pid') || '').match(/\d+/);
        if (!ev || !pid) return json({ error: '需要 event 和 pid' }, 400);
        const r = await findMatch(ev[0], pid[0]);
        // 對手也是 APP 會員時，帶上他加入時填的暱稱
        if (gated(env) && r && r.current && r.current.opp) { const nick = await nickOf(env, r.current.opp.id); if (nick) { r.current.opp.nick = nick; if (r.opponent) r.opponent.nick = nick; } }
        return json(r);
      }
      if (u.pathname === '/api/decks') {
        const ev = (q.get('event') || '').match(/\d+/);
        if (!ev) return json({ error: '需要 event' }, 400);
        return json(await decks(ev[0]));
      }
      if (u.pathname === '/api/report') {
        const ev = (q.get('event') || '').match(/\d+/), pid = (q.get('pid') || '').match(/\d+/);
        if (!ev || !pid) return json({ error: '需要 event 和 pid' }, 400);
        return json(await report(ev[0], pid[0]));
      }
      if (u.pathname === '/api/standings') {
        const ev = (q.get('event') || '').match(/\d+/);
        if (!ev) return json({ error: '需要 event' }, 400);
        return json(await standings(ev[0]));
      }
      if (u.pathname === '/api/player') {
        if (q.get('pid')) return json((await playerByPid(q.get('pid').replace(/\D/g, ''))) || { notFound: true });
        if (q.get('name')) return json((await playerBySlug(encodeURIComponent(q.get('name')))) || { notFound: true });
        return json({ error: '需要 pid 或 name' }, 400);
      }
      if (u.pathname === '/api/search') {
        const s = (q.get('q') || '').trim();
        if (s.length < 2) return json([]);
        return json(await search(s.replace(/^#/, '')));
      }
      return json({ ok: true, name: 'GA 比賽助手 API', routes: ['/api/status', '/api/join', '/api/me', '/api/match', '/api/decks', '/api/report', '/api/standings', '/api/player', '/api/search', '/api/champions', '/api/season', '/api/find', '/api/hist', '/api/gasraw', '/api/bug', '/api/index/*', '/api/admin/*（含 backups、backup、export、restore）'] });
    } catch (e) {
      return json({ error: e.message || String(e) }, 502);
    }
  },
  // 每小時排程（Cloudflare → ga-helper → 設定 → 觸發事件 → Cron 觸發條件：0 * * * *）
  async scheduled(event, env, ctx) { env = safeEnv(env); ctx.waitUntil(cronRun(env).then(() => weeklyBackup(env)).catch(() => {})); },
};
