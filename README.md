# agent-bridge

AgentBridge 是基于 Node.js 26 和 Claude ACP 的飞书开发助手。你可以在飞书里让 Claude 分析代码、修改文件或运行项目命令，并通过 Markdown 卡片查看流式回复。服务支持扫码绑定机器人、恢复会话、查询和取消长任务，以及从源码构建 Docker 镜像。

每个实例服务于一个固定项目，仅允许白名单用户发起任务，同一时间执行一个任务。

- [实现设计：架构、行为契约与验收边界](docs/design.md)

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:bundle
```

复制 `.env.example` 为 `.env`，填写业务项目路径和所需的模型、认证配置，准备获授权的项目目录，然后运行 `pnpm start`。首次正常启动会在终端显示飞书二维码及备用链接，使用飞书扫码确认创建应用，扫码用户自动成为允许使用者。`pnpm dev` 使用 Node.js 26 原生 TypeScript 支持。请勿提交 `.env` 或飞书绑定文件。

示例直接列出网关、主模型、各档位模型映射、子 Agent 模型和项目路径，按网关支持情况填写。管理员列表、数据库路径、超时、时区和镜像源可按需覆盖，参见[配置契约](docs/design.md#配置契约)。模型别名没有 Bridge 内置映射；自定义网关使用哪些别名，就应将它们映射到网关实际支持的模型 ID，不能假定填写主模型会同时覆盖其他模型用途。

| 模型变量 | 用途 |
|---|---|
| `ANTHROPIC_MODEL` | 主会话模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `sonnet` 别名对应的模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `opus` 别名对应的模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `haiku` 别名及相关后台用途的模型 |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | 使用 `fable` 时的模型映射，按网关支持情况配置 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 未单独指定模型的子 Agent 默认模型；单次调用或 Agent 定义可覆盖 |

以上变量可一起配置，并不要求使用不同模型 ID；只有一个可用模型的网关可将所需别名映射到同一个 ID。配置自定义网关时填写 `ANTHROPIC_BASE_URL`。留空时由 Claude 的配置和默认行为决定模型路由。变量用途依据 [Claude Code 模型配置](https://code.claude.com/docs/en/model-config)。修改运行时模型变量后，执行 `docker compose up -d --force-recreate` 重新注入配置。

直接依赖和开发依赖使用 `^`，具体安装版本由 pnpm-lock.yaml 固定。升级时核对 npm 官方最新稳定版本并重新验证。TypeScript 7 与 Claude SDK 均包含平台二进制，应使用完整安装，不能全局跳过 optionalDependencies。protobufjs 的可选 postinstall 明确忽略。

`pnpm build` 先用 TypeScript 编译到 `.build`，再由 ncc 通过 CommonJS 入口打包到 `dist/index.cjs`，兼容飞书 SDK 的 `__dirname` 使用。Bridge 应用代码和可打包依赖合并为单入口；ncc 生成的资源文件也应随整个 `dist` 目录交付。Claude ACP 作为外部子进程依赖保留，不能仅复制一个 JS 文件就运行 Agent。

`pnpm test:bundle` 验证真实打包入口、模块加载、配置和外部 Adapter 路径解析，不连接飞书或调用模型。也可在填写 `.env` 后使用 `pnpm start --check` 做启动前检查；尚未绑定时会提示首次启动需要扫码，检查本身不会创建应用、打印二维码或写入绑定文件。

## 飞书配置

`FEISHU_APP_NAME` 可配置首次扫码创建的应用名称，默认 `AgentBridge`，留空也使用默认值。Compose 已映射，可在 `.env` 或 Portainer 中设置。该值仅作为创建时的预设名称，最终名称以飞书确认页为准；已有绑定不会被自动改名或重新创建，需要改名时在飞书后台操作。

默认使用扫码创建：首次启动调用飞书官方设备授权流程，二维码仅允许创建新应用，避免覆盖已有机器人的配置。确认页申请机器人发消息、接收私聊和群聊 @消息、发送/删除表情回复及 CardKit 卡片写入权限，订阅 `im.message.receive_v1`；不申请用户身份权限。确认后保存应用凭据及平台返回的扫码者 open_id，再查询机器人 open_id。若平台未返回扫码者身份，按下文设置 `ALLOWED_USERS` 后重启。

凭据保存在 SQLite 同目录的 `feishu-binding.json`，Docker 默认路径为 `/data/bridge/feishu-binding.json`，随 agent-data 卷持久化。POSIX 文件权限为 0600，日志不输出 App Secret。后续查询机器人身份失败时保留已取得凭据，重启继续处理，不重新创建应用。二维码过期或拒绝授权后会报错，重启可重新扫码。Compose 的重启策略可能自动重试，请扫描日志中最新的二维码。当前仅支持飞书，扫码到 Lark 租户会停止并保留记录。

平台支持范围和租户审批规则可能影响自动配置；请在扫码确认页核对权限及事件。若应用仍待审核、缺机器人能力或无法收消息，需到飞书后台完成发布，并确认事件订阅为长连接。注册流程不绕过平台审批，也不通过 API 强制修改已有应用。

恢复时注意：已保存凭据但机器人身份查询失败，只需重启继续查询；不要删除绑定文件重新扫码。修改数据库所在目录时，应一并迁移 `feishu-binding.json`。若远端已创建应用、但本地凭据写入失败，请从飞书后台找回应用并使用下述完整手动配置。绑定文件包含密钥，首次启动日志包含有效期内的授权链接，均应限制访问。

已有应用可使用手动模式，在进程环境中同时填写以下四项（容器部署需先在 Compose environment 中添加对应映射，再通过 `.env` 或 Portainer 设置值）；这组配置优先于保存的扫码绑定，不会混用其他应用的使用者身份：

```dotenv
FEISHU_APP_ID=cli_your_app
FEISHU_APP_SECRET=your_app_secret
FEISHU_BOT_OPEN_ID=ou_your_bot
ALLOWED_USERS=ou_your_user
```

手动应用需要启用机器人、发布版本，并配置上述消息权限与事件长连接订阅。任意应用字段已填写但其余缺失会报错，不会静默改成扫码模式。扫码模式可单独设置 `ALLOWED_USERS` 覆盖扫码使用者。使用 Compose 时，先在服务的 `environment` 中添加 `ALLOWED_USERS: ${ALLOWED_USERS:-}`，再设置该变量。若飞书未返回扫码用户身份，必须通过此项明确指定使用者，服务不会接受“第一个发消息的人”自动占用。绑定文件损坏时停止并提示恢复；更换绑定前先停服务、备份并移走该文件。已有飞书应用不会被本服务自动删除。

群聊必须 @配置的机器人。仅文本消息进入任务。会话按用户和话题区分，群聊中的流式卡片和 `/result` 回复仍发到原群聊或话题。以 open_id 配置白名单；ADMIN_USERS 的管理员若需要执行命令，也应加入 ALLOWED_USERS。

- 普通文本：启动任务或继续该用户当前话题的会话。
- `/cancel`：取消本人在该聊天内的任务，管理员亦可取消。
- `/new`：清除本人当前话题的会话映射，下次新建；运行中不可重置。
- `/result`：取回本人当前话题最近一次已保存的任务结果，不重新执行任务。
- `/status`：查询当前话题任务的阶段、已用时间、执行时限与最近文字输出时间，不启动模型；管理员可查看同一聊天、话题中的任务状态。

任务默认允许执行 2 小时，包含会话初始化时间。可在 `.env`、Portainer 或进程环境中设置 `TASK_TIMEOUT_MS`，例如 `10800000` 为 3 小时，最多 24 小时；Compose 已映射该变量，修改后需重新创建容器。任务长时间没有文字输出不会触发额外的空闲超时，工具执行期间可用 `/status` 查询、用 `/cancel` 取消。最近文字输出时间不是工具心跳，也不能用于判断任务卡住。

长任务期间工作区仍被独占，普通新消息会提示忙，不排队。关闭飞书客户端不影响服务端任务；服务重启、进程退出或模型网关故障仍可能中断执行。当前不跟踪 Claude 结束本轮后遗留的后台命令，也不自动续跑中断任务。流式卡片更新被远端拒绝时，最终结果会尝试富文本回传。

任务接收后在用户原消息上添加 `Typing` 表情反馈，与模型启动并行；完成、失败或取消后尝试移除。有实际输出后开始推送 CardKit 流式卡片进度，每 250 毫秒至多合并更新一次正文。任务结束时也可直接创建卡片投递最终回复，并尝试关闭流式状态。正文使用飞书 JSON 2.0 Markdown（飞书客户端需 7.20 或更高版本），不添加任务标题、编号或默认折叠区域。快速完成的任务直接投递最终正文，内部 stopReason 不放进回复。

回复按每片最多 3,000 个原文 Unicode 码点拆分，优先在换行处分段，跨段代码围栏会闭合再重新打开。第一段在同一卡片内流式更新，余下段落在完成后按序发送 Markdown 富文本消息。CardKit 创建或正文更新失败时降级为富文本，保留原消息/话题的回复关系。累计输出最多保留末尾 24,000 个码点，超限会明确标注；`/result` 取回同一份已保存结果，不能恢复被截掉的开头。

已有飞书应用需在后台补充 `im:message.reactions:write_only`（Typing 表情）和 `cardkit:card:write`（原生流式卡片）并发布。首次扫码会申请这两项，更新服务不会修改旧应用权限；缺少表情权限仍执行任务，缺少 CardKit 权限则在完成后发送富文本回复。交互路径参考 OpenClaw 的 [Typing](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/typing.ts)、[流式卡片](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/streaming-card.ts)与[回复调度](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/reply-dispatcher.ts)。

日志二维码使用整格模块（每格两个字符宽），显式 ANSI 黑白配色、四格白色留白，并在每行重置颜色，减少主题反色和半格字体错位。图案比紧凑字符画更宽，Portainer 查看时需展开日志区域、关闭时间戳和自动换行。日志查看器仍可能改变行距或剥离颜色，无法保证所有版本和字体下都可扫码；剥离颜色后只剩普通字符图案，其颜色取决于查看器主题。

授权链接优先显示，同时在等待扫码期间生成 `/data/bridge/feishu-qr.svg` 固定黑白二维码图片，可复制到本机打开，不受日志字体影响。绑定完成、过期或失败后删除图片；图片和链接也属于短期授权凭据。

对符合接入规则且在白名单内的发送者，超长文本会提示拆分，非文本会提示暂不支持；不会截断用户指令后执行。Typing 表情失败仍执行任务。最终结果与任务终态先事务保存，再投递；可恢复网络错误和限流最多尝试 3 次，总发送窗口 15 秒，使用稳定分片 UUID 去重，不重放 Agent prompt。服务重启后不自动补发，可用 `/result` 取回。数据库本身不可写时无法保证结果落盘，会记录脱敏错误。

## Docker

在完整仓库目录中运行 Compose，使用当前检出的源码和 Dockerfile 构建镜像。通过 shell 环境变量或 Compose 自动读取的 `.env` 配置部署参数；不要求存在 `.env` 文件。业务项目代码由容器内的 Agent 管理。`/data` 使用单个 Docker 命名卷 agent-data，代码位于 `/data/workspace`，不需要在宿主机额外准备业务项目目录或设置 `WORKSPACE_HOST_PATH`。默认 `WORKSPACE_PROJECT=.` 使用 `/data/workspace`，可直接启动后让 Agent 创建项目。

先将 `.env.example` 复制为 `.env`，按需填写网关地址、主模型和认证变量。使用默认工作区时，在仓库根目录运行：

```sh
docker compose up -d --build
docker compose logs -f
```

如果 Agent 需要操作已有 Git 仓库，可先将该业务仓库克隆到卷中。下例使用 `/data/workspace/my-repo`，部署环境需设置：

```dotenv
WORKSPACE_PROJECT=my-repo
```

`WORKSPACE_PROJECT` 指定的子目录必须在服务启动前存在。首次初始化执行（替换仓库 URL；新项目使用默认 `.` 时跳过 clone）：

```sh
docker compose build
docker compose run --rm --no-deps agentbridge git clone https://your-git-server/team/my-repo.git /data/workspace/my-repo
docker compose run --rm agentbridge node dist/index.cjs --check
docker compose up -d
docker compose logs -f
```

上面的 `docker compose build` 构建 Bridge 服务；随后示例中的 clone 用于初始化 Agent 将要操作的业务项目，两者是不同的代码目录。更新 Bridge 源码后执行 `docker compose up -d --build`，重新构建并启动。业务项目 clone 只在首次初始化时执行。私有仓库需先配置容器可用的认证。日常通过 Agent 或 `docker compose exec -w /data/workspace/my-repo agentbridge bash` 操作代码；使用默认 `.` 时工作目录改为 `/data/workspace`。本地直接运行 Node 时，`WORKSPACE_ROOT` 仍填写本机已存在的绝对路径；Compose 固定使用 `/data/workspace`。

普通重建容器或 `docker compose down` 会保留命名卷；`docker compose down -v` 会删除包括代码在内的持久数据。备份时保存整个 agent-data 卷；Git 推送不包含未提交文件。卷默认跟随 Compose 项目名，部署时保持项目名稳定，避免切换到另一组空卷。迁移部署位置时，先确认旧卷名称；若原卷为 `<旧项目名>_agent-data`，所有 Compose 命令均使用 `docker compose -p <旧项目名> ...`，复用原卷。仓库复制不会迁移 Docker 卷，换宿主机时需另行备份、恢复。

### Portainer

当前 Compose 需要完整源码构建上下文，不能只在 Portainer Web editor 中粘贴 `compose.yaml` 就完成部署。推荐在 Docker 主机检出仓库、配置环境变量，然后按上面的 Compose 命令构建和启动；Portainer 用于查看容器、日志和数据卷。

若使用 Portainer Stack 部署，需要确认该部署方式将完整仓库作为构建上下文交给 Docker，并支持 Compose build；当前未验证此路径，也未验证 Swarm。不能继续套用原先仅拉取预构建镜像的 Web editor 操作步骤。

首次使用可保留 `WORKSPACE_PROJECT=.`，启动后让 Agent 创建或克隆项目。若改为子目录，需提前在卷中创建该目录。部署后从日志扫码绑定飞书。修改运行环境变量后执行 `docker compose up -d --force-recreate`；单纯重启不会更新配置。

目录职责如下；`.env` 的本地开发路径不会覆盖 Compose 固定的容器路径：

| 路径 | 用途 |
|---|---|
| `/app` | Bridge 程序启动目录 |
| `/data` | 唯一的 agent-data 持久卷挂载点 |
| `/data/workspace` | agent-data 卷内的代码目录，保存 Git 元数据及项目依赖 |
| `/data/workspace/<WORKSPACE_PROJECT>` | Claude ACP 进程 cwd 和 ACP new/load 的 cwd；项目代码、CLAUDE.md 及项目 `.claude` 配置位于这里 |
| `/home/node` | 容器内 HOME，用户为 node（UID 1000） |
| `/data/claude` | CLAUDE_CONFIG_DIR，agent-data 卷内保存 Claude 配置和历史；不当作项目 cwd |
| `/data/bridge` | agent-data 卷内保存 SQLite 和飞书扫码绑定文件 |

Dockerfile 分为基础工具、依赖安装、ncc 构建、生产依赖裁剪和最终运行五阶段。最终镜像包含 dist、生产 node_modules、Node/npm、pnpm 12.14.0、Bash、Git、SSH 客户端、curl、ripgrep、CA 和时区数据；不包含 Bridge 源码、TypeScript 或 ncc。pnpm 留在运行镜像供 Agent 安装和测试项目依赖。没有预装 Python/Go/编译器、浏览器或 AWS CLI，项目需要时扩展镜像。Claude 由 ACP 的 SDK 依赖启动，不额外全局安装另一个 Claude CLI。

参考其他项目的镜像源约定，默认 npm/pnpm 使用 npmmirror、apt 使用阿里云、时区为 Asia/Shanghai。Compose 将 `NPM_REGISTRY` 同时传入 Docker 构建参数和容器运行环境，控制构建阶段及 Agent 内的 npm/pnpm；`BASE_IMAGE`、`DEBIAN_MIRROR` 只作为构建参数传入，可在 shell 或 `.env` 中覆盖。修改构建参数后执行 `docker compose up -d --build`。也可使用 `docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org -t agent-bridge:local .` 单独构建。`BASE_IMAGE` 必须是 Node 26 Debian bookworm 基底；现有自研 Node Alpine 镜像不适用于这里的 apt/glibc 配置。

容器不加载宿主机 Claude 配置。已有卷的权限不会被 Dockerfile 重新修正，修改用户或替换卷后需单独核对目录权限。SSH 客户端已安装，但不内置 SSH 密钥或私有仓库凭证。

无需入站端口。项目、SQLite 和 Claude 会话目录共享一个 agent-data 持久卷，分别位于 /data/workspace、/data/bridge 和 /data/claude；HOME 下其他文件（如 `.ssh`、`.gitconfig` 和包管理器缓存）目前不持久化。仅适合单实例；不要横向扩容共享数据库/项目。模型网关必须兼容 Anthropic Messages、流式输出和工具调用。

`ANTHROPIC_BASE_URL` 选填，使用自定义网关时填写 HTTP(S) 基址，路径应止于 API 根目录。地址缺失或为空白时，Claude 使用自身配置和默认路由，可能请求 Anthropic 官方 API。网关地址、主模型、各档位模型映射及子 Agent 模型在 Compose environment 中显式注入；认证变量同样通过 environment 显式注入，Agent 所需变量再由 runtime 白名单传递。Compose 不会自动透传未列出的变量；需要额外参数时应在 environment 中添加映射。认证按网关要求选 `ANTHROPIC_API_KEY`（x-api-key）或 `ANTHROPIC_AUTH_TOKEN`（Bearer），未用的变量留空或删除。`ANTHROPIC_MODEL` 配置主模型；需要时设置 `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 和 `CLAUDE_CODE_SUBAGENT_MODEL` 为网关支持的模型 ID，避免子任务或别名回落到不可用模型。详见 [Claude 网关配置](https://code.claude.com/docs/en/llm-gateway-connect) 和 [模型配置](https://code.claude.com/docs/en/model-config)。

模型配置在运行时注入。Claude 的用户、项目和本地设置也可能覆盖网关地址及模型变量。部署前核对持久卷和项目中的 Claude 设置，并在网关侧确认实际请求路由。当前仅支持 Anthropic 兼容端点；未透传 Bedrock/Vertex/Foundry 开关与云凭证。`--check` 只检查 Bridge 配置、已有绑定文件、项目路径与 Adapter 入口，不验证模型凭证、网络、目录写权限或真实模型调用。主模型和认证凭证当前不属于 Bridge 必填校验项，检查通过不能证明它们已正确配置。绑定文件缺少使用者、损坏或手动配置不全时仍会失败，详见[启动状态表](docs/design.md#首次启动与绑定)。容器内 `localhost` 指容器自身，宿主机网关需使用容器可达地址。

Linux 使用独立进程组终止 Adapter 及子进程；Windows 本地仅终止 Adapter 进程，强制取消时请检查其工具子进程。生产部署以 Linux 容器为目标。

## 恢复与边界

重启后旧运行任务标记 interrupted，不重放任务。会话仅在 Agent 声明支持并成功 load 时恢复，否则通知用户创建新会话。用户上下文隔离不等于文件隔离：所有白名单用户都必须有权访问固定项目。

Claude ACP 使用 bypassPermissions 免审批模式，不提供客户端文件/终端 ACP 能力；Agent 使用自身工具执行读写和命令。cwd 不是沙箱，单容器中的 Bridge 与 Agent 不是强隔离安全边界。

每次新建或恢复会话均启用 `allowDangerouslySkipPermissions=true`，并在 prompt 前设置和确认 `bypassPermissions`；Adapter 不支持或拒绝该模式时任务失败，不退回逐条审批。意外收到权限请求时立即返回 cancelled，不发审批卡片、不等待聊天授权。只有白名单用户可启动任务，取消和失败任务等待进程清理后才释放工作区。此模式允许 Claude 在容器用户权限范围内直接执行工具，不构成工作目录沙箱。

尚不包括 Git worktree、多项目、并发执行、附件与 Web 管理 API。当前无需引入 @maxtan/nest-core；后续管理 API 可复用该框架。

## 线上验收

`AgentBridge started` 在飞书长连接就绪后记录；首次连接超过 30 秒或遇到不可恢复错误会启动失败。运行期间的不可恢复连接错误会记录脱敏日志并以非零退出码停机，由 Compose 重启；可恢复断线由 SDK 重连。连接就绪不代表权限和事件订阅已经生效，部署时仍需实际发消息、观察 Typing 表情及卡片原位更新确认。

本地测试使用模拟 ACP 子进程，并包含已安装真实 Adapter 的协议协商检查，不调用模型、不发送飞书消息。配置真实凭证后逐项验证：文本任务修改测试文件、连续对话、免审批读写执行、Typing 清理、CardKit 原生流式与关闭、缺权限时的富文本降级、长文续发和代码块渲染、取消、重复事件、容器重启后恢复。Linux 真实进程组与 Docker 构建运行仍需验收；未经此验收不能视为生产上线完成。
