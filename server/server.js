/**
 * 睡得好，做得好 — 遊戲伺服器
 *  1) 靜態網站（web/）
 *  2) 管理員系統（帳號、角色、session、登出登入）
 *  3) 問卷資料收集與匯出（需登入）
 *  4) 聯機房間（WebSocket，跨網絡，跨裝置）
 *
 * 啟動：node server.js  (預設 8080)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const WEB = path.join(ROOT, '..', 'web');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8080);
const SESSION_TTL = 1000 * 60 * 60 * 12;   // 12 小時

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

/* ------------------------------------------------------------------ *
 *  JSON 儲存（本機檔案 + 可選 Upstash Redis 雲端同步）
 *  部署到雲端時設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN，
 *  資料就會存在雲端，主機重啟或休眠都唔會唔見。
 * ------------------------------------------------------------------ */
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(UPSTASH_URL && UPSTASH_TOKEN);

const files = {
  users: path.join(DATA, 'users.json'),
  responses: path.join(DATA, 'responses.json'),
};
const cache = {};

function load(name, fallback) {
  if (cache[name]) return cache[name];
  try {
    cache[name] = JSON.parse(fs.readFileSync(files[name], 'utf8'));
  } catch (e) {
    cache[name] = fallback;
  }
  return cache[name];
}
function pushRemote(name) {
  if (!REMOTE) return;
  const body = JSON.stringify(['SET', 'sq:' + name, JSON.stringify(cache[name] || [])]);
  fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  }).catch(e => console.warn('[雲端] 寫入失敗', name, e.message));
}
function save(name) {
  try {
    const tmp = files[name] + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 2), 'utf8');
    fs.renameSync(tmp, files[name]);
  } catch (e) {
    /* 雲端唯讀檔案系統：忽略，只靠 Redis */
  }
  pushRemote(name);
}
async function hydrate() {
  if (!REMOTE) return;
  for (const name of ['users', 'responses']) {
    try {
      const r = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', 'sq:' + name]),
      });
      const j = await r.json();
      if (j && j.result) {
        cache[name] = JSON.parse(j.result);
        console.log(`[雲端] 已載入 ${name}：${cache[name].length} 筆`);
      }
    } catch (e) {
      console.warn(`[雲端] 載入 ${name} 失敗，改用本機檔案：${e.message}`);
    }
  }
}
const users = () => load('users', []);
const responses = () => load('responses', []);

/* ------------------------------------------------------------------ *
 *  密碼與 session
 * ------------------------------------------------------------------ */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

const sessions = new Map();           // sid -> {uid, exp}
const loginGuard = new Map();          // ip -> {n, until}

function newSession(uid) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { uid, exp: Date.now() + SESSION_TTL });
  return sid;
}
function sessionUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]{48})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  const u = users().find(x => x.id === s.uid);
  if (!u || u.active === false) return null;
  return { user: u, sid: m[1] };
}
function cookieHeader(sid, maxAge) {
  return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
const uid = () => crypto.randomBytes(6).toString('hex');
const nowISO = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 *  卡牌與房間（多人）
 * ------------------------------------------------------------------ */
const CARDS = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'data', 'cards.json'), 'utf8')).cards;
const byId = Object.fromEntries(CARDS.map(c => [c.id, c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
const MAIN_DECK = CARDS.filter(c => c.type !== 'disrupt').map(c => c.id);
const EVENTS = CARDS.filter(c => c.type === 'disrupt').map(c => c.id);

const rooms = new Map();   // code -> room

function newRoom(hostName) {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
  const room = {
    code, host: uid(), phase: 'lobby', night: 0, turn: 0,
    players: [], deck: [], event: null, eventDone: false, log: [], createdAt: Date.now(),
  };
  room.players.push({ id: room.host, name: hostName || '主持人', pts: 0, stars: 0, cycles: 0, hand: [], online: true });
  rooms.set(code, room);
  return room;
}
function roomView(room, playerId) {
  return {
    code: room.code, phase: room.phase, night: room.night, turn: room.turn,
    event: room.event, eventDone: room.eventDone,
    hostId: room.host, youId: playerId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, pts: p.pts, stars: p.stars, cycles: p.cycles,
      online: p.online, handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : undefined,
    })),
    log: room.log.slice(-12),
  };
}
function roomBroadcast(room) {
  for (const p of room.players) {
    const ws = clients.get(p.id);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: roomView(room, p.id) }));
  }
}
function draw(room, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) room.deck = shuffle(MAIN_DECK);
    out.push(room.deck.pop());
  }
  return out;
}
function logEvent(room, text) {
  room.log.push({ t: nowISO(), text });
  if (room.log.length > 60) room.log.shift();
}
function startNight(room) {
  room.event = EVENTS[room.night % EVENTS.length];
  room.eventDone = false;
  room.turn = 0;
  room.phase = 'play';
  logEvent(room, `第 ${room.night + 1} 夜開始｜事件：${byId[room.event].title}`);
  for (const p of room.players) p.hand = draw(room, 2);
  roomBroadcast(room);
}
function advanceTurn(room) {
  room.turn++;
  if (room.turn >= room.players.length) {
    room.night++;
    if (room.night >= 3) { room.phase = 'over'; logEvent(room, '三夜結束'); roomBroadcast(room); return; }
    startNight(room);
    return;
  }
  const p = room.players[room.turn];
  p.hand = draw(room, 2);
  roomBroadcast(room);
}

const clients = new Map();   // playerId -> ws

function roomAction(room, playerId, msg) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'not in room' };

  if (msg.type === 'start') {
    if (playerId !== room.host) return { error: '只有主持人可以開始' };
    if (room.players.length < 2) return { error: '至少需要 2 位玩家' };
    if (room.phase !== 'lobby') return { error: '已經開始' };
    room.deck = shuffle(MAIN_DECK);
    room.night = 0;
    startNight(room);
    return {};
  }

  if (msg.type === 'play') {
    if (room.phase !== 'play') return { error: '現在不能出牌' };
    const cur = room.players[room.turn];
    if (cur.id !== playerId) return { error: '未到你出牌' };
    const cardId = cur.hand[Number(msg.idx)];
    if (!cardId) return { error: '沒有這張牌' };
    const c = byId[cardId];
    cur.hand.splice(Number(msg.idx), 1);
    let note = '';

    if (c.type === 'action') {
      let add = 2;
      if (!room.eventDone && c.counter && c.counter.includes(c.id)) { room.eventDone = true; add += 1; }
      cur.pts += add; cur.cycles++;
      note = `${cur.name} 打出「${c.title}」+${add} 分`;
    } else if (c.type === 'maintain') {
      if (!room.eventDone) { room.eventDone = true; note = `${cur.name} 用「${c.title}」抵消今晚干擾`; }
      else { cur.pts += 2; note = `${cur.name} 打出「${c.title}」+2 分`; }
      cur.cycles++;
    } else if (c.type === 'skill') {
      cur.pts += 1; cur.stars++; cur.cycles++;
      note = `${cur.name} 完成技能「${c.title}」+1 分、+1 星`;
    } else if (c.type === 'myth') {
      room.pendingMyth = { player: playerId, card: cardId };
      note = `${cur.name} 抽到迷思卡`;
      roomBroadcast(room);
      return {};
    }
    logEvent(room, note);
    advanceTurn(room);
    return {};
  }

  if (msg.type === 'myth') {
    const pending = room.pendingMyth;
    if (!pending || pending.player !== playerId) return { error: '沒有待答的迷思卡' };
    const c = byId[pending.card];
    const correct = (msg.answer === c.answer);
    const p = room.players.find(x => x.id === playerId);
    if (correct) p.pts += 2;
    p.cycles++;
    logEvent(room, `${p.name} 答${correct ? '對' : '錯'}（正確答案：${c.answer ? '對' : '錯'}）${correct ? ' +2 分' : ''}`);
    room.pendingMyth = null;
    advanceTurn(room);
    return {};
  }

  if (msg.type === 'leave') return { error: 'left' };
  return { error: 'unknown action' };
}

/* ------------------------------------------------------------------ *
 *  HTTP
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/rooms') p = '/rooms.html';
  const file = path.join(WEB, path.normalize(p).replace(/^(\.\.[\\/])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const route = url.split('?')[0].replace(/\/$/, '') || '/';
  const ip = req.socket.remoteAddress || '?';

  try {
    /* ---------- 公開 API ---------- */
    if (route === '/api/health') {
      return json(res, 200, {
        ok: true, hasOwner: users().length > 0, responses: responses().length,
        rooms: rooms.size, storage: REMOTE ? 'cloud' : 'file',
      });
    }
    if (route === '/api/setup' && req.method === 'POST') {
      if (users().length) return json(res, 409, { error: '主管理員已存在' });
      const b = await readBody(req);
      const name = String(b.username || '').trim();
      const pw = String(b.password || '');
      if (name.length < 2) return json(res, 400, { error: '帳號至少 2 個字元' });
      if (pw.length < 8) return json(res, 400, { error: '密碼至少 8 個字元' });
      const { salt, hash } = hashPassword(pw);
      const u = { id: uid(), username: name, role: 'owner', salt, hash, active: true, created: nowISO(), lastLogin: null };
      users().push(u); save('users');
      const sid = newSession(u.id);
      return json(res, 200, { ok: true, user: { id: u.id, username: u.username, role: u.role } },
        { 'Set-Cookie': cookieHeader(sid, SESSION_TTL / 1000) });
    }
    if (route === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const g = loginGuard.get(ip) || { n: 0, until: 0 };
      if (g.until > Date.now()) return json(res, 429, { error: '嘗試次數過多，請稍後再試' });
      const u = users().find(x => x.username === String(b.username || '').trim());
      if (!u || u.active === false || !verifyPassword(String(b.password || ''), u.salt, u.hash)) {
        g.n++; if (g.n >= 6) { g.until = Date.now() + 60_000; g.n = 0; }
        loginGuard.set(ip, g);
        return json(res, 401, { error: '帳號或密碼不正確' });
      }
      loginGuard.delete(ip);
      u.lastLogin = nowISO(); save('users');
      const sid = newSession(u.id);
      return json(res, 200, { ok: true, user: { id: u.id, username: u.username, role: u.role } },
        { 'Set-Cookie': cookieHeader(sid, SESSION_TTL / 1000) });
    }
    if (route === '/api/logout' && req.method === 'POST') {
      const s = sessionUser(req);
      if (s) sessions.delete(s.sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (route === '/api/me') {
      const s = sessionUser(req);
      if (!s) return json(res, 401, { error: '未登入' });
      return json(res, 200, { user: { id: s.user.id, username: s.user.username, role: s.user.role } });
    }

    /* ---------- 問卷（公開提交） ---------- */
    if (route === '/api/responses' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || typeof b !== 'object') return json(res, 400, { error: '格式錯誤' });
      const rec = Object.assign({}, b, { id: uid(), receivedAt: nowISO(), ip: undefined });
      delete rec.ip;
      responses().push(rec); save('responses');
      return json(res, 200, { ok: true, id: rec.id });
    }

    /* ---------- 房間 API（公開，必須在需登入區塊之前） ---------- */
    if (route === '/api/rooms' && req.method === 'POST') {
      const b = await readBody(req);
      const room = newRoom(String(b.name || '').trim().slice(0, 12));
      return json(res, 200, { code: room.code, playerId: room.host });
    }
    const mRoomPub = route.match(/^\/api\/rooms\/(\d{6})$/);
    if (mRoomPub && req.method === 'GET') {
      const room = rooms.get(mRoomPub[1]);
      if (!room) return json(res, 404, { error: '房間不存在' });
      return json(res, 200, { code: room.code, phase: room.phase, players: room.players.map(p => p.name) });
    }

    /* ---------- 需登入 ---------- */
    if (route.startsWith('/api/')) {
      const s = sessionUser(req);
      if (!s) return json(res, 401, { error: '未登入' });
      const me = s.user;
      const isOwner = me.role === 'owner';
      const canWrite = me.role === 'owner' || me.role === 'admin';

      if (route === '/api/users' && req.method === 'GET') {
        if (!isOwner && me.role !== 'admin') return json(res, 403, { error: '沒有權限' });
        return json(res, 200, { users: users().map(u => ({ id: u.id, username: u.username, role: u.role, active: u.active !== false, created: u.created, lastLogin: u.lastLogin })) });
      }
      if (route === '/api/users' && req.method === 'POST') {
        if (!isOwner) return json(res, 403, { error: '只有主管理員可以建立帳號' });
        const b = await readBody(req);
        const name = String(b.username || '').trim();
        const pw = String(b.password || '');
        if (name.length < 2) return json(res, 400, { error: '帳號至少 2 個字元' });
        if (pw.length < 8) return json(res, 400, { error: '密碼至少 8 個字元' });
        if (users().some(u => u.username === name)) return json(res, 409, { error: '帳號已存在' });
        const { salt, hash } = hashPassword(pw);
        const u = { id: uid(), username: name, role: b.role === 'admin' ? 'admin' : 'viewer', salt, hash, active: true, created: nowISO(), lastLogin: null };
        users().push(u); save('users');
        return json(res, 200, { ok: true, user: { id: u.id, username: u.username, role: u.role } });
      }
      const mUser = route.match(/^\/api\/users\/([a-f0-9]+)$/);
      if (mUser && (req.method === 'PATCH' || req.method === 'DELETE')) {
        if (!isOwner) return json(res, 403, { error: '只有主管理員可以修改帳號' });
        const target = users().find(u => u.id === mUser[1]);
        if (!target) return json(res, 404, { error: '找不到帳號' });
        if (target.role === 'owner' && target.id !== me.id) return json(res, 403, { error: '不能修改其他主管理員' });
        if (req.method === 'DELETE') {
          if (target.id === me.id) return json(res, 400, { error: '不能刪除自己' });
          cache.users = users().filter(u => u.id !== target.id); save('users');
          return json(res, 200, { ok: true });
        }
        const b = await readBody(req);
        if (b.role && ['owner', 'admin', 'viewer'].includes(b.role)) target.role = b.role;
        if (typeof b.active === 'boolean') target.active = b.active;
        if (b.password) {
          if (String(b.password).length < 8) return json(res, 400, { error: '密碼至少 8 個字元' });
          const { salt, hash } = hashPassword(String(b.password));
          target.salt = salt; target.hash = hash;
        }
        save('users');
        return json(res, 200, { ok: true });
      }

      if (route === '/api/responses' && req.method === 'GET') {
        return json(res, 200, { responses: responses().slice().reverse() });
      }
      const mResp = route.match(/^\/api\/responses\/([a-f0-9]+)$/);
      if (mResp && req.method === 'DELETE') {
        if (!canWrite) return json(res, 403, { error: '沒有權限' });
        cache.responses = responses().filter(r => r.id !== mResp[1]); save('responses');
        return json(res, 200, { ok: true });
      }
      if (route === '/api/export.csv') {
        if (!canWrite) return json(res, 403, { error: '只有管理員可以匯出' });
        if (!responses().length) return json(res, 400, { error: '暫時沒有資料' });
        const keys = new Set();
        responses().forEach(r => Object.keys(r).forEach(k => keys.add(k)));
        const cols = ['receivedAt', 'mode', 'code', ...Array.from(keys).filter(k => !['receivedAt', 'mode', 'code', 'id'].includes(k)).sort()];
        const rows = [cols.join(',')].concat(responses().map(r => cols.map(c => csvEscape(r[c])).join(',')));
        const blob = '\ufeff' + rows.join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sleep_quest_${new Date().toISOString().slice(0, 10)}.csv"`,
        });
        return res.end(blob);
      }
      return json(res, 404, { error: 'not found' });
    }

    /* ---------- 靜態檔 ---------- */
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'server error' });
  }
});

/* ------------------------------------------------------------------ *
 *  WebSocket：聯機房間
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x');
  const code = q.searchParams.get('code');
  const name = (q.searchParams.get('name') || '玩家').slice(0, 12);
  const playerId = q.searchParams.get('pid') || uid();
  const room = rooms.get(code);
  if (!room) { ws.send(JSON.stringify({ type: 'error', error: '房間不存在' })); ws.close(); return; }

  if (!room.players.some(p => p.id === playerId)) {
    if (room.players.length >= 6) { ws.send(JSON.stringify({ type: 'error', error: '房間已滿（最多 6 人）' })); ws.close(); return; }
    if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', error: '遊戲已開始，無法加入' })); ws.close(); return; }
    room.players.push({ id: playerId, name, pts: 0, stars: 0, cycles: 0, hand: [], online: true });
    logEvent(room, `${name} 加入房間`);
  }
  room.players.find(p => p.id === playerId).online = true;
  clients.set(playerId, ws);
  ws.send(JSON.stringify({ type: 'hello', playerId, code }));
  roomBroadcast(room);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const r = roomAction(room, playerId, msg);
    if (r && r.error) ws.send(JSON.stringify({ type: 'error', error: r.error }));
  });

  ws.on('close', () => {
    clients.delete(playerId);
    const p = room.players.find(x => x.id === playerId);
    if (p) { p.online = false; roomBroadcast(room); }
    if (room.players.every(x => !x.online) && room.phase === 'lobby') {
      setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.players.every(x => !x.online)) rooms.delete(code);
      }, 1000 * 60 * 30);
    }
  });
});

/* ------------------------------------------------------------------ *
 *  定期清理
 * ------------------------------------------------------------------ */
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k);
  for (const [k, r] of rooms) if (t - r.createdAt > 1000 * 60 * 60 * 6) rooms.delete(k);
}, 60_000).unref?.();

(async () => {
  await hydrate();
  server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log('');
    console.log('  睡得好，做得好 — 伺服器已啟動');
    console.log('  ------------------------------------------------');
    console.log(`  本機：  http://127.0.0.1:${PORT}/`);
    ips.forEach(ip => console.log(`  手機：  http://${ip}:${PORT}/`));
    console.log(`  後台：  http://127.0.0.1:${PORT}/admin`);
    console.log(`  房間：  http://127.0.0.1:${PORT}/rooms`);
    console.log('  ------------------------------------------------');
    console.log(`  資料儲存：${REMOTE ? '雲端（Upstash Redis）' : '本機檔案'}`);
    console.log(`  主管理員：${users().length ? '已建立' : '尚未建立（開啟 /admin 設定）'}`);
    console.log('');
  });
})();
