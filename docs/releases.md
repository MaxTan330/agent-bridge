# 版本发布

`package.json` 的 `version` 是应用和镜像版本的来源。Release Please 负责在发布 PR 中同步更新它、`CHANGELOG.md` 和 `.release-please-manifest.json`，合并后创建 `v<version>` 标签和 GitHub Release，再发布 `ghcr.io/maxtan330/agent-bridge:<version>`。例如 package 版本为 `0.1.0` 时，Git 标签为 `v0.1.0`，镜像标签为 `0.1.0`。

运行时 ACP 握手、启动日志和 `node dist/index.cjs --version` 使用同一 package 版本；构建时打包版本数据，不从业务项目的 package 读取。镜像 OCI version 标签和 Cosign 签名中的 version 注解同样使用发布校验的 package 版本。

首次发布使用当前 package 版本 `0.1.0`，对应 `v0.1.0` 和镜像 `:0.1.0`。manifest 初始为空，表示尚未发布，避免将 `0.1.0` 当作已发布版本再自动递增；配置显式设置 `initial-version: 0.1.0`，使首次发布 PR 使用 `0.1.0` 并写入 manifest；不能依赖 Node 策略的默认初始版本。后续版本再按提交类型递增。镜像发布仅支持稳定三段版本号，不发布 `latest`、主版本浮动标签或预发布版本，不发布 npm 包。配置落地后，首次真实发布仍需合并发布 PR 并等待镜像任务成功。

## 一次性设置

1. 将工作流及配置合并到 `main`，启用 GitHub Actions。
2. 在 Settings → Actions → General 中允许 GitHub Actions 创建 Pull Request。工作流为 Release Please 声明 `contents: write`、`issues: write`、`pull-requests: write`，为 GHCR 发布声明 `packages: write`；签名 job 及调用方还声明 `id-token: write`，用于获取 OIDC 身份。组织策略也需允许这些操作。
3. 默认使用内置 `GITHUB_TOKEN`，不需要配置 Docker Hub 密钥。首次发布后在 GitHub Packages 检查镜像可见性；私有镜像需要拉取凭据。

如果希望自动创建的发布 PR 也触发普通 `pull_request` CI，可配置可创建 PR、发布 Release 的 PAT 或 GitHub App token 为仓库 secret `RELEASE_PLEASE_TOKEN`。未配置时使用 `GITHUB_TOKEN`，其创建的 PR 不会自动触发 CI；合并前可在 Actions → Docker image → Run workflow 中选择发布 PR 的分支，保持 `release-tag` 为空以运行检查。若仓库要求 PR 检查状态，建议配置专用 token。镜像发布任务始终重新运行测试，并校验发布版本。

这是 GitHub 的事件触发限制，参见 [Release Please 凭据与工作流说明](https://github.com/googleapis/release-please-action#github-credentials)。发布流程直接调用可复用的 Docker workflow，因此默认 token 创建标签后也能继续构建镜像，无需依赖标签或 Release 事件再次触发。

## 日常发布

使用 Conventional Commits 合并变更到 `main`，例如：

```text
fix: 修复工作区配置说明
feat: 支持版本化 Docker 镜像部署
feat!: 调整不兼容的配置格式
```

采用默认版本策略：`fix` 对应补丁，`feat` 对应次版本，破坏性变更对应主版本。Release Please 汇总提交，创建或更新发布 PR；检查 PR 中的 package 版本和 changelog 后合并，即完成发布决策。只包含普通 `docs`/`chore` 等提交时，不一定会提出新版本。可在 Actions 手动运行 Release workflow 重新处理 `main`。

首次目标已经是 `0.1.0`，无需额外指定。以后需要明确指定下一版本时，可在合并提交消息中加入 `Release-As` footer，保持空行，例如升级至 `0.2.0`：

```text
chore: prepare stable release

Release-As: 0.2.0
```

Release Please 会据此更新发布 PR。使用 squash merge 时，应确保最终 squash 提交保留该 footer。不要只修改 Docker 标签；版本调整应经过发布 PR，并同步 package、manifest 和 changelog。版本规则参见 [Release Please 配置](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)。

## 自动检查与镜像发布

普通 PR 和 `main` 提交运行类型检查、测试及 Docker 构建，不登录 GHCR、不推送或签名镜像。Dockerfile 构建阶段另外执行打包和 bundle smoke check。发布仅允许从 `main` 的 workflow 发起；手动选择其他分支时必须保持 `release-tag` 为空。

Release Please 创建 Release 后，调用 Docker image 工作流并传入确切的标签；测试和构建都检出该标签，而非随后变化的 `main`。发布前检查：

- `package.json` 是稳定的 `major.minor.patch` 版本。
- Git 标签严格等于 `v` 加 package 版本。
- manifest 记录与 package 一致。
- `CHANGELOG.md` 存在该版本的二级标题。

检查、测试和镜像构建通过后，使用 package 版本推送到 GHCR。默认构建 `linux/amd64`，镜像带有版本和实际检出提交的 OCI 标签。Fork 会按自己的 GitHub 仓库名生成镜像路径；使用镜像部署文件时应填写对应的完整地址。

GitHub Release 创建成功不代表镜像发布完成，需等待 Release workflow 的 `publish` 调用完成，包括 `image` 和 `sign` 两个 job。首次发布之前，文档中的 `0.1.0` 仅为用法示例。

## 镜像签名与验证

发布镜像后，独立 `sign` job 使用固定提交版本的 Cosign installer 安装 Cosign 3，通过 GitHub Actions OIDC 无密钥签名。签名对象为 Buildx 返回的 `image@sha256:...`，并绑定 `version` 和实际检出的 `revision` 注解；不根据可变标签重新解析签名目标。签名随后验证本仓库 `docker-publish.yml@refs/heads/main` 的精确身份、GitHub OIDC issuer 和注解，任何一步失败均使发布失败。构建和测试 job 不授予 `id-token: write`。

无需配置 Cosign 私钥。签名和验证材料随镜像存放于 GHCR；签名证书身份及记录会写入公共 Sigstore 透明日志。原理见 [Sigstore 容器签名](https://docs.sigstore.dev/cosign/signing/signing_with_containers/)，复用 workflow 的身份取自 [Fulcio 的 job_workflow_ref](https://github.com/sigstore/fulcio/blob/main/docs/oidc.md#github)。

成功后在 Actions 的 `sign` job 摘要查看版本、digest、源码提交号和签名身份。安装 Cosign 3 后，将摘要里的完整镜像 digest 填入下面命令（私有镜像需先 `docker login ghcr.io`）：

```sh
IMAGE='ghcr.io/maxtan330/agent-bridge@sha256:<摘要中的完整digest>'
cosign verify "$IMAGE" \
  --certificate-identity 'https://github.com/MaxTan330/agent-bridge/.github/workflows/docker-publish.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  -a version=0.1.0
```

版本应替换为目标发布版本；还可添加 `-a revision=<摘要中的源码提交号>`。Fork 需将镜像地址和证书身份替换为自己的仓库，身份中的仓库大小写须与 GitHub 一致。验证成功后可将 `AGENTBRIDGE_IMAGE` 设置为同一完整 digest 部署，避免验证与拉取间标签变化。Compose/Portainer 不自动执行验签，需要在部署前执行；签名证明来源与内容完整性，不代表实际功能已经验收。

## 重试、升级与回滚

如果 GitHub Release 已创建，但测试、网络或 GHCR 推送失败，在 Actions → Docker image → Run workflow 中选择 `main`，将 `release-tag` 填为已有的 `v0.1.0`。工作流会检出该标签、重新验证并发布；留空只检查当前所选分支，不发布。不要移动已有版本标签来发布不同代码。

若镜像已推送而签名失败，该镜像可能已可拉取，但发布尚未完成。优先在原运行中 Re-run failed jobs，对同一 digest 补签并验证；手动重新运行完整发布会重建镜像，digest 可能改变，应重新验证最终摘要里的 digest。

部署时在 `.env` 或 Portainer 中指定：

```dotenv
AGENTBRIDGE_IMAGE=ghcr.io/maxtan330/agent-bridge:0.1.0
```

```sh
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d
```

升级/回滚时替换为已发布的目标版本，保持 Compose 项目名及数据卷一致。源码构建方式仍使用原 `compose.yaml`。
