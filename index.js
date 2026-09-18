/**
 * DevSpace — host half.
 *
 * One place to manage N DevSpace nodes. A node IS an MCP server under the hood,
 * but it is owned here rather than on the MCP page: this plugin stores the node
 * list, mounts each enabled node through `@deepseek-ai/dsh-mcp-client`, reports
 * live per-node state, and publishes one global skill describing the nodes and
 * the remote workflow.
 *
 * Picking a remote directory adopts it as a LOCAL mirror workspace: an empty
 * directory under the mirror root (`~/DevSpace/<node>/<path>` by default) that
 * is a real Workspace on this machine, so the Session groups under it in the
 * sidebar. The project itself stays on the node and is only touched through
 * that node's own `mcp__<name>__*` tools; `devspace_pull` / `devspace_push`
 * move files across, and nothing is synced automatically.
 *
 * Stores, all under `$DSH_HOME`:
 *   devspace-nodes.json   { version, nodes: [{ name, label, root, url, headers,
 *                          notes, enabled, toolCallTimeoutMs,
 *                          failOnStartupError }] }
 *   devspace-mirrors.json { version, root, mirrors: { [workspaceId]:
 *                          { node, relative, remotePath, localPath,
 *                            remoteWorkspaceId, title, createdAt } } }
 * `name` doubles as the MCP `serverName` and the tool prefix. Secrets stay in
 * the file as `${VAR}` references resolved from the process environment.
 *
 * Deliberately dependency-free: only `node:*` builtins and Cordis services.
 */

import { existsSync } from 'node:fs'
import { mkdir, open as openFile, readFile, rename, stat as statFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'devspace'

/** Services this plugin consumes. */
export const inject = ['skills', 'tools', 'webServer', 'loader']

/** The MCP bridge mounted once per node. */
const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/devspace'

/** Node name grammar; identical to the MCP bridge's `serverName`. */
const NODE_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** The single skill this plugin publishes. */
const SKILL_NAME = 'devspace-nodes'

/** Bound on one request body. */
const MAX_BODY_BYTES = 1 << 20

/** Default per-call timeout for a node. */
const DEFAULT_TIMEOUT_MS = 120_000

/** An expected refusal with an HTTP status. */
class HttpError extends Error {
  /** @param {number} status - HTTP status. @param {string} message - client-facing message. */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read the node store; a missing or malformed file reads as empty. */
async function readNodes(path, warn) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
    return nodes.filter(node => node !== null && typeof node === 'object' && typeof node.name === 'string')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`devspace: ignoring malformed ${path}: ${messageOf(error)}`)
    return []
  }
}

/** Atomic write with owner-only permissions (headers may carry a token). */
async function writeNodes(path, nodes) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, nodes }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** Resolve `${VAR}` references from the process environment. */
function resolveRefs(text, unresolved) {
  return String(text ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) => {
    const value = process.env[key]
    if (value === undefined) {
      unresolved.add(key)
      return whole
    }
    return value
  })
}

/** One stored node, coerced into the shape the rest of the plugin uses. */
function normalizeNode(input) {
  const nodeName = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!NODE_NAME.test(nodeName)) {
    throw new HttpError(400, `节点名 ${JSON.stringify(input?.name ?? null)} 不合法：只允许 [A-Za-z0-9_-]{1,32}`)
  }
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (url.length === 0) throw new HttpError(400, '节点需要一个 MCP 端点 URL')
  const headers = {}
  if (input.headers !== null && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const timeout = Number(input.toolCallTimeoutMs)
  return {
    name: nodeName,
    label: typeof input.label === 'string' ? input.label.trim() : '',
    // The node's allowed root: browsing and `open_workspace` start here.
    root: typeof input.root === 'string' ? input.root.trim() : '',
    // Optional shell dialect override ('win' | 'posix'); when empty the node's
    // own shell tool decides (see nodeDialect).
    platform: typeof input.platform === 'string' ? input.platform.trim() : '',
    url,
    headers,
    notes: typeof input.notes === 'string' ? input.notes.trim() : '',
    enabled: input.enabled !== false,
    toolCallTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    failOnStartupError: input.failOnStartupError !== false,
  }
}

/** Read the mirror store: which local Workspace mirrors which node directory. */
async function readMirrors(path, warn) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return {
      root: typeof parsed?.root === 'string' && parsed.root.length > 0 ? parsed.root : null,
      mirrors: parsed !== null && typeof parsed.mirrors === 'object' && parsed.mirrors !== null ? parsed.mirrors : {},
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`devspace: ignoring malformed ${path}: ${messageOf(error)}`)
    return { root: null, mirrors: {} }
  }
}

/** Persist the mirror store. */
async function writeMirrors(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, root: value.root, mirrors: value.mirrors }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await rename(temporary, path)
}

/**
 * The mirror one Session runs in: its cwd is the mirror directory itself or a
 * directory below it. The deepest match wins, so a mirror nested inside another
 * (a node root and a subdirectory both adopted) still resolves to the exact one.
 * @param {Record<string, any>} mirrors - stored mirrors by local workspace id.
 * @param {string | undefined} cwd - the Session's working directory.
 * @returns the matching mirror, or undefined.
 */
function mirrorForCwd(mirrors, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  let best
  for (const mirror of Object.values(mirrors)) {
    const base = mirror?.localPath
    if (typeof base !== 'string' || base.length === 0) continue
    const prefix = base.endsWith('/') ? base : `${base}/`
    if (cwd !== base && !cwd.startsWith(prefix)) continue
    if (best === undefined || base.length > best.localPath.length) best = mirror
  }
  return best
}

/** One PowerShell single-quoted literal. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Single-quote one POSIX shell argument (an embedded quote becomes `'\''`). */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * The shell dialect a node speaks, which decides both the script wording and
 * the path spelling. Codex-style nodes publish `exec_command` (the PowerShell
 * wording this plugin has always used); claude-style nodes publish `bash` and
 * get POSIX wording. An operator can force either with the node's `platform`.
 * @param {any} node - the stored node record.
 * @param {string|null} shellTool - the shell tool the node publishes.
 * @returns {'win'|'posix'} the dialect.
 */
function nodeDialect(node, shellTool) {
  const forced = String(node?.platform ?? '').trim().toLowerCase()
  if (['win', 'windows', 'powershell'].includes(forced)) return 'win'
  if (['posix', 'unix', 'linux', 'darwin', 'macos'].includes(forced)) return 'posix'
  return shellTool === 'bash' ? 'posix' : 'win'
}

/** Remote path spelling with forward slashes and no trailing separator. */
function normalizeRemotePath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * The skill body: the node list (with the tools each node actually publishes)
 * plus the rules that are easy to get wrong.
 * @param {any[]} nodes - enabled node records.
 * @param {(name: string) => string[]} [toolsOf] - plain tool names per node.
 */
function renderSkill(nodes, toolsOf) {
  const lines = [
    '# DevSpace 远端节点',
    '',
    `本机挂着 ${String(nodes.length)} 个 DevSpace 节点。**项目本体在远端节点上，本地那个同名目录只是镜像工作区**：用来放下载下来的数据、待上传的产物和本地处理脚本，两边不会自动同步，也不要假设内容一致。`,
    '',
    '## 节点',
    '',
  ]
  for (const node of nodes) {
    const parts = [node.label.length > 0 ? node.label : node.name, node.url, `工具前缀 \`mcp__${node.name}__*\``]
    lines.push(`- \`${node.name}\` — ${parts.join(' · ')}`)
    const tools = typeof toolsOf === 'function' ? toolsOf(node.name) : []
    if (tools.length > 0) {
      const shell = tools.includes('bash') && !tools.includes('exec_command') ? 'bash' : 'exec_command'
      const dialect = nodeDialect(node, shell)
      lines.push(`  - 该节点暴露的工具：${tools.map(name => `\`${name}\``).join(' / ')} · shell：${dialect === 'win' ? 'PowerShell（Windows 路径）' : 'POSIX（类 Unix 路径）'}`)
    }
    if (node.notes.length > 0) lines.push(`  - 备注：${node.notes}`)
  }
  lines.push(
    '',
    '## 用法',
    '',
    '0. 开工前先调一次 `devspace_target`：它按本会话的 cwd 报出远端目标（节点 + 远端目录 + 远端 workspace_id + 本地镜像目录）。有目标就直接复用那个 workspace_id，不要再 `open_workspace`。',
    '1. 没有目标时：一个远端目录调一次 `open_workspace { path }`，拿到 `workspace_id` 之后在所有后续调用里复用；**不同节点的 workspace_id 不通用**。',
    '2. `open_workspace` 的返回里会列出该目录的 `AGENTS.md` / `CLAUDE.md` 与可用技能 —— 先读它们再动手。',
    '3. 改远端代码用**该节点暴露的**编辑工具（`apply_patch`，或 `write` / `edit`），跑命令用它暴露的 shell 工具（`exec_command`，或 `bash`），支持时再用 `write_stdin` 接长任务。**先看上面「节点」一节列出的工具名，别用该节点没有的工具。**',
    '4. 传文件用 `devspace_pull`（远端 → 本地镜像）与 `devspace_push`（本地 → 远端）：二进制安全、按块传输。别手工 base64 搬运，也别假设两边已同步。',
    '5. 本地镜像目录里的文件可以直接用本地工具读写（下载的数据、本地分析脚本都在这里）。',
    '6. 有 `show_changes` 的节点，一轮改动结束、给出最终答复前调一次，让用户看到远端合并 diff。',
    '7. 路径一律写远端形式，并照该节点的平台写：Windows 节点如 `D:\\ai\\项目\\src\\x.ts`，macOS/Linux 节点如 `/Users/joe/code/proj/src/x.ts`；`exec_command` 的退出码在输出末尾（`Process exited with code N`）。',
    '',
  )
  return lines.join('\n')
}

/**
 * Install the DevSpace node manager: the node store, one mounted MCP bridge per
 * enabled node, the global skill, and the Settings routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ dshHome?: string, nodesFile?: string }} [config] - path overrides.
 */
export function apply(ctx, config = {}) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const nodesFile = resolve(config.nodesFile ?? join(dshHome, 'devspace-nodes.json'))
  const warn = message => ctx.logger.warn(message)

  /** Skill provider handle, so a node change can invalidate the catalog. */
  let self = null
  /** Live mount per node name. */
  const applied = new Map()
  /** Serialise reconciles so create/dispose never interleave. */
  let chain = Promise.resolve()
  let callSeq = 0

  /** Every `mcp__<node>__*` tool the registry currently exposes. */
  const toolsFor = (nodeName) => {
    try {
      return ctx.tools.schemas().map(schema => schema.name).filter(schemaName => schemaName.startsWith(`mcp__${nodeName}__`))
    } catch {
      return []
    }
  }

  /** Node names another composition layer already mounts. */
  const compositionNames = () => {
    const names = new Set()
    try {
      for (const entry of ctx.loader.entries()) {
        if (entry.options?.name !== MCP_PLUGIN) continue
        const serverName = entry.options?.config?.serverName
        if (typeof serverName === 'string') names.add(serverName)
      }
    } catch {
      // A composition without a loader simply has no foreign rows.
    }
    return names
  }

  /** The bridge config for one node, with its references resolved. */
  const toClientConfig = (node, unresolved) => {
    const headers = {}
    for (const [key, value] of Object.entries(node.headers)) headers[key] = resolveRefs(value, unresolved)
    return {
      transport: 'streamable-http',
      serverName: node.name,
      url: resolveRefs(node.url, unresolved),
      headers,
      toolCallTimeoutMs: node.toolCallTimeoutMs,
      failOnStartupError: node.failOnStartupError,
    }
  }

  const disposeOne = async (nodeName) => {
    const record = applied.get(nodeName)
    if (record === undefined) return
    applied.delete(nodeName)
    try {
      await record.fiber?.dispose?.()
    } catch (error) {
      warn(`devspace: disposing node "${nodeName}" failed: ${messageOf(error)}`)
    }
  }

  const mountOne = async (node) => {
    const unresolved = new Set()
    const clientConfig = toClientConfig(node, unresolved)
    const record = {
      nodeName: node.name,
      key: JSON.stringify(clientConfig),
      state: 'connecting',
      error: null,
      unresolved: [...unresolved],
      fiber: undefined,
      toolCount: 0,
    }
    applied.set(node.name, record)
    try {
      // `loader.import` is composeError-wrapped around an async callback, so it
      // resolves to the module namespace rather than returning it.
      const imported = await ctx.loader.import(MCP_PLUGIN)
      const plugin = typeof imported?.apply === 'function'
        ? imported
        : typeof imported?.default?.apply === 'function'
          ? imported.default
          : undefined
      if (plugin === undefined) throw new Error(`${MCP_PLUGIN} exposes no plugin`)
      const fiber = ctx.plugin(plugin, clientConfig)
      record.fiber = fiber
      await fiber
      record.state = 'ready'
      record.toolCount = toolsFor(node.name).length
    } catch (error) {
      record.state = 'error'
      record.error = messageOf(error)
      try {
        await record.fiber?.dispose?.()
      } catch {
        // A failed startup already rolled the fiber back.
      }
      record.fiber = undefined
    }
  }

  /**
   * Bring live mounts in line with the stored node list.
   * @param {boolean} retryErrors - whether failing nodes are mounted again.
   * @returns {Promise<void>} after quiescence.
   */
  const reconcile = (retryErrors = false) => {
    chain = chain.then(async () => {
      const nodes = await readNodes(nodesFile, warn)
      const foreign = compositionNames()
      const desired = new Map()
      for (const node of nodes) {
        if (node.enabled === false) continue
        desired.set(node.name, node)
      }
      for (const [nodeName, record] of [...applied]) {
        const next = desired.get(nodeName)
        if (next === undefined) {
          await disposeOne(nodeName)
          continue
        }
        const key = JSON.stringify(toClientConfig(next, new Set()))
        if (key !== record.key || (retryErrors && record.state === 'error')) await disposeOne(nodeName)
      }
      for (const [nodeName, node] of desired) {
        if (applied.has(nodeName)) continue
        if (foreign.has(nodeName)) {
          applied.set(nodeName, {
            nodeName, key: '', state: 'conflict', fiber: undefined, toolCount: 0, unresolved: [],
            error: `节点 "${nodeName}" 已由另一行 composition 提供（cordis.patch.yml）；要交给本插件管理，请删除那一行并重启`,
          })
          continue
        }
        await mountOne(node)
      }
      self?.invalidate()
    }).catch(error => {
      warn(`devspace: reconcile failed: ${messageOf(error)}`)
    })
    return chain
  }

  /** The full UI state. */
  const buildState = async () => {
    const nodes = await readNodes(nodesFile, warn)
    const foreign = compositionNames()
    const unresolvedAll = new Set()
    const list = nodes.map((node) => {
      const live = applied.get(node.name)
      toClientConfig(node, unresolvedAll)
      return {
        ...node,
        state: node.enabled === false
          ? 'disabled'
          : live === undefined
            ? 'pending'
            : live.state,
        error: live?.error ?? null,
        toolCount: live?.state === 'ready' ? toolsFor(node.name).length : 0,
        fromComposition: foreign.has(node.name),
      }
    })
    const mirrorList = await listMirrors()
    return {
      nodes: list,
      nodesFile,
      mirrorRoot: mirrorList.mirrorRoot,
      mirrors: mirrorList.mirrors,
      skill: { name: SKILL_NAME, active: list.some(node => node.enabled !== false) },
      unresolved: [...unresolvedAll],
      envSources: ['process.env'],
      plugin: MCP_PLUGIN,
    }
  }

  /** Upsert one node, then apply the change. */
  const saveNode = async (input) => {
    const raw = input?.node ?? input
    const existing = (await readNodes(nodesFile, warn)).find(node => node.name === raw?.name)
    const node = normalizeNode({
      ...existing,
      ...raw,
      // A missing field in a partial update keeps what was stored.
      headers: raw?.headers ?? existing?.headers,
      enabled: raw?.enabled ?? existing?.enabled ?? true,
      failOnStartupError: raw?.failOnStartupError ?? existing?.failOnStartupError ?? true,
      toolCallTimeoutMs: raw?.toolCallTimeoutMs ?? existing?.toolCallTimeoutMs,
    })
    const nodes = await readNodes(nodesFile, warn)
    const index = nodes.findIndex(entry => entry.name === node.name)
    if (index >= 0) nodes[index] = node
    else nodes.push(node)
    await writeNodes(nodesFile, nodes)
    await reconcile(true)
    return buildState()
  }

  /** Remove one node and unmount it. */
  const deleteNode = async (input) => {
    const nodeName = typeof input?.name === 'string' ? input.name : ''
    if (!NODE_NAME.test(nodeName)) throw new HttpError(400, '节点名不合法')
    const nodes = await readNodes(nodesFile, warn)
    const remaining = nodes.filter(node => node.name !== nodeName)
    if (remaining.length === nodes.length) throw new HttpError(404, `没有名为 "${nodeName}" 的节点`)
    await writeNodes(nodesFile, remaining)
    await reconcile(false)
    return buildState()
  }

  /** Enable or disable one node. */
  const toggleNode = async (input) => {
    const nodeName = typeof input?.name === 'string' ? input.name : ''
    if (!NODE_NAME.test(nodeName)) throw new HttpError(400, '节点名不合法')
    const nodes = await readNodes(nodesFile, warn)
    const node = nodes.find(entry => entry.name === nodeName)
    if (node === undefined) throw new HttpError(404, `没有名为 "${nodeName}" 的节点`)
    node.enabled = input?.enabled !== false
    await writeNodes(nodesFile, nodes)
    await reconcile(false)
    return buildState()
  }

  // ---- remote directory browsing and local mirror workspaces ---------

  const mirrorsFile = resolve(config.mirrorsFile ?? join(dshHome, 'devspace-mirrors.json'))
  /** Where local mirror workspaces live unless the operator picked another root. */
  const defaultMirrorRoot = resolve(config.mirrorRoot ?? join(homedir(), 'DevSpace'))
  /** Above this, one transfer call refuses instead of running for hours. */
  const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
  /**
   * Transfer chunk sizes, one per direction, because the two directions hit
   * different ceilings and base64 inflates by 4/3:
   *
   * - Downloading, the chunk rides in the MCP *response*; the Express server in
   *   front of the node is only size-limited on request bodies, so 48 KiB raw
   *   (~64 KiB of base64) is comfortable.
   * - Uploading, the chunk rides in the remote PowerShell *command line*, and
   *   Windows refuses a command line past 32 KB — so 16 KiB raw (~22 KB of
   *   base64 plus the script) stays well clear of it.
   *
   * Both are configurable (`pullChunkBytes` / `pushChunkBytes`) for nodes whose
   * transport allows more.
   */
  const chunkBytes = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback)
  const pullChunkBytes = chunkBytes(config.pullChunkBytes ?? config.transferChunkBytes, 48 * 1024)
  const pushChunkBytes = chunkBytes(config.pushChunkBytes ?? config.transferChunkBytes, 16 * 1024)
  /** Lazily opened workspace id per node, for calls that need one. */
  const rootWorkspaces = new Map()

  /** Dispatch one of a node's own MCP tools. */
  const callNode = (nodeName, tool, args, signal) => {
    callSeq += 1
    return ctx.tools.execute({
      callId: `devspace-${String(callSeq)}-${String(Date.now())}`,
      name: `mcp__${nodeName}__${tool}`,
      arguments: args,
      signal: signal ?? AbortSignal.timeout(180_000),
    })
  }

  const resultText = result => (Array.isArray(result?.content)
    ? result.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    : '')

  /** Find one stored node by name. */
  const requireNode = async (nodeName) => {
    if (typeof nodeName !== 'string' || !NODE_NAME.test(nodeName)) throw new HttpError(400, '节点名不合法')
    const node = (await readNodes(nodesFile, warn)).find(entry => entry.name === nodeName)
    if (node === undefined) throw new HttpError(404, `没有名为 "${nodeName}" 的节点`)
    return node
  }

  /** The workspace id that addresses a node's allowed root, opened once. */
  const workspaceIdForRoot = async (node) => {
    const cached = rootWorkspaces.get(node.name)
    if (cached !== undefined && cached.root === node.root) return cached.workspaceId
    const root = String(node.root ?? '')
    if (root.length === 0) throw new HttpError(409, `节点 "${node.name}" 还没填允许根目录（root），无法浏览远端目录`)
    const result = await callNode(node.name, 'open_workspace', { path: root })
    const text = resultText(result)
    const match = /\b(ws_[A-Za-z0-9_-]{4,})\b/.exec(text)
    if (match === null) throw new HttpError(502, `open_workspace 没有返回 workspace_id：${text.slice(0, 300)}`)
    rootWorkspaces.set(node.name, { root: node.root, workspaceId: match[1] })
    return match[1]
  }

  /** The plain (prefix-free) tool names one node currently publishes, sorted. */
  const toolNamesFor = (nodeName) => {
    const prefix = `mcp__${nodeName}__`
    return toolsFor(nodeName)
      .map(name => (name.startsWith(prefix) ? name.slice(prefix.length) : name))
      .sort()
  }

  /**
   * The shell tool a node publishes: `exec_command` (codex-style, the wording
   * this plugin has always driven) when present, else `bash` (claude-style),
   * else `exec_command` so a node whose tools have not synced yet behaves
   * exactly as it did before.
   */
  const shellToolFor = (nodeName) => {
    const names = toolNamesFor(nodeName)
    if (names.includes('exec_command')) return 'exec_command'
    if (names.includes('bash')) return 'bash'
    return 'exec_command'
  }

  /** The dialect (`win` | `posix`) one node's shell and paths use. */
  const dialectFor = (node) => nodeDialect(node, shellToolFor(node.name))

  /**
   * Run one shell command inside a node workspace through whichever shell tool
   * that node publishes. `command` is written in the node's own dialect by the
   * caller; this only picks the tool and its argument names.
   * @param {any} node - the node record.
   * @param {string} workspaceId - the node workspace the command runs in.
   * @param {string} command - the command, in that node dialect's wording.
   * @param {string} [cwdRel] - node-root-relative directory to run it in.
   * @param {{ maxOutputTokens?: number }} [options] - codex-only extras.
   */
  const runShell = async (node, workspaceId, command, cwdRel = '', options = {}) => {
    const tool = shellToolFor(node.name)
    if (tool === 'bash') {
      return await callNode(node.name, 'bash', {
        workspaceId,
        command,
        ...(cwdRel.length === 0 ? {} : { workingDirectory: cwdRel }),
      })
    }
    const win = nodeDialect(node, tool) === 'win'
    return await callNode(node.name, 'exec_command', {
      workspace_id: workspaceId,
      cmd: command,
      ...(options.maxOutputTokens === undefined ? {} : { max_output_tokens: options.maxOutputTokens }),
      ...(cwdRel.length === 0 ? {} : { working_directory: win ? cwdRel.split('/').join('\\') : cwdRel }),
    })
  }

  /**
   * Where a caller's path is anchored: the node's allowed root (`~/` absent), or
   * the node's HOME directory (`~/…`, where user-level skills and configs live).
   * @param {string} path - the caller's path.
   * @returns {{ home: boolean, rel: string }} the anchor and its relative part.
   */
  const resolveNodePath = (path) => {
    const raw = String(path ?? '').trim().replace(/\\/g, '/')
    if (raw === '~' || raw.startsWith('~/')) return { home: true, rel: splitRemote(raw.replace(/^~\/?/, '')).rel }
    return { home: false, rel: splitRemote(raw).rel }
  }

  /**
   * A command prefix that moves into a HOME-relative directory, so every listing
   * and read can address `~/.claude/skills` and friends without absolute paths.
   */

  /**
   * Refuse to treat a shell failure as data: a spawn error ("spawn … ENOENT")
   * or a missing-path message would otherwise become a listing row.
   * @param {string} text - the raw command output.
   */
  const assertShellOutput = (text) => {
    const trimmed = String(text ?? '').trim()
    if (trimmed.length === 0) return
    // The shell's own trailer is the authoritative signal: a non-zero exit is a
    // failure even when the tool reports success.
    const exit = /(?:Process|Command) exited with code (\d+)/.exec(trimmed)
    if (exit !== null && exit[1] !== '0') {
      throw new HttpError(502, `远端命令退出码 ${exit[1]}：${trimmed.slice(0, 300)}`)
    }
    if (/\bspawn\b[^\n]*ENOENT/i.test(trimmed)
      || /^\s*(?:bash|sh|zsh|pwsh|powershell)[^\n]*no such file/i.test(trimmed)
      || /is not recognized as the name of a cmdlet/i.test(trimmed)
      || /CategoryInfo|FullyQualifiedErrorId|Set-Location\s*:|找不到路径|no-such-home-dir/.test(trimmed)) {
      throw new HttpError(502, `远端 shell 报错：${trimmed.slice(0, 300)}`)
    }
  }

  /** Split a node-relative path into its parent and leaf. */
  const splitRemote = (rel) => {
    const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (clean.length === 0) return { rel: '', parent: '', leaf: '' }
    const parts = clean.split('/').filter(part => part.length > 0 && part !== '.')
    if (parts.some(part => part === '..')) throw new HttpError(400, '路径不能包含 ..')
    return { rel: parts.join('/'), parent: parts.slice(0, -1).join('/'), leaf: parts[parts.length - 1] ?? '' }
  }

  /**
   * A remote path as the node-root-relative spelling its workspace accepts:
   * a relative value resolves against `base`, an absolute one must stay inside
   * the node's allowed root.
   * @param {any} node - the node owning the path.
   * @param {string} base - node-relative directory a relative value starts in.
   * @param {string} value - the caller's remote path.
   * @returns the node-root-relative path with '/' separators.
   */
  const toRootRelative = (node, base, value) => {
    const raw = String(value ?? '').trim().replace(/\\/g, '/')
    if (raw.length === 0) throw new HttpError(400, '需要一个远端路径')
    const root = normalizeRemotePath(node.root)
    let combined
    if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('//') || raw.startsWith('/')) {
      const target = normalizeRemotePath(raw)
      // Windows paths compare case-insensitively; POSIX paths do not.
      const win = dialectFor(node) === 'win'
      const left = win ? root.toLowerCase() : root
      const right = win ? target.toLowerCase() : target
      if (right !== left && !right.startsWith(`${left}/`)) {
        throw new HttpError(400, `远端路径必须在节点根 ${node.root} 内：${raw}`)
      }
      combined = target.slice(root.length)
    } else {
      combined = `${normalizeRemotePath(base)}/${raw}`
    }
    const parts = combined.split('/').filter(part => part.length > 0 && part !== '.')
    if (parts.some(part => part === '..')) throw new HttpError(400, '路径不能包含 ..')
    return parts.join('/')
  }

  /** Absolute remote spelling of a node-root-relative path, in the node's separator. */
  const toRemoteAbsolute = (node, rel) => {
    const root = String(node.root).replace(/[\\/]+$/, '')
    if (rel.length === 0) return root
    return dialectFor(node) === 'win' ? `${root}\\${rel.split('/').join('\\')}` : `${root}/${rel}`
  }

  /** The mirror store plus the root in force. */
  const mirrorState = async () => {
    const store = await readMirrors(mirrorsFile, warn)
    return { store, root: resolve(store.root ?? defaultMirrorRoot) }
  }

  /** The local directory that mirrors one node directory. */
  const mirrorPathFor = (root, node, rel) => {
    const parts = rel.length === 0 ? [] : rel.split('/')
    return join(root, node.name, ...parts)
  }

  /** The mirror a tool call belongs to: explicit node, else the Session's cwd. */
  const targetForExec = async (exec, explicitNode) => {
    const { store } = await mirrorState()
    const cwd = exec?.agent?.session?.header?.cwd
    const fromCwd = mirrorForCwd(store.mirrors, typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : cwd)
    const wanted = typeof explicitNode === 'string' && explicitNode.length > 0 ? explicitNode : fromCwd?.node
    if (typeof wanted !== 'string' || wanted.length === 0) {
      throw new HttpError(409, '这个会话没有远端目标：先用「Add Remote…」选一个远端目录开会话（会话 cwd 就是本地镜像目录），或显式给 node + remotePath')
    }
    const node = await requireNode(wanted)
    const target = fromCwd !== undefined && fromCwd.node === node.name ? fromCwd : undefined
    return { node, target }
  }

  /** Every mirror, newest first, with the node label attached. */
  const listMirrors = async () => {
    const { store, root } = await mirrorState()
    const nodes = await readNodes(nodesFile, warn)
    return {
      mirrorRoot: root,
      mirrors: Object.values(store.mirrors)
        .filter(mirror => mirror !== null && typeof mirror === 'object')
        .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
        .map(mirror => ({
          ...mirror,
          nodeLabel: nodes.find(node => node.name === mirror.node)?.label ?? '',
          exists: existsSync(String(mirror.localPath ?? '')),
        })),
    }
  }

  /** List the directories directly under one node-relative path. */
  /**
   * The node's own spelling of a path, for a command that addresses it as an
   * ARGUMENT rather than as the working directory. A non-existent working
   * directory fails the whole spawn on Windows (`spawn … powershell.exe
   * ENOENT`, exit -4058), so every listing addresses its target this way and
   * runs with the node root — which always exists — as its cwd.
   */
  const dirExpression = (home, rel, dialect) => {
    const winRel = rel.split('/').join('\\')
    if (dialect === 'win') {
      if (home) return rel.length === 0 ? '$env:USERPROFILE' : `(Join-Path $env:USERPROFILE ${psQuote(winRel)})`
      return rel.length === 0 ? '(Get-Location).Path' : psQuote(winRel)
    }
    if (home) return rel.length === 0 ? '"$HOME"' : `"$HOME"/${shQuote(rel)}`
    return rel.length === 0 ? '"."' : shQuote(rel)
  }

  /** The same path as a short label, for messages and result paths. */
  const dirLabel = (home, rel) => (home ? (rel.length === 0 ? '~' : `~/${rel}`) : rel)

  const listRemote = async (input) => {
    const node = await requireNode(input?.node)
    const { home, rel } = resolveNodePath(input?.path)
    const workspaceId = await workspaceIdForRoot(node)
    const win = dialectFor(node) === 'win'
    const target = dirExpression(home, rel, win ? 'win' : 'posix')
    // Every row carries the Hidden flag so the dialog can decide what to show.
    // Windows rows are `name|hidden` (a pipe cannot appear in a Windows
    // directory name); POSIX rows are `hidden<TAB>name`, because a POSIX name
    // may contain `|` and `ls -1A` alone cannot flag a hidden entry.
    const command = win
      ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `$p = ${target}; if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 4 }; Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name | `
        + 'ForEach-Object { $h = if (($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0) { "1" } else { "0" }; "$($_.Name)|$h" }'
      : `p=${target}; [ -d "$p" ] || exit 4; ls -1A "$p" | while IFS= read -r entry; do [ -d "$p/$entry" ] || continue; `
        + 'case "$entry" in .*) flag=1;; *) flag=0;; esac; printf \'%s\\t%s\\n\' "$flag" "$entry"; done'
    const result = await runShell(node, workspaceId, command, '')
    if (result.isError === true) {
      const text = resultText(result)
      if (/\bexit 4\b|exited with code 4\b|找不到|Cannot find|does not exist/i.test(text)) {
        throw new HttpError(404, `节点上没有这个目录：${dirLabel(home, rel)}`)
      }
      throw new HttpError(502, text || '列目录失败')
    }
    assertShellOutput(resultText(result))
    const entries = resultText(result).split(/\r?\n/)
      .map(line => line.replace(/\r$/, ''))
      .filter(line => line.trim().length > 0 && !/^(?:Process|Command) exited with code/.test(line.trim()))
      .map((line) => {
        if (!win) {
          const tab = line.indexOf('\t')
          if (tab === -1) return { name: line, hidden: line.startsWith('.') }
          return { name: line.slice(tab + 1), hidden: line.slice(0, tab).trim() === '1' }
        }
        const cut = line.lastIndexOf('|')
        const name = (cut === -1 ? line : line.slice(0, cut)).trim()
        return { name, hidden: cut !== -1 && line.slice(cut + 1).trim() === '1' }
      })
      .filter(entry => entry.name.length > 0)
    const prefix = dirLabel(home, rel)
    return {
      node: node.name,
      root: node.root,
      path: prefix,
      home,
      parent: splitRemote(rel).parent,
      entries: entries.map(entry => ({
        name: entry.name,
        hidden: entry.hidden,
        path: prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`,
      })),
    }
  }

  /** Create one directory under a node-relative path. */
  const makeRemote = async (input) => {
    const node = await requireNode(input?.node)
    const { rel } = splitRemote(input?.path)
    const name = String(input?.name ?? '').trim()
    if (name.length === 0 || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      throw new HttpError(400, '目录名不合法')
    }
    const workspaceId = await workspaceIdForRoot(node)
    const target = rel.length === 0 ? name : `${rel}/${name}`
    const result = await runShell(
      node,
      workspaceId,
      dialectFor(node) === 'win'
        ? `[Console]::OutputEncoding=[Text.Encoding]::UTF8; New-Item -ItemType Directory -Force -Path ${psQuote(target)} | Select-Object -ExpandProperty Name`
        : `mkdir -p -- ${shQuote(name)}`,
      rel,
    )
    if (result.isError === true) throw new HttpError(502, resultText(result) || '新建目录失败')
    return await listRemote({ node: node.name, path: rel })
  }

  /**
   * List the FILES directly under one node-relative path, with sizes. The
   * directory twin is `/ls`; both carry a hidden flag so a caller can filter
   * without a second round trip. Windows rows are `name|hidden|bytes` (a pipe
   * cannot appear in a Windows name); POSIX rows are tab-separated, because a
   * POSIX name may contain a pipe.
   */
  const listFilesRemote = async (nodeName, path) => {
    const node = await requireNode(nodeName)
    const { home, rel } = resolveNodePath(path)
    const win = dialectFor(node) === 'win'
    const target = dirExpression(home, rel, win ? 'win' : 'posix')
    const command = win
      ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `$p = ${target}; if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 4 }; `
        + 'Get-ChildItem -LiteralPath $p -File -Force -ErrorAction SilentlyContinue | Sort-Object Name | '
        + 'ForEach-Object { $h = if (($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0) { "1" } else { "0" }; "$($_.Name)|$h|$($_.Length)" }'
      : `p=${target}; [ -d \"$p\" ] || exit 4; ls -1A \"$p\" | while IFS= read -r entry; do [ -f \"$p/$entry\" ] || continue; `
        + 'case "$entry" in .*) flag=1;; *) flag=0;; esac; printf \'%s\\t%s\\t%s\\n\' "$entry" "$flag" "$(wc -c < "$p/$entry" | tr -d "  ")"; done'
    const result = await runShell(node, await workspaceIdForRoot(node), command, '')
    if (result.isError === true) {
      const text = resultText(result)
      if (/\bexit 4\b|exited with code 4\b|找不到|Cannot find|does not exist/i.test(text)) {
        throw new HttpError(404, `节点上没有这个目录：${dirLabel(home, rel)}`)
      }
      throw new HttpError(502, text || '列文件失败')
    }
    assertShellOutput(resultText(result))
    const files = resultText(result).split(/\r?\n/)
      .map(line => line.replace(/\r$/, ''))
      .filter(line => line.trim().length > 0 && !/^(?:Process|Command) exited with code/.test(line.trim()))
      .map((line) => {
        const parts = win ? line.split('|') : line.split('\t')
        const name = (parts[0] ?? '').trim()
        return {
          name,
          hidden: (parts[1] ?? '').trim() === '1',
          bytes: Number.isFinite(Number(parts[2])) ? Number(parts[2]) : 0,
          path: rel.length === 0 ? name : `${rel}/${name}`,
        }
      })
      .filter(entry => entry.name.length > 0)
    return { node: node.name, root: node.root, path: dirLabel(home, rel), home, files }
  }

  /**
   * The node-manager service other plugins consume: `ctx.get('devspace')`.
   *
   * Reading a remote node's content (its skills, its MCP config, its env keys)
   * belongs to whoever owns that node, so it is served here rather than
   * re-implemented per plugin: every method is dialect-aware (a claude-style
   * node gets POSIX commands, a codex-style node PowerShell) and every path is
   * resolved inside the node's allowed root.
   */
  ctx.provide('devspace', {
    version: 1,
    /** Enabled nodes with their live mount state. */
    nodes: async () => (await readNodes(nodesFile, warn))
      .filter(node => node.enabled !== false)
      .map(node => ({
        name: node.name,
        label: node.label,
        root: node.root,
        notes: node.notes,
        platform: node.platform ?? '',
        dialect: dialectFor(node),
        state: applied.get(node.name)?.state ?? 'pending',
        error: applied.get(node.name)?.error ?? null,
        toolCount: toolsFor(node.name).length,
      })),
    /** The bare names of every tool the node publishes. */
    tools: async (nodeName) => (await requireNode(nodeName), toolsFor(nodeName)
      .map(name => name.slice(`mcp__${nodeName}__`.length))),
    /** One directory level: directories only. */
    listDirs: async (nodeName, path) => (await listRemote({ node: nodeName, path })).entries,
    /** One directory level: files only, with sizes. */
    listFiles: (nodeName, path) => listFilesRemote(nodeName, path),
    /** One bounded text file. */
    readText: async (nodeName, path, maxBytes = 64 * 1024) => {
      const node = await requireNode(nodeName)
      const { home, rel } = resolveNodePath(path)
      if (rel.length === 0) throw new HttpError(400, '需要一个文件路径')
      const win = dialectFor(node) === 'win'
      const limit = Math.max(1, Math.floor(Number(maxBytes) || 64 * 1024))
      const target = dirExpression(home, rel, win ? 'win' : 'posix')
      const command = win
        ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + `$p = ${target}; if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { exit 3 }; `
          + `$bytes = [IO.File]::ReadAllBytes((Get-Item -LiteralPath $p).FullName); `
          + `$take = [Math]::Min(${String(limit)}, $bytes.Length); `
          + `[Text.Encoding]::UTF8.GetString($bytes, 0, $take)`
        : `p=${target}; [ -f "$p" ] || exit 3; head -c ${String(limit)} "$p"`
      const result = await runShell(node, await workspaceIdForRoot(node), command, '')
      if (result.isError === true) {
        const text = resultText(result)
        if (/\bexit 3\b|no such file|Cannot find path|找不到路径/i.test(text)) throw new HttpError(404, `远端没有这个文件：${rel}`)
        throw new HttpError(502, text || '读远端文件失败')
      }
      const raw = resultText(result)
      const lines = raw.split(/\r?\n/)
        .filter(line => !/^(?:Process|Command) exited with code/.test(line.trim()))
      return lines.join('\n')
    },
    /** Whether one node-relative path exists (as a file or a directory). */
    exists: async (nodeName, path) => {
      const node = await requireNode(nodeName)
      const { home, rel } = resolveNodePath(path)
      if (rel.length === 0) return true
      const win = dialectFor(node) === 'win'
      const target = dirExpression(home, rel, win ? 'win' : 'posix')
      const command = win
        ? `if (Test-Path -LiteralPath ${target}) { 'yes' } else { 'no' }`
        : `[ -e ${target} ] && echo yes || echo no`
      const result = await runShell(node, await workspaceIdForRoot(node), command, '')
      if (result.isError === true) return false
      return /\byes\b/.test(resultText(result))
    },
    /** Call any tool the node publishes (an escape hatch for its own surface). */
    call: (nodeName, tool, args) => callNode(nodeName, tool, args),
    /**
     * The mirror a working directory belongs to, when that directory is inside
     * one — how a consumer narrows a listing to "the node this Session is on".
     * @param {string} cwd - an absolute working directory.
     * @returns the mirror record (with the node's label) or null.
     */
    mirror: async (cwd) => {
      if (typeof cwd !== 'string' || cwd.length === 0) return null
      const { store } = await mirrorState()
      const mirror = mirrorForCwd(store.mirrors, cwd.replace(/\/+$/, ''))
      if (mirror === undefined) return null
      const node = (await readNodes(nodesFile, warn)).find(entry => entry.name === mirror.node)
      return { ...mirror, label: node?.label ?? '' }
    },
  }, candidate => candidate !== null && typeof candidate === 'object' && candidate.version === 1)

  /** Write the mirror's own AGENTS.md so any Session in it knows the truth. */
  const ensureMirrorReadme = async (localPath, node, rel, remoteAbsolute) => {
    const file = join(localPath, 'AGENTS.md')
    if (existsSync(file)) return
    const label = node.label.length > 0 ? node.label : node.name
    const tools = toolNamesFor(node.name)
    const toolLine = tools.length > 0
      ? tools.map(name => `\`${name}\``).join(' / ')
      : '`read` / `write` / `edit` / `bash`'
    const example = dialectFor(node) === 'win' ? `${remoteAbsolute}\\src\\x.ts` : `${remoteAbsolute}/src/x.ts`
    const body = [
      `# 远端镜像工作区（DevSpace · ${label}）`,
      '',
      `这个本地目录是「${node.name}」节点上 \`${remoteAbsolute}\` 的镜像工作区，**不是**远端项目的副本：`,
      '',
      `- 远端项目本身仍在节点 \`${node.name}\` 上（工具前缀 \`mcp__${node.name}__*\`：${toolLine}）。读写远端代码、跑远端命令一律用这些工具，路径写远端形式（如 \`${example}\`）。`,
      '- 这个本地目录用来放：下载下来的数据、待上传的产物、本地分析/处理脚本。本地读写用普通本地工具即可。',
      '- 开工前先调 `devspace_target` 确认本会话的远端目标（节点 + 远端目录 + workspace_id），不要假设两边内容一致。',
      '- 传文件：`devspace_pull`（远端 → 本地镜像）与 `devspace_push`（本地 → 远端），二进制安全，按块传输。',
      '',
    ].join('\n')
    await writeFile(file, body, { encoding: 'utf8' })
  }

  /**
   * Adopt one node directory: create (or reuse) its local mirror workspace,
   * register that directory as a real Workspace so Sessions group under it in
   * the sidebar, and open the directory on the node for its workspace id.
   * @param {any} input - `{ node, path, root?, title? }`.
   * @returns the mirror record plus the freshly resolved remote workspace id.
   */
  const openRemote = async (input) => {
    const node = await requireNode(input?.node)
    const { rel } = splitRemote(input?.path)
    const { store, root: storedRoot } = await mirrorState()
    const root = typeof input?.root === 'string' && input.root.trim().length > 0 ? resolve(input.root.trim()) : storedRoot
    if (root !== storedRoot) {
      const next = await readMirrors(mirrorsFile, warn)
      next.root = root
      await writeMirrors(mirrorsFile, next)
    }
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new HttpError(500, '这台 harness 没有 workspaceRegistry 服务，无法把远端目录注册成本地镜像工作区')
    const remoteAbsolute = toRemoteAbsolute(node, rel)
    // The mirror directory must exist before the registry can own it.
    const localPath = mirrorPathFor(root, node, rel)
    await mkdir(localPath, { recursive: true })
    await ensureMirrorReadme(localPath, node, rel, remoteAbsolute)
    const remote = await callNode(node.name, 'open_workspace', { path: remoteAbsolute })
    const remoteText = resultText(remote)
    if (remote.isError === true) throw new HttpError(502, remoteText || 'open_workspace 失败')
    const remoteMatch = /\b(ws_[A-Za-z0-9_-]{4,})\b/.exec(remoteText)
    const label = node.label.length > 0 ? node.label : node.name
    const requested = typeof input?.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : `[${label}] ${rel.length === 0 ? '.' : rel}`
    const workspace = await registry.create(localPath, requested)
    const mirror = {
      workspaceId: String(workspace.id),
      node: node.name,
      relative: rel,
      remotePath: remoteAbsolute,
      remoteWorkspaceId: remoteMatch?.[1] ?? '',
      localPath: workspace.path,
      title: workspace.title,
      createdAt: Date.now(),
    }
    const latest = await readMirrors(mirrorsFile, warn)
    latest.root = root
    latest.mirrors[mirror.workspaceId] = mirror
    await writeMirrors(mirrorsFile, latest)
    self?.invalidate()
    // `workspaceId` is the LOCAL mirror workspace; `remoteWorkspaceId` is the
    // node's own id for the directory. The client opens the local one.
    return { ...mirror, localWorkspaceId: mirror.workspaceId, remoteText: remoteText.slice(0, 800) }
  }

  /** Forget one mirror: drop the local Workspace registration, keep the files. */
  const dropMirror = async (input) => {
    const wanted = String(input?.workspaceId ?? '')
    const { store, root } = await mirrorState()
    const mirror = store.mirrors[wanted]
    if (mirror === undefined) throw new HttpError(404, `没有 workspaceId=${wanted} 的镜像工作区`)
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        await registry.delete(wanted)
      } catch (error) {
        warn(`devspace: deleting workspace ${wanted} failed: ${messageOf(error)}`)
      }
    }
    const latest = await readMirrors(mirrorsFile, warn)
    delete latest.mirrors[wanted]
    latest.root = root
    await writeMirrors(mirrorsFile, latest)
    self?.invalidate()
    return { removed: wanted, localPath: mirror.localPath, kept: true }
  }

  /** Change where new mirrors are created. */
  const setMirrorRoot = async (input) => {
    const wanted = String(input?.root ?? '').trim()
    if (wanted.length === 0) throw new HttpError(400, '需要一个本地目录作为镜像根')
    const root = resolve(wanted.replace(/^~(?=\/|$)/, homedir()))
    await mkdir(root, { recursive: true })
    const store = await readMirrors(mirrorsFile, warn)
    store.root = root
    await writeMirrors(mirrorsFile, store)
    return await listMirrors()
  }

  /** Remote file facts: size in bytes; a directory is refused. */
  const remoteFileSize = async (node, rel) => {
    const script = dialectFor(node) === 'win'
      ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `$item = Get-Item -LiteralPath ${psQuote(rel)} -ErrorAction Stop; `
        + 'if ($item.PSIsContainer) { Write-Error "is-a-directory"; exit 4 }; $item.Length'
      : `if [ -d ${shQuote(rel)} ]; then echo is-a-directory >&2; exit 4; fi; wc -c < ${shQuote(rel)}`
    const result = await runShell(node, await workspaceIdForRoot(node), script)
    if (result.isError === true) throw new HttpError(502, resultText(result) || `读不到远端文件 ${rel}`)
    const line = resultText(result).split(/\r?\n/)
      .map(entry => entry.trim())
      .filter(entry => /^\d+$/.test(entry))
      .pop()
    if (line === undefined) throw new HttpError(502, `读不到远端文件大小：${resultText(result).slice(0, 300)}`)
    return Number(line)
  }

  /** One base64 chunk of a remote file, starting at `offset`. */
  const readRemoteChunk = async (node, rel, offset) => {
    const win = dialectFor(node) === 'win'
    const script = win
      ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `$fs = [IO.File]::OpenRead((Get-Item -LiteralPath ${psQuote(rel)}).FullName); `
        + `$fs.Seek(${String(offset)}, 'Begin') | Out-Null; `
        + `$buf = New-Object byte[] ${String(pullChunkBytes)}; `
        + '$n = $fs.Read($buf, 0, $buf.Length); $fs.Close(); [Convert]::ToBase64String($buf, 0, $n)'
      : `tail -c +${String(offset + 1)} < ${shQuote(rel)} | head -c ${String(pullChunkBytes)} | openssl base64 -A`
    const result = await runShell(node, await workspaceIdForRoot(node), script, '', win ? { maxOutputTokens: 100_000 } : {})
    if (result.isError === true) throw new HttpError(502, resultText(result) || '读远端文件失败')
    const text = resultText(result).split(/\r?\n/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0 && !/^(?:Process|Command) exited with code/.test(entry))
      .join('')
    if (!/^[A-Za-z0-9+/=]*$/.test(text)) throw new HttpError(502, `远端返回了非 base64 内容：${text.slice(0, 120)}`)
    return Buffer.from(text, 'base64')
  }

  /**
   * Append (or create) one remote file with a base64 chunk.
   * The script reports the file's length AFTER the write, so a silently failed
   * handle (Windows refuses an Open while a previous handle lingers) cannot pass
   * as success — the caller compares it against the bytes it sent.
   * @returns the remote file length the node reported.
   */
  const writeRemoteChunk = async (node, rel, base64, create) => {
    const script = dialectFor(node) === 'win'
      ? '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `$p = ${psQuote(rel)}; `
        + 'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) -ErrorAction SilentlyContinue | Out-Null; '
        + `$bytes = [Convert]::FromBase64String(${psQuote(base64)}); `
        + `$fs = [IO.File]::Open($p, ${create ? "'Create'" : "'Append'"}); `
        + '$fs.Write($bytes, 0, $bytes.Length); $fs.Close(); (Get-Item -LiteralPath $p).Length'
      : `mkdir -p -- "$(dirname ${shQuote(rel)})"; printf %s ${shQuote(base64)} | openssl base64 -d -A ${create ? '>' : '>>'} ${shQuote(rel)}; wc -c < ${shQuote(rel)}`
    const result = await runShell(node, await workspaceIdForRoot(node), script)
    if (result.isError === true) throw new HttpError(502, resultText(result) || '写远端文件失败')
    const reported = resultText(result).split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\d+$/.test(line))
      .pop()
    if (reported === undefined) {
      throw new HttpError(502, `远端没有回报写入后的文件长度：${resultText(result).slice(0, 300)}`)
    }
    return Number(reported)
  }

  /** Copy one remote file into the local side (chunk by chunk). */
  const pullFile = async (input, exec) => {
    const { node, target } = await targetForExec(exec, input?.node)
    const base = target === undefined ? '' : target.relative
    const rel = toRootRelative(node, base, input?.remotePath)
    const size = await remoteFileSize(node, rel)
    if (size > MAX_TRANSFER_BYTES) {
      throw new HttpError(413, `文件 ${String(size)} 字节超过一次传输上限 ${String(MAX_TRANSFER_BYTES)} 字节`)
    }
    const cwd = exec?.agent?.session?.header?.cwd
    const baseLocal = target?.localPath ?? (typeof cwd === 'string' ? cwd : homedir())
    const relativeFromTarget = target !== undefined && rel.startsWith(target.relative === '' ? '' : `${target.relative}/`)
      ? rel.slice(target.relative.length).replace(/^\/+/, '')
      : rel.split('/').pop() ?? 'download.bin'
    const localPath = typeof input?.localPath === 'string' && input.localPath.trim().length > 0
      ? resolve(input.localPath.trim().replace(/^~(?=\/|$)/, homedir()))
      : join(baseLocal, relativeFromTarget)
    await mkdir(dirname(localPath), { recursive: true })
    const handle = await openFile(localPath, 'w')
    let written = 0
    try {
      while (written < size) {
        const chunk = await readRemoteChunk(node, rel, written)
        const expected = Math.min(pullChunkBytes, size - written)
        if (chunk.length !== expected) {
          throw new HttpError(502, `远端输出被截断（期望 ${String(expected)} 字节，收到 ${String(chunk.length)}）——请重试或改用更小的文件`)
        }
        await handle.write(chunk)
        written += chunk.length
      }
    } finally {
      await handle.close()
    }
    return { node: node.name, remotePath: toRemoteAbsolute(node, rel), localPath, bytes: written, localMirror: baseLocal }
  }

  /** Copy one local file onto the node (chunk by chunk). */
  const pushFile = async (input, exec) => {
    const { node, target } = await targetForExec(exec, input?.node)
    const cwd = exec?.agent?.session?.header?.cwd
    const raw = String(input?.localPath ?? '').trim()
    if (raw.length === 0) throw new HttpError(400, '需要一个本地文件路径')
    const localPath = resolve(raw.replace(/^~(?=\/|$)/, homedir()).startsWith('/') ? raw.replace(/^~(?=\/|$)/, homedir()) : join(typeof cwd === 'string' ? cwd : homedir(), raw))
    const info = await statFile(localPath).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new HttpError(400, `本地没有这个文件：${localPath}`)
    if (info.size > MAX_TRANSFER_BYTES) {
      throw new HttpError(413, `文件 ${String(info.size)} 字节超过一次传输上限 ${String(MAX_TRANSFER_BYTES)} 字节`)
    }
    const wantsRemote = typeof input?.remotePath === 'string' && input.remotePath.trim().length > 0
    const rel = wantsRemote
      ? toRootRelative(node, target?.relative ?? '', input.remotePath)
      : (() => {
          // Default: the file's path under the mirror, placed at the same spot
          // on the node.
          const mirror = target?.localPath ?? ''
          const inside = mirror.length > 0 && localPath.startsWith(mirror.endsWith('/') ? mirror : `${mirror}/`)
          const tail = inside ? localPath.slice(mirror.length).replace(/^\/+/, '') : (localPath.split('/').pop() ?? 'upload.bin')
          return toRootRelative(node, target?.relative ?? '', tail)
        })()
    // One whole pass. A chunk that lands short leaves the file shifted by those
    // bytes, which appending cannot repair — so a failed pass is thrown away and
    // re-sent from the start (the first chunk opens with 'Create', truncating).
    const send = async () => {
      const handle = await openFile(localPath, 'r')
      let offset = 0
      try {
        while (offset < info.size) {
          const length = Math.min(pushChunkBytes, info.size - offset)
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, offset)
          if (bytesRead <= 0) break
          const expected = offset + bytesRead
          const reported = await writeRemoteChunk(node, rel, buffer.subarray(0, bytesRead).toString('base64'), offset === 0)
          if (reported !== expected) {
            throw new HttpError(502, `远端写入长度不符：发到 ${String(expected)} 字节，远端文件却是 ${String(reported)} 字节`)
          }
          offset = expected
        }
        if (info.size === 0) await writeRemoteChunk(node, rel, '', true)
      } finally {
        await handle.close()
      }
      return offset
    }
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const bytes = await send()
        return { node: node.name, localPath, remotePath: toRemoteAbsolute(node, rel), bytes, attempts: attempt }
      } catch (error) {
        lastError = error
        warn(`devspace: upload of ${rel} failed on attempt ${String(attempt)}: ${messageOf(error)}`)
      }
    }
    throw lastError
  }

  // ---- the global skill --------------------------------------------

  ctx.skills.registerProvider((control) => {
    const provider = {
      name: 'devspace',
      /** Offer the DevSpace skill whenever at least one node is enabled. */
      async list() {
        const nodes = (await readNodes(nodesFile, warn)).filter(node => node.enabled !== false)
        if (nodes.length === 0) return []
        return [{
          name: SKILL_NAME,
          description: `通过 DevSpace 远端节点操作项目（本机挂着 ${String(nodes.length)} 个：${nodes.map(node => node.name).join(', ')}）`,
          whenToUse: '需要读写远端机器上的代码、在远端跑命令、或用户提到 devspace / 远端目录时',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: 'devspace',
          rank: 40,
          locator: { nodes: nodes.map(node => node.name) },
          resourceBase: { kind: 'opaque', description: 'DevSpace 节点通过各自的 MCP 工具访问；没有本地映射' },
          metadata: { nodeCount: nodes.length, nodes: nodes.map(node => ({ name: node.name, label: node.label, url: node.url })) },
        }]
      },
      /** Render the body from the node list in force at load time. */
      async get(candidate) {
        const nodes = (await readNodes(nodesFile, warn)).filter(node => node.enabled !== false)
        if (nodes.length === 0) return undefined
        return {
          name: candidate.name,
          description: candidate.description,
          whenToUse: candidate.whenToUse,
          invocation: candidate.invocation,
          source: candidate.source,
          provider: 'devspace',
          resourceBase: candidate.resourceBase,
          metadata: candidate.metadata,
          content: renderSkill(nodes, nodeName => toolNamesFor(nodeName)),
        }
      },
    }
    self = { provider, invalidate: control.invalidate }
    control.signal.addEventListener('abort', () => {
      if (self?.provider === provider) self = null
    }, { once: true })
    return provider
  })

  // ---- routes --------------------------------------------------------

  const handle = async (req, res) => {
    try {
      if (rejectUnauthenticated(ctx, req, res)) return
      const url = new URL(String(req.url), 'http://localhost')
      const routePath = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      if (req.method === 'GET' && routePath === '/state') {
        sendJson(res, 200, await buildState())
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (routePath === '/save') return void sendJson(res, 200, await saveNode(body))
        if (routePath === '/delete') return void sendJson(res, 200, await deleteNode(body))
        if (routePath === '/toggle') return void sendJson(res, 200, await toggleNode(body))
        if (routePath === '/ls') return void sendJson(res, 200, await listRemote(body))
        if (routePath === '/mkdir') return void sendJson(res, 200, await makeRemote(body))
        if (routePath === '/open') return void sendJson(res, 200, await openRemote(body))
        // Both respond with the full UI state: the Settings page replaces its
        // copy with whatever a mutation returns.
        if (routePath === '/mirror-root') {
          await setMirrorRoot(body)
          return void sendJson(res, 200, await buildState())
        }
        if (routePath === '/unmirror') {
          await dropMirror(body)
          return void sendJson(res, 200, await buildState())
        }
        if (routePath === '/retry') {
          await reconcile(true)
          return void sendJson(res, 200, await buildState())
        }
      }
      sendJson(res, 404, { code: 'not-found', message: `no devspace route for ${req.method} ${routePath}` })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) warn(`devspace: ${messageOf(error)}`)
      sendJson(res, status, { code: status === 500 ? 'internal' : 'bad-request', message: messageOf(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'devspace: routes')

  // ---- model-facing tool --------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'devspace_admin',
    description:
      'List, add, update, enable, disable, remove and retry DevSpace nodes for this harness, and manage the local mirror '
      + 'workspaces they feed. A node is an MCP endpoint owned by this plugin: enabling one mounts it immediately (no restart) '
      + 'and its tools appear as mcp__<node>__<tool>. `open` adopts one node directory as a LOCAL mirror workspace so its Sessions '
      + 'group under that directory in the sidebar; remote work itself always happens through the node tools.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'add', 'update', 'remove', 'enable', 'disable', 'retry', 'mirrors', 'open', 'unmirror', 'mirrorRoot'], description: 'Operation to perform. `mirrors` lists the local mirror workspaces, `open` adopts one node directory as a mirror workspace (its own Session groups under it in the sidebar), `unmirror` drops that registration, `mirrorRoot` changes where new mirrors are created.' },
        name: { type: 'string', description: 'Node name ([A-Za-z0-9_-]{1,32}); also the mcp__<name>__ tool prefix.' },
        label: { type: 'string', description: 'Human label for the node.' },
        url: { type: 'string', description: 'DevSpace MCP endpoint, e.g. http://192.168.1.10:7676/mcp.' },
        headers: { type: 'object', description: 'Request headers, e.g. {"Authorization": "Bearer ${DEVSPACE_TOKEN}"}.' },
        notes: { type: 'string', description: 'Free-form note shown in the skill.' },
        root: { type: 'string', description: 'The node directory the pickers and open_workspace start from, e.g. D:\\work\\project.' },
        path: { type: 'string', description: 'For `open`: the node-relative directory to adopt, e.g. "test" or "src/app".' },
        localRoot: { type: 'string', description: 'For `open`: a local mirror root other than the stored one.' },
        workspaceId: { type: 'string', description: 'For `unmirror`: the local mirror workspace id.' },
        toolCallTimeoutMs: { type: 'number', description: 'Per-call timeout; default 120000.' },
        failOnStartupError: { type: 'boolean', description: 'Report an unreachable node instead of retrying quietly; default true.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /** @param {any} args - validated arguments. */
    async execute(args) {
      switch (args.action) {
        case 'status': {
          const state = await buildState()
          return {
            nodesFile: state.nodesFile,
            skill: state.skill,
            unresolved: state.unresolved,
            nodes: state.nodes.map(node => ({
              name: node.name, label: node.label, url: node.url, enabled: node.enabled,
              state: node.state, toolCount: node.toolCount, error: node.error, fromComposition: node.fromComposition,
            })),
          }
        }
        case 'add':
        case 'update':
          return await saveNode({
            node: {
              name: args.name,
              label: args.label,
              url: args.url,
              headers: args.headers,
              notes: args.notes,
              toolCallTimeoutMs: args.toolCallTimeoutMs,
              failOnStartupError: args.failOnStartupError,
              enabled: true,
            },
          })
        case 'remove': return await deleteNode({ name: args.name })
        case 'enable':
        case 'disable': return await toggleNode({ name: args.name, enabled: args.action === 'enable' })
        case 'mirrors': return await listMirrors()
        case 'open': {
          if (typeof args.path !== 'string' || args.path.trim().length === 0) {
            throw new HttpError(400, '`open` 需要一个节点相对目录：path')
          }
          return await openRemote({ node: args.name, path: args.path, root: args.localRoot })
        }
        case 'unmirror': return await dropMirror({ workspaceId: args.workspaceId })
        case 'mirrorRoot': return await setMirrorRoot({ root: args.localRoot ?? args.path })
        case 'retry': {
          await reconcile(true)
          const state = await buildState()
          return { nodes: state.nodes.map(node => ({ name: node.name, state: node.state, error: node.error, toolCount: node.toolCount })) }
        }
        /* c8 ignore next 2 -- the enum above is enforced before execute runs. */
        default:
          throw new HttpError(400, `unsupported action "${String(args.action)}"`)
      }
    },
  }), 'devspace: devspace_admin tool')

  ctx.effect(() => ctx.tools.register({
    name: 'devspace_target',
    description:
      'Report the remote target of THIS Session: which DevSpace node, which remote directory, and the remote workspace_id to '
      + 'reuse, plus the local mirror directory this Session runs in. The answer is derived from the Session working directory, '
      + 'so it stays correct for every Session started by picking a remote directory. Call it before any DevSpace work; a null '
      + 'target means this Session has no remote directory, so open one with mcp__<node>__open_workspace first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /** @param {any} args - none. @param {any} exec - execution context. */
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.header?.id
      const cwd = exec.agent?.session?.header?.cwd
      const { store } = await mirrorState()
      const target = mirrorForCwd(store.mirrors, typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : cwd) ?? null
      return {
        sessionId: sessionId ?? null,
        cwd: cwd ?? null,
        target: target === null
          ? null
          : {
              node: target.node,
              remotePath: target.remotePath,
              remoteWorkspaceId: target.remoteWorkspaceId,
              localPath: target.localPath,
              workspaceId: target.workspaceId,
            },
        hint: target === null
          ? '这个会话没有远端目标：用「Add Remote…」选一个远端目录开会话（会话 cwd 就是本地镜像目录），或先调 mcp__<节点>__open_workspace 自己拿 workspace_id。'
          : `远端目标：节点 ${target.node} 的 ${target.remotePath}（workspace_id=${target.remoteWorkspaceId}）；本地镜像是 ${target.localPath}。`
            + `远端代码/命令一律走 mcp__${target.node}__* 工具并用远端路径；本地镜像目录只放下载数据、待上传产物和本地处理脚本，两边不会自动同步。`,
      }
    },
  }), 'devspace: devspace_target tool')

  ctx.effect(() => ctx.tools.register({
    name: 'devspace_pull',
    description:
      'Download one file from a DevSpace node into the local mirror directory (binary-safe, transferred in chunks). '
      + 'Use it to bring remote data local for processing. The remote path is relative to this Session’s remote target, '
      + 'or an absolute path inside the node root; without localPath the file lands at the matching path in the local mirror.',
    parameters: {
      type: 'object',
      properties: {
        remotePath: { type: 'string', description: '远端文件：相对本会话目标目录，或节点根内的绝对路径（如 D:\\work\\project\\out\\a.bin）。' },
        localPath: { type: 'string', description: '本地落盘路径（绝对路径，或相对会话 cwd）；默认写到本地镜像里的同名相对路径。' },
        node: { type: 'string', description: '节点名；默认用本会话的远端目标节点。' },
      },
      required: ['remotePath'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /** @param {any} args - the tool arguments. @param {any} exec - execution context. */
    execute: (args, exec) => pullFile(args ?? {}, exec),
  }), 'devspace: devspace_pull tool')

  ctx.effect(() => ctx.tools.register({
    name: 'devspace_push',
    description:
      'Upload one local file (usually something prepared inside the local mirror directory) onto a DevSpace node '
      + '(binary-safe, transferred in chunks). Without remotePath the file lands under this Session’s remote target at the '
      + 'same relative path it has in the mirror.',
    parameters: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: '本地文件：绝对路径，或相对会话 cwd 的路径。' },
        remotePath: { type: 'string', description: '远端落点：相对本会话目标目录，或节点根内的绝对路径；默认按镜像内的相对路径放。' },
        node: { type: 'string', description: '节点名；默认用本会话的远端目标节点。' },
      },
      required: ['localPath'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /** @param {any} args - the tool arguments. @param {any} exec - execution context. */
    execute: (args, exec) => pushFile(args ?? {}, exec),
  }), 'devspace: devspace_push tool')

  // ---- read-only self-check ----------------------------------------

  const inspect = ctx.get('cordisInspect')
  if (inspect !== undefined) {
    try {
      ctx.effect(() => inspect.register({
        manifest: {
          id: 'DevSpace',
          description: 'Live facts about the DevSpace node manager: stored nodes, per-node mount state, tool counts, and the published skill.',
          methods: [
            {
              name: 'report',
              description: 'Return the node store, each node’s live mount state and tool count, and the skill the provider would serve.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { description: 'DevSpace manager state.' },
            },
            {
              name: 'probeBridge',
              description: 'Import @deepseek-ai/dsh-mcp-client through the live Loader and report the export shape it resolved to, without mounting anything.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { description: 'Module resolution facts.' },
            },
          ],
        },
        query: async (method) => {
          if (method === 'probeBridge') {
            try {
              const imported = await ctx.loader.import(MCP_PLUGIN)
              const resolved = typeof imported?.apply === 'function' ? imported : imported?.default
              return {
                ok: true,
                exports: Object.keys(imported ?? {}).sort(),
                hasApply: typeof resolved?.apply === 'function',
                file: existsSync(nodesFile) ? nodesFile : null,
              }
            } catch (error) {
              return { ok: false, error: messageOf(error) }
            }
          }
          const state = await buildState()
          const providerList = self === null ? null : await self.provider.list()
          return {
            ...state,
            applied: [...applied.values()].map(record => ({
              nodeName: record.nodeName, state: record.state, error: record.error, hasFiber: record.fiber !== undefined,
            })),
            providerCandidates: providerList === null ? null : providerList.map(candidate => candidate.name),
            skillBody: providerList !== null && providerList.length > 0 && self !== null
              ? (await self.provider.get(providerList[0]))?.content ?? null
              : null,
          }
        },
      }), 'devspace: inspect provider')
    } catch (error) {
      warn(`devspace: inspect provider registration failed: ${messageOf(error)}`)
    }
  }

  // Mount whatever is already configured, without blocking activation.
  ctx.effect(() => () => {
    for (const [nodeName, record] of applied) {
      applied.delete(nodeName)
      void record.fiber?.dispose?.()
    }
  }, 'devspace: node mounts')
  void reconcile(false)
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Answer an unauthenticated or non-loopback request; true when it was rejected. */
function rejectUnauthenticated(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection === undefined) return false
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload ?? null))
}

/** Read one bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return parsed
}
