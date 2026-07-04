// Phase 10 performance/stress harness for ai-in-ta-telegram-bot.
// Drives the REAL worker source (worker/src/index.js) under the same CF mock
// the behavioral suite uses: in-memory KV, singleton BotState DO with
// serialized RPC, instrumented fetch. Network is stubbed, so measured CPU/wall
// time is the pure JS cost that maps to Cloudflare's per-request CPU budget,
// and the fetch count IS the subrequest count (the real production ceiling).
//
// Run with: node --expose-gc test/perf-stress.mjs
// Not a *.test.mjs file, so it does not run in CI (`npm test`) — it's an
// on-demand measurement rig, reusing the behavioral suite's cf-hooks stub.

import { register } from 'node:module'
import { performance } from 'node:perf_hooks'

const t0import = performance.now()
register('./cf-hooks.mjs', import.meta.url)
const worker = await import('../worker/src/index.js')
const importMs = performance.now() - t0import

// ---------- mocks (identical semantics to test/worker.behavior.test.mjs) ----------
class FakeStorage {
  constructor() { this.map = new Map() }
  async get(k) { const v = this.map.get(k); return v === undefined ? undefined : structuredClone(v) }
  async put(k, v) { this.map.set(k, structuredClone(v)) }
}
class FakeKV {
  constructor() { this.map = new Map() }
  async get(k, type) { const v = this.map.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v }
  async put(k, v) { this.map.set(k, String(v)) }
}

let fetchLog = []
globalThis.fetch = async (url, opts) => {
  url = String(url)
  fetchLog.push({ url, method: opts?.method ?? 'GET' })
  if (url.includes('api.telegram.org'))
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.includes('api.github.com')) return new Response(null, { status: 204 })
  return new Response('not mocked', { status: 599 })
}

const kv = new FakeKV()
const doStorage = new FakeStorage()
const env = {
  BOT_STATE: kv,
  TELEGRAM_BOT_TOKEN: 'TEST:TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'sekret',
  GITHUB_TOKEN: 'ghp_x',
  GITHUB_REPO: 'example/repo',
}
const botDo = new worker.BotState({ storage: doStorage }, env)
let doQueue = Promise.resolve()
const serializedDo = new Proxy(botDo, {
  get(target, prop) {
    const v = target[prop]
    if (typeof v !== 'function') return v
    return (...args) => { const run = doQueue.then(() => v.apply(target, args)); doQueue = run.catch(() => {}); return run }
  },
})
env.BOT_DO = { idFromName: n => n, get: () => serializedDo }

const OWNER = '111'
function resetState({ allowFrom = [OWNER], subscribers = [OWNER], pending = {} } = {}) {
  doStorage.map.clear(); kv.map.clear()
  doStorage.map.set('access', { dmPolicy: 'allowlist', allowFrom: [...allowFrom], ownerChatId: OWNER, pending: structuredClone(pending) })
  doStorage.map.set('subscribers', { subscribers: [...subscribers], owner: OWNER })
  fetchLog = []
}
let UID = 5000
function upd(fromId, text) {
  return { update_id: UID++, message: { message_id: UID, chat: { id: Number(fromId), type: 'private' }, from: { id: Number(fromId), first_name: 'U' + fromId }, text } }
}
async function send(update) {
  const req = new Request('https://bot.test/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sekret' }, body: JSON.stringify(update) })
  return worker.default.fetch(req, env)
}
const tgSends = () => fetchLog.filter(c => c.url.includes('api.telegram.org') && c.url.endsWith('/sendMessage')).length

function gc() { if (global.gc) { global.gc(); global.gc() } }
function memMB() { const m = process.memoryUsage(); return { rss: m.rss / 1048576, heap: m.heapUsed / 1048576 } }

// median helper
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

// ---------- A. STARTUP ----------
console.log('\n=== A. STARTUP ===')
console.log(`Worker module import + eval: ${importMs.toFixed(2)} ms (one-time isolate cold cost; single ~800-line file)`)
// Cold first request triggers DO getAccess() migration read from KV.
resetState()
kv.map.set('access', JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER], ownerChatId: OWNER, pending: {} }))
doStorage.map.delete('access') // force first-touch migration path
let tc = performance.now()
await send(upd(OWNER, '/status'))
const coldMs = performance.now() - tc
tc = performance.now()
await send(upd(OWNER, '/status'))
const warmMs = performance.now() - tc
console.log(`Cold first request (DO migrates access from KV): ${coldMs.toFixed(2)} ms`)
console.log(`Warm request (DO hydrated):                      ${warmMs.toFixed(2)} ms`)

// ---------- B. PER-COMMAND LATENCY + CPU (warm, median of 200) ----------
console.log('\n=== B. PER-COMMAND LATENCY + CPU (median of 200 warm runs, network stubbed) ===')
const smallMd = '# Daily AI Recruitment Briefing — 2 July 2026\n\n' +
  Array.from({ length: 5 }, (_, i) => `- **Story ${i}** — a one sentence summary here. (source.com)`).join('\n')
async function bench(label, prep, run) {
  resetState({ allowFrom: [OWNER, '222'], subscribers: [OWNER] })
  if (prep) await prep()
  // warmup
  for (let i = 0; i < 20; i++) await run()
  const walls = [], cpus = []
  for (let i = 0; i < 200; i++) {
    fetchLog = []
    const c0 = process.cpuUsage(); const w0 = performance.now()
    await run()
    walls.push(performance.now() - w0)
    const c = process.cpuUsage(c0); cpus.push((c.user + c.system) / 1000)
  }
  console.log(`  ${label.padEnd(34)} wall ${med(walls).toFixed(3)} ms | cpu ${med(cpus).toFixed(3)} ms | subreq ${tgSends()}`)
}
await bench('/status (allowed)', null, () => send(upd(OWNER, '/status')))
await bench('/start (new, notifies owner)', () => { doStorage.map.get('access').allowFrom.length = 0; doStorage.map.set('access', { dmPolicy: 'allowlist', allowFrom: [], ownerChatId: OWNER, pending: {} }) }, () => send(upd('900' + (UID % 100), '/start')))
await bench('/subscribe (churn add/remove)', null, async () => { await send(upd('222', '/subscribe')); await send(upd('222', '/unsubscribe')) })
await bench('/briefing (cached, 5-story md)', () => { kv.map.set('today_briefing_date', todayStr()); kv.map.set('today_briefing_md', smallMd) }, () => send(upd(OWNER, '/briefing')))
await bench('/admin (owner panel)', null, () => send(upd(OWNER, '/admin')))
function todayStr() { return new Date().toISOString().slice(0, 10) }

// ---------- C. BROADCAST FAN-OUT STRESS (the subrequest-cap dimension) ----------
console.log('\n=== C. BROADCAST FAN-OUT @ scale (single Worker invocation) ===')
console.log('  Cloudflare subrequest cap: 50 (free) / 1000 (paid). Telegram sendMessage = 1 subrequest each.')
console.log('  users |  subreq | wall ms |  cpu ms | peak heap MB | verdict')
for (const N of [10, 50, 100, 500, 1000]) {
  const subs = Array.from({ length: N }, (_, i) => String(200000 + i))
  resetState({ allowFrom: [OWNER, ...subs], subscribers: subs })
  gc(); const m0 = memMB()
  const c0 = process.cpuUsage(); const w0 = performance.now()
  await send(upd(OWNER, '/broadcast hello everyone this is a test message'))
  const wall = performance.now() - w0
  const cpu = (() => { const c = process.cpuUsage(c0); return (c.user + c.system) / 1000 })()
  const m1 = memMB()
  const sub = tgSends()
  const free = sub <= 50 ? 'OK' : 'OVER free cap'
  const paid = sub <= 1000 ? '' : ' / OVER paid cap'
  console.log(`  ${String(N).padStart(5)} | ${String(sub).padStart(7)} | ${wall.toFixed(1).padStart(7)} | ${cpu.toFixed(1).padStart(7)} | ${(m1.heap).toFixed(1).padStart(12)} | ${free}${paid}`)
}

// ---------- D. CONCURRENT COMMAND THROUGHPUT (singleton DO serialization) ----------
console.log('\n=== D. CONCURRENT /subscribe THROUGHPUT (N distinct users at once, one singleton DO) ===')
console.log('  users | total ms | ms/op | ops/sec (DO-serialized)')
for (const N of [10, 50, 100, 500, 1000]) {
  const ids = Array.from({ length: N }, (_, i) => String(300000 + i))
  resetState({ allowFrom: [OWNER, ...ids], subscribers: [] })
  const updates = ids.map(id => upd(id, '/subscribe'))
  const w0 = performance.now()
  await Promise.all(updates.map(u => send(u)))         // fire all concurrently
  const wall = performance.now() - w0
  console.log(`  ${String(N).padStart(5)} | ${wall.toFixed(1).padStart(8)} | ${(wall / N).toFixed(3).padStart(5)} | ${(1000 * N / wall).toFixed(0).padStart(8)}`)
}

// ---------- E. STATE / MEMORY FOOTPRINT ----------
console.log('\n=== E. STATE FOOTPRINT (serialized KV/DO value sizes) ===')
console.log('  users | subscribers JSON | usage_stats last_seen JSON | DO in-mem subs array (approx)')
for (const N of [10, 50, 100, 500, 1000]) {
  const subs = Array.from({ length: N }, (_, i) => String(200000 + i))
  const subsJson = JSON.stringify({ subscribers: subs, owner: OWNER }).length
  const lastSeen = {}; for (const s of subs) lastSeen[s] = '2026-07-02'
  const statsJson = JSON.stringify({ last_seen: lastSeen }).length
  console.log(`  ${String(N).padStart(5)} | ${(subsJson + ' B').padStart(16)} | ${(statsJson + ' B').padStart(26)} | ${((N * 8 / 1024).toFixed(1) + ' KB').padStart(12)}`)
}

// ---------- F. API-USAGE MODEL (derived, incl. real Telegram rate limit) ----------
console.log('\n=== F. API USAGE per operation (external calls) ===')
console.log('  Daily briefing run:  1 Claude(-p) generation + 1 GitHub dispatch(n/a for cron) + N Telegram sendMessage (Actions runner: no subrequest cap, bounded by Telegram ~30 msg/s)')
console.log('  /newbriefing:        1 GitHub repository_dispatch (Worker) -> 1 Claude generation + 1 Telegram send (runner)')
console.log('  /briefing (cached):  ceil(html/3500) Telegram sendMessage, 0 Claude, 0 GitHub')
console.log('  /broadcast:          N+2 Telegram sendMessage in ONE Worker invocation (subrequest-capped)')
console.log('  Daily-send wall time under Telegram 30 msg/s limit:')
for (const N of [10, 50, 100, 500, 1000]) {
  console.log(`    ${String(N).padStart(5)} users -> ~${(N / 30).toFixed(1)}s of sends (before any 429 backoff)`)
}

console.log('\nDone.')
