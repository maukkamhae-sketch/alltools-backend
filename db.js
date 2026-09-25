// Penyimpanan sederhana pakai file JSON di disk.
// DATA_DIR bisa diisi lewat environment variable supaya datanya disimpan
// di Volume Railway (permanen), bukan di filesystem sementara yang
// ke-reset setiap kali server di-deploy ulang.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');

function emptyDb() {
  return { users: [], history: [], sites: [], bots: [], settings: {}, transactions: [], orders: [], amDevices: [], amCommands: [], amLocations: [] };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    return emptyDb();
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!data.users) data.users = [];
    if (!data.history) data.history = [];
    if (!data.sites) data.sites = [];
    if (!data.bots) data.bots = [];
    if (!data.settings) data.settings = {};
    if (!data.transactions) data.transactions = [];
    if (!data.orders) data.orders = [];
    if (!data.amDevices) data.amDevices = [];
    if (!data.amCommands) data.amCommands = [];
    if (!data.amLocations) data.amLocations = [];
    return data;
  } catch (e) {
    return emptyDb();
  }
}

function writeDb(data) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function findUserByEmail(email) {
  const db = readDb();
  return db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

function findUserById(id) {
  const db = readDb();
  return db.users.find(u => u.id === id);
}

function saveUser(user) {
  const db = readDb();
  const idx = db.users.findIndex(u => u.id === user.id);
  if (idx === -1) db.users.push(user);
  else db.users[idx] = user;
  writeDb(db);
}

function resetQuotaIfNewDay(user) {
  if (user.quota.date !== todayStr()) {
    user.quota = { date: todayStr(), downloads: 0, ai: 0, enhance: 0, convert: 0 };
  }
  return user;
}

function addHistory(userId, type, label) {
  const db = readDb();
  db.history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    userId, type, label,
    date: new Date().toISOString(),
  });
  db.history = db.history.slice(0, 2000); // batasi biar file tidak membengkak
  writeDb(db);
}

function getHistoryForUser(userId, limit = 50) {
  const db = readDb();
  return db.history.filter(h => h.userId === userId).slice(0, limit);
}

function findSiteBySlug(slug) {
  const db = readDb();
  return db.sites.find(s => s.slug === slug);
}

function saveSite(site) {
  const db = readDb();
  const idx = db.sites.findIndex(s => s.slug === site.slug);
  if (idx === -1) db.sites.push(site);
  else db.sites[idx] = site;
  writeDb(db);
}

function getSitesForUser(userId) {
  const db = readDb();
  return db.sites.filter(s => s.userId === userId);
}

function findBotByApiKey(apiKey) {
  const db = readDb();
  return db.bots.find(b => b.apiKey === apiKey);
}

function saveBot(bot) {
  const db = readDb();
  const idx = db.bots.findIndex(b => b.id === bot.id);
  if (idx === -1) db.bots.push(bot);
  else db.bots[idx] = bot;
  writeDb(db);
}

function getBotsForUser(userId) {
  const db = readDb();
  return db.bots.filter(b => b.userId === userId);
}

function findBotByPin(pin) {
  const db = readDb();
  return db.bots.find(b => b.pin === pin);
}

function findBotByLinkedJid(jid) {
  const db = readDb();
  return db.bots.find(b => b.linkedJid === jid);
}

function getSettings() {
  const db = readDb();
  return db.settings;
}

function updateSettings(patch) {
  const db = readDb();
  db.settings = { ...db.settings, ...patch };
  writeDb(db);
  return db.settings;
}

function saveTransaction(tx) {
  const db = readDb();
  const idx = db.transactions.findIndex(t => t.orderId === tx.orderId);
  if (idx === -1) db.transactions.push(tx);
  else db.transactions[idx] = tx;
  writeDb(db);
}

function findTransactionByOrderId(orderId) {
  const db = readDb();
  return db.transactions.find(t => t.orderId === orderId);
}

/* Pesanan Pulsa & Paket Data */

function saveOrder(order) {
  const db = readDb();
  const idx = db.orders.findIndex(o => o.orderId === order.orderId);
  if (idx === -1) db.orders.push(order);
  else db.orders[idx] = order;
  writeDb(db);
}

function findOrderByOrderId(orderId) {
  const db = readDb();
  return db.orders.find(o => o.orderId === orderId);
}

function getOrdersForUser(userId, limit = 50) {
  const db = readDb();
  return db.orders
    .filter(o => o.userId === userId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);
}


/* AntiMaling: device (HP yang dilindungi), command (perintah dari dashboard
 * ke apk), dan riwayat lokasi. */

function saveAmDevice(dev) {
  const db = readDb();
  const idx = db.amDevices.findIndex(d => d.id === dev.id);
  if (idx === -1) db.amDevices.push(dev);
  else db.amDevices[idx] = dev;
  writeDb(db);
}
function findAmDeviceById(id) {
  return readDb().amDevices.find(d => d.id === id);
}
function findAmDeviceByPairCode(code) {
  return readDb().amDevices.find(d => d.pairCode === code && !d.paired);
}
function findAmDeviceByApiKey(apiKey) {
  return readDb().amDevices.find(d => d.apiKey === apiKey && d.paired);
}
function getAmDevicesForUser(userId) {
  return readDb().amDevices.filter(d => d.userId === userId);
}
function deleteAmDevice(id) {
  const db = readDb();
  db.amDevices = db.amDevices.filter(d => d.id !== id);
  db.amCommands = db.amCommands.filter(c => c.deviceId !== id);
  db.amLocations = db.amLocations.filter(l => l.deviceId !== id);
  writeDb(db);
}

function saveAmCommand(cmd) {
  const db = readDb();
  const idx = db.amCommands.findIndex(c => c.id === cmd.id);
  if (idx === -1) db.amCommands.push(cmd);
  else db.amCommands[idx] = cmd;
  writeDb(db);
}
function getPendingAmCommands(deviceId) {
  return readDb().amCommands.filter(c => c.deviceId === deviceId && c.status === 'pending');
}
function getAmCommandsForDevice(deviceId, limit = 50) {
  return readDb().amCommands.filter(c => c.deviceId === deviceId).slice(-limit).reverse();
}
function ackAmCommand(commandId, result) {
  const db = readDb();
  const cmd = db.amCommands.find(c => c.id === commandId);
  if (cmd) { cmd.status = 'done'; cmd.result = result || 'ok'; cmd.ackAt = new Date().toISOString(); writeDb(db); }
  return cmd;
}

function addAmLocation(point) {
  const db = readDb();
  db.amLocations.push(point);
  const others = db.amLocations.filter(l => l.deviceId !== point.deviceId);
  const mine = db.amLocations.filter(l => l.deviceId === point.deviceId).slice(-200);
  db.amLocations = others.concat(mine);
  writeDb(db);
}
function getAmLocationsForDevice(deviceId, limit = 100) {
  return readDb().amLocations.filter(l => l.deviceId === deviceId).slice(-limit);
}

module.exports = {
  readDb, writeDb, findUserByEmail, findUserById, saveUser,
  resetQuotaIfNewDay, addHistory, getHistoryForUser, todayStr,
  findSiteBySlug, saveSite, getSitesForUser,
  findBotByApiKey, saveBot, getBotsForUser,
  findBotByPin, findBotByLinkedJid, getSettings, updateSettings,
  saveTransaction, findTransactionByOrderId,
  saveOrder, findOrderByOrderId, getOrdersForUser,
  saveAmDevice, findAmDeviceById, findAmDeviceByPairCode, findAmDeviceByApiKey,
  getAmDevicesForUser, deleteAmDevice, saveAmCommand, getPendingAmCommands,
  getAmCommandsForDevice, ackAmCommand, addAmLocation, getAmLocationsForDevice,
};
