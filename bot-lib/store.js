/**
 * Penyimpanan per bot: DATA_DIR/bot-sessions/<botId>/meta.json
 * (config + data + info bot). Satu objek meta per bot disimpan di memori
 * supaya endpoint pengaturan dan pemroses pesan selalu melihat data yang sama.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ALL_FEATURES } = require('./util');
const { defaultConfig, defaultData, cleanConfig } = require('./config');

const cache = new Map();     // botId -> meta
const savers = new WeakMap(); // meta -> fungsi simpan (ditunda 400ms)

const dirOf = id => path.join(ROOT, String(id).replace(/[^a-zA-Z0-9_-]/g, ''));

function readFile(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8')); } catch (e) { return null; }
}
function writeMeta(meta) {
  fs.mkdirSync(dirOf(meta.id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(meta.id), 'meta.json'), JSON.stringify(meta));
}
function saverOf(meta) {
  if (!savers.has(meta)) {
    let t = null;
    savers.set(meta, () => { clearTimeout(t); t = setTimeout(() => { try { writeMeta(meta); } catch (e) {} }, 400); });
  }
  return savers.get(meta);
}

/* Ambil meta sebuah bot. `bot` = objek dari db (sumber kebenaran untuk nama, fitur, masa sewa, mode). */
function getMeta(bot) {
  let meta = cache.get(bot.id);
  const fresh = !meta;
  if (fresh) {
    meta = readFile(bot.id) || { id: bot.id, config: defaultConfig(), data: defaultData(), phone: '' };
    meta.config = cleanConfig(meta.config, null);
    meta.data = { ...defaultData(), ...(meta.data || {}) };
    cache.set(bot.id, meta);
  }
  meta.userId = bot.userId;
  meta.name = bot.name;
  meta.features = (bot.features || []).filter(f => ALL_FEATURES.includes(f));
  meta.expiresAt = bot.expiresAt;
  meta.mode = bot.senderMode === 'global' ? 'global' : 'personal';
  if (fresh) writeMeta(meta);
  return meta;
}

/* Muat meta dari file (untuk pemulihan setelah server restart). */
function loadMeta(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = readFile(id);
  if (meta) {
    meta.config = cleanConfig(meta.config, null);
    meta.data = { ...defaultData(), ...(meta.data || {}) };
    cache.set(id, meta);
  }
  return meta;
}

const allMetas = () => [...cache.values()];

module.exports = { dirOf, getMeta, loadMeta, writeMeta, saverOf, allMetas };
