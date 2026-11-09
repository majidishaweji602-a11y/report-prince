// ⟦ZUKO⟧ owner-only web page: type a spammer's number → the bot reports that person's latest message to WhatsApp
// GET /myreport (page) · POST /api/myreport   — protected by the ADMIN_KEY config variable
import path from 'node:path'
import crypto from 'node:crypto'

import { zukoCfg } from '../config/zuko.config.js'
import { zukoHub } from './zuko.hub.js'
import { zukoGet, zukoSet } from '../lib/zuko.store.js'
import { zukoLog } from '../lib/zuko.utils.js'
import { findMessageFrom } from '../commands/webreports.js'
import { sendReport, sentAt } from '../commands/spamreport.js'

const VALID = /^\d{7,15}$/
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const fails = new Map() // ip -> [timestamps of wrong keys]
const busy = new Set() // numbers being processed right now (blocks double-clicks / parallel requests)

// Behind Heroku's router every request arrives from the router's own address, so req.socket.remoteAddress
// is the same for everybody (one wrong-key lockout would lock out the owner too).
// Heroku APPENDS the real client address to the END of X-Forwarded-For, so the last entry is the one that
// cannot be faked by the caller (the first entries can).
const clientIp = (req) => {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  return xff.length ? xff[xff.length - 1] : String(req.socket?.remoteAddress || 'unknown')
}

const sameKey = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

// keep the failed-attempts map small
const prune = (now) => {
  if (fails.size < 500) return
  for (const [ip, list] of fails) {
    const fresh = list.filter((t) => now - t < HOUR)
    if (fresh.length) fails.set(ip, fresh)
    else fails.delete(ip)
  }
}

export function zukoAdminReportRoutes(app) {

  app.get('/myreport', (_, res) => {
    res.sendFile(path.join(zukoCfg.publicDir, 'myreport.html'))
  })

  app.post('/api/myreport', async (req, res) => {

    const KEY = process.env.ADMIN_KEY

    if (!KEY || KEY.length < 8) {
      return res.status(503).json({
        error: 'Set ADMIN_KEY (at least 8 characters) in server variables.'
      })
    }

    const ip = clientIp(req)
    const now = Date.now()

    // Password attempt protection
    prune(now)
    const bad = (fails.get(ip) || []).filter((t) => now - t < HOUR)

    if (bad.length >= 5) {
      return res.status(429).json({
        error: 'Too many wrong keys. Try again in an hour.'
      })
    }

    if (!sameKey(req.body?.key ?? '', KEY)) {
      fails.set(ip, [...bad, now])
      return res.status(401).json({
        error: 'Wrong admin key.'
      })
    }

    // Validate phone number
    const number = String(req.body?.number || '')
      .replace(/\D/g, '')
      .slice(0, 15)

    if (!VALID.test(number)) {
      return res.status(400).json({
        error: 'Enter number with country code.'
      })
    }

    // One report request per number every 24 hours
    if (now - (zukoGet('myreports', 'done', {})[number] || 0) < DAY) {
      return res.status(409).json({
        error: 'You can only submit one report request for this number every 24 hours.'
      })
    }

    // Same number already being processed by another request
    if (busy.has(number)) {
      return res.status(409).json({
        error: 'This number is already being reported. Wait a moment.'
      })
    }

    busy.add(number)
    try {

      // Find a real message received from the number
      const sessions = [...zukoHub.sessions.values()].filter((s) => s.opened && s.sock)

      sessions.sort((a, b) =>
        (zukoCfg.owners.includes(String(b.number)) ? 1 : 0) -
        (zukoCfg.owners.includes(String(a.number)) ? 1 : 0)
      )

      for (const s of sessions) {

        const m = findMessageFrom(String(s.number), number)
        if (!m) continue

        try {
          const chat = m.key.remoteJid
          let subject = ''

          if (chat.endsWith('@g.us')) {
            try {
              subject = (await s.sock.groupMetadata(chat)).subject || ''
            } catch {}
          }

          await sendReport(
            s.sock,
            chat,
            m.key.id,
            m.key.participant,
            sentAt(String(s.number), chat, m.key.id),
            subject
          )

          // Save successful request timestamp (re-read so we never overwrite other numbers saved meanwhile)
          zukoSet('myreports', 'done', {
            ...zukoGet('myreports', 'done', {}),
            [number]: Date.now()
          })

          return res.json({
            ok: true,
            message: `Report request processed for +${number}.`
          })

        } catch (e) {
          zukoLog.warn('myreport: ' + e.message)

          return res.status(502).json({
            error: 'WhatsApp did not accept the report.'
          })
        }
      }

      return res.status(404).json({
        error: `No recent message from +${number} found in bot memory.`
      })

    } finally {
      busy.delete(number)
    }
  })
}
