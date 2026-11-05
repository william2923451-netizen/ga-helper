// =====================================================================
// GA 比賽助手：推播分身（ga-push）11/05
// 只做一件事：幫主 Worker（ga-helper）加密並送出推播。
// 沒有公開網址（wrangler-push.toml 設 workers_dev = false），只有 ga-helper 透過綁定（PUSHER）叫得到。
// 主 Worker 同時叫好幾個分身，每個分身送幾則，所以朋友很多時也能在同一分鐘送完。
// 金鑰（VAPID）跟主 Worker 共用：讀同一個 KV 的 push:vapid（主 Worker 第一次開推播時建立）。
// =====================================================================
const PER_CALL_MAX = 4; // 每次最多送 4 則（每則約 1.5 毫秒運算，留在 10 毫秒內）

const b64u = buf => { const b = new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = str => { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const b = atob(str); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const cat = (...arrs) => { const n = arrs.reduce((a, x) => a + x.length, 0), out = new Uint8Array(n); let o = 0; for (const x of arrs) { out.set(x, o); o += x.length; } return out; };
const enc = new TextEncoder();
const MEM = new Map();
const memGet = k => { const v = MEM.get(k); if (!v || v.exp < Date.now()) return undefined; return v.val; };
const memSet = (k, val, sec) => MEM.set(k, { val, exp: Date.now() + sec * 1000 });

async function vapidKeys(env) {
  const hit = memGet('vapid'); if (hit) return hit;
  const k = await env.GA_KV.get('push:vapid', 'json');
  if (!k) throw new Error('no-vapid');
  const priv = await crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const out = { priv, pub: k.pub }; memSet('vapid', out, 3600); return out;
}
async function vapidAuth(env, endpoint, nocache) {
  const aud = new URL(endpoint).origin, ck = 'vjwt:' + aud, hit = !nocache && memGet(ck); if (hit) return hit;
  const v = await vapidKeys(env), exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))), body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: 'https://william2923451-netizen.github.io/ga-helper/' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.priv, enc.encode(head + '.' + body));
  const h = `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`; memSet(ck, h, 11 * 3600); return h;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
// RFC 8291（aes128gcm）加密，跟主 Worker 的 encryptPush 一樣
async function encryptPush(sub, payload) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
// 送一則；回傳 'ok' | 'gone'（訂閱失效）| 'fail'
async function sendPush(env, sub, payload) {
  try {
    const body = await encryptPush(sub, payload);
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '1800', Urgency: 'high' }, body });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'fail';
  } catch (e) { return 'fail'; }
}
// 檢測用：做跟真的送一樣多的加密運算，但不送出去（看 Cloudflare 會不會讓每個分身各自有 10 毫秒）
async function probe(env, n) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sub = { endpoint: 'https://probe.invalid/x', keys: { p256dh: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
  for (let i = 0; i < n; i++) await encryptPush(sub, { title: 'probe', body: 'x'.repeat(60) });
  await vapidAuth(env, sub.endpoint, true);
}
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method !== 'POST') return json({ ok: true, name: 'ga-push' });
    let b = {}; try { b = await req.json(); } catch (e) {}
    try {
      if (u.pathname === '/send') {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, PER_CALL_MAX);
        const res = await Promise.all(items.map(x => sendPush(env, x.sub, x.payload))); // 加密照順序跑，等網路回應時一起等
        return json({ ok: true, res });
      }
      if (u.pathname === '/probe') { await probe(env, Math.min(PER_CALL_MAX, +b.n || PER_CALL_MAX)); return json({ ok: true }); }
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};
