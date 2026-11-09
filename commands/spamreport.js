// ⟦ZUKO⟧ .spamreport [block] — reply to a spam message to report it to WhatsApp (same as tapping Report in the app)
//   .spamreport          → reports the replied message to WhatsApp
//   .spamreport block    → reports it AND blocks the sender
//   .spamreport methods  → owner: lists report-related functions found in the Baileys fork (for debugging)
// Manual only (group admins / owner) with a cooldown — there is deliberately no auto-report, so it cannot be abused for mass-reporting.
import { zukoCtx, zukoGuard } from '../lib/zuko.admin.js'
import { zukoNumber } from '../lib/zuko.utils.js'

const COOLDOWN_MS = 30_000
const last = new Map() // sender -> timestamp
const reported = new Set() // `${chat}:${messageId}` — each message is reported once

// time the reported message was sent (the handler keeps recent messages in this shared map); falls back to "now"
export function sentAt(session, chat, id) {
  const m = globalThis.__zukoRecentMessages?.get(`${session}:${chat}:${id}`)
  const ts = m?.messageTimestamp
  const n = typeof ts === 'object' && ts ? (ts.toNumber?.() ?? Number(ts)) : Number(ts)
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000)
}

export async function sendReport(sock, chat, id, participant, t, subject) {
  // 1) fork provides its own function → use it
  for (const name of ['reportMessage', 'reportSpam', 'sendSpamReport']) {
    if (typeof sock[name] === 'function') { await sock[name](chat, id, participant); return `via sock.${name}` }
  }
  // 2) WhatsApp "spam" IQ (the request WhatsApp Web sends when you tap Report)
  await sock.query({
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
    content: [{
      tag: 'spam_list',
      attrs: { spam_flow: 'MessageMenu', jid: chat, ...(subject ? { subject } : {}) },
      content: [{ tag: 'message', attrs: { id, t: String(t), from: chat, ...(participant ? { participant } : {}) } }]
    }]
  })
  return 'via spam IQ'
}

export default {
  name: 'spamreport',
  aliases: ['reportspam', 'wareport'],
  desc: 'Report a replied message to WhatsApp as spam',
  async run(z) {
    const sub = (z.args[0] || '').toLowerCase()
    if (sub === 'methods') {
      if (!z.isOwner) return z.reply('⛔ Owner only.')
      const found = Object.keys(z.sock).filter((k) => /report|spam/i.test(k))
      return z.reply(found.length ? `🔎 Found: ${found.join(', ')}` : '🔎 No report/spam function in this Baileys fork — using the raw spam IQ.')
    }
    if (z.isGroup && !(await zukoGuard(z))) return
    if (!z.isGroup && !z.isOwner) return z.reply('⛔ Owner only.')

    const c = zukoCtx(z)
    if (!c?.stanzaId) return z.reply('↩️ Reply to the spam message, then send *.spamreport*')
    const me = zukoNumber(z.sender)
    if (Date.now() - (last.get(me) || 0) < COOLDOWN_MS) return z.reply('⏳ Wait a few seconds before the next report.')
    const dedupe = `${z.jid}:${c.stanzaId}`
    if (reported.has(dedupe)) return z.reply('✅ That message was already reported.')
    last.set(me, Date.now())

    try {
      let subject = ''
      if (z.isGroup) { try { subject = (z.groupMeta || (await z.sock.groupMetadata(z.jid))).subject || '' } catch {} }
      const how = await sendReport(z.sock, z.jid, c.stanzaId, c.participant, sentAt(z.session.number, z.jid, c.stanzaId), subject)
      reported.add(dedupe)
      if (reported.size > 1000) reported.delete(reported.values().next().value)
      let extra = ''
      if (sub === 'block' && c.participant) {
        try { await z.sock.updateBlockStatus(c.participant, 'block'); extra = '\n🚫 Sender blocked.' } catch (e) { extra = `\n⚠️ Could not block: ${e.message}` }
      }
      return z.reply(`🚨 Spam report sent to WhatsApp (${how}).${extra}`)
    } catch (e) {
      last.delete(me)
      return z.reply(`❌ WhatsApp did not accept the report: ${e?.message || e}\nTip: you can always long-press the message → Report in the WhatsApp app. Owner can run *.spamreport methods* to see what this bot supports.`)
    }
  }
                      }
