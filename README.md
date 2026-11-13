# agent-bridge

AgentBridge 是基于 Node.js 26 和 Claude ACP 的飞书开发助手。你可以在飞书里让 Claude 分析代码、修改文件或运行项目命令。默认短任务直接回复，长任务先通知后台执行、完成后再返回结果；也可开启 Markdown 卡片流式回复。服务支持扫码绑定机器人、恢复会话、查询和取消长任务，以及从源码构建或拉取版本化 Docker 镜像。

每个实例服务于一个固定项目，仅允许白名单用户发起任务，同一时间执行一个任务。

## 文档

| 我想… | 看 |
|---|---|
| 绑定飞书、查命令、了解回复方式、排队和排障 | [使用与运维指南](docs/usage.md) |
| 部署镜像或源码、挂载宿主机目录、Portainer、备份卷、上线验收 | [部署指南](docs/deployment.md) |
| 看架构图、消息流程、任务状态机，以及模块、持久化、权限和配置契约 | [实现设计](docs/design.md) |
| 接入 MCP、项目 `CLAUDE.md`/Skills/Hooks、关闭提交署名 | [Claude 原生能力](docs/claude-capabilities.md) |
| 发布版本、Changelog、镜像签名与回滚 | [版本发布](docs/releases.md) |
| 了解为什么不引入独立 LLM 调度层 | [调度决策记录](docs/decisions/conversation-orchestration.md) |
| 查看变更 | [CHANGELOG](CHANGELOG.md) |

## 快速开始

### 本地运行

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

复制 `.env.example` 为 `.env`，取消 `WORKSPACE_ROOT` 的注释并填写本机已存在的业务项目绝对路径，再填写所需的模型、认证配置，然后运行 `pnpm start`。`WORKSPACE_PROJECT=.` 表示直接使用该项目目录。未手动配置飞书应用时，首次正常启动会在终端显示飞书二维码及备用链接，使用飞书扫码确认创建应用，扫码用户自动成为允许使用者。`pnpm dev` 使用 Node.js 26 原生 TypeScript 支持。请勿提交 `.env` 或飞书绑定文件。

网关地址、主模型、各档位模型映射和子 Agent 模型按网关支持情况填写，变量与默认值见[配置契约](docs/design.md#配置契约)。别名没有 Bridge 内置映射，自定义网关使用哪些别名，就应将它们映射到网关实际支持的模型 ID。管理员列表、数据库路径、超时、时区和镜像源可按需覆盖。

`pnpm build` 先用 TypeScript 编译到 `.build`，再由 ncc 通过 CommonJS 入口打包到 `dist/index.cjs`，兼容飞书 SDK 的 `__dirname` 使用。Bridge 应用代码和可打包依赖合并为单入口；ncc 生成的资源文件也应随整个 `dist` 目录交付。Claude ACP 作为外部子进程依赖保留，不能仅复制一个 JS 文件就运行 Agent。

`pnpm test:bundle` 验证真实打包入口、模块加载、配置和外部 Adapter 路径解析，不连接飞书或调用模型。填写 `.env` 后可用 `pnpm start --check` 做启动前检查；尚未绑定时会提示首次启动需要扫码，检查本身不会创建应用、打印二维码或写入绑定文件。`node src/main.ts --version` 或 `node dist/index.cjs --version` 可查询 package 版本，不需要配置凭据或启动服务。

直接依赖和开发依赖使用 `^`，具体安装版本由 `pnpm-lock.yaml` 固定。升级时核对 npm 官方最新稳定版本并重新验证。TypeScript 7 与 Claude SDK 均包含平台二进制，应使用完整安装，不能全局跳过 optionalDependencies；protobufjs 的可选 postinstall 明确忽略。

### Docker

镜像部署：复制 `.env.example` 为 `.env`，设置 `AGENTBRIDGE_IMAGE` 为已发布版本，然后执行 `docker compose -f compose.image.yaml pull` 和 `docker compose -f compose.image.yaml up -d`。源码构建：在仓库根目录执行 `docker compose up -d --build`。两者都用 `docker compose ... logs -f` 查看首次扫码二维码。完整步骤、宿主机目录挂载、Portainer、卷迁移和上线验收见[部署指南](docs/deployment.md)。

## 运行边界

重启后旧运行任务标记 interrupted，不重放任务；会话仅在 Agent 声明支持并成功 load 时恢复。用户上下文隔离不等于文件隔离：所有白名单用户都必须有权访问固定项目。

Claude ACP 默认使用 bypassPermissions 免审批执行模式，可通过 `/mode plan` 显式选择计划模式。Bridge 不提供客户端文件/终端 ACP 能力，读写和命令由 Agent 自身工具执行；cwd 不是沙箱，单容器中的 Bridge 与 Agent 不是强隔离安全边界，白名单用户可在容器用户权限内直接读写文件和执行命令。

当前仅支持一个飞书应用、一个固定项目、一个服务实例；工作区内的任务串行执行。尚不包括 Git worktree、多项目 ACL、多任务并发、其他消息渠道与 Web 管理 API。真实飞书扫码、模型工具执行、Linux 进程组清理和 Docker 镜像运行仍需在目标环境验收，详见[部署指南](docs/deployment.md#上线验收)。

## 许可证

[MIT](LICENSE)
