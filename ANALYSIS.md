# coding-agent 项目分析

> 分析对象：仓库 `coding-agent`（HEAD = `e007d03 feat(session): 会话持久化与 /new /resume 命令`，工作区有未提交改动）
> 分析日期：基于当前工作区快照

---

## 1. 项目定位

一个**极简的终端 coding agent**：Node.js + [OpenTUI](https://opentui.com) 提供 TUI，
走 DeepSeek 的 OpenAI 兼容 Chat Completions API，内置 4 个工具（`bash` / `read` / `write` / `edit`）
和一个约 60 行的 Agent Loop。目标是"能跑通闭环的最小实现"，而不是一个生产级产品——
这一点在 README 的「已知限制」里也是明确承认的。

| 维度 | 情况 |
| --- | --- |
| 语言 / 模块制 | 原生 ESM JavaScript（无 TypeScript、无构建步骤、无转译） |
| 运行时 | Node.js >= 26.4.0（`.nvmrc` = 26.8.2），必须带 `--experimental-ffi`（OpenTUI 原生 FFI） |
| 包管理 | pnpm 10.33.0 |
| 运行依赖 | **仅 1 个**：`@opentui/core ^0.5.11` |
| 开发依赖 | `node-network-devtools ^1.0.30`（可选，动态 import） |
| 代码量 | `src/` ≈ 1654 行（其中 `ui.js` 583 行，占 35%）；`debug-ui/` 726 行单文件 HTML；`scripts/` 164 行 |
| 测试 / Lint / CI | **无** |

依赖极轻是这个项目最大的优点：除了 OpenTUI，其余全是 Node 内置模块（`node:fs`、`child_process`、
`readline`、`fetch`、`TextDecoder`），没有 SDK 包装层。

## 2. 目录与模块职责

```
src/
  index.js     TUI 入口：校验配置 → 注册网络调试 → startTui()          (16 行)
  cli.js       无界面 REPL 入口：同一套 agent + /new /resume /help /exit (145 行)
  ui.js        OpenTUI 界面：transcript 流式块、多行输入框、状态行、resume 选择器 (583 行)
  agent.js     Agent Loop + system prompt + tool_calls 分发              (112 行)
  llm.js       SSE 流式 chat/completions 客户端（fetch + 手写 SSE 解析） (103 行)
  session.js   会话持久化：一会话一 JSON，原子写 + 250ms 防抖             (208 行)
  config.js    环境变量读取 + assertConfig()                              (15 行)
  devtools.js  可选 Chrome DevTools 网络调试（NETWORK_DEBUG=1）           (31 行)
  api-log.js   API 请求/响应控制台格式化（**当前无人调用**，见 §5-A）     (134 行)
  tools/
    index.js   注册表 + OpenAI tool schema 生成                           (18 行)
    bash.js    spawn /bin/bash -lc，进程组超时 kill，30KB 截断             (88 行)
    read.js    1-indexed 带行号输出，单次上限 2000 行                       (50 行)
    write.js   全量覆盖，自动 mkdir -p                                     (31 行)
    edit.js    oldText/newText 唯一匹配替换（CRLF 感知）                    (85 行)
    util.js    路径解析、二进制探测、按行切分、相对路径显示                 (35 行)
scripts/
  run.mjs             启动器：版本检查 + 重选 nvm Node + --experimental-ffi + --env-file (100 行)
  serve-debug-ui.mjs  debug-ui 的零依赖静态服务器（pnpm viewer）          (64 行)
debug-ui/
  index.html          流式请求查看器：粘 SSE → 右侧合并成非流式结果（单文件无外部请求）(726 行)
```

## 3. 架构与一次请求的完整数据流

```
用户输入 (ui.js TextareaRenderable.onSubmit / cli.js readline)
   │
   ▼
agent.send(text)                      agent.js:31
   ├─ messages.push({role:"user"}) → notify() → onSessionChange → store.schedule (防抖落盘)
   │
   └─ for (;;)                         agent.js:35   ← 唯一的循环，无最大轮次
        ├─ streamChatCompletion({messages, tools})
        │     llm.js:16  POST /chat/completions  {stream:true, tool_choice:"auto"}
        │     llm.js:89  sseData()：按 \n 切行，只取 `data:` 前缀载荷
        │     累积 content / reasoning_content；tool_calls 按 index 拼 id+name+arguments 分片
        │     └─ 回调 onTextDelta / onReasoningDelta → ui.js 渲染
        │
        ├─ messages.push(toHistoryMessage(msg))   ← 剥掉 reasoning_content（DeepSeek 拒收回传）
        │
        ├─ 有 tool_calls？───否──▶ onTurnEnd → 返回，本轮结束
        │        │是
        │        └─ 逐个执行：onToolStart → tool.run(args) → onToolEnd
        │             messages.push({role:"tool", tool_call_id, content: result})
        │             （工具错误不抛出，转成 "Error: ..." 字符串喂回模型）agent.js:94-111
        │
        └─ 继续下一轮
```

三条并行的侧信道都通过 `handlers` 回调出来，没有事件总线、没有 Promise 队列：

1. **渲染**：`onTextDelta` / `onReasoningDelta` / `onToolStart` / `onToolEnd` / `onTurnEnd`
2. **持久化**：`onSessionChange(session)` → `store.schedule()`（250ms 防抖，`/new` `/resume` 退出时同步 `flush`）
3. **调试**：`devtools.js` 在进程启动最早期 patch `fetch`（`index.js:8`，注释明确说明"必须在首个请求之前"）

会话存储格式（`session.js:57-80`）：

```json
{ "version": 1, "id": "2026-01-02T03-04-05-678Z", "title": "首条用户消息首行",
  "cwd": "…", "createdAt": "…", "updatedAt": "…",
  "messages": [ /* 仅非 system 消息，tool_calls/tool 结果原样保留 */ ] }
```

写盘用 `tmp + rename` 原子替换；`system` 消息（内嵌 cwd）**不入盘**，加载时由 `agent.js:80`
按当前目录重新生成——这样同一份历史换目录恢复也不会带着过期 cwd。

## 4. 值得肯定的设计决策

| 决策 | 位置 | 为什么好 |
| --- | --- | --- |
| 头部无渲染依赖的 REPL | `cli.js` | 调试 Agent Loop 时不用被 TUI 干扰，两入口共用 `agent.js`，行为一致 |
| `handlers` 回调隔离副作用 | `agent.js:26` | Agent 核心零 I/O 依赖（除 fetch），换 UI/换存储都不用改 Loop |
| system prompt 派生而非持久化 | `agent.js:79-85` | 恢复会话时 cwd 不会陈旧；`session.cwd` 仅用于提示 |
| `reasoning_content` 只显示不回传 | `agent.js:88` | 直接踩过 DeepSeek 的接口约束，注释里写明了原因 |
| `bash` 用 `detached:true` + `kill(-pid)` | `bash.js:39-56` | 超时能杀掉整个进程组，不留孤儿进程 |
| `edit` 的 CRLF 归一化匹配 | `edit.js:38-43` | 模型从 `read` 复制的 LF 文本能命中 CRLF 文件，写回仍用原换行符 |
| `edit` 用 oldText 唯一匹配而非行号 | `edit.js`（见 `da42f67`） | 精确、可校验（0 处/多处都报错且不改文件），比行号区间抗漂移 |
| 工具错误转成文本回喂模型 | `agent.js:107-111` | 一轮工具失败不炸整个会话，模型可以自我纠正 |
| 启动器做 Node 版本兜底 | `scripts/run.mjs` | 把 "bad option: --experimental-ffi" 这种难懂报错换成明确提示，并自动找 nvm 里的合适版本 |
| 原子写 + 防抖 + exit flush | `session.js:143-207` | 一个 turn 会多次改 history，防抖避免频繁写；`flush` 是同步的，可安全放在 `process.on("exit")` |
| 调试设施与主流程解耦 | `devtools.js` / `debug-ui/` | 动态 import + 环境变量开关，生产安装缺依赖也不会崩 |

## 5. 问题清单

### A. 确定的缺陷（建议修）

1. **`src/api-log.js` 是死代码，`LOG_API` 开关完全无效。**
   全仓库搜索 `logApiExchange` / `api-log`，只有 `api-log.js` 自身和 `run.mjs` 的注释提到它；
   `llm.js` 里没有任何 import 或 console 输出。也就是说 `pnpm inspect` / `pnpm inspect:chat`
   （`run.mjs:86` 设置 `LOG_API=1`）**不会打印任何请求/响应**。
   连带 README 的两处描述已经与代码不符：
   - 「把请求/响应打到 console（`LOG_API=1`）… `src/llm.js` 在整段 SSE 流合并完之后打印」——`llm.js` 无此逻辑；
   - 「`pnpm inspect`（TUI）用的是 opentui 自带的 console 面板，`src/ui.js` 启动时自动展开」——
     `ui.js` 中没有任何 `LOG_API` / console 面板相关代码，也未 import `api-log.js`。

2. **busy 状态下会吞掉用户输入。** `ui.js:114-117`：

   ```js
   const value = input.plainText.trim();
   input.setText("");                       // ← 先清空
   if (!value || busy || picker) return;    // ← 再判断 busy，直接 return
   ```

   模型正在跑的时候按回车，输入框会被清空且请求被丢弃。应先判断 `busy` 再清空
   （或把输入缓存起来待本轮结束再发）。

3. **没有中断 / 取消能力。** `llm.js:13` 支持 `signal`，但 `agent.js` 从不传；
   TUI 里 `ctrl+c` 直接退出整个进程（`ui.js:33` `exitOnCtrlC:true`）；`busy` 只用来拦截回车。
   长命令（`bash` 默认 120s、上限 600s）期间用户没有任何"停下"的手段。

4. **Agent Loop 无轮次上限。** `agent.js:35` 的 `for (;;)` 完全依赖模型自己收敛。
   一个反复调用同一工具的模型会让进程无限循环（只能 ctrl+c 杀进程）。

### B. 风险 / 设计缺口（值得记录）

5. **工具没有任何沙箱与确认机制。** `util.js:5-10` 的 `resolveToolPath` 只做 `path.resolve`，
   没有限制在 cwd 内；`bash.js` 直接 `bash -lc` 以当前用户权限执行。
   这是"本地 agent"的常规取舍，但至少应在 README 里显著提示（当前只在「已知限制」里提了 edit/会话层面的限制）。
   另外 `.env` 里有真实 `DEEPSEEK_API_KEY`（已被 `.gitignore` 忽略，`git ls-files` 确认未入库），这点是安全的。

6. **`cli.js` 被无谓地绑上 OpenTUI 的运行要求。** `run.mjs:79` 无条件加 `--experimental-ffi`，
   且 `satisfies()` 检查的是 Node >= 26.4；但 `cli.js` 并不 import `@opentui/core`。
   纯文本 REPL 本可以在更低版本 Node 上跑，目前却会被版本检查拦下。

7. **`edit` 的写入不是原子的、也没有并发/陈旧检测。** `edit.js:62` 直接 `writeFile`；
   如果文件在 `read` 之后被外部改过，模型基于旧文本的替换会静默成功。没有 diff 预览、没有备份。

8. **上下文无界。** 恢复会话后整段 history 原样发给模型（README 已承认）；`llm.js` 也不记录 `usage`。
   没有 token 预算、没有历史裁剪/摘要。

9. **LLM 层很薄（刻意的，但缺容错）**：无 429/5xx 重试与退避、无超时（只支持传 `signal`）、
   不读 `finish_reason`、`sseData()` 不处理"最后一行没有换行"的残留 buffer（`llm.js:89-102`）、
   不支持多行 `data:` 事件。流中途失败会丢掉已累积的内容（无部分恢复）。

10. **`bash` 输出不是流式的**：全部缓冲在内存里，命令结束（或 30KB 截断）之后才一次性展示，
    长命令期间用户只能干等（配合第 3 点体验更差）。

11. **会话管理能力单一**：不能删除/重命名/搜索；`listSessions` 每次全量解析目录下所有 JSON
    （`session.js:97-127`），`/resume` 打开必扫一遍；`/resume` 加载空会话也会成功。

### C. 小瑕疵（低成本清理）

12. `session.js:143` JSDoc 与 `export function` 挤在同一行，可读性差。
13. `createSessionStore().save()`（`session.js:182`）与 `apiLogEnabled()`（`api-log.js:22`）目前无人调用——
    一个随死代码一起清理，一个可作为 `/new` 立即落盘的显式 API 保留但应加注释说明。
14. `index.js:15` 在 `createCliRenderer()` 之前 `console.log`，TUI 下这行输出会被之后的全屏渲染覆盖/干扰，
    要么去掉，要么挪进 UI 的欢迎语。
15. 无任何测试（`createApp` 已经拆出来并注释"split out so tests can drive it headlessly"，但测试没写）、
    无 eslint/prettier 配置、无 CI。`ui.js` 583 行单函数 `createApp` 承担了 UI、命令路由、会话编排三重职责。

## 6. 改进建议（按性价比排序）

**短期（半天内）**

1. 二选一解决 §5-A1：把 `logApiExchange` 接回 `llm.js`（在 SSE 合并完后调用，包一层 try/catch
   不影响主流程），或者在 README 中删掉这部分描述并把 `api-log.js` 从仓库移除。
   顺带修正 README 关于 opentui console 面板的那段。
2. 修 §5-A2 的输入吞噬：`if (busy || picker) return;` 提到 `input.setText("")` 之前。
3. 给 `agent.js` 的循环加 `MAX_STEPS`（比如 30），超限时把一段说明塞回 history 让模型收尾，
   避免无限循环。
4. 给 `send()` 接上 `AbortController`：TUI 里 `esc` 或输入框旁的快捷键触发
   `controller.abort()`，`llm.js` 已有 `signal` 通道，改动很小。

**中期**

5. 上下文治理：记录 `usage.total_tokens`，超过阈值时从最早的轮次开始丢弃
   （保留 system + 最近 N 轮，注意成对保留 assistant/tool_calls 与 tool 结果，否则 API 会报错）。
6. `edit` 增加"文件在 read 之后被改过"的检测（记录 mtime/hash），并顺手把写盘改成 tmp+rename。
7. 会话侧加 `/delete`、`/rename`，以及 `listSessions` 的轻量元数据缓存（或读文件头部即可）。
8. 补一层最小测试：`edit`（唯一匹配、0 处、CRLF）、`session`（防抖/原子写/标题派生）、
   `llm.sseData`（分片边界、`[DONE]`）——这三个模块都是纯逻辑，最容易测。

**长期（若想继续长大）**

9. 拆 `ui.js`：把「渲染块管理」「命令路由」「会话编排」分开，现在三者互相引用（`store` 被 handlers 和命令共用）。
10. 加权限确认层（`bash` / 越出 cwd 的写操作先问一次），这是 coding agent 走向可日常使用的必经一步。
11. 类型化：至少用 JSDoc `@typedef` 描述 message / toolCall 形状，或直接迁 TS（代码量小，迁移成本低）。

## 7. 结论

这是一份**质量明显高于"初版玩具"的极简实现**：模块边界干净（llm / agent / tools / session / ui 各司其职）、
依赖只有 1 个运行时包、注释普遍解释了"为什么这么做"（例如 detached kill、flexBasis 0、
reasoning_content 不回传、CRLF 归一化），会话持久化的原子写 + 防抖 + 派生 system prompt 处理得很到位。

主要短板集中在**运行时控制**（无中断、无轮次上限、无上下文治理）和**安全/测试基建**（无沙箱确认、无测试、无 CI），
再加上一处**文档与代码脱节**：`api-log.js` 写完了却从未接线，导致 `pnpm inspect` 的核心功能实际不可用。
把 §6 的 1–4 条做掉（预计不超过半天），这个项目的"可用性"会有明显跃升。
