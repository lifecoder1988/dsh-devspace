# dsh-devspace

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）插件。

把 DevSpace 远端节点接进 DSH：一个插件里统一管理 N 个节点（每个节点就是一个 MCP 端点），并且可以把远端目录「领养」成本地镜像工作区，会话就挂在那个工作区下。

## 安装

最省事的方式是用 DSH 自带的 `plugin_manager` 工具安装（会自动写 profile 并把插件行插进 composition）：

```sh
# 或者手工装进当前 profile
cd "$DSH_HOME/profiles/<profile>"
pnpm add github:lifecoder1988/dsh-devspace
```

本仓库自带的 `cordis.patch.yml` 就是它的 composition 行；手工接的话在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: devspace
      name: '@local/dsh-devspace'
```

装完重启 DSH（host 半边改动需要重启；只有 client 半边的话刷新页面即可）。

## 它做什么

DevSpace 这类远端执行器把「另一台机器上的目录」暴露成 MCP 工具（`read` / `apply_patch` / `exec_command` / `write_stdin` / `show_changes`）。本插件负责三件事：

1. **节点管理**：一个节点 = 一个 MCP 端点。存在 `$DSH_HOME/devspace-nodes.json`，启用即通过 `@deepseek-ai/dsh-mcp-client` 热挂载（**不需要重启**），工具以 `mcp__<节点名>__<工具>` 出现。想加几台机器就加几条。
2. **远端目录 → 本地镜像工作区**：在工作区选择器里点「Add Remote…」，浏览远端目录树，选定后：
   - 在远端对该目录调一次 `open_workspace`，拿到远端 `workspace_id`；
   - 在本地建 `<mirrorRoot>/<节点名>/<路径>`（默认 `~/DevSpace/...`）并写入一份 `AGENTS.md` 说明「项目本体在远端，这里只放下载数据 / 待上传产物 / 本地脚本」；
   - 把这个本地目录注册成**真实 Workspace**，于是侧栏 `Workspaces` 里出现它、会话归到它下面、`cwd` 就是镜像目录。
3. **传文件**：`devspace_pull`（远端 → 本地镜像）与 `devspace_push`（本地 → 远端），二进制安全、按块传输，双向都有完整性校验。

远端仍然是远端：远端代码/命令只走该节点的 `mcp__*` 工具，本地镜像目录不会被自动同步。

## 依赖：两个上游 client 补丁

「Add Remote…」这一行落在 DSH 的 `conversation.hero.workspace.action` 槽位上。这个槽位是通用的扩展点，为此仓库带了一份最小补丁：

```
patches/upstream-workspace-action-slot.patch
```

- `packages/client/ui-primitives/src/Menu.tsx`：`Menu` 增加可选的 `footerNode`（在 footer 行之后渲染）。
- `packages/client/ui-workspace/src/client/{contract/slots.ts,WorkspacePicker.tsx,index.ts}`：声明并渲染 `conversation.hero.workspace.action`（`list`，owner = `{ busy, onClose, getAnchorRect? }`）。

在 DSH 检出目录里：

```sh
git apply /path/to/dsh-devspace/patches/upstream-workspace-action-slot.patch
pnpm --filter @deepseek-ai/dsh-client-ui-workspace run bundle
pnpm run build:web
```

没打补丁时插件其余部分照常工作，只是工作区菜单里不会出现「Add Remote…」（可以从设置页的节点管理 + 模型工具用）。

## 模型工具

| 工具 | 说明 |
|---|---|
| `devspace_admin` | `status` / `add` / `update` / `remove` / `enable` / `disable` / `retry` 管节点；`mirrors` / `open` / `unmirror` / `mirrorRoot` 管镜像工作区 |
| `devspace_target` | 按**本会话 cwd** 报出远端目标（节点、远端路径、远端 `workspace_id`、本地镜像目录）；没有目标时返回 `null` |
| `devspace_pull` | 远端文件 → 本地（可指定落盘路径，默认落在镜像里的同名相对路径） |
| `devspace_push` | 本地文件 → 远端（可指定远端落点，默认按镜像内的相对路径放） |

另外插件会发布一个全局技能 `devspace-nodes`（从当前节点列表渲染），提醒模型「远端 ≠ 本地镜像」以及正确的调用顺序。

## HTTP 路由（前缀 `/devspace`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state?cwd=&sessionId=` | 节点 + 镜像工作区状态 |
| POST | `/save` `/delete` `/toggle` `/retry` | 节点增删改 / 启停 / 重连 |
| POST | `/ls` | 列远端目录（带 hidden 标记） |
| POST | `/mkdir` | 在远端建目录 |
| POST | `/open` | 领养远端目录：建镜像 + 注册工作区 + 远端 `open_workspace` |
| POST | `/mirror-root` `/unmirror` | 改镜像根 / 移除工作区登记（本地目录保留） |

## 界面注入点

| slot | id | order |
|---|---|---|
| `settings.section` | `devspace` | 33 |
| `conversation.hero.workspace.action` | `devspace-remote` | 10 |
| `shell.overlay` | `devspace-remote-dialog` | 60 |

## 传输实现说明（两个真实限额）

远端节点前面是 Express，请求体上限约 100 KB；远端命令行走的是 Windows `CreateProcess`，命令行上限 32 KB。base64 还会放大 4/3，所以：

- **下载** 48 KiB/块（`pullChunkBytes`）—— 走响应方向；
- **上传** 16 KiB/块（`pushChunkBytes`）—— 走命令行方向。

每次远端写入都会回报**写后文件长度**，与已发送字节数不符就整份重传（最多 3 次）——这正是修掉过一次「静默丢块」的地方。可用 `transferChunkBytes` 或分方向的键覆盖。

## 配置

```yaml
config:
  dshHome: /path/to/.dsh          # 默认 $DSH_HOME 或 ~/.dsh
  nodesFile: …/devspace-nodes.json      # 默认 $DSH_HOME/devspace-nodes.json
  mirrorsFile: …/devspace-mirrors.json  # 默认 $DSH_HOME/devspace-mirrors.json
  mirrorRoot: ~/DevSpace          # 新建镜像的落点（设置页里也能改）
  pullChunkBytes: 49152
  pushChunkBytes: 16384
```

节点的 `headers` 支持 `${VAR}` 引用（token 不落明文）。

## 自检

```sh
node test/local-check.mjs    # host 面：节点存储、挂载状态、路由
node test/mirror-check.mjs   # 镜像流程 + 双向传输（内置一个假的远端节点，20 项断言）
```

`mirror-check.mjs` 不联网、不碰真机：它在临时目录里模拟节点（识别 PowerShell 脚本形状），跑完 `open` → 目录列表 → `devspace_target` → 400 KB 上传 → 400 KB 下载 → 哈希比对 → `unmirror`，并断言每条远端命令行都短于 Windows 的 32 KB 上限。

## 文件结构

```
index.js              host 半边：节点存储与挂载、远端目录浏览、镜像工作区、四个工具、技能、路由
client.js             浏览器半边：设置页、工作区菜单里的「Add Remote…」、远端目录对话框
cordis.patch.yml      bundle patch
patches/              上游 client 槽位补丁
package.json          dsh.bundle.patch / dsh.client 声明
test/                 离线自检 + 镜像/传输回归
```

## 许可

MIT
