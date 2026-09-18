/**
 * Offline exercise of a POSIX (claude-style) node: the plugin's remote
 * directory routes and chunked transfers drive `bash`, and the fake node really
 * runs each command through `sh -c` inside a temp fixture, so the POSIX wording
 * is executed rather than pattern-matched. The codex/PowerShell wording stays
 * covered by `local-check.mjs` and `mirror-check.mjs`.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apply } from '../index.js'

const run = promisify(execFile)
const sandbox = await mkdtemp(join(tmpdir(), 'devspace-posix-'))
const dshHome = join(sandbox, 'dsh')
const remoteRoot = join(sandbox, 'gpt-workspace')
const mirrorRoot = join(sandbox, 'mirror')
await mkdir(join(remoteRoot, 'sub', 'nested'), { recursive: true })
await mkdir(join(remoteRoot, '.hidden'), { recursive: true })
const payload = Buffer.alloc(40 * 1024)
for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
await writeFile(join(remoteRoot, 'sub', 'data.bin'), payload)
await mkdir(dshHome, { recursive: true })

const warnings = []
const tools = new Map()
const routes = []
const mounted = new Map()
const registry = new Map()
const started = []
let skillProvider = null

/** The node's own `bash` tool, executed for real in the fixture tree. */
async function executeNodeTool(name, args) {
  if (name.endsWith('__open_workspace')) {
    return { isError: false, content: [{ type: 'text', text: `Opened workspace ws_posix01 for ${String(args.path)}.` }] }
  }
  const cwd = typeof args.workingDirectory === 'string' && args.workingDirectory.length > 0
    ? join(remoteRoot, args.workingDirectory)
    : remoteRoot
  try {
    const { stdout } = await run('/bin/sh', ['-c', String(args.command ?? '')], { cwd, maxBuffer: 8 * 1024 * 1024 })
    return { isError: false, content: [{ type: 'text', text: stdout }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.stdout ?? error?.message ?? error) }] }
  }
}

const ctx = {
  logger: { warn: message => warnings.push(String(message)), info: () => {}, error: () => {} },
  effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
  get(key) {
    if (key === 'workspaceRegistry') {
      return {
        create: async (path, title) => {
          const id = `wsp-${String(registry.size + 1)}`
          const workspace = { id, path, title: title ?? path.split('/').pop(), sessionIds: [] }
          registry.set(id, workspace)
          return workspace
        },
        delete: async id => registry.delete(id),
        get: id => registry.get(id),
        list: () => [...registry.values()],
      }
    }
    return undefined
  },
  tools: {
    register(definition) { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } },
    schemas: () => [...tools.keys()].map(name => ({ name })),
    async execute(exec) {
      const name = String(exec.name)
      if (!name.startsWith('mcp__')) throw new Error(`unexpected tool ${name}`)
      return await executeNodeTool(name, exec.arguments ?? {})
    },
  },
  webServer: { register(route) { routes.push(route); return () => {} } },
  loader: { entries: () => [], import: async () => ({ apply() {} }) },
  /** The MCP bridge mount: this node publishes `bash`, not `exec_command`. */
  plugin(pluginModule, config) {
    const serverName = String(config.serverName)
    const toolName = `mcp__${serverName}__bash`
    tools.set(toolName, { name: toolName })
    mounted.set(serverName, config)
    started.push(serverName)
    const fiber = Promise.resolve()
    fiber.dispose = () => { tools.delete(toolName); mounted.delete(serverName) }
    return fiber
  },
  skills: {
    registerProvider(create) {
      skillProvider = create({ invalidate: () => {}, signal: new AbortController().signal })
      return () => {}
    },
  },
  on() {},
}

apply(ctx, {
  dshHome,
  mirrorRoot,
  nodesFile: join(dshHome, 'devspace-nodes.json'),
  mirrorsFile: join(dshHome, 'devspace-mirrors.json'),
})
await new Promise(resolve => setTimeout(resolve, 50))

const handler = routes[0].handler
/** One fake HTTP call into the plugin's own routes. */
async function callRoute(method, path, body) {
  const req = {
    method,
    url: `/devspace${path}`,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { payload = chunk === undefined ? '' : String(chunk) } }
  await handler(req, res)
  return { status: res.statusCode, json: payload.length === 0 ? null : JSON.parse(payload) }
}

const checks = []
const check = (label, condition, detail) => { checks.push({ label, ok: condition === true, detail }) }

// 1. hot mount a POSIX node
const saved = await callRoute('POST', '/save', {
  node: {
    name: 'devspace-mac',
    label: 'Mac mini',
    url: 'http://joes-mac-mini.example:7676/mcp',
    root: remoteRoot,
    headers: {},
    notes: 'macOS node',
    enabled: true,
  },
})
check('the posix node mounts', mounted.has('devspace-mac'), [...mounted.keys()])
check('its bash tool is published', tools.has('mcp__devspace-mac__bash'), [...tools.keys()])
check('state reports it ready', saved.json?.nodes?.[0]?.name === 'devspace-mac', saved.json?.nodes)

// 2. the directory listing runs through `bash` and reports hidden entries
const listing = await callRoute('POST', '/ls', { node: 'devspace-mac', path: '' })
const names = (listing.json?.entries ?? []).map(entry => entry.name)
check('ls lists the POSIX root', names.includes('sub') && names.includes('.hidden'), names)
check('ls flags the hidden directory', listing.json?.entries?.find(entry => entry.name === '.hidden')?.hidden === true, listing.json?.entries)
check('ls leaves the visible directory unflagged', listing.json?.entries?.find(entry => entry.name === 'sub')?.hidden === false, listing.json?.entries)
const nested = await callRoute('POST', '/ls', { node: 'devspace-mac', path: 'sub' })
check('ls descends into a subdirectory', (nested.json?.entries ?? []).map(entry => entry.name).includes('nested'), nested.json?.entries)
check('ls reports the parent', nested.json?.parent === '', nested.json?.parent)

// 3. mkdir runs POSIX
await callRoute('POST', '/mkdir', { node: 'devspace-mac', path: '', name: 'fresh' })
check('mkdir creates a directory on the node', existsSync(join(remoteRoot, 'fresh')), join(remoteRoot, 'fresh'))

// 4. adopting a subdirectory mirrors it with POSIX wording
const opened = await callRoute('POST', '/open', { node: 'devspace-mac', path: 'sub' })
const localPath = opened.json?.localPath
check('open adopts a remote directory', typeof localPath === 'string' && existsSync(localPath), opened.json)
check('the remote path is spelled POSIX', opened.json?.remotePath === `${remoteRoot}/sub`, opened.json?.remotePath)
const readme = existsSync(join(localPath ?? sandbox, 'AGENTS.md')) ? await readFile(join(localPath, 'AGENTS.md'), 'utf8') : ''
check('the mirror AGENTS.md names the real tools', readme.includes('`bash`') && !readme.includes('`exec_command`'), readme.slice(0, 200))
check('the mirror AGENTS.md spells a POSIX example path', readme.includes(`${remoteRoot}/sub/src/x.ts`), readme.slice(0, 300))

// 5. transfers: pull and push through the POSIX chunk commands
const target = await tools.get('devspace_target').execute({}, { agent: { session: { header: { id: 'session-posix', cwd: localPath } } } })
check('devspace_target resolves the mirror', target.target?.node === 'devspace-mac', target.target)
const pulledTo = join(sandbox, 'pulled.bin')
const pulled = await tools.get('devspace_pull').execute(
  { remotePath: `${remoteRoot}/sub/data.bin`, localPath: pulledTo },
  { agent: { session: { header: { id: 'session-posix', cwd: localPath } } } },
)
check('pull reports the full size', pulled.bytes === payload.length, pulled.bytes)
check('pull content is identical', Buffer.compare(await readFile(pulledTo), payload) === 0, 'bytes differ')

const uploadTo = join(sandbox, 'upload.bin')
const uploadPayload = Buffer.alloc(20 * 1024 + 7)
for (let index = 0; index < uploadPayload.length; index += 1) uploadPayload[index] = (index * 7) % 253
await writeFile(uploadTo, uploadPayload)
const pushed = await tools.get('devspace_push').execute(
  { localPath: uploadTo, remotePath: `${remoteRoot}/sub/uploaded.bin` },
  { agent: { session: { header: { id: 'session-posix', cwd: localPath } } } },
)
check('push reports the full size', pushed.bytes === uploadPayload.length, pushed.bytes)
check('push content is identical', Buffer.compare(await readFile(join(remoteRoot, 'sub', 'uploaded.bin')), uploadPayload) === 0, 'bytes differ')

// 6. the published skill names the node's own tools
const rendered = await skillProvider.get('devspace-nodes')
check('the skill lists the posix node', String(rendered?.content).includes('devspace-mac'), String(rendered?.content).slice(0, 120))
check('the skill names the bash tool set', String(rendered?.content).includes('`bash`') && String(rendered?.content).includes('POSIX'), String(rendered?.content).slice(0, 400))
check('no warnings', warnings.length === 0, warnings)

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `  ${JSON.stringify(item.detail)}`}`)
console.log(`\n${String(checks.filter(item => item.ok).length)}/${String(checks.length)} passed`)
await rm(sandbox, { recursive: true, force: true })
process.exit(checks.every(item => item.ok) ? 0 : 1)
