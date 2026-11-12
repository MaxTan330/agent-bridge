# Claude 原生能力与架构接入计划

> **历史实施计划：** 以下保留开发阶段的任务拆分与验收要求，不是当前待办清单。当前支持范围以 [原生能力文档](../../claude-capabilities.md) 为准；最终审查完成后按用户要求提交并推送 main，不修改用户配置。

**Goal:** 在现有 ACP 执行链路上尽量接入可协商的 Claude 原生能力，不增加独立 LLM。

**Architecture:** Bridge 保留串行任务生命周期与队列互斥；命令解析、运行时状态、交互请求独立成模块。Runtime 只处理 ACP、能力协商和进程生命周期，渠道只负责输入归一化与投递。按用户/账号/聊天/话题/工作区隔离状态和会话。

**Tech Stack:** Node 26、TypeScript、ACP v1、飞书 SDK、SQLite、node:test。

## 执行结果

已完成 Runtime 能力契约、独立命令/状态/问题模块、任务引导、历史归属与恢复、模式/模型/effort 偏好、MCP/轮数/预算配置、有界附件和默认关闭署名。图片、文本下载仅在鉴权和调度后发生。新增能力未引入第二套 LLM。

审查发现并修复了多问题标题覆盖正文、模式更新后配置快照被旧响应覆盖，以及非正常结束原因被误报完成的问题，均有回归测试。最终本地 187 项测试、typecheck、build、test:bundle 和 actionlint 通过。没有真实模型/飞书调用或 Docker 实际构建；另统一 package 运行版本并接入镜像 Cosign/OIDC 签名；远端发布仍需按发布流程完成。

下面的任务列表保留原实施要求。任务 3 的扩展核对已形成 [支持范围与限制](../../claude-capabilities.md)：fork、checkpoint、独立后台任务、结构化结果专用展示及 worktree 并发未接入，不将协议内部或未验证的能力声明为用户可用功能。

## 已同意的行为

- 普通消息继续 FIFO；管理查询、回答和 steering 独立处理，不能因队列满被阻塞。
- steering 仅作用于发送者当前执行的同会话任务。使用 idleBehavior=promptRequired；结果未知不自动重发或转队列。
- 表单提问用明确请求编号关联，允许文本 /answer 回复和 /skip，校验回答字段；取消、任务结束、断连必须释放等待。
- 工具、计划、用量、命令、配置来自真实事件；恢复历史文本不作为新输出发送。
- 默认免审批执行不变；计划模式显式请求，不把未知模式偷偷切回执行模式。
- 会话闲置 4 小时回收，查询不刷新时间。历史选择只允许 Bridge 记录归属于当前用户的 ID，不能直接展示共享 Claude 目录全量历史。
- 不将尚未协商或专用客户端私有扩展包装成可用能力；不做虚假进度、自动重试副作用、自动发布或历史删除。

## Task 1 — Runtime 与能力契约

文件：src/types.ts、src/runtime.ts、新增 runtime 能力测试及独立 stdio fixture。

- [ ] 先写真实 stdio 测试：事件提取、能力协商、steering injected/promptRequired/unsupported、表单取消、配置与 mode 校验。
- [ ] Runtime.open 增加可选 hooks（onEvent/onQuestion/mode/model/effort）；保持现有四参数调用兼容。
- [ ] 增加可选 steer(session,text)；显式能力检查、会话 ID 检查、有界请求，不进行隐式 prompt 回退。
- [ ] 读取项目原生设置来源，不改变原项目 skills/hooks/agents 文件；保留环境变量白名单。
- [ ] 运行 typecheck、runtime 测试，审查协议字段及旧版本不支持时的行为。

## Task 2 — 状态、命令与提问模块

文件：新增 src/agent-state.ts、src/interactions.ts、src/commands.ts，对接 src/bridge.ts，新增对应测试。

- [ ] 先写回归：满队列可查询、跨用户不可查看、工具状态合并、陈旧事件隔离、回答一次性消费、取消释放、错误回答可重试。
- [ ] agent-state 投影命令列表、工具状态、计划、usage、配置选项；限制缓存体积，保存有边界的最近快照。
- [ ] interactions 管理请求 ID、表单校验、AbortSignal 和回答生命周期。
- [ ] commands 解析已保留的管理命令和带参数命令；未知命令仍交 Claude。
- [ ] Bridge 对接 /help /commands /tools /plan /usage /capabilities /steer /answer /skip；不改变原 FIFO 和取消权限。
- [ ] 所有新状态均绑定实际任务，控制命令不延长会话 TTL。

## Task 3 — 持久偏好、历史与扩展配置

文件：src/store.ts、src/config.ts、src/main.ts、Compose/.env、会话及配置测试。

- [ ] 记录 Bridge 自己创建的会话历史归属，/sessions 与 /resume 仅访问该范围；查询不触发 Claude 进程。
- [ ] 每会话 model/effort/下一任务模式偏好持久化；空闲时修改，执行时由 runtime 对实际选项校验。
- [ ] 项目原生 Skills/CLAUDE.md/Hooks/Subagents 使用现有设置加载；MCP 通过部署配置文件接入，绝不把凭据显示到聊天或日志。
- [ ] 对图片、文件、fork、checkpoint、后台任务、JSON 输出及预算逐项核对实际接口，有可靠通路才启用；未实现项写入能力矩阵，不宣称支持。

## Task 4 — 验证与文档

- [ ] pnpm typecheck、pnpm test、pnpm build、pnpm test:bundle。
- [ ] workflow actionlint、Compose 运行配置一致性、git diff --check。
- [ ] 审查命令权限、请求超时、任务结束竞态、历史泄露、初始化与回收。
- [ ] README/设计/CHANGELOG 更新实际支持项、命令示例、失败语义和仍需真实模型/飞书验收的内容。

## 验收用例

```text
长任务运行 → /tools 即时显示真实工具 → /steer 补充要求 → 仅原任务接收
Claude 提问 → /answer <id> <JSON> → 原请求继续；其他用户回答被拒绝
/cancel → 所有未回答请求取消 → 排队下一项执行
4 小时无任务 → 默认新会话；/sessions → /resume 本人历史 → 下次明确恢复
不支持 steering → 明确提示未发送；请求超时 → 明确结果未知，绝不重复执行
```
