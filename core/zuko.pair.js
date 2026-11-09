// ⟦ZUKO⟧ web pairing API — POST /api/webpair/start, GET /api/webpair/status
import express from 'express'
import path from 'node:path'
import { zukoCfg } from '../config/zuko.config.js'
import { zukoHub } from './zuko.hub.js'
import { zukoStartSock, zukoIsRegistered, zukoDropSession } from './zuko.sock.js'
import { zukoListNumbers } from './zuko.auth.js'
import { zukoGet, zukoSet } from '../lib/zuko.store.js'
import { zukoLog } from '../lib/zuko.utils.js'
import { zukoReportRoutes } from './zuko.reports.js'
import { zukoAdminReportRoutes } from './zuko.adminreport.js'

const lastByIp = new Map()
const VALID = /^\d{7,15}$/
const SERVER_NAME = process.env.SERVER_NAME || zukoCfg.botName

// Public counters (saved through the settings store, so they survive restarts)
let views = 0, pairs = 0, dirty = false
const countView = () => { views++; dirty = true }
const lastContact = new Map() // ip -> last support message time (spam guard)
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
setInterval(() => { const old = Date.now() - 3600000; for (const [k, t] of lastContact) if (t < old) lastContact.delete(k) }, 600000).unref()
const countPair = () => { pairs++; dirty = true }

// Server stats (cached 15s): total = accounts that finished pairing, online = currently connected
let statsCache = { at: 0, data: null }
async function zukoStats() {
  if (statsCache.data && Date.now() - statsCache.at < 15000) return statsCache.data
  let total = 0
  for (const n of await zukoListNumbers()) if (await zukoIsRegistered(n)) total++
  const online = [...zukoHub.sessions.values()].filter((s) => s.opened).length
  statsCache = { at: Date.now(), data: { server: SERVER_NAME, total, online, capacity: zukoCfg.maxSessions } }
  return statsCache.data
}

export function zukoServe() {
  const app = express()
  views = Number(zukoGet('webpair', 'views', 0)) || 0
  pairs = Number(zukoGet('webpair', 'pairs', 0)) || 0
  setInterval(() => {
    if (!dirty) return
    dirty = false
    try { zukoSet('webpair', 'views', views); zukoSet('webpair', 'pairs', pairs) } catch (e) { zukoLog.warn('counter save: ' + e.message) }
  }, 10000).unref()
  app.use(express.json({ limit: '8kb' }))

  // CORS: lets webpair.html on one server talk to the other servers' /api
  app.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.get('/api/stats', async (_, res) => {
    try { res.json({ ...(await zukoStats()), views, pairs }) }
    catch (e) { res.status(500).json({ error: 'stats unavailable' }) }
  })

  zukoReportRoutes(app)
  zukoAdminReportRoutes(app)
  app.get('/', (_, res) => res.redirect('/webpair'))
  app.get('/webpair', (_, res) => { countView(); res.sendFile(path.join(zukoCfg.publicDir, 'webpair.html')) })
  app.get('/assets/logo.jpg', (_, res) => res.sendFile(zukoCfg.logo))
  app.get('/health', (_, res) => res.json({
    status: 'ok',
    bot: zukoCfg.botName,
    uptime: Math.floor(process.uptime()) + 's',
    linked: [...zukoHub.sessions.values()].filter((s) => s.opened).length
  }))

  // Support form: the message is sent by the bot straight to the owner's WhatsApp
  app.post('/api/contact', async (req, res) => {
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n)
    const message = clean(req.body?.message, 500)
    const name = clean(req.body?.name, 40)
    const number = String(req.body?.number || '').replace(/\D/g, '').slice(0, 15)
    if (message.length < 5) return res.status(400).json({ error: 'Message too short.' })
    if (number && !VALID.test(number)) return res.status(400).json({ error: 'Invalid number.' })

    const ip = clientIp(req), now = Date.now()
    if (now - (lastContact.get(ip) || 0) < 60000) return res.status(429).json({ error: 'Please wait a minute.' })

    const ownerJid = `${zukoCfg.owner}@s.whatsapp.net`
    const open = [...zukoHub.sessions.values()].filter((s) => s.opened && s.sock)
    const sess = open.find((s) => zukoCfg.owners.includes(String(s.number))) || open[0]
    if (!sess) return res.status(503).json({ error: 'No connected WhatsApp on this server.' })

    const time = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam', hour12: false })
    const text = [
      '📩 *PRINCE MINI · Support message*',
      '',
      `👤 Name: ${name || '-'}`,
      `📞 Number: ${number ? '+' + number : '-'}`,
      number ? `💬 wa.me/${number}` : null,
      `🕒 ${time}`,
      `🖥 ${SERVER_NAME}`,
      '',
      message
    ].filter((x) => x !== null).join('\n')

    try {
      await sess.sock.sendMessage(ownerJid, { text })
      lastContact.set(ip, now)
      res.json({ ok: true })
    } catch (e) {
      zukoLog.err('support message: ' + e.message)
      res.status(502).json({ error: 'Could not deliver the message.' })
    }
  })

  app.post('/api/webpair/start', async (req, res) => {
    const number = String(req.body?.number || '').replace(/\D/g, '')
    if (!VALID.test(number)) return res.status(400).json({ error: 'Enter a valid phone number with country code.' })

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
    const now = Date.now()
    if (now - (lastByIp.get(ip) || 0) < 60000) {
      return res.status(429).json({ error: 'Please wait one minute before another pairing request.' })
    }
    const existingPair = zukoHub.pair.get(number)
    if (existingPair?.status === 'pending' && now - Number(existingPair.at || now) < 120000) {
      return res.status(409).json({ error: 'A pairing request for this number is already running. Wait a moment for its code.' })
    }
    // Recover from an abandoned request left pending by an older socket or page.
    if (existingPair?.status === 'pending') zukoHub.pair.delete(number)
    lastByIp.set(ip, now)

    // If the account is already linked and connected, do not issue a second code.
    const registered = await zukoIsRegistered(number)
    if (!registered) {
      const st = await zukoStats().catch(() => null)
      if (st && st.total >= st.capacity) {
        lastByIp.delete(ip)
        return res.status(503).json({ error: 'This server is full. Please choose another server.' })
      }
    }
    const live = zukoHub.sessions.get(number)
    if (registered && live?.opened) {
      return res.status(202).json({ status: 'already-paired' })
    }

    // IMPORTANT: registered credentials must be resumed first. Previously this
    // path returned HTTP 409 without ever opening a socket, so an offline saved
    // session could never recover itself from the web-pair page. Preserve the
    // saved auth and let Baileys reconnect; if WhatsApp confirms logout, the
    // socket handler removes only this number's invalid auth and status polling
    // can then request a fresh code.
    if (registered) {
      zukoHub.pair.set(number, { status: 'recovering', at: now })
      try {
        await zukoStartSock(number)
        countPair()
        return res.status(202).json({ status: 'recovering' })
      } catch (e) {
        zukoHub.pair.set(number, { status: 'error', error: `Could not resume the saved session: ${e.message}`, at: Date.now() })
        return res.status(500).json({ error: 'Could not resume the saved WhatsApp session. Please try again shortly.' })
      }
    }

    try {
      // stale, unregistered half-finished link → start clean so WhatsApp issues a fresh code
      await zukoDropSession(number)
      zukoHub.pair.set(number, { status: 'pending', at: now })
      await zukoStartSock(number, { wantCode: true })
      countPair()
      return res.status(202).json({ status: 'started' })
    } catch (e) {
      zukoHub.pair.delete(number)
      zukoLog.err(`webpair start ${number}: ${e.message}`)
      return res.status(500).json({ error: 'Unable to start pairing right now.' })
    }
  })

  app.get('/api/webpair/status', async (req, res) => {
    const number = String(req.query.number || '').replace(/\D/g, '')
    if (!VALID.test(number)) return res.status(400).json({ error: 'Invalid phone number.' })

    const p = zukoHub.pair.get(number)
    if (p?.status === 'ready') return res.json({ status: 'ready', code: p.code })
    if (p?.status === 'error') { zukoHub.pair.delete(number); return res.status(500).json({ status: 'error', error: p.error }) }
    if (zukoHub.sessions.get(number)?.opened) {
      zukoHub.pair.delete(number)
      return res.json({ status: 'already-paired' })
    }

    // A saved session may be cleared by the socket handler only after WhatsApp
    // explicitly reports logout. Once that happens, continue the user's original
    // request by creating a fresh first-link socket. This is scoped to the number
    // that initiated recovery; no other user's sessions are touched.
    if (p?.status === 'recovering' && !(await zukoIsRegistered(number))) {
      zukoHub.pair.set(number, { status: 'pending', at: Date.now() })
      try {
        await zukoStartSock(number, { wantCode: true })
      } catch (e) {
        zukoHub.pair.set(number, { status: 'error', error: `Fresh pairing could not start: ${e.message}`, at: Date.now() })
        return res.status(500).json({ status: 'error', error: 'The old session was cleared, but a fresh pairing request could not start. Please retry.' })
      }
      return res.json({ status: 'pending' })
    }

    if (p?.status === 'recovering') {
      if (Date.now() - Number(p.at || Date.now()) > 90000) {
        return res.status(503).json({ status: 'error', error: 'The saved session is still offline. It has been preserved, not deleted. Check the original WhatsApp account for a linked-device or logout notice, then retry.' })
      }
      return res.json({ status: 'recovering' })
    }
    return res.json({ status: 'pending' })
  })

  app.listen(zukoCfg.port, () => zukoLog.ok(`web pair panel on port ${zukoCfg.port} → /webpair`))
  return app
                  }
