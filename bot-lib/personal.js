/**
 * Sender Personal: tiap bot punya nomor WhatsApp sendiri (dipasang user lewat kode pairing).
 */
const fs = require('fs');
const path = require('path');
const { sleep, isExpired } = require('./util');
const { dirOf, loadMeta, writeMeta, saverOf } = require('./store');
const { send } = require('./messaging');
const { onMessage, onGroupUpdate } = require('./handler');
const { newRuntime, connect, stopSocket } = require('./session');

const runtimes = new Map(); // botId -> runtime
const digitsOf = require('./util').digits;

async function start(meta, pairPhone) {
  const old = runtimes.get(meta.id);
  if (old) { old.stopped = true; try { old.sock.end(undefined); } catch (e) {} }

  return connect({
    authDir: path.join(dirOf(meta.id), 'auth'),
    pairPhone,
    makeRuntime: sock => {
      const rt = newRuntime(sock, { meta, save: saverOf(meta) });
      runtimes.set(meta.id, rt);
      return rt;
    },
    onMessage, onGroup: onGroupUpdate,
    onOpen: rt => { meta.phone = digitsOf(rt.sock.user && rt.sock.user.id); writeMeta(meta); },
    onLoggedOut: () => { meta.phone = ''; writeMeta(meta); runtimes.delete(meta.id); },
    isDead: () => isExpired(meta),
    reconnect: () => start(meta),
  });
}

function stop(id, logout) {
  const rt = runtimes.get(id);
  if (!rt) return;
  stopSocket(rt, logout);
  runtimes.delete(id);
}

/* Data yang dikirim ke aplikasi untuk menampilkan status sender Personal. */
function publicState(meta) {
  const rt = runtimes.get(meta.id);
  return {
    mode: 'personal',
    status: isExpired(meta) ? 'expired' : (rt ? rt.status : (meta.phone ? 'connecting' : 'idle')),
    phone: meta.phone || '', code: rt && rt.status === 'pairing' ? rt.code : '', error: rt ? rt.err : '',
    features: meta.features, config: meta.config, orders: (meta.data.orders || []).slice(-20).reverse(),
    stats: { contacts: meta.data.contacts.length, reminders: meta.data.reminders.length, orders: meta.data.orders.length },
  };
}

/* Nomor ini sudah dipakai bot Personal lain? */
function phoneInUse(phone, exceptId) {
  for (const [id, rt] of runtimes) if (id !== exceptId && rt.meta && rt.meta.phone === phone) return true;
  return false;
}
/* Pool Sender Global: sender Personal yang sudah terverifikasi (connected), masa sewa aktif, dan owner-nya mengizinkan (config.sharePool). */
function poolRuntimes() {
  return [...runtimes.values()].filter(rt => rt && !rt.stopped && rt.status === 'connected' && rt.meta && rt.meta.config && rt.meta.config.sharePool === true && !isExpired(rt.meta));
}
/* Pilih satu nomor dari pool secara acak. `exceptDigits` = nomor yang tidak boleh dipakai (mis. target kirim). */
function pickFromPool(exceptDigits) {
  const list = poolRuntimes().filter(rt => digitsOf(rt.sock.user && rt.sock.user.id) !== exceptDigits);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}
const runtimeOf = id => runtimes.get(id);
const activeCount = () => [...runtimes.values()].filter(rt => !rt.stopped).length;

/* Setelah server restart: sambungkan lagi semua sender yang sudah pernah terpasang. */
async function restoreAll(skipIds) {
  let ids = [];
  try { ids = fs.readdirSync(require('./util').ROOT); } catch (e) {}
  for (const id of ids) {
    if (skipIds.includes(id)) continue;
    const meta = loadMeta(id);
    if (!meta || meta.mode === 'global' || !meta.phone || isExpired(meta) || meta.server >= 1) continue;
    if (!fs.existsSync(path.join(dirOf(id), 'auth', 'creds.json'))) continue;
    try { await start(meta); } catch (e) { console.error('[bot-sender] gagal pulihkan', id, e.message); }
    await sleep(1500);
  }
}

/* Dipanggil tiap 15 detik: kirim pengingat jatuh tempo + hentikan bot yang masa sewanya habis. */
async function tick() {
  for (const [id, rt] of runtimes) {
    if (!rt || rt.stopped) continue;
    if (isExpired(rt.meta)) { rt.status = 'expired'; stop(id, false); continue; }
    if (rt.status !== 'connected' || !rt.meta.features.includes('reminder')) continue;
    await deliverReminders(rt, rt.meta);
  }
}

async function deliverReminders(rt, meta) {
  const due = meta.data.reminders.filter(r => r.at <= Date.now());
  if (!due.length) return;
  meta.data.reminders = meta.data.reminders.filter(r => r.at > Date.now());
  saverOf(meta)();
  for (const r of due) {
    try { await send(rt, r.jid, { text: `⏰ Pengingat untuk @${r.who}: ${r.text}`, mentions: [r.who + '@s.whatsapp.net'] }); } catch (e) {}
  }
}

module.exports = { start, stop, runtimeOf, poolRuntimes, pickFromPool, publicState, phoneInUse, activeCount, restoreAll, tick, deliverReminders };
