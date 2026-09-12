# coding-agent

极简 coding agent：Node.js + [OpenTUI](https://opentui.com) TUI，走 DeepSeek 的 OpenAI 兼容
Chat Completions API，内置 4 个工具（bash / read / write / edit）+ 一个极简 Agent Loop。

```
src/
  index.js        TUI 入口
  cli.js          无界面 REPL 入口（调试 loop 用，不需要 opentui）
  ui.js           opentui 界面：输出流 + 输入框 + 状态行
  agent.js        Agent Loop + system prompt + 工具调用分发
  llm.js          SSE 流式 chat completions 客户端
  config.js       环境变量
  tools/
    bash.js       command, timeout
    read.js       path, startLine, endLine
    write.js      path, content
    edit.js       path, startLine, endLine, content
    index.js      工具注册表 + OpenAI tool schema
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
node --experimental-ffi --env-file=.env src/index.js   # 等价于 pnpm start
```

TUI 里输入请求回车即可，`ctrl+c` 退出。

## 工具语义

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `bash` | `command`, `timeout`(ms，默认 120000，上限 600000) | `bash -lc`，返回 stdout / stderr / exit code；超时杀整个进程组，输出超 30KB 截断 |
| `read` | `path`, `startLine?`, `endLine?` | 1-indexed，两端 inclusive；输出带行号前缀；单次最多 2000 行 |
| `write` | `path`, `content` | 全量覆盖，自动创建父目录；内容原样写入（不做换行归一化） |
| `edit` | `path`, `startLine`, `endLine`, `content` | 用 `content` 替换 `[startLine, endLine]`（inclusive）；`content` 为空串即删除该区间；越界报错 |

## Agent Loop

1. 把用户输入追加进 history，携带 4 个工具的 schema 请求 `/chat/completions`（`stream: true`）。
2. 累积流式 delta：`content` 直接显示，`reasoning_content` 只显示不回传（DeepSeek 不接受回传），
   `tool_calls` 按 `index` 拼接分片（`id` / `name` / `arguments` 都是增量的）。
3. 有 `tool_calls` 就逐个执行，把结果以 `{ role: "tool", tool_call_id, content }` 追加进 history，
   回到第 1 步；工具抛错不中断，而是把 `Error: ...` 作为结果回给模型。
4. 没有 `tool_calls` 即本轮结束。最多 25 步，防止死循环。

## 已知限制（初版有意留的）

- `edit` 用行号定位，需要模型先 `read`；行号会因文件变动失效（后续可换成 oldText/newText 精确匹配）。
- 没有 glob/grep，找文件只能靠 `bash`。
- 没有中断（busy 时不能取消）、没有历史长度控制、没有持久化。
- 输出只在 TUI 显示，没有日志落盘。
