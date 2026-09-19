// Penyimpanan sederhana pakai file JSON di disk.
// DATA_DIR bisa diisi lewat environment variable supaya datanya disimpan
// di Volume Railway (permanen), bukan di filesystem sementara yang
// ke-reset setiap kali server di-deploy ulang.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], history: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    return { users: [], history: [] };
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

module.exports = {
  readDb, writeDb, findUserByEmail, findUserById, saveUser,
  resetQuotaIfNewDay, addHistory, getHistoryForUser, todayStr,
};
    
