/**
 * Offline exercise of the DevSpace host half's node surface: the node store, the
 * hot mount/unmount through the MCP bridge, the remote directory routes, the
 * model tool's node actions, and the published skill. The node itself is
 * emulated (an MCP endpoint is a remote process; here a stub answers the
 * plugin's own tool calls), so the whole path runs with no network.
 *
 * The mirror-workspace flow and the chunked transfers live in `mirror-check.mjs`.
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const sandbox = await mkdtemp(join(tmpdir(), 'devspace-nodes-'))
const dshHome = join(sandbox, 'dsh')
const remoteRoot = 'D:\\work\\project'
const mirrorRoot = join(sandbox, 'mirror')
await mkdir(dshHome, { recursive: true })

const warnings = []
const tools = new Map()
const routes = []
const labels = []
const mounted = new Map()
const registry = new Map()
const remoteDirectories = ['test', '.git']
let toolSeq = 0
let skillProvider = null

/** The remote `exec_command` the plugin's routes and tools drive, emulated. */
async function executeNodeTool(name, args) {
  const cmd = String(args.cmd ?? '')
  // The plugin addresses its target as `$p = '<path>'` and passes `-LiteralPath $p`.
  const rel = /\$p = '((?:[^']|'')*)'/.exec(cmd)?.[1]?.replace(/''/g, "'")
    ?? /-(?:Literal)?Path '((?:[^']|'')*)'/.exec(cmd)?.[1]?.replace(/''/g, "'")
    ?? ''
  if (name.endsWith('__open_workspace')) {
    return { isError: false, content: [{ type: 'text', text: `Opened workspace ws_emulated01 for ${String(args.path)}.` }] }
  }
  if (cmd.includes('Get-ChildItem -LiteralPath') || cmd.includes('Get-ChildItem -Directory')) {
    const hidden = new Set(['.git'])
    const body = remoteDirectories.map(entry => `${entry}|${hidden.has(entry) ? '1' : '0'}`).join('\n')
    return { isError: false, content: [{ type: 'text', text: `${body}\nProcess exited with code 0.` }] }
  }
  if (cmd.includes('New-Item -ItemType Directory')) {
    const created = rel.split('\\').pop() ?? ''
    if (created.length > 0 && !remoteDirectories.includes(created)) remoteDirectories.push(created)
    return { isError: false, content: [{ type: 'text', text: `${created}\nProcess exited with code 0.` }] }
  }
  return { isError: false, content: [{ type: 'text', text: 'Process exited with code 0.' }] }
}

const ctx = {
  logger: { warn: message => warnings.push(String(message)), info: () => {}, error: () => {} },
  effect(fn, label) {
    labels.push(label)
    const disposer = fn()
    return () => { if (typeof disposer === 'function') disposer() }
  },
  /** The node service this plugin publishes to other plugins. */
  provide(name, value) { this.services = { ...(this.services ?? {}), [name]: value } },
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
  /** The MCP bridge mount: publishes the node's tools and hands back a fiber. */
  plugin(pluginModule, config) {
    const serverName = String(config.serverName)
    toolSeq += 1
    const toolName = `mcp__${serverName}__probe${String(toolSeq)}`
    tools.set(toolName, { name: toolName })
    mounted.set(serverName, config)
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
const nodeInput = {
  name: 'devspace-win',
  label: 'Windows box',
  url: 'http://192.168.1.10:7676/mcp',
  root: remoteRoot,
  headers: { Authorization: 'Bearer ${NODE_TOKEN}' },
  notes: 'allowed root',
  enabled: true,
}

// 1. nothing configured yet
const empty = await callRoute('GET', '/state')
check('a fresh store has no nodes', empty.json?.nodes?.length === 0, empty.json?.nodes)
check('the skill is inactive with no node', empty.json?.skill?.active === false, empty.json?.skill)
check('the mirror root is reported', empty.json?.mirrorRoot === mirrorRoot, empty.json?.mirrorRoot)

// 2. a node mounts hot, and its tools appear under mcp__<node>__*
const saved = await callRoute('POST', '/save', { node: nodeInput })
const record = saved.json?.nodes?.[0]
check('save mounts the node', record?.state === 'ready', record)
check('the mount received the resolved config', mounted.get('devspace-win')?.url === nodeInput.url, mounted.get('devspace-win'))
check('an unresolved ${VAR} is reported', saved.json?.unresolved?.includes('NODE_TOKEN'), saved.json?.unresolved)
check('the node tool count is live', record?.toolCount === 1, record?.toolCount)

// 3. the skill renders from the live node list
const rendered = await skillProvider.get('devspace-nodes')
check('the skill is published once a node is enabled', (await skillProvider.list()).length === 1, await skillProvider.list())
check('the skill names the node', String(rendered?.content).includes('devspace-win'), String(rendered?.content).slice(0, 80))
check('the skill separates remote from the mirror', String(rendered?.content).includes('镜像工作区'), null)
check('the skill teaches the transfer tools', String(rendered?.content).includes('devspace_pull'), null)

// 4. remote directory routes
const listed = await callRoute('POST', '/ls', { node: 'devspace-win', path: '' })
check('ls returns the node root', listed.json?.root === remoteRoot, listed.json?.root)
check('ls flags hidden entries', listed.json?.entries?.find(entry => entry.name === '.git')?.hidden === true, listed.json?.entries)
check('ls marks visible entries', listed.json?.entries?.find(entry => entry.name === 'test')?.hidden === false, listed.json?.entries)
const sub = await callRoute('POST', '/ls', { node: 'devspace-win', path: 'test' })
check('ls descends into a subdirectory', sub.json?.parent === '' && sub.json?.path === 'test', sub.json)
await callRoute('POST', '/mkdir', { node: 'devspace-win', path: '', name: 'fresh' })
check('mkdir creates a directory', remoteDirectories.includes('fresh'), remoteDirectories)

// 5. the model tool's node actions
const admin = tools.get('devspace_admin')
const status = await admin.execute({ action: 'status' }, {})
check('admin status reports the node list', status?.nodes?.length === 1, status?.nodes)
const added = await admin.execute({ action: 'add', name: 'devspace-linux', url: 'http://192.168.1.20:7676/mcp', root: '/srv/project' }, {})
check('admin add mounts a second node', added?.nodes?.length === 2 && mounted.has('devspace-linux'), [...mounted.keys()])
const disabled = await admin.execute({ action: 'disable', name: 'devspace-linux' }, {})
check('admin disable unmounts it', disabled?.nodes?.find(node => node.name === 'devspace-linux')?.state === 'disabled', disabled?.nodes)
check('the unmounted node has no tools left', ![...tools.keys()].some(name => name.startsWith('mcp__devspace-linux__')), [...tools.keys()])
await admin.execute({ action: 'remove', name: 'devspace-linux' }, {})

// 6. the mirror actions ride the same tool
const rootChanged = await admin.execute({ action: 'mirrorRoot', localRoot: join(sandbox, 'mirror2') }, {})
check('admin mirrorRoot moves the root', rootChanged?.mirrorRoot === join(sandbox, 'mirror2'), rootChanged?.mirrorRoot)
const opened = await admin.execute({ action: 'open', name: 'devspace-win', path: 'test' }, {})
check('admin open adopts a remote directory', typeof opened?.localWorkspaceId === 'string', opened)
check('the mirror directory exists', existsSync(String(opened?.localPath)), opened?.localPath)
check('the mirror carries its AGENTS.md', existsSync(join(String(opened?.localPath), 'AGENTS.md')), null)
const mirrors = await admin.execute({ action: 'mirrors' }, {})
check('admin mirrors lists it', mirrors?.mirrors?.length === 1, mirrors?.mirrors)
const dropped = await admin.execute({ action: 'unmirror', workspaceId: opened.localWorkspaceId }, {})
check('admin unmirror drops the registration', dropped?.removed === opened.localWorkspaceId, dropped)
check('the local mirror directory survives', existsSync(String(opened?.localPath)), null)

// 7. devspace_target has no answer outside a mirror
const target = await tools.get('devspace_target').execute({}, { agent: { session: { header: { id: 'session-x', cwd: sandbox } } } })
check('devspace_target is null outside a mirror', target.target === null, target.target)

// 8. removing the node unmounts it and deactivates the skill
const deleted = await callRoute('POST', '/delete', { name: 'devspace-win' })
check('delete empties the store', deleted.json?.nodes?.length === 0, deleted.json?.nodes)
check('delete unmounts the bridge', mounted.size === 0, [...mounted.keys()])
check('the skill deactivates again', deleted.json?.skill?.active === false, deleted.json?.skill)

// 9. the store is a real file on disk
const stored = JSON.parse(await readFile(join(dshHome, 'devspace-nodes.json'), 'utf8')).nodes
check('the node store is persisted', Array.isArray(stored) && stored.length === 0, stored)
check('no warnings', warnings.length === 0, warnings)

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `  ${JSON.stringify(item.detail)}`}`)
console.log(`\n${String(checks.filter(item => item.ok).length)}/${String(checks.length)} passed`)
await rm(sandbox, { recursive: true, force: true })
process.exit(checks.every(item => item.ok) ? 0 : 1)
