// GA 比賽助手 — Cloudflare Worker（免費方案即可）
// 功能：轉接 Omnidex 配對與 grandarchivestats 玩家資料，加上 CORS 讓手機網頁可以讀。
//
// 路由：
//   /api/match?event=<賽事編號>&pid=<你的 GA 編號>   目前這輪的對手＋對手資料
//   /api/player?pid=<GA 編號>                       用編號查玩家
//   /api/player?name=<GAS 玩家名稱>                 用名稱查玩家
//   /api/search?q=<關鍵字>                          搜尋玩家（名稱或編號）
//   /api/champions                                  英雄卡列表（名稱、等級、生命、卡圖網址）
//   任何路由加 &fresh=1 會跳過快取，重新向 Omnidex／grandarchivestats 抓取

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
  return { name, slug, elo, events, featured: (events.find(e => e.deck) || {}).deck || '' };
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
          me: { score: me.score, status: me.status },
          opp: opp ? { id: opp.id, score: opp.score, status: opp.status } : null,
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
  let opponent = null;
  if (current && current.opp) {
    try { opponent = await playerByPid(current.opp.id); } catch (e) { opponent = { error: e.message }; }
    if (!opponent) opponent = { pid: current.opp.id, notFound: true };
  }
  return {
    event: { id: ev.id, name: ev.name, status: ev.status, date: ev.date, swissRounds: ev.swissRounds },
    record: rec, rounds, current, timer, opponent,
    fetchedAt: new Date().toISOString(),
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

// ---------- 路由 ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const q = u.searchParams;
    FRESH = q.get('fresh') === '1';
    try {
      if (u.pathname === '/api/champions') {
        const r = json(await champions());
        r.headers.set('Cache-Control', 'public, max-age=86400');
        return r;
      }
      if (u.pathname === '/api/match') {
        const ev = (q.get('event') || '').match(/\d+/), pid = (q.get('pid') || '').match(/\d+/);
        if (!ev || !pid) return json({ error: '需要 event 和 pid' }, 400);
        return json(await findMatch(ev[0], pid[0]));
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
      return json({ ok: true, name: 'GA 比賽助手 API', routes: ['/api/match', '/api/player', '/api/search', '/api/champions'] });
    } catch (e) {
      return json({ error: e.message || String(e) }, 502);
    }
  },
};
