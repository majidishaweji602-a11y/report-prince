// ⟦ZUKO⟧ owner tools for reports sent through the /report web form
//   .webreports [n]        → list the latest reports
//   .webreports send <n>   → REPORT TO WHATSAPP: reports the last real message this bot received from that number (list position n)
//   .webreports clear      → delete all
// Reports reach WhatsApp only when the owner approves AND the bot actually holds a message from that number —
// web submissions are never forwarded automatically (anyone could type any number into the form).
import { zukoWebReports } from '../core/zuko.reports.js'
import { zukoSet } from '../lib/zuko.store.js'
import { zukoNumber } from '../lib/zuko.utils.js'
import { sendReport, sentAt } from './spamreport.js'

const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam', hour12: false })

// newest cached message from this phone number (the handler keeps the last ~2000 messages in memory)
export function findMessageFrom(session, number) {
  const cache = globalThis.__zukoRecentMessages
  if (!cache) return null
  for (const [k, m] of [...cache.entries()].reverse()) {
    if (!k.startsWith(`${session}:`) || m?.key?.fromMe) continue
    const jid = m.key.remoteJid || ''
    const from = zukoNumber(m.key.participantAlt || m.key.participant || (jid.endsWith('@g.us') ? '' : jid))
    if (from === number) return m
  }
  return null
}

export default {
  name: 'webreports',
  aliases: ['reports'],
  owner: true,
  desc: 'Show spam reports from the web form / send one to WhatsApp',
  async run(z) {
    const sub = (z.args[0] || '').toLowerCase()
    if (sub === 'clear') { zukoSet('webreports', 'list', []); return z.reply('🧹 All web reports cleared.') }

    const list = zukoWebReports()
    if (sub === 'send') {
      const r = list[(parseInt(z.args[1], 10) || 0) - 1]
      if (!r) return z.reply('Usage: .webreports send <number from the list>')
      if (r.sentToWA) return z.reply('✅ This report was already sent to WhatsApp.')
      const m = findMessageFrom(z.session.number, r.spammer)
      if (!m) return z.reply(`❌ I have no recent message from +${r.spammer}, and WhatsApp only accepts a report that points at a real message.\nOpen their message and use *.spamreport* (reply to it), or Report in the WhatsApp app.`)
      try {
        const chat = m.key.remoteJid
        let subject = ''
        if (chat.endsWith('@g.us')) { try { subject = (await z.sock.groupMetadata(chat)).subject || '' } catch {} }
        const how = await sendReport(z.sock, chat, m.key.id, m.key.participant, sentAt(z.session.number, chat, m.key.id), subject)
        r.sentToWA = true
        zukoSet('webreports', 'list', list)
        return z.reply(`🚨 Reported +${r.spammer} to WhatsApp (${how}).`)
      } catch (e) {
        return z.reply(`❌ WhatsApp did not accept the report: ${e?.message || e}`)
      }
    }

    if (!list.length) return z.reply('No web reports yet.')
    const n = Math.min(Math.max(parseInt(sub, 10) || 10, 1), 30)
    const rows = list.slice(0, n).map((r, i) => `*${i + 1}.* +${r.spammer} · ${r.type}${r.sentToWA ? ' · ✅ sent to WhatsApp' : ''}\n${when(r.at)}${r.group ? ` · ${r.group}` : ''}\n_${r.details.slice(0, 140)}_`)
    return z.reply(`🚨 *Web spam reports* (${Math.min(n, list.length)} of ${list.length})\n\n${rows.join('\n\n')}\n\n.webreports send <n> — report to WhatsApp\n.webreports clear — delete all`)
  }
    }
