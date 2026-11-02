// โปรแกรมจัดคิวเพลง TikTok Live — ทำงานในเบราว์เซอร์ทั้งหมด (สำหรับ GitHub Pages)
// ดึงแชทไลฟ์ผ่าน Euler Stream WebSocket: https://www.eulerstream.com

const STORE_KEY = 'songqueue-v1';
const KEY_KEY = 'songqueue-apikey';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('songqueue') : null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? 'เมื่อกี้' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม.ที่แล้ว`; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- ข้อมูล ----------
let S = {
  settings: { username: '', keywords: ['ขอเพลง', '!song', '!ขอ'], maxPerUser: 2, blockDuplicate: true, autoAccept: true },
  nowPlaying: null, queue: [], history: [], log: [],
};
try {
  const saved = JSON.parse(store.get(STORE_KEY) || 'null');
  if (saved) S = { ...S, ...saved, settings: { ...S.settings, ...saved.settings }, log: [] };
} catch {}
let live = { status: 'offline', message: 'ยังไม่ได้เชื่อมต่อ' };
let nextId = Date.now();

function commit() {
  const { log, ...rest } = S;
  store.set(STORE_KEY, JSON.stringify(rest));
  if (channel) channel.postMessage({ nowPlaying: S.nowPlaying, queue: S.queue, keywords: S.settings.keywords });
  render();
}
function addLog(text, type = 'info') { S.log.unshift({ text, type }); S.log = S.log.slice(0, 80); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200); }

// ---------- แยกชื่อเพลงจากแชท ----------
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const PARTICLES = 'หน่อย|ด้วย|นะ|ค่ะ|คะ|ครับ|คับ|ฮะ|จ้า|จ้ะ|จ่ะ|ค่า|งับ|เด้อ|พี่';

function extractSong(comment) {
  const text = comment.trim();
  const lower = text.toLowerCase();
  for (const kw of S.settings.keywords) {
    const k = kw.trim().toLowerCase();
    if (!k) continue;
    const idx = lower.indexOf(k);
    if (idx === -1) continue;
    let song = text.slice(idx + k.length).replace(/^[\s:：\-–—,]+/, '').trim();
    for (let i = 0; i < 3; i++) {
      song = song.replace(/[\p{Extended_Pictographic}‍️]+$/u, '').trim()
        .replace(new RegExp(`\\s+(${PARTICLES})+[!~.]*$`, 'u'), '').trim();
    }
    if (new RegExp(`^(${PARTICLES}|ได้ไหม|ได้มั้ย)*[\\s!?~.]*$`, 'u').test(song)) return null;
    return song;
  }
  return null;
}

function handleChat(uniqueId, nickname, comment) {
  const song = extractSong(comment || '');
  if (!song) return { ok: false, reason: 'ไม่ใช่ข้อความขอเพลง' };
  return addRequest(song, uniqueId, nickname, 'chat');
}

function addRequest(song, user, nickname, source) {
  song = song.slice(0, 120);
  const s = S.settings;
  if (s.blockDuplicate) {
    const n = normalize(song);
    if (S.queue.some(q => normalize(q.song) === n) || (S.nowPlaying && normalize(S.nowPlaying.song) === n)) {
      addLog(`⛔ ${nickname || user}: "${song}" มีในคิวแล้ว`, 'warn'); commit();
      return { ok: false, reason: 'เพลงนี้อยู่ในคิวแล้ว' };
    }
  }
  if (source === 'chat' && s.maxPerUser > 0 && S.queue.filter(q => q.user === user).length >= s.maxPerUser) {
    addLog(`⛔ ${nickname || user} ขอครบ ${s.maxPerUser} เพลงแล้ว`, 'warn'); commit();
    return { ok: false, reason: 'ขอเกินจำนวนที่กำหนด' };
  }
  const item = {
    id: String(nextId++), song, user: user || 'vj', nickname: nickname || user || 'VJ', time: Date.now(),
    status: source === 'chat' && !s.autoAccept ? 'pending' : 'queued',
  };
  S.queue.push(item);
  addLog(`🎵 ${item.nickname} ขอ "${song}"${item.status === 'pending' ? ' (รออนุมัติ)' : ''}`, 'ok');
  commit();
  return { ok: true };
}

// ---------- เชื่อมต่อ TikTok Live ผ่าน Euler Stream ----------
let ws = null, wantLive = false, retry = 0, retryTimer = null;

function setLive(status, message) { live = { status, message }; render(); }

function connectLive() {
  const username = $('username').value.replace(/^@/, '').trim();
  const key = store.get(KEY_KEY);
  if (!username) return toast('ใส่ชื่อผู้ใช้ TikTok ก่อน');
  if (!key) { $('setup').style.display = ''; $('apiKey').focus(); return toast('ใส่ API Key ก่อน'); }
  S.settings.username = username; commit();
  wantLive = true; retry = 0;
  openSocket(username, key);
}

function openSocket(username, key) {
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  setLive('connecting', `กำลังเชื่อมต่อ @${username}...`);
  const url = `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(username)}&apiKey=${encodeURIComponent(key)}`;
  try { ws = new WebSocket(url); } catch (e) { return setLive('offline', 'เชื่อมต่อไม่ได้'); }

  ws.onopen = () => {
    retry = 0;
    setLive('online', `เชื่อมต่อ @${username} แล้ว`);
    addLog(`✅ เชื่อมต่อไลฟ์ @${username} แล้ว`, 'ok'); commit();
  };
  ws.onmessage = (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [data];
    for (const m of list) {
      const type = String(m?.type || m?.event || '').toLowerCase();
      if (!type.includes('chat')) continue;
      const d = m.data || m;
      const u = d.user || m.user || {};
      const comment = d.comment ?? d.content ?? m.comment ?? '';
      handleChat(u.uniqueId || u.unique_id || u.userId || 'viewer', u.nickname || u.nickName || u.uniqueId || 'คนดู', comment);
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (!wantLive) return setLive('offline', 'ยกเลิกการเชื่อมต่อแล้ว');
    // 4xxx = ปฏิเสธจากเซิร์ฟเวอร์ (key ผิด / ไม่ได้ไลฟ์) — ไม่ต้องลองใหม่ถี่ๆ
    const reason = ev.reason || (ev.code >= 4000 ? 'ถูกปฏิเสธ (เช็ค API Key / ต้องกำลังไลฟ์)' : 'หลุดการเชื่อมต่อ');
    addLog(`🔌 ${reason} [${ev.code}]`, 'warn');
    if (retry >= 5) { wantLive = false; commit(); return setLive('offline', reason); }
    const wait = Math.min(30, 3 * 2 ** retry++);
    setLive('connecting', `${reason} — ลองใหม่ใน ${wait} วินาที`);
    commit();
    retryTimer = setTimeout(() => openSocket(username, key), wait * 1000);
  };
}

function disconnectLive() {
  wantLive = false; clearTimeout(retryTimer);
  if (ws) ws.close(); else setLive('offline', 'ยกเลิกการเชื่อมต่อแล้ว');
  addLog('🔌 ยกเลิกการเชื่อมต่อ'); commit();
}

// ---------- คำสั่งจัดการคิว ----------
function pushHistory() { if (S.nowPlaying) S.history.unshift({ ...S.nowPlaying, doneAt: Date.now() }); S.history = S.history.slice(0, 200); }
const actions = {
  next() { pushHistory(); const i = S.queue.findIndex(q => q.status === 'queued'); S.nowPlaying = i === -1 ? null : S.queue.splice(i, 1)[0]; },
  finishCurrent() { pushHistory(); S.nowPlaying = null; },
  play(id) { const i = S.queue.findIndex(q => q.id === id); if (i < 0) return; pushHistory(); S.nowPlaying = S.queue.splice(i, 1)[0]; },
  approve(id) { const q = S.queue.find(x => x.id === id); if (q) q.status = 'queued'; },
  remove(id) { S.queue = S.queue.filter(q => q.id !== id); },
  move(id, dir) {
    const i = S.queue.findIndex(q => q.id === id);
    const j = dir === 'top' ? 0 : i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= S.queue.length) return;
    const [it] = S.queue.splice(i, 1); S.queue.splice(j, 0, it);
  },
  edit(id) { const q = S.queue.find(x => x.id === id); const v = q && prompt('แก้ชื่อเพลง', q.song); if (v) q.song = v.slice(0, 120); },
  requeue(id) { const h = S.history.find(x => x.id === id); if (h) addRequest(h.song, h.user, h.nickname, 'manual'); },
};

// ---------- แสดงผล ----------
function render() {
  $('dot').className = 'dot ' + live.status;
  $('liveMsg').textContent = live.message;
  $('connectBtn').textContent = live.status === 'offline' ? 'เชื่อมต่อ' : 'ยกเลิก';

  $('now').innerHTML = S.nowPlaying
    ? `<div class="song">${esc(S.nowPlaying.song)}</div><div class="by">ขอโดย ${esc(S.nowPlaying.nickname)}</div>`
    : `<div class="song" style="color:var(--muted)">— ยังไม่มีเพลง —</div><div class="by">กด "เพลงถัดไป" เพื่อเริ่มคิว</div>`;

  $('qCount').textContent = S.queue.length;
  $('queue').innerHTML = S.queue.length ? S.queue.map((q, i) => `
    <li class="item ${q.status}">
      <div class="num">${i + 1}</div>
      <div><div class="song-name">${esc(q.song)} ${q.status === 'pending' ? '<span class="tag">รออนุมัติ</span>' : ''}</div>
        <div class="meta">${esc(q.nickname)} · ${ago(q.time)}</div></div>
      <div class="acts">
        ${q.status === 'pending' ? `<button data-a="approve" data-id="${q.id}" title="อนุมัติ">✔</button>` : ''}
        <button data-a="play" data-id="${q.id}" title="เล่นเลย">▶</button>
        <button data-a="top" data-id="${q.id}" title="ขึ้นบนสุด">⤒</button>
        <button data-a="up" data-id="${q.id}" title="ขึ้น">↑</button>
        <button data-a="down" data-id="${q.id}" title="ลง">↓</button>
        <button data-a="edit" data-id="${q.id}" title="แก้ชื่อเพลง">✎</button>
        <button data-a="remove" data-id="${q.id}" title="ลบ">✕</button>
      </div></li>`).join('') : '<div class="empty">ยังไม่มีคนขอเพลง</div>';

  $('hCount').textContent = S.history.length;
  $('history').innerHTML = S.history.slice(0, 50).map(h => `
    <li class="item"><div class="num">✓</div>
      <div><div class="song-name">${esc(h.song)}</div><div class="meta">${esc(h.nickname)}</div></div>
      <div class="acts"><button data-a="requeue" data-id="${h.id}" title="ใส่คิวอีกครั้ง">↺</button></div></li>`).join('');

  $('chips').innerHTML = S.settings.keywords.map((k, i) => `<span class="chip">${esc(k)}<button data-kw="${i}" title="ลบ">×</button></span>`).join('');
  if (document.activeElement !== $('maxPerUser')) $('maxPerUser').value = S.settings.maxPerUser;
  $('blockDuplicate').checked = S.settings.blockDuplicate;
  $('autoAccept').checked = S.settings.autoAccept;
  $('log').innerHTML = S.log.map(l => `<div class="${l.type}">${esc(l.text)}</div>`).join('') || '<div class="meta">—</div>';
}

// ---------- ปุ่มต่างๆ ----------
$('username').value = S.settings.username ? '@' + S.settings.username : '';
$('setup').style.display = store.get(KEY_KEY) ? 'none' : '';
$('saveKey').onclick = () => {
  const k = $('apiKey').value.trim(); if (!k) return;
  store.set(KEY_KEY, k); $('apiKey').value = ''; $('setup').style.display = 'none'; toast('บันทึก API Key แล้ว');
};
$('changeKey').onclick = () => { $('setup').style.display = ''; $('apiKey').focus(); };
$('connectBtn').onclick = () => live.status === 'offline' ? connectLive() : disconnectLive();
$('username').onkeydown = (e) => { if (e.key === 'Enter') $('connectBtn').click(); };
$('nextBtn').onclick = () => { actions.next(); commit(); };
$('finishBtn').onclick = () => { actions.finishCurrent(); commit(); };
$('clearBtn').onclick = () => { if (confirm('ล้างคิวทั้งหมด?')) { S.queue = []; addLog('🧹 ล้างคิวแล้ว'); commit(); } };
$('addForm').onsubmit = (e) => {
  e.preventDefault(); const v = $('addSong').value.trim();
  if (v) { const r = addRequest(v, 'vj', 'VJ', 'manual'); if (!r.ok) toast(r.reason); }
  $('addSong').value = '';
};
$('testForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('testUser').value || 'ทดสอบ';
  const r = handleChat(name, name, $('testMsg').value);
  toast(r.ok ? 'เข้าคิวแล้ว' : r.reason);
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (b) {
    const { a, id } = b.dataset;
    if (['top', 'up', 'down'].includes(a)) actions.move(id, a); else actions[a](id);
    return commit();
  }
  const k = e.target.closest('button[data-kw]');
  if (k) { S.settings.keywords = S.settings.keywords.filter((_, i) => i != k.dataset.kw); commit(); }
});
$('kwForm').onsubmit = (e) => { e.preventDefault(); const v = $('kwInput').value.trim(); if (v) S.settings.keywords.push(v); $('kwInput').value = ''; commit(); };
$('maxPerUser').onchange = () => { S.settings.maxPerUser = Math.max(0, parseInt($('maxPerUser').value) || 0); commit(); };
$('blockDuplicate').onchange = () => { S.settings.blockDuplicate = $('blockDuplicate').checked; commit(); };
$('autoAccept').onchange = () => { S.settings.autoAccept = $('autoAccept').checked; commit(); };
$('openOverlay').onclick = () => window.open('overlay.html', 'overlay-songqueue', 'width=500,height=560');

// overlay ขอข้อมูลล่าสุดตอนเปิด
if (channel) channel.onmessage = (e) => { if (e.data === 'hello') commit(); };
window.addEventListener('beforeunload', (e) => { if (wantLive) { e.preventDefault(); e.returnValue = ''; } });
setInterval(render, 30000);
render();
