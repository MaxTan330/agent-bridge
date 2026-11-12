# agent-bridge

AgentBridge 是基于 Node.js 26 和 Claude ACP 的飞书开发助手。你可以在飞书里让 Claude 分析代码、修改文件或运行项目命令。默认短任务直接回复，长任务先通知后台执行、完成后再返回结果；也可开启 Markdown 卡片流式回复。服务支持扫码绑定机器人、恢复会话、查询和取消长任务，以及从源码构建或拉取版本化 Docker 镜像。

每个实例服务于一个固定项目，仅允许白名单用户发起任务，同一时间执行一个任务。

- [实现设计：架构、行为契约与验收边界](docs/design.md)
- [版本发布：package.json、Changelog、GitHub Release 和 Docker 镜像](docs/releases.md)
- [变更记录](CHANGELOG.md)

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:bundle
```

复制 `.env.example` 为 `.env`，取消 `WORKSPACE_ROOT` 的注释并填写本机已存在的业务项目绝对路径，再填写所需的模型、认证配置，然后运行 `pnpm start`。`WORKSPACE_PROJECT=.` 表示直接使用该项目目录。首次正常启动会在终端显示飞书二维码及备用链接，使用飞书扫码确认创建应用，扫码用户自动成为允许使用者。`pnpm dev` 使用 Node.js 26 原生 TypeScript 支持。请勿提交 `.env` 或飞书绑定文件。

示例直接列出网关、主模型、各档位模型映射、子 Agent 模型和项目路径，按网关支持情况填写。管理员列表、数据库路径、超时、时区和镜像源可按需覆盖，参见[配置契约](docs/design.md#配置契约)。模型别名没有 Bridge 内置映射；自定义网关使用哪些别名，就应将它们映射到网关实际支持的模型 ID，不能假定填写主模型会同时覆盖其他模型用途。

| 模型变量 | 用途 |
|---|---|
| `ANTHROPIC_MODEL` | 主会话模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `sonnet` 别名对应的模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `opus` 别名对应的模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `haiku` 别名及相关后台用途的模型 |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | 使用 `fable` 时的模型映射，按网关支持情况配置 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 未单独指定模型的子 Agent 默认模型；单次调用或 Agent 定义可覆盖 |

以上变量可一起配置，并不要求使用不同模型 ID；只有一个可用模型的网关可将所需别名映射到同一个 ID。配置自定义网关时填写 `ANTHROPIC_BASE_URL`。留空时由 Claude 的配置和默认行为决定模型路由。变量用途依据 [Claude Code 模型配置](https://code.claude.com/docs/en/model-config)。修改运行时模型变量后，源码部署执行 `docker compose up -d --force-recreate`，镜像部署执行 `docker compose -f compose.image.yaml up -d --force-recreate`；使用 override 时保留相同的 `-f` 参数，Portainer 则更新 Stack。

直接依赖和开发依赖使用 `^`，具体安装版本由 pnpm-lock.yaml 固定。升级时核对 npm 官方最新稳定版本并重新验证。TypeScript 7 与 Claude SDK 均包含平台二进制，应使用完整安装，不能全局跳过 optionalDependencies。protobufjs 的可选 postinstall 明确忽略。

`node src/main.ts --version` 或 `node dist/index.cjs --version` 可查询 package 版本，不需要配置凭据或启动服务。镜像中可执行 `docker compose -f compose.image.yaml run --rm --no-deps agentbridge node dist/index.cjs --version`。

`pnpm build` 先用 TypeScript 编译到 `.build`，再由 ncc 通过 CommonJS 入口打包到 `dist/index.cjs`，兼容飞书 SDK 的 `__dirname` 使用。Bridge 应用代码和可打包依赖合并为单入口；ncc 生成的资源文件也应随整个 `dist` 目录交付。Claude ACP 作为外部子进程依赖保留，不能仅复制一个 JS 文件就运行 Agent。

`pnpm test:bundle` 验证真实打包入口、模块加载、配置和外部 Adapter 路径解析，不连接飞书或调用模型。也可在填写 `.env` 后使用 `pnpm start --check` 做启动前检查；尚未绑定时会提示首次启动需要扫码，检查本身不会创建应用、打印二维码或写入绑定文件。

## 飞书配置

`FEISHU_APP_NAME` 可配置首次扫码创建的应用名称，默认 `AgentBridge`，留空也使用默认值。Compose 已映射，可在 `.env` 或 Portainer 中设置。该值仅作为创建时的预设名称，最终名称以飞书确认页为准；已有绑定不会被自动改名或重新创建，需要改名时在飞书后台操作。

默认使用扫码创建：首次启动调用飞书官方设备授权流程，二维码仅允许创建新应用，避免覆盖已有机器人的配置。确认页申请机器人发消息、接收私聊和群聊 @消息、读取消息及附件资源、发送/删除表情回复及 CardKit 卡片写入权限，订阅 `im.message.receive_v1`；不申请用户身份权限。确认后保存应用凭据及平台返回的扫码者 open_id，再查询机器人 open_id。若平台未返回扫码者身份，按下文设置 `ALLOWED_USERS` 后重启。

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

群聊必须 @配置的机器人。支持文本、图片和 UTF-8 文本文件消息；附件仅在白名单校验通过、任务真正执行时下载。图片最多 5 MiB（PNG/JPEG/GIF/WebP），文本附件最多 256 KiB，暂不解析 PDF、Office、压缩包和音视频。会话按用户和话题区分，群聊中的流式卡片和 `/result` 回复仍发到原群聊或话题。以 open_id 配置白名单；ADMIN_USERS 的管理员若需要执行命令，也应加入 ALLOWED_USERS。

- 普通文本：空闲时启动任务；忙时自动排队，轮到后继续该用户当前话题的会话，无需重发。
- `/queue`：查看本人当前话题的排队任务、编号和前方任务数量；管理员可查看同一话题其他用户的队列。
- `/cancel`：取消本人在当前聊天、话题内正在执行的任务，管理员亦可取消；取消后继续下一项。
- `/cancel <任务编号>`：取消指定的排队任务，编号来自入队回复或 `/queue`；管理员可取消同一话题其他用户的排队任务。
- `/cancel all`：清空本人当前话题的排队任务，不取消执行中的任务或其他用户的队列。
- `/new`：清除本人当前话题的会话映射，下次新建；该会话有执行中或排队任务时，需等待完成或取消后重置。

原生能力入口：`/help` 查看所有命令；`/commands` 查看 Claude 公布的命令；`/tools`、`/plan`、`/usage` 查看最近工具、计划与用量；`/steer <要求>` 引导本人执行中任务。Claude 提问时使用 `/answer <编号> <回答或 JSON>`，无需排队；`/questions` 重看问题，`/skip <编号>` 跳过。`/sessions`、`/resume <编号>` 仅列出和恢复本人历史。`/mode plan` 设置后续任务为计划模式，`/mode execute` 恢复执行；`/model`、`/effort` 设置原生偏好，`/config` 查看实际可选项。详见 [原生能力与架构](docs/claude-capabilities.md)。

Claude 的 `CLAUDE.md`、Skills、Hooks、子 Agent 和已配置插件继续使用原生项目设置。可用 `CLAUDE_RUNTIME_CONFIG` 指定 MCP 与执行限制的 JSON 文件，两个 Compose 已映射该路径；格式和凭据管理见上述文档。默认传入 `includeCoAuthoredBy: false` 和空的 commit/pr attribution，同时关闭会话链接，不修改 Git 作者信息。

附件下载需要飞书 `im:message:readonly` 权限。首次扫码注册会申请；已绑定机器人需要在飞书开发者后台补充该权限并发布新应用版本，重启 Bridge 不会自动修改已有应用授权。

- `/result`：取回本人当前话题最近一次已保存的任务结果，不重新执行任务。
- `/status`：查询当前话题任务的阶段、已用时间、执行时限与最近文字输出时间，不启动模型；管理员可查看同一聊天、话题中的任务状态。

任务默认允许执行 2 小时，包含会话初始化时间。可在 `.env`、Portainer 或进程环境中设置 `TASK_TIMEOUT_MS`，例如 `10800000` 为 3 小时，最多 24 小时；Compose 已映射该变量，修改后需重新创建容器。任务长时间没有文字输出不会触发额外的空闲超时，工具执行期间可用 `/status` 查询、用 `/cancel` 取消。最近文字输出时间不是工具心跳，也不能用于判断任务卡住。

长任务期间工作区仍由一个任务独占，后续普通消息按接收顺序排队，最多等待 20 项（不含当前任务）。入队后立即回复任务编号和前方任务数量；当前任务完成、失败或取消并收尾后，自动执行下一项。排队时间不计入任务执行时限；任务真正启动时再恢复会话并开始计时，只有 stream 模式添加 Typing 表情。队列满时明确告知本条未接收。`/status` 同时显示当前会话可查看的排队数量。

管理命令走独立处理路径，不占队列容量，队列满时仍可查询状态、查看结果、取消执行中或排队任务。`/new` 立即检查当前会话，存在未完成任务时提示先取消，不会插入普通任务队列。其他发给 Claude 的项目指令仍按普通任务执行，不能借命令形式绕过工作区互斥。

同一用户和话题的 Claude 会话在任务收尾后闲置满 4 小时，下次任务创建新会话；连续工作可复用上下文。可用 `SESSION_IDLE_TIMEOUT_MS=14400000` 配置（范围 1 分钟至 7 天），两个 Compose 文件均已映射。`/status`、`/queue`、`/result` 不延长会话有效期。全局无执行中和排队任务满该时长时，也停止闲置 Adapter 进程；运行中的长任务不受闲置回收影响。排队任务在实际启动时判断会话是否过期，排队等待本身不刷新有效期。回收仅清除 Bridge 映射及空闲进程，保留任务结果和 Claude 历史文件。旧数据库会自动补充活动时间字段；缺少时间的旧映射首次使用时创建新会话。

关闭飞书客户端不影响任务执行。服务停止或进程清理失败时，等待项会中断并尽力通知；异常退出后重启也会将等待项标记中断，可用 `/result` 查看当前会话最近记录。排队提示正文仅保存在内存，不会在重启后自动重放；需要执行时重新发送。当前不跟踪 Claude 结束本轮后遗留的后台命令，也不自动续跑中断任务。流式卡片更新被远端拒绝时，最终结果会尝试富文本回传。

默认 `TASK_REPLY_MODE=auto`：执行不满 5 秒直接返回结果；达到 `TASK_BACKGROUND_NOTICE_MS`（默认 5000，可改为 10000）时发送一次后台执行通知，完成后再发送结果。自动模式不持续显示 Typing 或中间流式卡片，仍可用 `/status` 查询。通知计时从任务实际开始执行算起，不包含排队时间；消息队列接收提示仍即时发送。通知与执行并行，网络故障不会阻塞模型启动，最终结果会等待通知投递结束或超时，避免消息顺序颠倒。这一规则不额外调用 LLM。

`TASK_REPLY_MODE=background` 始终先发后台执行回执；`TASK_REPLY_MODE=stream` 保留流式交互：开始时添加 Typing 表情，完成、失败或取消后移除；有实际输出后每 250 毫秒至多合并更新一次 CardKit 卡片。各模式最终均可创建卡片投递完整回复并关闭流式状态。正文使用飞书 JSON 2.0 Markdown（飞书客户端需 7.20 或更高版本），不添加默认折叠区域，内部 stopReason 不放进回复。Compose 已映射这两个回复配置，修改后需重新创建容器。

回复按每片最多 3,000 个原文 Unicode 码点拆分，优先在换行处分段，跨段代码围栏会闭合再重新打开。第一段在同一卡片内流式更新，余下段落在完成后按序发送 Markdown 富文本消息。CardKit 创建或正文更新失败时降级为富文本，保留原消息/话题的回复关系。累计输出最多保留末尾 24,000 个码点，超限会明确标注；`/result` 取回同一份已保存结果，不能恢复被截掉的开头。

已有飞书应用需在后台补充 `im:message.reactions:write_only`（Typing 表情）和 `cardkit:card:write`（原生流式卡片）并发布。首次扫码会申请这两项，更新服务不会修改旧应用权限；缺少表情权限仍执行任务，缺少 CardKit 权限则在完成后发送富文本回复。交互路径参考 OpenClaw 的 [Typing](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/typing.ts)、[流式卡片](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/streaming-card.ts)与[回复调度](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/reply-dispatcher.ts)。

日志二维码使用整格模块（每格两个字符宽），显式 ANSI 黑白配色、四格白色留白，并在每行重置颜色，减少主题反色和半格字体错位。图案比紧凑字符画更宽，Portainer 查看时需展开日志区域、关闭时间戳和自动换行。日志查看器仍可能改变行距或剥离颜色，无法保证所有版本和字体下都可扫码；剥离颜色后只剩普通字符图案，其颜色取决于查看器主题。

授权链接优先显示，同时在等待扫码期间生成 `/data/bridge/feishu-qr.svg` 固定黑白二维码图片，可复制到本机打开，不受日志字体影响。绑定完成、过期或失败后删除图片；图片和链接也属于短期授权凭据。

对符合接入规则且在白名单内的发送者，超长文本会提示拆分，图片和 UTF-8 文本附件按上述限制处理，其他不支持的消息类型会提示暂不支持；不会截断用户指令后执行。Typing 表情失败仍执行任务。最终结果与任务终态先事务保存，再投递；可恢复网络错误和限流最多尝试 3 次，总发送窗口 15 秒，使用稳定分片 UUID 去重，不重放 Agent prompt。服务重启后不自动补发，可用 `/result` 取回。数据库本身不可写时无法保证结果落盘，会记录脱敏错误。

## Docker

支持从已发布镜像部署和从源码构建。两种方式都固定使用容器内的 `/data/workspace`，通过 `WORKSPACE_PROJECT` 选择项目；`.env` 的 `WORKSPACE_ROOT` 只用于本地 Node。

### 按版本拉取镜像

下载仓库中的 `compose.image.yaml` 和 `.env.example`，将后者复制为 `.env`。在 `.env` 中取消 `AGENTBRIDGE_IMAGE` 的注释，选择已经成功发布的版本，例如：

```dotenv
AGENTBRIDGE_IMAGE=ghcr.io/maxtan330/agent-bridge:0.1.0
WORKSPACE_PROJECT=.
```

`0.1.0` 仅为示例，以仓库 Releases 和 Packages 中实际发布成功的版本为准。镜像只发布完整版本号，不维护 `latest`；未设置 `AGENTBRIDGE_IMAGE` 时 Compose 会明确报错。当前构建平台为 `linux/amd64`。发布镜像经过 Cosign 无密钥签名和验签，部署前可按[镜像签名与验证](docs/releases.md#镜像签名与验证)核对身份、版本和 digest；Compose 不自动验签。

```sh
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d
docker compose -f compose.image.yaml logs -f
```

升级或回滚时修改 `AGENTBRIDGE_IMAGE` 为目标版本，再执行上述 `pull` 和 `up -d`。从源码部署切换时保持相同目录/Compose 项目名，复用原 agent-data 卷；更换目录时使用 `-p <原项目名>`。首次发布后检查 GHCR 包的访问权限：公开包可匿名拉取，私有包需先登录 GHCR，Portainer 则需配置相应 Registry 凭据，参见 [GHCR 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### 从源码构建

在完整仓库目录中运行 Compose，使用当前检出的源码和 Dockerfile 构建镜像。通过 shell 环境变量或 Compose 自动读取的 `.env` 配置部署参数；不要求存在 `.env` 文件。业务项目代码由容器内的 Agent 管理。`/data` 使用单个 Docker 命名卷 agent-data，代码位于 `/data/workspace`，不需要在宿主机额外准备业务项目目录或设置 `WORKSPACE_HOST_PATH`。默认 `WORKSPACE_PROJECT=.` 使用 `/data/workspace`，可直接启动后让 Agent 创建项目。

先将 `.env.example` 复制为 `.env`，按需填写网关地址、主模型和认证变量。**Docker 部署无需填写 `WORKSPACE_ROOT`：Compose 固定注入容器路径 `/data/workspace`，不会采用 `.env` 中的同名值，也不会自动挂载宿主机路径。** 使用默认工作区时，在仓库根目录运行：

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

### 使用宿主机已有项目目录

如果业务代码已经位于 Docker 主机的 `/srv/projects/my-repo`，在 `compose.yaml` 同目录新建 `compose.override.yaml`，将该项目挂载到容器工作区：

```yaml
services:
  agentbridge:
    volumes:
      - type: bind
        source: /srv/projects/my-repo
        target: /data/workspace
        bind:
          create_host_path: false
```

将 `source` 替换为 Docker 主机上已存在的绝对目录，并确保容器用户 UID 1000 有读写权限；这里填写的是 Docker 主机路径。`.env` 保持 `WORKSPACE_PROJECT=.`，无需设置 `WORKSPACE_ROOT`。如果挂载的是包含多个项目的父目录，再用 `WORKSPACE_PROJECT` 选择其下的项目。

在仓库目录执行以下命令，Compose 会自动合并 `compose.override.yaml`：

```sh
docker compose build
docker compose run --rm --no-deps agentbridge node dist/index.cjs --check
docker compose up -d --force-recreate
docker compose exec agentbridge printenv WORKSPACE_ROOT WORKSPACE_PROJECT
```

最后一条命令在上述配置下应输出 `/data/workspace` 和 `.`。`--check` 验证路径存在及启动配置，不检查写权限。

使用已发布镜像时，将上面的每条 Compose 命令改为 `docker compose -f compose.image.yaml -f compose.override.yaml ...`，并将第一条命令的 `build` 改为 `pull`；显式使用 `-f` 时需要同时列出挂载覆盖文件。

启用该挂载后，项目文件直接读写宿主机目录，SQLite 和 Claude 配置仍保存在原 agent-data 卷。已有卷中的 `/data/workspace` 内容会被挂载遮住，不会自动迁移或删除；如需保留其中的项目，请先复制到宿主机目录。备份时同时保存宿主机项目和 agent-data 卷。后文目录表描述默认命名卷部署。

### Portainer

使用已发布镜像时，可以将 `compose.image.yaml` 粘贴到 Portainer Stack 的 Web editor，在 Stack 环境变量中填写 `AGENTBRIDGE_IMAGE`（完整版本镜像地址）及模型配置，再部署；无需源码构建上下文。复用现有数据时保持原 Stack/Compose 项目名。此配置已做静态检查，Portainer 实际部署仍需在目标环境验证。

`compose.yaml` 则用于源码构建，不能仅粘贴到 Web editor；需要完整仓库上下文和 Compose build 支持。未验证 Portainer 源码构建路径或 Swarm。

首次使用可保留 `WORKSPACE_PROJECT=.`，启动后让 Agent 创建或克隆项目。若改为子目录，需提前在卷中创建该目录。部署后从日志扫码绑定飞书。修改运行环境变量后，在 Portainer 更新 Stack 并重新创建容器；CLI 镜像部署使用 `docker compose -f compose.image.yaml up -d --force-recreate`，并保留原有 override 文件参数。单纯重启不会更新配置。

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

Claude ACP 默认使用 bypassPermissions 免审批执行模式，也可通过 `/mode plan` 显式选择计划模式。Bridge 不提供客户端文件/终端 ACP 能力；Agent 使用自身工具执行读写和命令。cwd 不是沙箱，单容器中的 Bridge 与 Agent 不是强隔离安全边界。

每次新建或恢复会话均启用 `allowDangerouslySkipPermissions=true`，并在 prompt 前设置和确认所选模式：默认 `bypassPermissions`，显式选择计划模式时为 `plan`。Adapter 不支持、拒绝或意外切换模式时任务失败，不退回逐条审批或自动批准计划。意外收到权限请求时立即返回 cancelled，不发审批卡片、不等待聊天授权。只有白名单用户可启动任务，取消和失败任务等待进程清理后才释放工作区。免审批执行允许 Claude 在容器用户权限范围内直接执行工具，不构成工作目录沙箱。

仅正常结束响应记为任务完成；执行或输出达到限制、模型拒绝及未知结束原因记为失败，并保留部分输出和原因，供 `/result` 取回。取消仍标记为取消，收尾后再执行下一项排队任务。

尚不包括 Git worktree、多项目、并发执行与 Web 管理 API。附件支持范围为图片及 UTF-8 文本文件。当前无需引入 @maxtan/nest-core；后续管理 API 可复用该框架。

## 线上验收

`AgentBridge started` 在飞书长连接就绪后记录；首次连接超过 30 秒或遇到不可恢复错误会启动失败。运行期间的不可恢复连接错误会记录脱敏日志并以非零退出码停机，由 Compose 重启；可恢复断线由 SDK 重连。连接就绪不代表权限和事件订阅已经生效，部署时仍需实际发消息确认短任务直接回复、长任务通知和最终结果；Typing 表情及卡片原位更新需在 `TASK_REPLY_MODE=stream` 下验证。

本地测试使用模拟 ACP 子进程，并包含已安装真实 Adapter 的协议协商检查，不调用模型、不发送飞书消息。配置真实凭证后逐项验证：文本任务修改测试文件、连续对话、免审批读写执行、Typing 清理、CardKit 原生流式与关闭、缺权限时的富文本降级、长文续发和代码块渲染、取消、重复事件、容器重启后恢复。Linux 真实进程组与 Docker 构建运行仍需验收；未经此验收不能视为生产上线完成。
