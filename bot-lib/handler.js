/**
 * Pemroses pesan masuk. Alurnya (urut):
 *   1. buildCall      — saring pesan & siapkan data (pengirim, owner, teks)
 *   2. antilink       — hapus link di grup
 *   3. trackContact   — simpan kontak untuk broadcast (Personal saja)
 *   4. runCommand     — perintah berawalan prefix (.menu, .ai, ...)
 *   5. privateChat    — FAQ, deteksi pesanan, auto-reply (chat pribadi, Personal saja)
 * Dipakai bersama oleh sender Personal dan Global.
 */
const { digits, clip, getText, isExpired, LINK_RE, findFaq, isCooling, markCool } = require('./util');
const { send, groupInfo } = require('./messaging');
const { findCommand } = require('./commands');

function buildCall(ctx, m) {
  const { meta } = ctx;
  if (!m || !m.message || !m.key) return null;
  const jid = m.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return null;
  if (ctx.sentIds.has(m.key.id)) return null;
  if (isExpired(meta)) return null;

  const cfg = meta.config, p = cfg.prefix;
  const isGroup = jid.endsWith('@g.us');
  const fromMe = !!m.key.fromMe;
  const sender = digits(isGroup ? (m.key.participant || '') : jid);
  return {
    ctx, m, meta, cfg, p, jid, isGroup, fromMe, sender,
    d: meta.data,
    text: getText(m).trim(),
    isGlobal: meta.mode === 'global',
    isOwner: fromMe || cfg.owners.includes(sender),
    has: f => meta.features.includes(f),
    reply: (t, extra) => send(ctx, jid, { text: clip(t, 3500), ...(extra || {}) }, m),
  };
}

/* ---- 2. anti-link ---- */
async function handleAntilink(c) {
  const { ctx, m, jid, sender, cfg, d } = c;
  if (!(c.isGroup && c.has('antilink') && !c.fromMe && c.text && LINK_RE.test(c.text))) return false;
  try {
    const g = await groupInfo(ctx, jid);
    if (g.admins.includes(sender)) return true;
    if (g.admins.includes(g.me)) {
      await ctx.sock.sendMessage(jid, { delete: m.key });
      const key = jid + ':' + sender;
      d.warns[key] = (d.warns[key] || 0) + 1;
      const n = d.warns[key];
      const mentions = [sender + '@s.whatsapp.net'];
      if (cfg.antilink.kick && n >= 3) {
        await send(ctx, jid, { text: `@${sender} dikeluarkan karena kirim link 3x.`, mentions });
        await ctx.sock.groupParticipantsUpdate(jid, mentions, 'remove');
        delete d.warns[key];
      } else {
        await send(ctx, jid, { text: `⚠️ @${sender} dilarang kirim link di grup ini${cfg.antilink.kick ? ` (peringatan ${n}/3)` : ''}.`, mentions });
      }
      ctx.save();
    }
  } catch (e) { /* bot bukan admin / gagal ambil info grup: abaikan */ }
  return true;
}

/* ---- 3. simpan kontak (untuk broadcast) ---- */
function trackContact(c) {
  const { d, jid, ctx } = c;
  if (c.isGlobal || c.isGroup || c.fromMe || !c.has('broadcast') || !jid.endsWith('@s.whatsapp.net') || d.contacts.includes(jid)) return;
  d.contacts.push(jid);
  if (d.contacts.length > 1000) d.contacts.shift();
  ctx.save();
}

/* ---- 4. perintah ---- */
function runCommand(c) {
  const parts = c.text.slice(c.p.length).trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const found = findCommand(cmd, c.has);
  if (!found) return; // perintah tidak dikenal: diam saja
  return found.run({ ...c, cmd, parts, rest: parts.join(' ').trim() });
}

/* ---- 5. chat pribadi biasa (FAQ -> pesanan -> auto-reply) ---- */
async function privateChat(c) {
  const { ctx, cfg, d, text, sender, m } = c;
  if (c.isGlobal || c.isGroup || c.fromMe) return;

  if (c.has('faq') && cfg.faq.length) {
    const f = findFaq(cfg.faq, text);
    if (f) return c.reply(f.a);
  }

  if (c.has('orderbot')) {
    const t = text.toLowerCase();
    if (cfg.orderbot.keywords.some(k => t.includes(k))) {
      const no = (d.orders.length ? d.orders[d.orders.length - 1].no : 0) + 1;
      d.orders.push({ no, from: sender, name: clip(m.pushName, 40), text: clip(text, 500), ts: Date.now(), done: false });
      if (d.orders.length > 300) d.orders = d.orders.slice(-300);
      ctx.save();
      await c.reply(`${cfg.orderbot.reply}\nNo. pesanan: *#${no}*`);
      // kabari pemilik bot
      const ownerJid = (cfg.owners[0] || digits(ctx.sock.user && ctx.sock.user.id)) + '@s.whatsapp.net';
      if (ownerJid.split('@')[0] !== sender) send(ctx, ownerJid, { text: `🛒 Pesanan baru #${no}\nDari: wa.me/${sender}\n${clip(text, 400)}` }).catch(() => {});
      return;
    }
  }

  if (c.has('autoreply')) {
    const t = text.toLowerCase();
    const rule = cfg.autoreply.rules.find(r => t.includes(r.k.toLowerCase()));
    if (rule) {
      if (isCooling(ctx, 'ar:' + sender, 3000)) return;
      markCool(ctx, 'ar:' + sender);
      return c.reply(rule.r);
    }
    if (cfg.autoreply.fallback) {
      if (isCooling(ctx, 'fb:' + sender, 6 * 3600000)) return; // sapaan default maksimal 1x / 6 jam per orang
      markCool(ctx, 'fb:' + sender);
      return c.reply(cfg.autoreply.fallback);
    }
  }
}

async function onMessage(ctx, m) {
  const c = buildCall(ctx, m);
  if (!c) return;
  if (await handleAntilink(c)) return;
  if (!c.text) return;
  if (c.fromMe && !c.text.startsWith(c.p)) return;
  trackContact(c);
  if (c.text.startsWith(c.p)) return runCommand(c);
  return privateChat(c);
}

/* ---- member baru masuk grup -> welcome ---- */
async function onGroupUpdate(ctx, ev) {
  const { meta } = ctx;
  if (!meta.features.includes('welcome') || isExpired(meta) || ev.action !== 'add') return;
  let name = '';
  try { name = (await groupInfo(ctx, ev.id)).subject; } catch (e) {}
  for (const part of ev.participants || []) {
    const pj = typeof part === 'string' ? part : (part.phoneNumber || part.id);
    const num = digits(pj);
    if (!num || num === digits(ctx.sock.user && ctx.sock.user.id)) continue;
    const txt = meta.config.welcome.text.replace(/@user/g, '@' + num).replace(/@group/g, name || 'grup ini');
    try { await send(ctx, ev.id, { text: txt, mentions: [num + '@s.whatsapp.net'] }); } catch (e) {}
  }
}

module.exports = { onMessage, onGroupUpdate };
