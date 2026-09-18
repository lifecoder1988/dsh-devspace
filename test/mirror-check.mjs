/**
 * Offline exercise of the DevSpace host half: the mirror-workspace flow, the
 * Settings routes, the cwd-based target resolution, and both chunked transfers.
 * The MCP node is emulated locally (PowerShell scripts are recognised by shape)
 * so the whole host path runs without the harness or the Windows machine.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const sandbox = await mkdtemp(join(tmpdir(), 'devspace-test-'))
const remoteRoot = join(sandbox, 'remote')
const mirrorRoot = join(sandbox, 'mirror')
const dshHome = join(sandbox, 'dsh')
await mkdir(join(remoteRoot, 'test'), { recursive: true })
await writeFile(join(remoteRoot, 'test', 'hello.txt'), 'hello remote\n', 'utf8')
const big = Buffer.alloc(400 * 1024)
for (let index = 0; index < big.length; index += 1) big[index] = index % 251
await writeFile(join(remoteRoot, 'test', 'big.bin'), big)
await mkdir(dshHome, { recursive: true })
await writeFile(join(dshHome, 'devspace-nodes.json'), JSON.stringify({
  version: 1,
  nodes: [{
    name: 'devspace-win', label: 'Windows 桌面机', root: remoteRoot,
    url: 'http://127.0.0.1:1/mcp', headers: {}, notes: '', enabled: false,
    toolCallTimeoutMs: 5000, failOnStartupError: false,
  }],
}, null, 2))

const warnings = []
const tools = new Map()
const routes = []
const registered = []
let createdWorkspaces = []
const mirrorsFixtures = new Map()
let workspaceSeq = 0

/** Read one PowerShell single-quoted literal out of an emulated command. */
function literals(cmd) {
  const found = []
  const pattern = /'((?:[^']|'')*)'/g
  let match
  while ((match = pattern.exec(cmd)) !== null) found.push(match[1].replace(/''/g, "'"))
  return found
}

let longestCommand = 0
/** The node's own tools, emulated against the local `remoteRoot` tree. */
async function executeNodeTool(name, args) {
  longestCommand = Math.max(longestCommand, String(args.cmd ?? '').length)
  if (name.endsWith('__open_workspace')) {
    return { isError: false, content: [{ type: 'text', text: `Opened workspace ws_emulated01 for ${String(args.path)}.` }] }
  }
  const cmd = String(args.cmd ?? '')
  const quoted = literals(cmd)
  const rel = quoted[0] ?? ''
  const file = join(remoteRoot, rel)
  if (cmd.includes('is-a-directory')) {
    if (!existsSync(file)) return { isError: true, content: [{ type: 'text', text: 'no such file' }] }
    const size = (await readFile(file)).length
    return { isError: false, content: [{ type: 'text', text: `${String(size)}\nProcess exited with code 0.` }] }
  }
  if (cmd.includes('OpenRead(')) {
    const seek = Number(/\$fs\.Seek\((\d+)/.exec(cmd)?.[1] ?? '0')
    const chunk = Number(/byte\[\] (\d+)/.exec(cmd)?.[1] ?? '0')
    const bytes = await readFile(file)
    const slice = bytes.subarray(seek, Math.min(seek + chunk, bytes.length))
    return { isError: false, content: [{ type: 'text', text: `${slice.toString('base64')}\nProcess exited with code 0.` }] }
  }
  if (cmd.includes('[IO.File]::Open(')) {
    const payload = /FromBase64String\('((?:[^']|'')*)'\)/.exec(cmd)?.[1]?.replace(/''/g, "'") ?? ''
    const append = cmd.includes("'Append'")
    const bytes = Buffer.from(payload, 'base64')
    const previous = append && existsSync(file) ? await readFile(file) : Buffer.alloc(0)
    await mkdir(join(file, '..'), { recursive: true })
    const merged = Buffer.concat([previous, bytes])
    await writeFile(file, merged)
    return { isError: false, content: [{ type: 'text', text: `${String(merged.length)}\nProcess exited with code 0.` }] }
  }
  if (cmd.includes('Get-ChildItem -Directory')) {
    return { isError: false, content: [{ type: 'text', text: 'test|0\nProcess exited with code 0.' }] }
  }
  return { isError: false, content: [{ type: 'text', text: 'Process exited with code 0.' }] }
}

const ctx = {
  logger: { warn: message => warnings.push(String(message)), info: () => {}, error: () => {} },
  effect(fn, label) {
    const disposer = fn()
    registered.push(label)
    return () => { if (typeof disposer === 'function') disposer() }
  },
  /** The node service this plugin publishes to other plugins. */
  provide(name, value) { this.services = { ...(this.services ?? {}), [name]: value } },
  get(key) {
    if (key === 'workspaceRegistry') {
      return {
        async create(path, title) {
          const existing = [...mirrorsFixtures.values()].find(entry => entry.path === path)
          if (existing !== undefined) return existing
          workspaceSeq += 1
          const workspace = { id: `wsp-${String(workspaceSeq)}`, path, title: title ?? path.split('/').pop(), sessionIds: [] }
          mirrorsFixtures.set(workspace.id, workspace)
          createdWorkspaces.push(workspace)
          return workspace
        },
        async delete(id) { createdWorkspaces = createdWorkspaces.filter(entry => entry.id !== id); return mirrorsFixtures.delete(id) },
        get: id => mirrorsFixtures.get(id),
        list: () => [...mirrorsFixtures.values()],
      }
    }
    return undefined
  },
  tools: {
    register(definition) { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } },
    schemas: () => [...tools.values()].map(definition => ({ name: definition.name })),
    async execute(exec) {
      if (String(exec.name).startsWith('mcp__')) {
        return await executeNodeTool(String(exec.name), exec.arguments ?? {})
      }
      throw new Error(`unexpected tool ${String(exec.name)}`)
    },
  },
  webServer: { register(route) { routes.push(route); return () => {} } },
  loader: { entries: () => [], import: async () => ({ apply() {} }) },
  skills: {
    registerProvider(create) {
      const provider = create({ invalidate: () => {}, signal: new AbortController().signal })
      ctx.__skill = provider
      return () => {}
    },
  },
  on() {},
  loader_: undefined,
}
// The plugin's own `self` handle comes from the provider control, which the real
// harness passes in; emulate the same shape.
ctx.skills.registerProvider = (create) => {
  const provider = create({ invalidate: () => {}, signal: new AbortController().signal })
  ctx.__skill = provider
  return () => {}
}

apply(ctx, { dshHome, mirrorRoot, nodesFile: join(dshHome, 'devspace-nodes.json'), mirrorsFile: join(dshHome, 'devspace-mirrors.json') })
await new Promise(resolve => setTimeout(resolve, 50))

const handler = routes[0].handler
/** One fake HTTP call into the plugin's own routes. */
async function callRoute(method, path, body) {
  const req = { method, url: `/devspace${path}`, headers: {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
  let status = 0
  let payload = ''
  const res = {
    setHeader() {},
    end(chunk) { payload = chunk === undefined ? '' : String(chunk) },
    get statusCode() { return status },
    set statusCode(value) { status = value },
  }
  await handler(req, res)
  return { status: res.statusCode, json: payload.length === 0 ? null : JSON.parse(payload) }
}

const checks = []
const check = (label, condition, detail) => { checks.push({ label, ok: condition === true, detail }) }

// 1. tools and routes are in place
check('tools registered', ['devspace_admin', 'devspace_target', 'devspace_pull', 'devspace_push'].every(name => tools.has(name)), [...tools.keys()])

// 2. the mirror flow adopts a remote directory
const open = await callRoute('POST', '/open', { node: 'devspace-win', path: 'test' })
const mirrorPath = join(mirrorRoot, 'devspace-win', 'test')
const state = await callRoute('GET', '/state')
check('open status 200', open.status === 200, open.status)
check('local workspace id returned', typeof open.json?.localWorkspaceId === 'string', open.json)
check('mirror directory created', existsSync(mirrorPath), mirrorPath)
check('mirror AGENTS.md written', existsSync(join(mirrorPath, 'AGENTS.md')), null)
check('remote workspace id recorded', open.json?.remoteWorkspaceId === 'ws_emulated01', open.json?.remoteWorkspaceId)
check('state carries the mirror', state.json?.mirrors?.length === 1 && state.json.mirrors[0].localPath === open.json.localPath, state.json?.mirrors)
check('mirror root surfaced', state.json?.mirrorRoot === mirrorRoot, state.json?.mirrorRoot)

// 3. the target resolves from the Session cwd
const target = await tools.get('devspace_target').execute({}, { agent: { session: { header: { id: 'session-1', cwd: mirrorPath } } } })
check('target resolves from cwd', String(target.target?.remotePath ?? '').endsWith('test') && target.target?.node === 'devspace-win' && target.target?.localPath === mirrorPath, target.target)
const outside = await tools.get('devspace_target').execute({}, { agent: { session: { header: { id: 'session-2', cwd: '/tmp' } } } })
check('target null outside a mirror', outside.target === null, outside.target)

// 4. pull: remote -> local, chunked and binary-safe
const pulledPath = join(sandbox, 'pulled.bin')
const pulled = await tools.get('devspace_pull').execute(
  { remotePath: 'big.bin', node: 'devspace-win', localPath: pulledPath },
  { agent: { session: { header: { id: 'session-1', cwd: mirrorPath } } } },
)
const pulledBytes = await readFile(pulledPath)
check('pull reports full size', pulled.bytes === big.length, pulled)
check('pull content identical', Buffer.compare(pulledBytes, big) === 0, `${String(pulledBytes.length)} vs ${String(big.length)}`)

// 5. push: local -> remote, chunked
const uploadSource = join(sandbox, 'upload.bin')
const uploadBytes = Buffer.alloc(300 * 1024)
for (let index = 0; index < uploadBytes.length; index += 1) uploadBytes[index] = (index * 7) % 256
await writeFile(uploadSource, uploadBytes)
const pushed = await tools.get('devspace_push').execute(
  { localPath: uploadSource, node: 'devspace-win', remotePath: 'upload.bin' },
  { agent: { session: { header: { id: 'session-1', cwd: mirrorPath } } } },
)
const remoteWritten = await readFile(join(remoteRoot, 'test', 'upload.bin'))
check('push reports full size', pushed.bytes === uploadBytes.length, pushed)
check('push content identical', Buffer.compare(remoteWritten, uploadBytes) === 0, `${String(remoteWritten.length)}`)
check('push path outside the root refused', await tools.get('devspace_push')
  .execute({ localPath: uploadSource, node: 'devspace-win', remotePath: 'C:/elsewhere/x.bin' }, { agent: { session: { header: { cwd: mirrorPath } } } })
  .then(() => false, error => String(error.message).includes('节点根')), null)

// 6. the mirror root can be changed and a mirror dropped
const rootChange = await callRoute('POST', '/mirror-root', { root: join(sandbox, 'mirror2') })
check('mirror root changed', rootChange.json?.mirrorRoot === join(sandbox, 'mirror2'), rootChange.json?.mirrorRoot)
const dropped = await callRoute('POST', '/unmirror', { workspaceId: open.json.localWorkspaceId })
if (dropped.status !== 200) console.log('unmirror response', dropped.status, JSON.stringify(dropped.json))
check('unmirror empties the list', dropped.json?.mirrors?.length === 0, dropped.json?.mirrors)
check('unmirror keeps the local directory', existsSync(mirrorPath), null)
check('every remote command stays under the Windows 32 KB command line', longestCommand < 30000, longestCommand)
check('no warnings', warnings.length === 0, warnings)

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `  ${JSON.stringify(item.detail)}`}`)
console.log(`\n${String(checks.filter(item => item.ok).length)}/${String(checks.length)} passed`)
await rm(sandbox, { recursive: true, force: true })
process.exit(checks.every(item => item.ok) ? 0 : 1)
