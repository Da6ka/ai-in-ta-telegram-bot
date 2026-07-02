// Registers the bot's command list with Telegram (setMyCommands), which is
// what populates the "/" autocomplete and the Menu button in every client.
// The webhook handler in worker/src/index.js processes commands but never
// registers them, so without this the client shows no command menu at all.
//
// Run once after deploy (and again whenever the command set changes):
//   TELEGRAM_BOT_TOKEN=... \
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... CF_KV_NAMESPACE_ID=... \
//   node scripts/set-commands.mjs
//
// The owner chat id is read from the live `access` KV key so the owner-only
// menu always matches the deployment. Override with OWNER_CHAT_ID=... to skip
// the KV lookup (e.g. if you don't want to hand this script CF credentials).

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')

// Commands every user sees. Order here is the order shown in the menu.
const PUBLIC_COMMANDS = [
  { command: 'briefing', description: "Get today's AI recruitment briefing" },
  { command: 'newbriefing', description: 'Generate a fresh briefing now' },
  { command: 'subscribe', description: 'Get the briefing every morning' },
  { command: 'unsubscribe', description: 'Stop the daily briefing' },
  { command: 'status', description: 'Check your access status' },
  { command: 'help', description: 'What this bot does' },
  { command: 'privacy', description: 'How your data is handled' },
  { command: 'mydata', description: "See what's stored about you" },
  { command: 'forgetme', description: 'Erase your data' },
]

// Owner-only admin commands, appended for the owner's chat scope only — so
// they never appear in a regular user's menu. (Real gating is still enforced
// in the Worker by chat_id; this is just discoverability + tidiness.)
const OWNER_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'admin', description: 'Admin dashboard' },
  { command: 'listusers', description: 'List allowlisted users' },
  { command: 'pending', description: 'List pending access requests' },
  { command: 'adduser', description: 'Allowlist a user by id' },
  { command: 'removeuser', description: 'Remove a user and erase their data' },
  { command: 'broadcast', description: 'Message all subscribers' },
]

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${method} failed: ${json.error_code} ${json.description}`)
  return json
}

async function resolveOwnerId() {
  if (process.env.OWNER_CHAT_ID) return String(process.env.OWNER_CHAT_ID)
  const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID } = process.env
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) return null
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/access`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`KV get access failed: ${res.status} ${await res.text()}`)
  return JSON.parse(await res.text()).ownerChatId || null
}

// Default scope: the public list for everyone.
await tg('setMyCommands', { commands: PUBLIC_COMMANDS })
console.log(`Set ${PUBLIC_COMMANDS.length} default commands.`)

// Owner scope: public + admin, only in the owner's own chat.
const ownerId = await resolveOwnerId()
if (ownerId) {
  await tg('setMyCommands', { commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: Number(ownerId) } })
  console.log(`Set ${OWNER_COMMANDS.length} owner commands for chat ${ownerId}.`)
} else {
  console.log('No owner chat id (set OWNER_CHAT_ID or provide CF_* creds) — skipped owner-scoped menu.')
}
