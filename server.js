// โปรแกรมจัดคิวเพลงจาก TikTok Live
// รัน: node server.js  แล้วเปิด http://localhost:3939
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3939;
// ตอนเป็น .exe ให้เก็บไฟล์ไว้ข้างๆ ตัวโปรแกรม
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_FILE = path.join(BASE_DIR, 'queue-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- ข้อมูล ----------
let state = {
  settings: {
    username: '',
    keywords: ['ขอเพลง', '!song', '!ขอ'],
    maxPerUser: 2,          // ขอได้กี่เพลงต่อคนในคิว (0 = ไม่จำกัด)
    blockDuplicate: true,   // ห้ามขอเพลงซ้ำที่อยู่ในคิวแล้ว
    autoAccept: true,       // false = ต้องกดอนุมัติก่อนเข้าคิว
  },
  nowPlaying: null,
  queue: [],    // { id, song, user, nickname, time, status: 'queued' | 'pending' }
  history: [],
  log: [],
};

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = { ...state, ...saved, settings: { ...state.settings, ...saved.settings }, log: [] };
  } catch { /* ยังไม่มีไฟล์ */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { log, ...rest } = state;
    fs.writeFile(DATA_FILE, JSON.stringify(rest, null, 2), () => {});
  }, 300);
}
load();

let conn = null;
let live = { status: 'offline', message: 'ยังไม่ได้เชื่อมต่อ' };
let nextId = Date.now();

// ---------- ส่งข้อมูลอัปเดตให้หน้าเว็บแบบเรียลไทม์ (SSE) ----------
const clients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify({ ...state, live })}\n\n`;
  for (const res of clients) res.write(payload);
  save();
}
function addLog(text, type = 'info') {
  state.log.unshift({ text, type, time: Date.now() });
  state.log = state.log.slice(0, 80);
}

// ---------- แยกชื่อเพลงจากแชท ----------
function normalize(s) { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }

function extractSong(comment) {
  const text = comment.trim();
  const lower = text.toLowerCase();
  for (const kw of state.settings.keywords) {
    const k = kw.trim().toLowerCase();
    if (!k) continue;
    const idx = lower.indexOf(k);
    if (idx !== -1) {
      let song = text.slice(idx + k.length).replace(/^[\s:：\-–—,]+/, '').trim();
      // ตัดคำลงท้ายและอีโมจิ เช่น "ลมหนาว ค่ะ 🙏" → "ลมหนาว"
      for (let i = 0; i < 3; i++) {
        song = song
          .replace(/[\p{Extended_Pictographic}‍️]+$/u, '').trim()
          .replace(/\s+(หน่อย|ด้วย|นะ|ค่ะ|คะ|ครับ|คับ|ฮะ|จ้า|จ้ะ|จ่ะ|ค่า|งับ|เด้อ|พี่)+[!~.]*$/u, '').trim();
      }
      if (/^(หน่อย|ด้วย|นะ|ค่ะ|คะ|ครับ|คับ|ฮะ|จ้า|จ้ะ|ค่า|งับ|เด้อ|พี่|ได้ไหม|ได้มั้ย)*[\s!?~.]*$/u.test(song)) return null;
      return song;
    }
  }
  return null;
}

function handleChat({ uniqueId, nickname, comment }) {
  const song = extractSong(comment || '');
  if (!song) return { ok: false, reason: 'ไม่ใช่ข้อความขอเพลง' };
  return addRequest(song, uniqueId, nickname, 'chat');
}

function addRequest(song, user, nickname, source) {
  song = song.slice(0, 120);
  const s = state.settings;
  if (s.blockDuplicate) {
    const n = normalize(song);
    const dup = state.queue.find(q => normalize(q.song) === n) ||
                (state.nowPlaying && normalize(state.nowPlaying.song) === n);
    if (dup) {
      addLog(`⛔ ${nickname || user}: "${song}" มีในคิวแล้ว`, 'warn');
      broadcast();
      return { ok: false, reason: 'เพลงนี้อยู่ในคิวแล้ว' };
    }
  }
  if (source === 'chat' && s.maxPerUser > 0) {
    const count = state.queue.filter(q => q.user === user).length;
    if (count >= s.maxPerUser) {
      addLog(`⛔ ${nickname || user} ขอครบ ${s.maxPerUser} เพลงแล้ว`, 'warn');
      broadcast();
      return { ok: false, reason: 'ขอเกินจำนวนที่กำหนด' };
    }
  }
  const item = {
    id: String(nextId++), song, user: user || 'vj', nickname: nickname || user || 'VJ',
    time: Date.now(), status: (source === 'chat' && !s.autoAccept) ? 'pending' : 'queued',
  };
  state.queue.push(item);
  addLog(`🎵 ${item.nickname} ขอ "${song}"${item.status === 'pending' ? ' (รออนุมัติ)' : ''}`, 'ok');
  broadcast();
  return { ok: true, item };
}

// ---------- เชื่อมต่อ TikTok Live ----------
function getLib() {
  try { return require('tiktok-live-connector'); }
  catch { return null; }
}

async function connectLive(username) {
  await disconnectLive();
  username = username.replace(/^@/, '').trim();
  if (!username) throw new Error('ใส่ชื่อผู้ใช้ TikTok ก่อน');
  const lib = getLib();
  if (!lib) throw new Error('ยังไม่ได้ติดตั้ง tiktok-live-connector (รัน npm install)');
  const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection;
  state.settings.username = username;
  live = { status: 'connecting', message: `กำลังเชื่อมต่อ @${username}...` };
  broadcast();

  conn = new Conn(username);
  conn.on('chat', (d) => {
    const u = d.user || d;
    handleChat({ uniqueId: u.uniqueId, nickname: u.nickname, comment: d.comment });
  });
  const onEnd = (why) => {
    live = { status: 'offline', message: why };
    addLog(`🔌 ${why}`, 'warn');
    broadcast();
  };
  conn.on('streamEnd', () => onEnd('ไลฟ์จบแล้ว'));
  conn.on('disconnected', () => { if (live.status === 'online') onEnd('หลุดการเชื่อมต่อ'); });

  try {
    await conn.connect();
    live = { status: 'online', message: `เชื่อมต่อ @${username} แล้ว` };
    addLog(`✅ เชื่อมต่อไลฟ์ @${username} แล้ว`, 'ok');
  } catch (err) {
    conn = null;
    live = { status: 'offline', message: 'เชื่อมต่อไม่ได้ — ต้องกำลังไลฟ์อยู่ และชื่อผู้ใช้ถูกต้อง' };
    addLog(`❌ เชื่อมต่อไม่ได้: ${err && err.message ? err.message : err}`, 'warn');
  }
  broadcast();
}

async function disconnectLive() {
  if (conn) { try { conn.disconnect(); } catch {} conn = null; }
  live = { status: 'offline', message: 'ยกเลิกการเชื่อมต่อแล้ว' };
}

// ---------- คำสั่งจัดการคิว ----------
const actions = {
  connect: async (b) => connectLive(b.username || ''),
  disconnect: async () => { await disconnectLive(); addLog('🔌 ยกเลิกการเชื่อมต่อ'); },
  add: async (b) => addRequest(String(b.song || '').trim(), 'vj', b.nickname || 'VJ', 'manual'),
  testChat: async (b) => handleChat({ uniqueId: b.user || 'tester', nickname: b.user || 'ทดสอบ', comment: String(b.comment || '') }),
  next: async () => {
    if (state.nowPlaying) state.history.unshift({ ...state.nowPlaying, doneAt: Date.now() });
    const idx = state.queue.findIndex(q => q.status === 'queued');
    state.nowPlaying = idx === -1 ? null : state.queue.splice(idx, 1)[0];
    state.history = state.history.slice(0, 200);
  },
  play: async (b) => {
    const idx = state.queue.findIndex(q => q.id === b.id);
    if (idx === -1) return;
    if (state.nowPlaying) state.history.unshift({ ...state.nowPlaying, doneAt: Date.now() });
    state.nowPlaying = state.queue.splice(idx, 1)[0];
  },
  approve: async (b) => { const q = state.queue.find(x => x.id === b.id); if (q) q.status = 'queued'; },
  remove: async (b) => { state.queue = state.queue.filter(q => q.id !== b.id); },
  move: async (b) => {
    const i = state.queue.findIndex(q => q.id === b.id);
    const j = b.dir === 'top' ? 0 : i + (b.dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= state.queue.length) return;
    const [item] = state.queue.splice(i, 1);
    state.queue.splice(j, 0, item);
  },
  edit: async (b) => { const q = state.queue.find(x => x.id === b.id); if (q && b.song) q.song = String(b.song).slice(0, 120); },
  finishCurrent: async () => {
    if (state.nowPlaying) state.history.unshift({ ...state.nowPlaying, doneAt: Date.now() });
    state.nowPlaying = null;
  },
  requeue: async (b) => {
    const h = state.history.find(x => x.id === b.id);
    if (h) addRequest(h.song, h.user, h.nickname, 'manual');
  },
  clearQueue: async () => { state.queue = []; addLog('🧹 ล้างคิวแล้ว'); },
  clearHistory: async () => { state.history = []; },
  settings: async (b) => {
    const s = state.settings;
    if (Array.isArray(b.keywords)) s.keywords = b.keywords.map(k => String(k).trim()).filter(Boolean);
    if (b.maxPerUser !== undefined) s.maxPerUser = Math.max(0, parseInt(b.maxPerUser) || 0);
    if (b.blockDuplicate !== undefined) s.blockDuplicate = !!b.blockDuplicate;
    if (b.autoAccept !== undefined) s.autoAccept = !!b.autoAccept;
  },
};

// ---------- เว็บเซิร์ฟเวอร์ ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ ...state, live })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const name = url.pathname.slice(5);
      try {
        const data = body ? JSON.parse(body) : {};
        if (!actions[name]) throw new Error('ไม่รู้จักคำสั่ง');
        const result = await actions[name](data);
        broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result || { ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: err.message }));
      }
    });
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname === '/overlay' ? '/overlay.html' : url.pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================');
  console.log('  🎵 โปรแกรมจัดคิวเพลง TikTok Live');
  console.log(`  หน้าจัดการคิว : ${url}`);
  console.log(`  หน้า Overlay  : ${url}/overlay  (ใส่ใน OBS / TikTok LIVE Studio)`);
  console.log('  ปิดหน้าต่างนี้ = ปิดโปรแกรม');
  console.log('==============================================');
  if (!getLib()) console.log('⚠️  ยังไม่ได้ติดตั้ง tiktok-live-connector — ใช้ได้เฉพาะโหมดทดสอบ');
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${url}"`);
});
