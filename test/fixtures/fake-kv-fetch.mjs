// Preload for test/sync-kv.test.mjs: replaces fetch with an in-memory KV seeded
// from FAKE_KV_SEED (JSON) and dumps every PUT to FAKE_KV_PUTS on exit.
import { writeFileSync } from 'node:fs'

const store = new Map(Object.entries(JSON.parse(process.env.FAKE_KV_SEED ?? '{}')))
const puts = []
globalThis.fetch = async (url, init = {}) => {
  const key = new URL(url).pathname.split('/values/')[1]
  if ((init.method ?? 'GET') === 'PUT') {
    puts.push(key)
    store.set(key, init.body)
    return new Response('{}', { status: 200 })
  }
  return store.has(key) ? new Response(store.get(key), { status: 200 }) : new Response('', { status: 404 })
}
process.on('exit', () => writeFileSync(process.env.FAKE_KV_PUTS, JSON.stringify({ puts, store: Object.fromEntries(store) })))
