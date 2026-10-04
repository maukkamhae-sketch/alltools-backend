/**
 * Sender Global: SATU nomor WhatsApp pusat (dipasang Owner) yang melayani banyak bot sewaan.
 *
 * Cara user memakainya:
 *   1. Chat pribadi ke nomor pusat:   .daftar <PIN bot>     -> nomor user jadi owner bot
 *   2. Masukkan nomor pusat ke grup
 *   3. Di grup, ketik:               .pasang                -> grup itu memakai bot user
 *   4. .lepas melepas grup, .status melihat masa sewa & jam aktif
 *
 * Di luar jam aktif (shared.globalStatus().online === false) bot hanya membalas
 * pemberitahuan istirahat (maks 1x per 30 menit per chat).
 *
 * Catatan: di mode Global, fitur yang bergantung chat pribadi pelanggan
 * (auto-reply, FAQ, deteksi pesanan, broadcast) tidak jalan, karena satu nomor
 * dipakai bersama dan tidak bisa tahu pelanggan itu milik bot yang mana.
 */
const fs = require('fs');
const path = require('path');
const { MAX_GLOBAL_CHATS, digits, clip, getText, isExpired, isCooling, markCool } = require('./util');
const { cleanConfig } = require('./config');
const { dirOf, getMeta, saverOf, allMetas } = require('./store');
const { send, groupInfo } = require('./messaging');
const { onMessage, onGroupUpdate } = require('./handler');
const { newRuntime, connect, stopSocket } = require('./session');
const shared = require('./shared');
const personal = require('./personal');

const GLOBAL_ID = '_global';
const SYSTEM_RE = /^\.(daftar|pasang|lepas|status)\b\s*(.*)$/i;
const OFF_NOTICE_EVERY = 30 * 60000;

let runtime = null; // koneksi WhatsApp pusat

/* ---------- state: nomor, owner terdaftar, grup terpasang ---------- */
const stateFile = () => path.join(dirOf(GLOBAL_ID), 'state.json');
let state = null;
function getState() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { state = null; }
  state = { phone: '', owners: {}, chats: {}, ...(state || {}) }; // owners: nomor -> {botId,userId}; chats: jid -> {botId,userId}
  return state;
}
function saveState() {
  fs.mkdirSync(dirOf(GLOBAL_ID), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(getState()));
}
const botOf = b => b && shared.db.getBotsForUser(b.userId).find(x => x.id === b.botId);
const chatCount = botId => Object.values(getState().chats).filter(x => x.botId === botId).length;

/* ---------- perintah sistem: .daftar .pasang .lepas .status ---------- */
const SYSTEM = {
  async daftar(c) {
    if (c.isGroup) {
      try { await runtime.sock.sendMessage(c.jid, { delete: c.m.key }); } catch (e) {}
      return c.reply('Kirim .daftar <PIN> lewat chat pribadi ke nomor ini, jangan di grup (PIN itu rahasia).');
    }
    const pin = c.arg.replace(/\D/g, '');
    if (!pin) return c.reply('Format: .daftar <PIN>\nPIN ada di menu Sewa Bot di aplikasi AllTools.');
    if (isCooling(runtime, 'pin:' + c.sender, 4000)) return c.reply('Pelan-pelan ya, tunggu beberapa detik.');
    markCool(runtime, 'pin:' + c.sender);
    const bot = shared.db.findBotByPin(pin);
    if (!bot || bot.senderMode !== 'global') return c.reply('PIN tidak ditemukan atau bukan bot Sender Global.');
    const meta = getMeta(bot);
    if (isExpired(meta)) return c.reply('Masa sewa bot ini sudah habis.');
    getState().owners[c.sender] = { botId: bot.id, userId: bot.userId };
    saveState();
    meta.config.owners = cleanConfig({ owners: [...meta.config.owners, c.sender] }, meta.config).owners;
    saverOf(meta)();
    return c.reply(`✅ Nomor kamu terdaftar sebagai owner bot *${meta.name}*.\n\nLangkah berikutnya: masukkan nomor ini ke grup, lalu ketik *.pasang* di grup itu.\nKetik ${meta.config.prefix}menu untuk daftar perintah.`);
  },

  async pasang(c) {
    if (!c.isGroup) return c.reply('.pasang dipakai di dalam grup. Masukkan nomor ini ke grupmu dulu.');
    const st = getState(), owner = st.owners[c.sender];
    if (!owner) return c.reply('Kamu belum terdaftar. Chat pribadi ke nomor ini: .daftar <PIN>');
    const bot = botOf(owner);
    if (!bot) return c.reply('Bot tidak ditemukan. Daftar ulang dengan .daftar <PIN>');
    const meta = getMeta(bot);
    if (isExpired(meta)) return c.reply('Masa sewa bot ini sudah habis.');
    const cur = st.chats[c.jid];
    if (cur && cur.botId === bot.id) return c.reply('Grup ini sudah memakai bot kamu. Ketik .menu');
    if (cur) return c.reply('Grup ini sudah dipakai bot lain. Pemiliknya harus ketik .lepas dulu.');
    if (chatCount(bot.id) >= MAX_GLOBAL_CHATS) return c.reply(`Satu bot maksimal ${MAX_GLOBAL_CHATS} grup. Lepas salah satu dengan .lepas.`);
    st.chats[c.jid] = { botId: bot.id, userId: bot.userId };
    saveState();
    return c.reply(`✅ Grup ini sekarang memakai bot *${meta.name}*.\nKetik ${meta.config.prefix}menu untuk daftar perintah.`);
  },

  async lepas(c) {
    if (!c.isGroup) return c.reply('.lepas dipakai di dalam grup.');
    const st = getState(), cur = st.chats[c.jid];
    if (!cur) return c.reply('Grup ini belum memasang bot.');
    let allowed = !!(st.owners[c.sender] && st.owners[c.sender].botId === cur.botId);
    if (!allowed) { try { allowed = (await groupInfo(runtime, c.jid)).admins.includes(c.sender); } catch (e) {} }
    if (!allowed) return c.reply('Hanya owner bot atau admin grup yang bisa melepas bot.');
    delete st.chats[c.jid];
    saveState();
    return c.reply('✅ Bot dilepas dari grup ini.');
  },

  async status(c) {
    const b = c.binding && botOf(c.binding);
    if (!b) return c.reply('Chat ini belum terhubung ke bot. Ketik .daftar <PIN> (chat pribadi) lalu .pasang (di grup).');
    const days = Math.max(0, Math.ceil((new Date(b.expiresAt).getTime() - Date.now()) / 86400000));
    const s = shared.globalStatus();
    const jam = s.windows.map(w => w.join('–')).join(', ');
    return c.reply(`*${b.name}*\nSisa masa sewa: ${days} hari\nJam aktif: ${jam} WIB\nSekarang: ${s.online ? 'aktif ✅' : 'istirahat 💤'}`);
  },
};

/* ---------- pesan masuk di nomor pusat ---------- */
function bindingFor(isGroup, jid, sender) {
  const st = getState();
  return isGroup ? st.chats[jid] : st.owners[sender];
}

async function onGlobalMessage(rt, m) {
  if (!m || !m.message || !m.key || m.key.fromMe) return;
  const jid = m.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
  if (rt.sentIds.has(m.key.id)) return;
  const text = getText(m).trim();
  if (!text) return;

  const isGroup = jid.endsWith('@g.us');
  const sender = digits(isGroup ? (m.key.participant || '') : jid);
  const binding = bindingFor(isGroup, jid, sender);
  const sys = SYSTEM_RE.exec(text);
  if (!sys && !binding) return; // chat tak dikenal: diam

  const bot = binding && botOf(binding);
  const meta = bot && getMeta(bot);
  const isCommand = !!sys || (meta && text.startsWith(meta.config.prefix));

  // jeda: balas pemberitahuan istirahat saja
  const status = shared.globalStatus();
  if (!status.online) {
    if (isCommand && !isCooling(rt, 'off:' + jid, OFF_NOTICE_EVERY)) {
      markCool(rt, 'off:' + jid);
      await send(rt, jid, { text: '💤 ' + status.offMessage }, m);
    }
    return;
  }

  if (sys) {
    const c = {
      m, jid, isGroup, sender, binding, arg: sys[2].trim(),
      reply: t => send(rt, jid, { text: clip(t, 3500) }, m),
    };
    return SYSTEM[sys[1].toLowerCase()](c);
  }
  if (!meta) return;
  return onMessage({ ...rt, meta, save: saverOf(meta) }, m);
}

async function onGlobalGroup(rt, ev) {
  const binding = getState().chats[ev.id];
  const bot = binding && botOf(binding);
  if (!bot || !shared.globalStatus().online) return;
  const meta = getMeta(bot);
  return onGroupUpdate({ ...rt, meta, save: saverOf(meta) }, ev);
}

/* ---------- koneksi nomor pusat ---------- */
async function start(pairPhone) {
  if (runtime) { runtime.stopped = true; try { runtime.sock.end(undefined); } catch (e) {} }
  return connect({
    authDir: path.join(dirOf(GLOBAL_ID), 'auth'),
    pairPhone,
    makeRuntime: sock => (runtime = newRuntime(sock)),
    onMessage: onGlobalMessage, onGroup: onGlobalGroup,
    onOpen: rt => { getState().phone = digits(rt.sock.user && rt.sock.user.id); saveState(); },
    onLoggedOut: () => { getState().phone = ''; saveState(); runtime = null; },
    isDead: () => false,
    reconnect: () => start(),
  });
}

function stop() {
  stopSocket(runtime, true);
  runtime = null;
  getState().phone = '';
  saveState();
  setTimeout(() => fs.rmSync(path.join(dirOf(GLOBAL_ID), 'auth'), { recursive: true, force: true }), 1500);
}

async function restore() {
  if (!getState().phone || !fs.existsSync(path.join(dirOf(GLOBAL_ID), 'auth', 'creds.json'))) return;
  try { await start(); } catch (e) { console.error('[bot-sender] gagal pulihkan sender global', e.message); }
}

/* ---------- data untuk aplikasi ---------- */
function adminState() {
  const st = getState();
  return {
    status: runtime ? runtime.status : 'idle', phone: st.phone, code: runtime && runtime.status === 'pairing' ? runtime.code : '',
    error: runtime ? runtime.err : '', chats: Object.keys(st.chats).length, owners: Object.keys(st.owners).length,
    schedule: shared.globalStatus(),
  };
}

function publicState(meta, bot) {
  const st = getState();
  const connected = runtime && runtime.status === 'connected';
  return {
    mode: 'global',
    status: isExpired(meta) ? 'expired' : (connected ? 'connected' : 'offline'),
    phone: st.phone, pin: bot.pin, schedule: shared.globalStatus(),
    registered: Object.values(st.owners).some(o => o.botId === bot.id),
    chats: chatCount(bot.id), maxChats: MAX_GLOBAL_CHATS,
    features: meta.features, config: meta.config, orders: [],
    stats: { contacts: 0, reminders: meta.data.reminders.length, orders: meta.data.orders.length },
  };
}

/* Pengingat bot Global: dikirim lewat nomor pusat, hanya saat jam aktif. */
async function tick() {
  if (!runtime || runtime.stopped || runtime.status !== 'connected' || !shared.globalStatus().online) return;
  for (const meta of allMetas()) {
    if (meta.mode !== 'global' || isExpired(meta) || !meta.features.includes('reminder')) continue;
    await personal.deliverReminders(runtime, meta);
  }
}

module.exports = { GLOBAL_ID, start, stop, restore, adminState, publicState, tick, getState, __test: { onGlobalMessage, setRuntime: r => { runtime = r; } } };
