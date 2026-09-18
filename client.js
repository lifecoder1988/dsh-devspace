/**
 * DevSpace — browser half.
 *
 * The Settings page for DevSpace nodes: one card per node with its live mount
 * state, and an in-place form to add or edit one. A node is an MCP endpoint, but
 * it is managed here rather than on the MCP page — this plugin owns the node
 * store, the mounts and the published skill.
 *
 * Three marks carry "this Workspace mirrors a remote directory" out of the
 * Settings page: the sidebar row wears the node's logo instead of putting the
 * node name in the Workspace title, the Hero's workspace chip names the node next
 * to the directory, and an open Session's header does the same — the chip is the
 * Hero's own seat, so a Session with turns has none. All three read one shared
 * mirror index.
 *
 * No local mapping: nothing on this page binds a node directory to a local
 * workspace, and remote work happens only through `mcp__<node>__*` tools.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-devspace',
  factory(require) {
    const React = require('react')
    const {
      Button, Input, Checkbox, Tag, IconProjectAddOutline16, Modal,
      IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconPlusOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    // A body-level portal: `position: fixed` inside the frame-wide overlay layer
    // degrades to that layer's own coordinate space when any ancestor carries a
    // transform/filter, which made the panel look like page content.
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const API = '/devspace'

    const NODE_NAME = /^[A-Za-z0-9_-]{1,32}$/

    /** Set from the plugin context: the local picker and starting a Session. */
    let devspaceUiWorkspace = null

    const CSS = `
.devs-page { display: flex; flex-direction: column; gap: 12px; max-width: 760px; color: var(--dsw-alias-label-primary); }
.devs-title { margin: 0; font-size: 18px; font-weight: 600; }
.devs-intro { margin: 0; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-tertiary); }
.devs-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.devs-grow { display: flex; align-self: stretch; box-sizing: border-box; }
.devs-group { display: flex; flex-direction: column; gap: 10px; }
.devs-group-head { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.devs-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); grid-auto-rows: min-content; align-items: start; gap: 12px; margin: 0; padding: 0; list-style: none; }
.devs-card { display: flex; flex-direction: column; align-self: start; background: transparent; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 20px; transition: border-color .16s, background .16s; }
.devs-card:hover:not(.devs-card-active) { background: var(--dsw-alias-interactive-bg-hover); }
.devs-card-active { background: var(--dsw-alias-bg-module-platform); border-color: var(--dsw-static-neutral-bluish-400); }
.devs-card-broken { border-color: var(--dsw-alias-state-error-primary); }
.devs-card-main { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 12px; appearance: none; border: 0; border-radius: 12px 12px 0 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.devs-card-main:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.devs-card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.devs-card-name { min-width: 0; overflow: hidden; font-size: 15px; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
/* Notes are free prose and can be arbitrarily long: three lines keep every card
   the same height, and the full text stays available through the title tooltip. */
.devs-card-desc { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 20px; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.devs-card-prefix { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
/* A disabled node stays readable but must not read as live. */
.devs-card-off .devs-card-main, .devs-card-off .devs-card-foot { opacity: .6; }
.devs-card-id { margin-top: auto; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.devs-card-err { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.devs-card-foot { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.devs-foot-spacer { flex: 1; }
.devs-empty-item { grid-column: 1 / -1; min-width: 0; list-style: none; }
.devs-empty-plus { font-size: 22px; line-height: 1; }
.devs-empty-label { font-size: 14px; font-weight: 600; color: currentColor; }
.devs-empty-hint { font-size: 12px; line-height: 1.5; }
.devs-mirrors { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.devs-mirror { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 14px; }
.devs-mirror-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.devs-mirror-title { font-size: 14px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.devs-root-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.devs-form-item { grid-column: 1 / -1; min-width: 0; list-style: none; }
.devs-editor { display: flex; flex-direction: column; gap: 12px; padding: 16px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 20px; background: var(--dsw-alias-bg-module-platform); }
.devs-editor-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.devs-editor-title { min-width: 0; overflow: hidden; font-size: 15px; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.devs-spacer { flex: 1; }
.devs-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 200px; }
/* No text-transform here: these labels name literal identifiers (mcp__<名称>__*,
   root), and uppercasing them states a prefix the tools do not actually use. */
.devs-field-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.devs-field-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.devs-field-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.devs-field-warn { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); }
.devs-row { display: flex; gap: 12px; flex-wrap: wrap; }
.devs-textarea { width: 100%; min-height: 72px; padding: 8px 12px; box-sizing: border-box; resize: vertical; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 20px; }
.devs-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.devs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.devs-danger { color: var(--dsw-alias-state-error-primary); }
.devs-note { margin: 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.devs-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.devs-error { margin: 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.devs-ok { margin: 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-state-success-primary); overflow-wrap: anywhere; }
.devs-loading { font-size: 13px; color: var(--dsw-alias-label-tertiary); }
/* Collapsed explanation: the page keeps one short lead line, the long version
   is one click away instead of five lines of prose above the list. */
.devs-more { font-size: 12px; }
.devs-more > summary { display: inline-flex; align-items: center; gap: 4px; list-style: none; cursor: pointer; color: var(--dsw-alias-label-tertiary); }
.devs-more > summary::-webkit-details-marker { display: none; }
.devs-more > summary:hover { color: var(--dsw-alias-label-primary); }
.devs-more > summary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.devs-more-chev { display: inline-flex; transition: transform .16s; }
.devs-more[open] .devs-more-chev { transform: rotate(90deg); }
.devs-more-body { margin: 8px 0 0; max-width: 68ch; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
/* Empty state: the add tile is the only cell, so it may take the whole width. */
.devs-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 132px; padding: 20px 16px; box-sizing: border-box; appearance: none; cursor: pointer; font: inherit; text-align: center; color: var(--dsw-alias-label-tertiary); background: transparent; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: 20px; transition: border-color .16s, background .16s, color .16s; }
.devs-empty:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.devs-empty:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.devs-confirm-text { margin-left: auto; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.devs-mirror-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.devs-mirror-path { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 11px; line-height: 17px; }
.devs-mirror-key { flex: none; color: var(--dsw-alias-label-tertiary); }
.devs-mirror-val { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-secondary); }
.devs-meta { margin: 0; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
`

    async function call(path, init) {
      const response = await fetch(new URL(API + path, location.origin), init)
      const text = await response.text()
      let payload
      try {
        payload = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        payload = { message: text }
      }
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`)
      return payload
    }

    const post = (path, body) => call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    /** `KEY=VALUE` lines ↔ object. */
    function linesToMap(text) {
      const out = {}
      for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const at = line.indexOf('=')
        if (at <= 0) continue
        out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
      return out
    }

    const mapToLines = map => Object.entries(map ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')

    /**
     * A credential-shaped header value written out in full instead of as a
     * `${VAR}` reference. The value itself is never echoed back — only a nudge to
     * move it into the environment.
     */
    function hasLiteralCredential(text) {
      for (const [key, value] of Object.entries(linesToMap(text))) {
        if (!/(authorization|token|secret|password|api[-_]?key|cookie)/i.test(key)) continue
        if (value.includes('${')) continue
        if (value.replace(/^Bearer\s+/i, '').length >= 16) return true
      }
      return false
    }

    const STATE_TAG = {
      ready: { tone: 'success', label: '运行中' },
      connecting: { tone: 'info', label: '连接中' },
      pending: { tone: 'info', label: '等待挂载' },
      error: { tone: 'danger', label: '连接失败' },
      conflict: { tone: 'warning', label: '名称被占用' },
      disabled: { tone: 'quiet', label: '已停用' },
    }

    /* ------------- remote marks: sidebar row + Hero workspace chip ------------ */

    const BADGE_CSS = `
.devs-mark { display: inline-flex; align-items: center; gap: 4px; min-width: 0; color: var(--dsw-alias-label-tertiary); }
.devs-mark-icon { display: inline-flex; align-items: center; flex: none; color: currentColor; }
.devs-mark-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; }
/* The Session header's mark reads as a chip, like the inspector chips beside it. */
.devs-mark-head { flex: none; max-width: 190px; height: 24px; padding: 0 9px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); }
.devs-mark-head .devs-mark-name { max-width: 140px; }
`

    /**
     * Which local Workspace mirrors which node, by Workspace id. One shared poller
     * feeds every mark: a row badge needs only "is this row remote", the chip also
     * names the machine, and neither should cost a request per rendered row.
     */
    const mirrorIndex = {
      byWorkspace: new Map(),
      listeners: new Set(),
      retainCount: 0,
      timer: null,
      loadedAt: 0,
      inflight: null,
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      emit() { for (const listener of [...this.listeners]) listener() },
      /** The mirror one local Workspace id belongs to, or null. */
      get(workspaceId) { return this.byWorkspace.get(String(workspaceId ?? '')) ?? null },
      /** The mirror one local directory lives in (itself or a subdirectory), or null. */
      at(cwd) {
        const path = String(cwd ?? '').replace(/\/+$/, '')
        if (path.length === 0) return null
        for (const mirror of this.byWorkspace.values()) {
          const root = mirror.localPath.replace(/\/+$/, '')
          if (root.length > 0 && (path === root || path.startsWith(`${root}/`))) return mirror
        }
        return null
      },
      /** Rebuild the index from one `/state` answer. */
      setState(data) {
        const nodes = new Map((data?.nodes ?? []).map(node => [String(node.name), node]))
        const next = new Map()
        for (const mirror of data?.mirrors ?? []) {
          if (typeof mirror?.workspaceId !== 'string') continue
          const node = nodes.get(String(mirror.node)) ?? {}
          const label = String(mirror.nodeLabel ?? node.label ?? '')
          next.set(mirror.workspaceId, {
            node: String(mirror.node ?? ''),
            label: label.length > 0 ? label : String(mirror.node ?? ''),
            remotePath: String(mirror.remotePath ?? ''),
            localPath: String(mirror.localPath ?? ''),
            exists: mirror.exists !== false,
          })
        }
        const changed = next.size !== this.byWorkspace.size || [...next].some(([id, value]) => {
          const current = this.byWorkspace.get(id)
          return current === undefined || current.node !== value.node || current.label !== value.label
            || current.localPath !== value.localPath
        })
        this.byWorkspace = next
        this.loadedAt = Date.now()
        if (changed) this.emit()
      },
      refresh() {
        if (this.inflight !== null) return this.inflight
        this.inflight = call('/state')
          .then(data => { this.setState(data) })
          .catch(() => {})
          .then(() => { this.inflight = null })
        return this.inflight
      },
      /** Keep the poller alive while at least one mark is mounted. */
      retain() {
        this.retainCount += 1
        if (this.retainCount === 1) {
          void this.refresh()
          this.timer = setInterval(() => { void this.refresh() }, 20000)
        }
        return () => {
          this.retainCount -= 1
          if (this.retainCount > 0) return
          this.retainCount = 0
          if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
          }
        }
      },
    }

    /** Subscribe one mark to the mirror index. */
    function useMirror(workspaceId) {
      const id = String(workspaceId ?? '')
      const [, bump] = React.useState(0)
      React.useEffect(() => mirrorIndex.subscribe(() => bump(value => value + 1)), [])
      React.useEffect(() => mirrorIndex.retain(), [])
      return id.length === 0 ? null : mirrorIndex.get(id)
    }

    /** The same subscription, for a mark that knows a directory instead of an id. */
    function useMirrorAt(cwd) {
      const path = String(cwd ?? '')
      const [, bump] = React.useState(0)
      React.useEffect(() => mirrorIndex.subscribe(() => bump(value => value + 1)), [])
      React.useEffect(() => mirrorIndex.retain(), [])
      return path.length === 0 ? null : mirrorIndex.at(path)
    }

    /**
     * The node logo one mark shows: the node's own name decides and a name that
     * says nothing falls back to the neutral grid. Same art as the sibling node
     * panels keep, so one machine reads the same everywhere.
     */
    const NODE_GLYPHS = {
      win: [['path', { d: 'M2 3.4 7.3 2.7 7.3 7.6 2 7.6 Z M8.3 2.6 14 1.8 14 7.6 8.3 7.6 Z M2 8.7 7.3 8.7 7.3 13.6 2 12.9 Z M8.3 8.7 14 8.7 14 14.5 8.3 13.7 Z', filled: true }]],
      mac: [
        ['path', { d: 'M11.2 8.4 C11.2 6.8 12.5 6.1 12.6 6 C11.8 4.9 10.6 4.7 10.2 4.7 9.1 4.6 8.2 5.3 7.6 5.3 7 5.3 6.3 4.7 5.4 4.7 4.3 4.7 3.2 5.4 2.6 6.4 1.4 8.5 2.3 11.6 3.5 13.3 4.1 14.1 4.8 15 5.7 14.9 6.6 14.9 6.9 14.3 8 14.3 9.1 14.3 9.4 14.9 10.3 14.9 11.3 14.9 11.9 14.1 12.5 13.3 13.2 12.4 13.4 11.5 13.5 11.4 13.5 11.4 11.2 10.5 11.2 8.4 Z', filled: true }],
        ['path', { d: 'M9.6 3.7 C10.1 3.1 10.4 2.3 10.3 1.5 9.6 1.5 8.7 2 8.2 2.6 7.8 3.1 7.4 4 7.5 4.8 8.3 4.9 9.1 4.4 9.6 3.7 Z', filled: true }],
      ],
      grid: [
        ['rect', { x: 2.3, y: 2.3, width: 4.7, height: 4.7, rx: 1.3 }],
        ['rect', { x: 9, y: 2.3, width: 4.7, height: 4.7, rx: 1.3 }],
        ['rect', { x: 2.3, y: 9, width: 4.7, height: 4.7, rx: 1.3 }],
        ['rect', { x: 9, y: 9, width: 4.7, height: 4.7, rx: 1.3 }],
      ],
    }

    /** One 16×16 node glyph, coloured by `currentColor`. */
    function nodeGlyph(mirror, size) {
      const named = `${mirror.node} ${mirror.label}`.toLowerCase()
      const id = /win|windows|powershell/.test(named) ? 'win' : /mac|darwin|apple|osx/.test(named) ? 'mac' : 'grid'
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        NODE_GLYPHS[id].map(([tag, attrs], index) => {
          const { filled, ...rest } = attrs
          return h(tag, {
            key: index,
            ...rest,
            ...(filled === true
              ? { fill: 'currentColor', stroke: 'none' }
              : { fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          })
        }))
    }

    /** What the node is, for the hover tooltip both marks carry. */
    const markTitle = mirror => `远端节点 ${mirror.label}（${mirror.node}）· ${mirror.remotePath}`

    /**
     * The sidebar row's mark: the node logo alone, because the directory title is
     * the row's text and the node is what the icon adds.
     */
    function RemoteRowBadge(props) {
      const mirror = useMirror(props?.workspaceId)
      if (mirror === null) return null
      return h('span', { className: 'devs-mark', 'data-devs-remote': mirror.node, title: markTitle(mirror) },
        h('style', null, BADGE_CSS),
        h('span', { className: 'devs-mark-icon' }, nodeGlyph(mirror, 14)),
      )
    }

    /**
     * The Hero workspace chip's mark: the same logo plus the node's own name, so
     * the chip says both which directory and which machine the Session runs in.
     */
    function RemoteChipBadge(props) {
      const mirror = useMirror(props?.workspaceId)
      if (mirror === null) return null
      return h('span', { className: 'devs-mark', 'data-devs-remote': mirror.node, title: markTitle(mirror) },
        h('style', null, BADGE_CSS),
        h('span', { className: 'devs-mark-icon' }, nodeGlyph(mirror, 14)),
        h('span', { className: 'devs-mark-name' }, mirror.label),
      )
    }

    /**
     * The open Session's own mark, for the seat the Hero chip cannot reach: once a
     * Session has turns there is no workspace chip any more, so the header names
     * the node instead. A Session in a local directory renders nothing.
     * @param props - the header seat's standard Session props (`sessionId`, `useSessions`).
     */
    function RemoteSessionBadge(props) {
      const sessionId = props?.sessionId
      const cwd = props.useSessions(snapshot => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd))
      const mirror = useMirrorAt(cwd)
      if (mirror === null) return null
      return h('span', {
        className: 'devs-mark devs-mark-head',
        'data-devs-remote': mirror.node,
        title: markTitle(mirror),
      },
        h('style', null, BADGE_CSS),
        h('span', { className: 'devs-mark-icon' }, nodeGlyph(mirror, 14)),
        h('span', { className: 'devs-mark-name' }, mirror.label),
      )
    }

    function emptyDraft() {
      return { name: '', label: '', url: 'http://', root: '', headersText: '', notes: '', toolCallTimeoutMs: 120000, failOnStartupError: true, enabled: true, mode: 'create' }
    }

    function draftOf(node) {
      return {
        mode: 'edit',
        name: node.name,
        label: node.label ?? '',
        url: node.url ?? '',
        root: node.root ?? '',
        headersText: mapToLines(node.headers),
        notes: node.notes ?? '',
        toolCallTimeoutMs: node.toolCallTimeoutMs ?? 120000,
        failOnStartupError: node.failOnStartupError !== false,
        enabled: node.enabled !== false,
      }
    }

    /* -------------------- layout self-check (read-only) -------------------- */

    const captured = []

    function recordReport(report) {
      const signature = [report.section.width, report.section.height, report.cardCount, report.formOpen, report.offenderCount].join(':')
      if (captured[0]?.signature === signature) return
      captured.unshift({ signature, capturedAt: new Date().toISOString(), ...report })
      if (captured.length > 8) captured.length = 8
    }

    function measureElement(section) {
      const round = value => Math.round(value * 10) / 10
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect()
        return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height), right: round(rect.right) }
      }
      const label = (element) => {
        const cls = typeof element.className === 'string' && element.className.length > 0
          ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : ''
        const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
        return `${element.tagName.toLowerCase()}${cls}${text.length > 0 ? ` "${text}"` : ''}`
      }
      const doc = document.documentElement
      let container = section.parentElement
      while (container !== null && container !== document.body) {
        const overflowY = getComputedStyle(container).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') break
        container = container.parentElement
      }
      const sectionRect = section.getBoundingClientRect()
      const offenders = []
      for (const element of section.querySelectorAll('*')) {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        const parent = element.parentElement
        const parentRect = parent === null ? sectionRect : parent.getBoundingClientRect()
        if (rect.right - parentRect.right > 1 || element.scrollWidth - element.clientWidth > 1) {
          offenders.push({ element: label(element), overflowRight: round(rect.right - parentRect.right) })
        }
      }
      const cards = [...section.querySelectorAll('.devs-card')]
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        horizontalDocumentOverflow: doc.scrollWidth > doc.clientWidth + 1,
        activeSettingsSection: (document.querySelector('[aria-current="true"]')?.textContent ?? '').trim() || null,
        section: rectOf(section),
        container: container === null ? null : { ...rectOf(container), clientWidth: container.clientWidth, scrollWidth: container.scrollWidth, horizontalOverflow: container.scrollWidth > container.clientWidth + 1 },
        cardCount: cards.length,
        cardNames: cards.map(card => (card.querySelector('.devs-card-name')?.textContent ?? '').trim()),
        formOpen: section.querySelector('.devs-editor') !== null,
        offenderCount: offenders.length,
        offenders: offenders.slice(0, 8),
      }
    }

    /* ------------------------------- page ------------------------------- */

    function Page() {
      const rootRef = React.useRef(null)
      const formRef = React.useRef(null)
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [mirrorRoot, setMirrorRoot] = React.useState('')

      React.useLayoutEffect(() => {
        if (rootRef.current !== null) recordReport(measureElement(rootRef.current))
      })
      React.useEffect(() => {
        const node = rootRef.current
        if (node === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => { recordReport(measureElement(node)) })
        observer.observe(node)
        return () => { observer.disconnect() }
      }, [])

      const load = React.useCallback(async (quiet = false) => {
        if (!quiet) setState(previous => ({ ...previous, loading: true, error: null }))
        try {
          const data = await call('/state')
          mirrorIndex.setState(data)
          setState({ loading: false, error: null, data })
          return data
        } catch (error) {
          setState(previous => (quiet ? previous : { loading: false, error: String(error.message ?? error), data: null }))
          return null
        }
      }, [])

      React.useEffect(() => { void load() }, [load])
      // The page polls every 8s; only a root that actually CHANGED may overwrite
      // what is currently typed here.
      const loadedRootRef = React.useRef(null)
      React.useEffect(() => {
        const loaded = state.data?.mirrorRoot
        if (typeof loaded !== 'string' || loaded.length === 0 || loaded === loadedRootRef.current) return
        loadedRootRef.current = loaded
        setMirrorRoot(loaded)
      }, [state.data?.mirrorRoot])
      React.useEffect(() => {
        const timer = setInterval(() => { void load(true) }, 8000)
        return () => { clearInterval(timer) }
      }, [load])

      const formKey = draft === null ? null : `${draft.mode}:${draft.name}`
      React.useEffect(() => {
        // A fresh draft never starts armed for deletion.
        setConfirmDelete(false)
        const field = formRef.current
        if (formKey === null || field === null) return
        field.scrollIntoView({ block: 'nearest' })
        const input = field.querySelector('input, textarea')
        if (input !== null) input.focus()
      }, [formKey])

      const act = React.useCallback(async (path, body, note) => {
        setBusy(true)
        setNotice(null)
        try {
          const data = await post(path, body)
          setState({ loading: false, error: null, data })
          if (note !== undefined) setNotice({ kind: 'ok', text: note })
          return data
        } catch (error) {
          setNotice({ kind: 'error', text: String(error.message ?? error) })
          return null
        } finally {
          setBusy(false)
        }
      }, [])

      const data = state.data
      const nodes = data?.nodes ?? []
      const nameValid = NODE_NAME.test(draft?.name ?? '')
      const canSubmit = draft !== null && nameValid && String(draft.url ?? '').trim().length > 0 && !busy

      const field = (label, key, placeholder, hint) => h('div', { className: 'devs-field' },
        h('label', { className: 'devs-field-label' }, label),
        h(Input, {
          className: 'devs-grow',
          value: draft[key],
          placeholder: placeholder ?? '',
          disabled: key === 'name' && draft.mode === 'edit',
          onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })),
        }),
        hint ?? null,
      )

      const renderForm = () => h('div', { className: 'devs-editor' },
        h('div', { className: 'devs-editor-head' },
          h('span', { className: 'devs-editor-title' }, draft.mode === 'create' ? '新增节点' : `编辑 ${draft.name}`),
          draft.mode === 'edit' && (nodes.find(node => node.name === draft.name)?.fromComposition ?? false)
            ? h(Tag, { tone: 'warning' }, '由 composition 提供')
            : null,
          h('span', { className: 'devs-spacer' }),
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => setDraft(null) }, '取消'),
        ),
        h('div', { className: 'devs-row' },
          field('节点名（= mcp__<名称>__* 前缀）', 'name', 'devspace-win', draft.name.length > 0 && !nameValid
            ? h('span', { className: 'devs-field-error' }, '只允许字母、数字、下划线和连字符，1–32 位')
            : h('span', { className: 'devs-field-hint' }, '一个节点 = 一个 MCP 端点。')),
          field('显示名', 'label', 'Windows 桌面机', null),
        ),
        field('MCP 端点 URL', 'url', 'http://192.168.1.10:7676/mcp', h('span', { className: 'devs-field-hint' }, 'DevSpace 节点的 streamable-http 端点。')),
        field('允许根目录（root）', 'root', 'D:\\work\\project', h('span', { className: 'devs-field-hint' }, '节点允许访问的根；目录选择器与 open_workspace 都从这里开始。')),
        h('div', { className: 'devs-field' },
          h('label', { className: 'devs-field-label' }, '请求头（每行 KEY=VALUE）'),
          h('textarea', {
            className: 'devs-textarea',
            value: draft.headersText,
            placeholder: 'Authorization=Bearer ${DEVSPACE_WIN_TOKEN}',
            onChange: event => setDraft(previous => ({ ...previous, headersText: event.target.value })),
          }),
          h('span', { className: 'devs-field-hint' }, 'token 写成 ${VAR} 引用，从进程环境解析；不要写明文。'),
          hasLiteralCredential(draft.headersText)
            ? h('span', { className: 'devs-field-warn' }, '这里有一行像明文凭据（值里没有 ${VAR} 引用）：它会明文写进节点文件，建议改成 ${VAR} 引用。')
            : null,
        ),
        h('div', { className: 'devs-row' },
          field('单次调用超时（毫秒）', 'toolCallTimeoutMs', '120000', null),
          field('备注（写进技能，可选）', 'notes', '允许根 D:\\work\\project', null),
        ),
        h(Checkbox, {
          checked: draft.failOnStartupError,
          label: '节点不可达时报错（关闭则后台自动重连）',
          onChange: next => setDraft(previous => ({ ...previous, failOnStartupError: next })),
        }),
        h(Checkbox, {
          checked: draft.enabled,
          label: '启用该节点（关闭后它的 mcp__ 工具立即卸载）',
          onChange: next => setDraft(previous => ({ ...previous, enabled: next })),
        }),
        h('div', { className: 'devs-actions' },
          h(Button, {
            size: 'sm', variant: 'primary', disabled: !canSubmit,
            onClick: () => {
              void act('/save', {
                node: {
                  name: draft.name,
                  label: draft.label,
                  url: draft.url,
                  root: draft.root,
                  headers: linesToMap(draft.headersText),
                  notes: draft.notes,
                  toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) || 120000,
                  failOnStartupError: draft.failOnStartupError,
                  enabled: draft.enabled,
                },
              }, draft.mode === 'create' ? `已添加节点 ${draft.name}` : `已保存节点 ${draft.name}`).then(result => { if (result !== null) setDraft(null) })
            },
          }, draft.mode === 'create' ? '添加并挂载' : '保存'),
          h('span', { className: 'devs-spacer' }),
          draft.mode !== 'edit'
            ? null
            : confirmDelete
              // Deleting a node unmounts its tools and is not undoable: arm the
              // intent first, and say what the click will actually do.
              ? h('span', { className: 'devs-confirm-text' }, '删除后它的 mcp__ 工具立即卸载，且不可撤销。')
              : h(Button, {
                  size: 'sm', variant: 'ghost', className: 'devs-danger', disabled: busy,
                  onClick: () => setConfirmDelete(true),
                }, '删除节点'),
          confirmDelete && draft.mode === 'edit'
            ? h(Button, {
                size: 'sm', variant: 'ghost', className: 'devs-danger', disabled: busy,
                onClick: () => { void act('/delete', { name: draft.name }, `已删除节点 ${draft.name}`).then(result => { if (result !== null) setDraft(null) }) },
              }, '确认删除')
            : null,
          confirmDelete && draft.mode === 'edit'
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setConfirmDelete(false) }, '取消删除')
            : null,
        ),
      )

      const cells = nodes.map((node) => {
        const active = draft !== null && draft.mode === 'edit' && draft.name === node.name
        if (active) return h('li', { key: node.name, className: 'devs-form-item', ref: formRef }, renderForm())
        const tag = STATE_TAG[node.state] ?? { tone: 'info', label: String(node.state) }
        const broken = node.state === 'error' || node.state === 'conflict'
        const title = node.label.length > 0 ? node.label : node.name
        const openEditor = () => { setNotice(null); setDraft(draftOf(node)) }
        return h('li', {
          key: node.name,
          className: `devs-card${broken ? ' devs-card-broken' : ''}${node.enabled !== true ? ' devs-card-off' : ''}`,
        },
        h('button', {
          type: 'button',
          className: 'devs-card-main',
          'aria-label': `编辑节点 ${node.name}`,
          onClick: openEditor,
        },
          h('span', { className: 'devs-card-head' },
            h('span', { className: 'devs-card-name', title }, title),
            h(Tag, { tone: tag.tone }, node.state === 'ready' ? `运行中 · ${String(node.toolCount)} 工具` : tag.label),
            node.fromComposition ? h(Tag, { tone: 'warning' }, 'composition') : null,
          ),
          // The prefix is what the tools are actually called: always visible, so
          // a label never hides the name the model has to use.
          h('span', { className: 'devs-card-prefix' }, `mcp__${node.name}__*`),
          node.notes.length > 0 ? h('span', { className: 'devs-card-desc', title: node.notes }, node.notes) : null,
          node.error !== null && node.error !== undefined ? h('span', { className: 'devs-card-err' }, node.error) : null,
          h('span', { className: 'devs-card-id' }, node.url),
        ),
        h('div', { className: 'devs-card-foot' },
          h(Button, { size: 'sm', variant: 'ghost', onClick: openEditor }, '编辑'),
          broken
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => { void act('/retry', {}, `已重试 ${node.name}`) } }, '重试')
            : null,
          h('span', { className: 'devs-foot-spacer' }),
          h(Button, {
            size: 'sm', variant: 'ghost', disabled: busy,
            onClick: () => { void act('/toggle', { name: node.name, enabled: node.enabled !== true }, `${node.enabled !== true ? '已启用' : '已停用'} ${node.name}`) },
          }, node.enabled !== true ? '启用' : '停用'),
        ))
      })
      // With nodes on screen the toolbar owns "add"; the dashed tile is the empty
      // state's only cell. Either way the create editor opens inside the grid.
      if (draft !== null && draft.mode === 'create') {
        cells.push(h('li', { key: '__create', className: 'devs-form-item', ref: formRef }, renderForm()))
      } else if (nodes.length === 0) {
        cells.push(h('li', { key: '__empty', className: 'devs-empty-item' },
          h('button', { type: 'button', className: 'devs-empty', onClick: () => { setNotice(null); setDraft(emptyDraft()) } },
            h('span', { className: 'devs-empty-plus' }, '＋'),
            h('span', { className: 'devs-empty-label' }, '添加第一个节点'),
            h('span', { className: 'devs-empty-hint' }, '一个节点 = 一个 MCP 端点；保存即挂载，无需重启'),
          )))
      }

      const skillLine = data === null
        ? ''
        : `技能 ${data.skill.active ? `${data.skill.name} 已注入` : '未注入（没有启用中的节点）'}`

      return h('div', { className: 'devs-page', ref: rootRef },
        h('style', null, CSS),
        h('h2', { className: 'devs-title' }, 'DevSpace 节点'),
        h('p', { className: 'devs-intro' }, '统一管理 DevSpace 节点：一个节点就是一个 MCP 端点，添加后即时挂载，工具以 mcp__<节点名>__<工具> 出现。'),
        h('details', { className: 'devs-more' },
          h('summary', null,
            h('span', { className: 'devs-more-chev' }, iconNode(IconChevronRightOutline14, { size: 12 })),
            '它是怎么工作的',
          ),
          h('p', { className: 'devs-more-body' }, '从工作区选择器的「Add Remote…」选一个远端目录，会在本地建一个镜像工作区（下面的列表），会话就挂在那个本地工作区下；项目本体仍在远端，远端读写只走 mcp__ 工具，两边靠 devspace_pull / devspace_push 传文件，不会自动同步。'),
        ),
        h('div', { className: 'devs-toolbar' },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => { void load() } }, busy ? '刷新中…' : '刷新'),
          h(Button, {
            size: 'sm', variant: 'primary',
            // Never re-open the draft from here: it would silently drop what is typed.
            disabled: busy || data === null || draft !== null,
            title: draft === null ? undefined : '先保存或取消当前编辑',
            onClick: () => { setNotice(null); setDraft(emptyDraft()) },
          }, '添加节点'),
        ),
        state.error !== null ? h('p', { className: 'devs-error', role: 'alert' }, state.error) : null,
        notice !== null
          ? h('p', { className: notice.kind === 'ok' ? 'devs-ok' : 'devs-error', role: notice.kind === 'ok' ? 'status' : 'alert' }, notice.text)
          : null,
        data !== null && data.unresolved.length > 0
          ? h('p', { className: 'devs-error', role: 'alert' }, `有 ${String(data.unresolved.length)} 个 ${'${VAR}'} 引用没解析到：${data.unresolved.join(', ')}`)
          : null,
        h('div', { className: 'devs-group' },
          h('h3', { className: 'devs-group-head' }, `节点 · ${String(nodes.length)}`),
          state.loading && nodes.length === 0
            ? h('span', { className: 'devs-loading' }, '加载中…')
            : h('ul', { className: 'devs-cards' }, cells),
        ),
        data !== null
          ? h('div', { className: 'devs-group' },
              h('h3', { className: 'devs-group-head' }, `镜像工作区 · ${String((data.mirrors ?? []).length)}`),
              h('div', { className: 'devs-root-row' },
                h('span', { className: 'devs-note' }, '镜像根'),
                h(Input, {
                  className: 'devs-grow',
                  value: mirrorRoot,
                  placeholder: data.mirrorRoot ?? '',
                  disabled: busy,
                  onChange: event => setMirrorRoot(event.target.value),
                }),
                h(Button, {
                  size: 'sm',
                  variant: 'outline',
                  disabled: busy || mirrorRoot.trim().length === 0 || mirrorRoot.trim() === data.mirrorRoot,
                  onClick: () => { void act('/mirror-root', { root: mirrorRoot.trim() }, '镜像根已更新（只影响之后新建的镜像）') },
                }, '保存'),
              ),
              (data.mirrors ?? []).length === 0
                ? h('p', { className: 'devs-note' }, `还没有镜像工作区。当前镜像根是 ${data.mirrorRoot}；从工作区选择器的「Add Remote…」选一个远端目录，这里会多一条，侧栏 Workspaces 里也会出现对应的本地工作区。`)
                : h('ul', { className: 'devs-mirrors' }, (data.mirrors ?? []).map(mirror => h('li', { key: mirror.workspaceId, className: 'devs-mirror' },
                    h('div', { className: 'devs-mirror-main' },
                      h('span', { className: 'devs-mirror-title' }, mirror.title),
                      h('span', { className: 'devs-mirror-tags' },
                        h(Tag, { tone: 'outline' }, mirror.node),
                        mirror.exists === false ? h(Tag, { tone: 'warning' }, '本地目录已不存在') : null,
                      ),
                      h('span', { className: 'devs-mirror-path' },
                        h('span', { className: 'devs-mirror-key' }, '远端'),
                        h('span', {
                          className: 'devs-mirror-val',
                          title: `${mirror.remotePath}${mirror.remoteWorkspaceId.length > 0 ? ` · ${mirror.remoteWorkspaceId}` : ''}`,
                        }, `${mirror.remotePath}${mirror.remoteWorkspaceId.length > 0 ? ` · ${mirror.remoteWorkspaceId}` : ''}`),
                      ),
                      h('span', { className: 'devs-mirror-path' },
                        h('span', { className: 'devs-mirror-key' }, '本地'),
                        h('span', { className: 'devs-mirror-val', title: mirror.localPath }, mirror.localPath),
                      ),
                    ),
                    h(Button, {
                      size: 'sm',
                      variant: 'ghost',
                      disabled: busy,
                      title: '只移除侧栏登记，本地目录保留',
                      onClick: () => { void act('/unmirror', { workspaceId: mirror.workspaceId }, '已从侧栏移除该工作区登记（本地目录保留）') },
                    }, '移除'),
                  ))),
            )
          : null,
        data !== null ? h('p', { className: 'devs-meta' }, `${data.nodesFile} · ${skillLine}`) : null,
        h('p', { className: 'devs-note' }, '一个 node = 一个 MCP 服务器。要多台机器就多加几条；同一台机器上的多个 project/worktree 在远端用各自的 workspace_id 区分（不同节点之间不通用）。'),
      )
    }


    /**
     * State of the remote picking dialog. It cannot live inside the row: the
     * picker's popover closes (and unmounts its content) the moment the row is
     * activated, exactly like "Add workspace…" does — so the dialog renders in
     * the frame-level overlay seat and is driven from here. The card itself is
     * the harness Modal: body-portaled, masked and blurred, which is exactly
     * what the shipped "Select Workspace Directory" dialog is built from.
     */
    const remoteDialog = {
      open: false,
      listeners: new Set(),
      emit() { for (const listener of this.listeners) listener() },
      subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
      show() { this.open = true; this.emit() },
      hide() { this.open = false; this.emit() },
    }

    /* ---- Add Remote… : browse one DevSpace node, open it, start a Session ---- */

    /**
     * Metrics and tokens copy the shipped `Select Workspace Directory` dialog
     * (ui-directory-picker-browse) so the remote picker reads as the same
     * product surface: 680x500 card, header with title + path breadcrumb, one
     * folder column, footer with 新建文件夹 / 显示隐藏项 / 取消 / 打开. Labels are
     * Chinese because every other surface this plugin owns is Chinese.
     * The card classes are doubled so they win over the Modal's own module class
     * regardless of stylesheet order.
     */
    const FLOW_CSS = `
.devs-dlg.devs-dlg { width: min(680px, 100%); height: min(500px, calc(100dvh - 32px)); padding: 0; gap: 0; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.devs-dlg-header { display: flex; flex-direction: column; gap: 8px; flex: none; padding: 16px 14px 8px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.devs-dlg-titleRow { display: flex; align-items: flex-end; gap: 8px; min-height: 28px; }
.devs-dlg-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 16px; line-height: 24px; font-weight: 510; color: var(--dsw-alias-label-primary); }
.devs-dlg-nodeSeat { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; }
.devs-dlg-nodeLabel { flex: none; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.devs-dlg-node { flex: none; max-width: 220px; height: 24px; padding: 0 4px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; cursor: pointer; }
.devs-dlg-node:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
.devs-dlg-crumbBar { display: flex; align-items: center; gap: 4px; box-sizing: border-box; min-height: 24px; margin-left: -9px; padding: 0 8px; border: 1px solid transparent; border-radius: 8px; }
.devs-dlg-crumbBar-on { border-color: var(--dsw-alias-border-l2); }
.devs-dlg-trail { display: flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.devs-dlg-seat { display: inline-flex; align-items: center; gap: 4px; flex: none; min-width: 0; }
.devs-dlg-crumb { border: none; background: transparent; padding: 0; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.devs-dlg-crumb:hover { color: var(--dsw-alias-label-primary); }
.devs-dlg-crumbNow { color: var(--dsw-alias-label-primary); cursor: default; }
.devs-dlg-chev { flex: none; color: var(--dsw-alias-label-tertiary); }
.devs-dlg-edit { display: flex; align-items: center; justify-content: flex-end; flex: 1 0 34px; min-width: 34px; height: 22px; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: text; }
.devs-dlg-edit:hover { color: var(--dsw-alias-label-primary); }
.devs-dlg-edit:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
.devs-dlg-path { box-sizing: border-box; flex: 1 1 0; min-width: 0; height: 22px; padding: 0; border: none; outline: none; background: transparent; font-family: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.devs-dlg-content { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; position: relative; padding: 16px 16px 16px 24px; }
.devs-dlg-column { display: flex; flex-direction: column; gap: 2px; flex: 1 1 0; min-height: 0; min-width: 256px; overflow-y: auto; padding-right: 8px; }
.devs-dlg-row { width: 100%; display: flex; align-items: center; gap: 4px; height: 28px; flex: none; padding: 4px; box-sizing: border-box; border: none; border-radius: 6px; background: transparent; color: inherit; font-family: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.devs-dlg-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.devs-dlg-rowIcon { flex: none; color: var(--dsw-alias-label-secondary); }
.devs-dlg-rowName { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--dsw-alias-label-primary); }
.devs-dlg-rowChev { flex: none; color: var(--dsw-alias-label-tertiary); }
.devs-dlg-empty { display: flex; flex-direction: column; gap: 4px; padding: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.devs-dlg-empty-hint { color: var(--dsw-alias-label-tertiary); }
/* Where this level actually is: pinned above the footer, out of the scrolling
   list, so it reads as a fact about the pick, not as list content. */
.devs-dlg-info { display: flex; flex-direction: column; gap: 2px; flex: none; padding: 8px 24px 0; }
.devs-dlg-infoRow { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 12px; line-height: 18px; }
.devs-dlg-infoKey { flex: none; width: 56px; color: var(--dsw-alias-label-tertiary); }
.devs-dlg-infoVal { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-secondary); }
.devs-dlg-infoHint { flex: none; color: var(--dsw-alias-label-caption); }
.devs-dlg-alert { flex: none; padding: 8px 24px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.devs-dlg-error { padding: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.devs-dlg-float { position: absolute; right: 16px; bottom: 8px; padding: 2px 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.devs-dlg-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: none; padding: 16px 24px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.devs-dlg-toggle { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; padding: 0; font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.devs-dlg-toggle:hover { color: var(--dsw-alias-label-primary); }
.devs-dlg-toggle-on { color: var(--dsw-alias-label-primary); }
.devs-dlg-gap { flex: 1 1 0; }
.devs-dlg-action { min-width: 72px; }
.devs-dlg-create.devs-dlg-create { width: min(380px, 100%); padding: 0; gap: 0; }
.devs-dlg-createBody { display: flex; flex-direction: column; gap: 12px; padding: 22px 24px 20px; }
.devs-dlg-createTitle { margin: 0; font-size: 16px; line-height: 24px; font-weight: 510; color: var(--dsw-alias-label-primary); }
.devs-dlg-createIn { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.devs-dlg-createInput { box-sizing: border-box; width: 100%; height: 44px; padding: 7px 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 22px; outline: none; background: transparent; font-family: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.devs-dlg-createInput::placeholder { color: var(--dsw-alias-label-caption); }
.devs-dlg-createActions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
`

    /** The idle glyph: a primitive that is missing from this build renders as nothing. */
    const iconNode = (component, props) => (typeof component === 'function' ? h(component, props) : null)

    const failureText = failure => String((failure && failure.message) || failure)

    /**
     * The remote directory dialog: it browses one DevSpace node's directory tree
     * over this plugin's own routes (`/ls`, `/mkdir`, `/open`) and, on Open, asks
     * the node's `open_workspace` for a workspace id and starts a Session. No
     * local directory is created and no path is mapped: the node stays remote.
     */
    function RemoteDirectoryDialog(props) {
      const open = props.open === true
      const [nodes, setNodes] = React.useState([])
      const [node, setNode] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [showHidden, setShowHidden] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [createOpen, setCreateOpen] = React.useState(false)
      const [createName, setCreateName] = React.useState('')
      const [creating, setCreating] = React.useState(false)
      const [opening, setOpening] = React.useState(false)
      const [mirrorRoot, setMirrorRoot] = React.useState('')

      // A Chinese (or any) IME commits a candidate with Enter, and that Enter
      // reaches keydown as well — without this guard, naming a folder 中文
      // creates it before the candidate is committed. The composition event
      // flags are the reliable signal; keyCode 229 covers IMEs that send the
      // Enter before compositionend lands.
      const composingRef = React.useRef(false)
      const composing = event => composingRef.current
        || event.nativeEvent?.isComposing === true
        || event.keyCode === 229
      const compositionGuard = {
        onCompositionStart: () => { composingRef.current = true },
        onCompositionEnd: () => { composingRef.current = false },
      }

      const navigate = React.useCallback(async (target, rel) => {
        if (target === '') return
        setBusy(true)
        setError(null)
        try {
          setListing(await post('/ls', { node: target, path: rel ?? '' }))
          setEditing(false)
          setCreateOpen(false)
        } catch (failure) {
          setError(failureText(failure))
        } finally {
          setBusy(false)
        }
      }, [])

      // Every open starts clean: the first enabled node, its allowed root, and a
      // level read fresh from the remote machine.
      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        setListing(null)
        setError(null)
        setShowHidden(false)
        setEditing(false)
        setCreateOpen(false)
        setCreateName('')
        setOpening(false)
        setBusy(true)
        void (async () => {
          try {
            const state = await call('/state')
            if (cancelled) return
            const enabled = (state.nodes ?? []).filter(entry => entry.enabled !== false)
            setNodes(enabled)
            setMirrorRoot(typeof state.mirrorRoot === 'string' ? state.mirrorRoot : '')
            const first = enabled.length > 0 ? enabled[0].name : ''
            setNode(first)
            if (first === '') {
              setError('还没有启用中的 DevSpace 节点：先到「设置 → DevSpace 节点」添加一个。')
              return
            }
            const answer = await post('/ls', { node: first, path: '' })
            if (!cancelled) setListing(answer)
          } catch (failure) {
            if (!cancelled) setError(failureText(failure))
          } finally {
            if (!cancelled) setBusy(false)
          }
        })()
        return () => { cancelled = true }
      }, [open])

      const segments = listing === null || listing.path === '' ? [] : listing.path.split('/')
      const rootLabel = listing === null ? node : (listing.root ?? node)
      const crumbs = [{ label: rootLabel, path: '' }].concat(
        segments.map((name, index) => ({ label: name, path: segments.slice(0, index + 1).join('/') })),
      )
      // Windows sets the Hidden attribute only sometimes (a dot-led name often
      // carries none), so both signals count as hidden and one toggle reveals
      // them together.
      const hiddenEntry = entry => entry.hidden === true || entry.name.startsWith('.')
      const visible = listing === null ? [] : (listing.entries ?? []).filter(entry => showHidden || !hiddenEntry(entry))
      const hostPath = listing === null
        ? ''
        : (listing.path === ''
            ? rootLabel
            : `${String(rootLabel).replace(/[\\/]+$/, '')}\\${listing.path.split('/').join('\\')}`)
      // What Open will create on this machine: the mirror workspace directory.
      const localPath = mirrorRoot === '' || node === ''
        ? ''
        : `${mirrorRoot.replace(/\/+$/, '')}/${node}${listing === null || listing.path === '' ? '' : `/${listing.path}`}`
      const levelName = listing === null || listing.path === '' ? rootLabel : listing.path.split('/').pop()

      const pick = async () => {
        if (listing === null || node === '') return
        setOpening(true)
        setError(null)
        try {
          // The host adopts the remote directory as a local mirror workspace: it
          // creates the mirror directory, registers the real Workspace, and opens
          // the directory on the node. Opening that workspace is what starts the
          // Session — and what makes the workspace show up in the sidebar.
          const answer = await post('/open', { node, path: listing.path })
          if (devspaceUiWorkspace !== null && typeof answer?.localWorkspaceId === 'string') {
            await devspaceUiWorkspace.openWorkspace(answer.localWorkspaceId)
          } else if (devspaceUiWorkspace !== null) {
            devspaceUiWorkspace.startSession()
          }
          props.onClose()
        } catch (failure) {
          setError(failureText(failure))
        } finally {
          setOpening(false)
        }
      }

      const createFolder = async () => {
        const name = createName.trim()
        if (listing === null || name === '') return
        setCreating(true)
        setError(null)
        try {
          await post('/mkdir', { node, path: listing.path, name })
          setCreateOpen(false)
          setCreateName('')
          await navigate(node, listing.path === '' ? name : `${listing.path}/${name}`)
        } catch (failure) {
          setError(failureText(failure))
        } finally {
          setCreating(false)
        }
      }

      return h(Modal, {
        open,
        // Escape and the mask reach this dialog; while the nested create dialog
        // is up, only that one closes, and an in-flight call pins the card.
        onClose: () => {
          if (createOpen) { if (!creating) setCreateOpen(false); return }
          if (!busy && !opening) props.onClose()
        },
        title: '选择远端目录',
        className: 'devs-dlg',
        headless: true,
      },
        h('style', null, FLOW_CSS),
        h('div', { className: 'devs-dlg-header', 'data-devs-dialog': 'header' },
          h('div', { className: 'devs-dlg-titleRow' },
            h('h2', { className: 'devs-dlg-title' }, '选择远端目录'),
            // Always present: it names the node being browsed, and it is the
            // switch between nodes when more than one is mounted.
            h('span', { className: 'devs-dlg-nodeSeat' },
              h('span', { className: 'devs-dlg-nodeLabel' }, '节点'),
              h('select', {
                className: 'devs-dlg-node',
                value: node,
                disabled: nodes.length === 0 || busy,
                'aria-label': 'DevSpace 节点',
                'data-devs-node': node,
                onChange: event => {
                  const next = event.target.value
                  setNode(next)
                  setListing(null)
                  void navigate(next, '')
                },
              },
                nodes.length === 0
                  ? h('option', { value: '' }, '（没有启用的节点）')
                  : nodes.map(entry => h('option', { key: entry.name, value: entry.name },
                      `${entry.label.length > 0 ? entry.label : entry.name} · ${entry.name}`)),
              ),
            ),
          ),
          h('div', { className: `devs-dlg-crumbBar${editing ? ' devs-dlg-crumbBar-on' : ''}` },
            h('div', { className: 'devs-dlg-trail' },
              crumbs.map((crumb, index) => h('span', {
                key: crumb.path === '' ? 'root' : crumb.path,
                className: 'devs-dlg-seat',
              },
                index > 0 ? iconNode(IconChevronRightOutline14, { size: 12, className: 'devs-dlg-chev' }) : null,
                h('button', {
                  type: 'button',
                  className: `devs-dlg-crumb${index === crumbs.length - 1 ? ' devs-dlg-crumbNow' : ''}`,
                  title: crumb.label,
                  disabled: index === crumbs.length - 1,
                  onClick: () => { void navigate(node, crumb.path) },
                }, crumb.label),
              )),
            ),
            editing
              ? h('input', {
                  className: 'devs-dlg-path',
                  autoFocus: true,
                  value: draft,
                  'aria-label': '远端路径',
                  onChange: event => setDraft(event.target.value),
                  ...compositionGuard,
                  onKeyDown: event => {
                    if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); void navigate(node, draft) }
                    if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) }
                  },
                  onBlur: () => setEditing(false),
                })
              : h('button', {
                  type: 'button',
                  className: 'devs-dlg-edit',
                  'aria-label': '编辑路径',
                  disabled: listing === null,
                  onClick: () => { setDraft(listing === null ? '' : listing.path); setEditing(true) },
                }, iconNode(IconEditOutline16, { size: 14 })),
          ),
        ),
        h('div', { className: 'devs-dlg-content' },
          h('div', { className: 'devs-dlg-column', 'data-devs-column': 'level' },
            listing === null
              ? h('div', { className: 'devs-dlg-empty', role: 'status' }, busy ? '正在读取远端目录…' : '还没有读到目录。')
              : visible.length === 0
                ? h('div', { className: 'devs-dlg-empty' },
                    h('span', null, '这个目录下没有子目录。'),
                    h('span', { className: 'devs-dlg-empty-hint' }, '可以直接点「打开」选中当前目录。'),
                  )
                : visible.map(entry => h('button', {
                    key: entry.path,
                    type: 'button',
                    className: 'devs-dlg-row',
                    'data-devs-row': entry.name,
                    onClick: () => { void navigate(node, entry.path) },
                  },
                    iconNode(IconFolderClose16, { size: 16, className: 'devs-dlg-rowIcon' }),
                    h('span', { className: 'devs-dlg-rowName' }, entry.name),
                    iconNode(IconChevronRightOutline14, { size: 12, className: 'devs-dlg-rowChev' }),
                  )),
          ),
          busy && listing !== null
            ? h('div', { className: 'devs-dlg-float', role: 'status' }, '读取中…')
            : null,
        ),
        listing === null
          ? null
          : h('div', { className: 'devs-dlg-info' },
              h('div', { className: 'devs-dlg-infoRow' },
                h('span', { className: 'devs-dlg-infoKey' }, '远端'),
                h('span', { className: 'devs-dlg-infoVal', title: hostPath }, hostPath),
              ),
              localPath === ''
                ? null
                : h('div', { className: 'devs-dlg-infoRow' },
                    h('span', { className: 'devs-dlg-infoKey' }, '本地镜像'),
                    h('span', { className: 'devs-dlg-infoVal', title: localPath }, localPath),
                    h('span', { className: 'devs-dlg-infoHint' }, '打开时建为镜像工作区'),
                  ),
            ),
        error !== null && !createOpen
          ? h('div', { className: 'devs-dlg-alert', role: 'alert' }, error)
          : null,
        h('div', { className: 'devs-dlg-foot' },
          h(Button, {
            variant: 'outline',
            icon: iconNode(IconPlusOutline16, { size: 14 }),
            disabled: listing === null || busy,
            onClick: () => { setCreateName(''); setCreateOpen(true) },
          }, '新建文件夹'),
          h('button', {
            type: 'button',
            className: `devs-dlg-toggle${showHidden ? ' devs-dlg-toggle-on' : ''}`,
            'aria-pressed': showHidden,
            onClick: () => setShowHidden(value => !value),
          },
            '显示隐藏项',
            showHidden ? iconNode(IconCheckOutline16, { size: 14 }) : null,
          ),
          h('span', { className: 'devs-dlg-gap' }),
          h(Button, {
            variant: 'outline',
            className: 'devs-dlg-action',
            disabled: opening,
            onClick: () => props.onClose(),
          }, '取消'),
          h(Button, {
            variant: 'primary',
            className: 'devs-dlg-action',
            disabled: listing === null || busy || opening,
            onClick: () => { void pick() },
          }, opening ? '打开中…' : '打开'),
        ),
        h(Modal, {
          open: createOpen,
          onClose: () => { if (!creating) setCreateOpen(false) },
          title: '新建文件夹',
          className: 'devs-dlg-create',
          headless: true,
        },
          h('div', { className: 'devs-dlg-createBody' },
            h('h3', { className: 'devs-dlg-createTitle' }, '新建文件夹'),
            h('p', { className: 'devs-dlg-createIn' }, `在“${levelName}”下新建文件夹`),
            h('input', {
              className: 'devs-dlg-createInput',
              autoFocus: true,
              disabled: creating,
              value: createName,
              placeholder: '未命名文件夹',
              'aria-label': '文件夹名称',
              onChange: event => setCreateName(event.target.value),
              ...compositionGuard,
              onKeyDown: event => {
                if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); void createFolder() }
                if (event.key === 'Escape') { event.stopPropagation(); if (!creating) setCreateOpen(false) }
              },
            }),
            error !== null ? h('div', { className: 'devs-dlg-error', role: 'alert' }, error) : null,
            h('div', { className: 'devs-dlg-createActions' },
              h(Button, { variant: 'outline', disabled: creating, onClick: () => setCreateOpen(false) }, '取消'),
              h(Button, {
                variant: 'primary',
                disabled: creating || createName.trim() === '',
                onClick: () => { void createFolder() },
              }, creating ? '创建中…' : '创建'),
            ),
          ),
        ),
      )
    }

    /**
     * The "Add Remote" row contributed to the empty-state picker's popover,
     * directly below "Add workspace…". Same interaction as its sibling: close the
     * popover, then run the picking interaction — which here opens the remote
     * directory dialog.
     */
    const ACTION_CSS = `
.devs-action { display: flex; flex-direction: column; gap: 8px; }
/* Menu-row metrics: no chrome of its own, 36px tall, 12px side padding. */
.devs-action-row { display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 12px; box-sizing: border-box; border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; }
.devs-action-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.devs-action-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.devs-action-row:disabled { opacity: .5; cursor: default; }
.devs-action-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); }
`

    function RemoteActionRow(props) {
      return h('div', { className: 'devs-action', 'data-devs-action': 'remote' },
        h('style', null, ACTION_CSS),
        h('button', {
          type: 'button',
          className: 'devs-action-row',
          disabled: props.busy === true,
          onClick: () => {
            remoteDialog.show()
            props.onClose()
          },
        },
          h('span', { className: 'devs-action-icon' }, iconNode(IconProjectAddOutline16, { size: 16 })),
          h('span', null, 'Add Remote…'),
        ),
      )
    }

    /**
     * Frame-level seat for the dialog: the row lives inside the picker popover,
     * which unmounts as soon as a row is activated, so the dialog needs a mount
     * that outlives it. The card portals itself to document.body.
     */
    function RemoteDialogHost() {
      const [, bump] = React.useState(0)
      React.useEffect(() => remoteDialog.subscribe(() => bump(value => value + 1)), [])
      return h(RemoteDirectoryDialog, {
        open: remoteDialog.open,
        onClose: () => remoteDialog.hide(),
      })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        devspaceUiWorkspace = ctx.get('uiWorkspace') ?? null
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'devspace',
          order: 33,
          label: 'DevSpace 节点',
        }, Page))

        // "Add Remote", rendered by the picker inside its popover right below
        // "Add workspace…" (the declared `conversation.hero.workspace.action` seat).
        ctx.slots.inject('conversation.hero.workspace.action', () => ctx.slots.register({
          name: 'conversation.hero.workspace.action',
          id: 'devspace-remote',
          order: 10,
        }, RemoteActionRow))

        // The dialog the row opens: mounted in a frame-level layer, because the
        // popover (and therefore the row) is gone by the time the dialog is up.
        // The card itself portals to document.body, so this seat only keeps the
        // component alive.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'devspace-remote-dialog',
          order: 60,
        }, RemoteDialogHost))

        // Marks that say "this Workspace mirrors a remote directory" where the
        // Workspace itself is shown: the sidebar row wears the node logo (the
        // title stays the plain directory name), and the Hero's workspace chip
        // names the node beside it. Both seats come from upstream ui-workspace /
        // ui-conversation, so a harness without them simply shows neither.
        ctx.slots.inject('sidebar.workspaces.row.badge', () => ctx.slots.register({
          name: 'sidebar.workspaces.row.badge',
          id: 'devspace-remote-row',
          order: 10,
        }, RemoteRowBadge))

        ctx.slots.inject('conversation.hero.workspaceBadge', () => ctx.slots.register({
          name: 'conversation.hero.workspaceBadge',
          id: 'devspace-remote-chip',
          order: 10,
        }, RemoteChipBadge))

        // An open mirror Session has no workspace chip (that seat is the Hero's),
        // so its header carries the same mark next to the title.
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'devspace-remote-session',
          order: 0,
        }, RemoteSessionBadge))

        // Read-only self-check over the harness's own Cordis Inspect channel.
        // Reactive injection, not a one-shot `ctx.get`: a plugin's apply may run
        // before the inspect service exists.
        ctx.inject(['cordisInspect'], (inspectCtx) => {
          try {
            ctx.effect(() => inspectCtx.cordisInspect.register({
              manifest: {
                id: 'DevSpacePage',
                description: 'Live geometry and content facts of the DevSpace node page.',
                methods: [{
                  name: 'measure',
                  description: 'Return the current layout (when mounted) plus the history of layouts captured while the page was on screen.',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  outputSchema: { description: 'Geometry and content report for the DevSpace node page.' },
                }],
              },
              query: () => {
                const live = document.querySelector('.devs-page')
                return Promise.resolve({
                  mountedNow: live !== null,
                  // The remote picking dialog, when it is up: its real card
                  // geometry, its rows and its footer labels.
                  dialog: (() => {
                    const card = document.querySelector('.devs-dlg')
                    if (card === null) return { mounted: false }
                    const box = card.getBoundingClientRect()
                    return {
                      mounted: true,
                      title: (card.querySelector('.devs-dlg-title') || { textContent: '' }).textContent.trim(),
                      width: Math.round(box.width),
                      height: Math.round(box.height),
                      left: Math.round(box.left),
                      top: Math.round(box.top),
                      rows: card.querySelectorAll('.devs-dlg-row').length,
                      crumbs: Array.prototype.map.call(card.querySelectorAll('.devs-dlg-crumb'), node => node.textContent),
                      footer: Array.prototype.map.call(card.querySelectorAll('.devs-dlg-foot button'), node => node.textContent.trim()),
                    }
                  })(),
                  live: live === null ? null : measureElement(live),
                  capturedCount: captured.length,
                  history: captured,
                })
              },
            }), 'devspace: inspect provider')
          } catch (error) {
            console.warn('[devspace] inspect provider registration failed:', error)
          }
        })
      },
    }
  },
})
