// ⟦ZUKO⟧ entry point — Heroku runs this file (see Procfile / package.json "start")
// 1) starts the web server (/webpair, /myreport ...) so Heroku sees the port open quickly
// 2) resumes every WhatsApp account that was already paired
import { zukoServe } from './core/zuko.pair.js'
import { zukoListNumbers } from './core/zuko.auth.js'
import { zukoStartSock, zukoIsRegistered } from './core/zuko.sock.js'
import { zukoCfg } from './config/zuko.config.js'
import { zukoLog } from './lib/zuko.utils.js'

// never let one error kill the whole bot
process.on('unhandledRejection', (e) => zukoLog.warn('unhandledRejection: ' + (e?.message || e)))
process.on('uncaughtException', (e) => zukoLog.warn('uncaughtException: ' + (e?.message || e)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function resumeSessions() {
  let started = 0
  const max = Number(zukoCfg.maxSessions) || Infinity
  for (const number of await zukoListNumbers()) {
    if (started >= max) break
    try {
      if (!(await zukoIsRegistered(number))) continue
      await zukoStartSock(number)
      started++
      await sleep(1500) // small gap so many sessions do not connect at the same second
    } catch (e) {
      zukoLog.warn(`resume ${number}: ${e?.message || e}`)
    }
  }
  zukoLog.ok(`resumed ${started} saved session(s)`)
}

zukoServe()
resumeSessions().catch((e) => zukoLog.warn('resume failed: ' + (e?.message || e)))
