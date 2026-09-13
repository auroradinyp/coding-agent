# coding-agent

极简 coding agent：Node.js + [OpenTUI](https://opentui.com) TUI，走 DeepSeek 的 OpenAI 兼容
Chat Completions API，内置 4 个工具（bash / read / write / edit）+ 一个极简 Agent Loop。

```
src/
  index.js        TUI 入口
  cli.js          无界面 REPL 入口（调试 loop 用，不需要 opentui）
  ui.js           opentui 界面：输出流 + 输入框 + 状态行 + /resume 选择器
  agent.js        Agent Loop + system prompt + 工具调用分发
  session.js      会话持久化（~/.coding-agent/historys）
  llm.js          SSE 流式 chat completions 客户端
  config.js       环境变量
  devtools.js     可选的 Chrome DevTools 网络调试（NETWORK_DEBUG=1）
  api-log.js      API 请求/响应控制台日志（pnpm inspect）
  tools/
    bash.js       command, timeout
    read.js       path, startLine, endLine
    write.js      path, content
    edit.js       path, oldText, newText
    index.js      工具注册表 + OpenAI tool schema

debug-ui/
  index.html      流式请求查看器（单文件，pnpm viewer）
scripts/
  run.mjs         启动器：补 --experimental-ffi / .env / 选 Node 版本
  serve-debug-ui.mjs  debug-ui 的零依赖静态服务器
bin/
  ca.mjs          全局命令 `ca`（pnpm link --global），转发给 scripts/run.mjs
```

## 环境要求

- **Node.js >= 26.4.0**（`@opentui/core` 的原生 FFI 需要；项目里已有 `.nvmrc`）
- 启动必须带 `--experimental-ffi`

```bash
nvm use            # 读取 .nvmrc
pnpm install
```

## 配置

`.env`（已被 gitignore）：

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

## 运行

```bash
pnpm start                     # TUI
pnpm chat                      # 无界面 REPL，方便看 loop 的每一步

pnpm inspect                   # TUI：开 Chrome DevTools + 请求/响应打到 console
pnpm inspect:chat              # REPL：同上，日志直接打终端
```

`pnpm start` / `pnpm chat` 实际上都走 `scripts/run.mjs`：它负责补上 `--experimental-ffi`、
加载 `.env`，并在当前 `node` 太旧（< 26.4）时自动改用在 nvm 里装的合适版本，
否则给出明确报错而不是 `bad option: --experimental-ffi`。

### 全局命令 `ca`

```bash
pnpm link --global            # 在仓库根目录执行一次
ca                            # 等价于 pnpm start（TUI）
ca --network --log-api        # 等价于 pnpm inspect
ca --help / ca --version
```

`bin/ca.mjs` 只是 `scripts/run.mjs` 的薄封装：默认 entry 是 `src/index.js`，
其余逻辑（Node 版本探测、`--experimental-ffi`、`--env-file`）完全复用。
因为是 `link`，改完源码直接生效，不用重新安装；配置仍读仓库里的 `.env`。

TUI 里输入请求回车即可，`ctrl+c` 退出（`/exit` 也可以）。

## 调试网络请求

`pnpm inspect` / `pnpm inspect:chat` 同时做两件事：

1. **自动打开 Chrome DevTools 的 Network 面板**（`NETWORK_DEBUG=1` → `src/devtools.js` +
   [node-network-devtools](https://github.com/GrinZero/node-network-devtools)）。地址形如
   `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:5271`，能看请求头（含
   `Authorization`）、SSE 原始分片，Initiator 里点一下跳回 `src/llm.js`。
2. **把请求/响应打到 console**（`LOG_API=1`）。`src/llm.js` 在**整段 SSE 流合并完**之后，
   把这一轮的请求和响应一次性打印出来（不是每个 delta 一行）：

```
╭─ API · deepseek-flash · 23:59:22 ───────────────────────────────────────────
│ POST https://api.deepseek.com/chat/completions
│ stream=true · tool_choice=auto · tools=0 · messages=1
│
│ { "model": "deepseek-flash", "messages": [ … ] }               ← 完整请求体
│
│ response 200 · 966ms · stop
│ { "role": "assistant", "content": "OK", "tool_calls": [ … ] }  ← 合并后的响应
╰─────────────────────────────────────────────────────────────────────────────
```

- `pnpm inspect:chat`（无界面 REPL）直接打在终端上，最清楚。
- `pnpm inspect`（TUI）用的是 opentui 自带的 **console 面板**（底部 30%），`src/ui.js`
  启动时自动展开；`↑↓` 翻日志、`esc` 让出键盘焦点（面板保留，可以边看边输入），
  `+/-` 调高度、`ctrl+s` 存盘。
- 响应里的 `tool_calls[].function.arguments` 会被解析成对象，不再是转义字符串。
- 单条 message 内容最长 2000 字：`LOG_API_LIMIT=0 pnpm inspect:chat` 可取消限制。
- 只想开其中一个：`NETWORK_DEBUG=1 pnpm start`（只开 Chrome）或 `LOG_API=1 pnpm chat`（只打日志）。
- 不想自动弹 Chrome、只想拿链接：再加 `NETWORK_DEBUG_MODE=true`。
- 都只在当前进程内生效：`bash` 工具起的子进程（比如 `curl`）抓不到；端口冲突用
  `NETWORK_SERVER_PORT=...` 覆盖。

## 流式请求查看器

`pnpm viewer` 起一个零依赖静态服务器（默认 http://localhost:5173，被占用就顺延），
打开 `debug-ui/index.html`。**左边粘贴原始内容，右边实时展示合并后的非流式结果。**

左边接受：

- `data: {...}` 的 SSE（DeepSeek / OpenAI 格式），`event:` / `id:` / 空行 / `[DONE]` 会忽略；
- 整段非流式响应 JSON，或一个 chunk 数组；
- chat/completions 的请求体（带 `messages`）——会识别出来并直接展示 messages。

右边会：

- 把 `tool_calls` 按 `index` 合并（`id` / `name` / `arguments` 都是增量分片），
  并把 `arguments` 解析成对象；
- 分开显示 `content` / `reasoning_content`，以及 `finish_reason` / `usage` / `model` 等元信息；
- 给出「原始分片时间线」和无法解析的行，方便对账。

单文件、无外部请求，直接 `open debug-ui/index.html` 也能用（只是 file:// 下剪贴板会退化）。

## 会话管理

每轮对话都会自动落盘，默认目录 `~/.coding-agent/historys`（可用 `CODING_AGENT_HISTORY_DIR`
覆盖，`createApp(renderer, { historyDir })` 也能指定），一个会话一个 JSON 文件：

```
{"version":1,"id":"2026-01-02T03-04-05-678Z","title":"帮我实现会话管理",
 "cwd":"/Users/me/code/proj","createdAt":"…","updatedAt":"…",
 "messages":[{"role":"user","content":"…"}, {"role":"assistant",…}, {"role":"tool",…}]}
```

- 文件名就是会话 id（ISO 时间戳换成文件名安全的形式），所以目录里按文件名排序 ≈ 按时间排序。
- 写入是原子的（先写 `.tmp` 再 rename），并且防抖 250ms；`/new`、`/resume`、退出（含 ctrl+c）
  时会同步 flush。
- **只存非 system 消息**：system prompt 里带着 `cwd`，是"派生"出来的，恢复时按当前目录重新生成；
  会话里的 `cwd` 字段会记下当初的目录，不一致时会提示。
- 空的会话（还没发过消息）不写盘。

命令：

| 命令 | 行为 |
| --- | --- |
| `/new` | 清屏，开一个全新会话；旧会话留在磁盘上 |
| `/resume` | 弹出选择器（`↑↓` 移动 · `enter` 恢复 · `esc` 取消），恢复后继续对话 |
| `/resume <id>` | 直接恢复，`id` 可以用前缀（唯一匹配时） |
| `/help` | 命令列表 |
| `/exit` | 退出并落盘 |

恢复会按顺序回放 transcript：用户消息、assistant 文本、工具调用（折叠的，带结果摘要）。
`pnpm chat`（无界面 REPL）里是同一套命令，`/resume` 不带参数时列出编号让你选。

## 工具语义

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `bash` | `command`, `timeout`(ms，默认 120000，上限 600000) | `bash -lc`，返回 stdout / stderr / exit code；超时杀整个进程组，输出超 30KB 截断 |
| `read` | `path`, `startLine?`, `endLine?` | 1-indexed，两端 inclusive；输出带行号前缀；单次最多 2000 行 |
| `write` | `path`, `content` | 全量覆盖，自动创建父目录；内容原样写入（不做换行归一化） |
| `edit` | `path`, `oldText`, `newText` | 用 `newText` 替换文件里**唯一一处** `oldText`；`newText` 为空串即删除该段。精确匹配（含缩进、空行），命中 0 处或多处都报错且不改动文件。文件是 CRLF 时，模型直接复制 `read` 输出的 LF 文本也能匹配，写回仍用原换行符 |

## Agent Loop

1. 把用户输入追加进当前 session 的 history，携带 4 个工具的 schema 请求 `/chat/completions`（`stream: true`）。
2. 累积流式 delta：`content` 直接显示，`reasoning_content` 只显示不回传（DeepSeek 不接受回传），
   `tool_calls` 按 `index` 拼接分片（`id` / `name` / `arguments` 都是增量的）。
3. 有 `tool_calls` 就逐个执行，把结果以 `{ role: "tool", tool_call_id, content }` 追加进 history，
   回到第 1 步；工具抛错不中断，而是把 `Error: ...` 作为结果回给模型。
4. 没有 `tool_calls` 即本轮结束；否则无限循环下去，直到模型给出最终回答。

每次 history 变化都会通过 `handlers.onSessionChange` 通知上层，由 `session.js` 落盘（见「会话管理」）。

## 已知限制（初版有意留的）

- `edit` 要求 `oldText` 唯一匹配，没有 `replaceAll`：同一片段要改多处得多次调用，每次带上更长的上下文。
- `edit` 不记录文件是否在 `read` 之后被改过，也没有 diff 预览；混合换行（CRLF 和 LF 混在一个文件里）会被统一成多数的那种。
- 没有 glob/grep，找文件只能靠 `bash`。
- 没有中断（busy 时不能取消）、没有历史长度控制（恢复出来的 history 会整段发给模型）。
- 会话只能新建和恢复，不能删/改名/搜索；`/resume` 会把目录里每个 JSON 都解析一遍。
- 输出只在 TUI 显示，没有日志落盘。
