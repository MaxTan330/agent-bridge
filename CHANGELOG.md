# Changelog

Release Please 根据 Conventional Commits 在发布 PR 中维护此文件，版本号与 `package.json` 同步。

首个版本为 `package.json` 中的 `0.1.0`，对应 Git 标签 `v0.1.0` 和镜像标签 `0.1.0`。以下为接入版本管理时的能力记录，正式发布条目由 Release Please 在发布 PR 中生成。

## [0.2.0](https://github.com/MaxTan330/agent-bridge/compare/v0.1.0...v0.2.0) (2026-11-12)


### Features

* improve task scheduling, result recovery and deployment configuration ([e045f80](https://github.com/MaxTan330/agent-bridge/commit/e045f808220f48d9810d07a401c76a8cadfb67d8))

## 0.1.0 (2026-11-12)


### Features

* add queued Claude tasks and signed versioned releases ([f54aa17](https://github.com/MaxTan330/agent-bridge/commit/f54aa172382e18401c1308a80a21b0a738829db5))


### Bug Fixes

* **ci:** upgrade release-please to Node 24 action runtime ([8caa1af](https://github.com/MaxTan330/agent-bridge/commit/8caa1af6e34d40cf44bac5ba83d10145f0a98056))

## [初始开发记录]

### Features

- 飞书扫码绑定机器人，通过 Claude ACP 执行固定工作区中的开发任务。
- 支持流式回复、会话恢复、任务状态查询、取消和执行时限配置。
- 工作区繁忙时自动按序排队，支持查看队列、取消指定等待项或清空本人队列；停止或重启后中断等待项且不自动重放。
- 默认短任务直接回复，执行超过 5 秒后通知后台处理；支持配置为 10 秒、始终回执或流式回复。
- 会话默认闲置 4 小时后换新，全局空闲时回收 Adapter 进程；保留历史结果，支持旧数据库活动时间字段升级。
- 管理命令独立于任务队列处理，队列满时仍可查询和取消；修复取消最后一个等待项时可能遗漏空闲回收的问题。
- 拆分原生能力控制、事件投影、用户问题与附件处理模块；接入原生命令列表、工具/计划/用量、任务引导和带编号的交互回答。
- 增加本人历史恢复、计划模式、模型与思考强度偏好，以及可选 MCP/执行轮数/预算配置。
- 支持有界图片与 UTF-8 文本附件输入，仅在鉴权通过且任务执行时下载；首次注册申请消息资源读取所需权限。
- 默认设置 includeCoAuthoredBy=false，并关闭提交、PR 和会话链接 attribution，保留 Git 作者身份。
- 支持源码构建 Docker 镜像，持久化项目、SQLite、飞书绑定及 Claude 配置。
- 增加 Release Please 发布 PR、GitHub Release 和按 package 版本发布 GHCR 镜像的工作流。
- 发布镜像按 digest 使用 Cosign/OIDC 签名并验证，绑定 package 版本和源码提交；运行时版本、启动日志及 `--version` 统一读取 package。
- 增加 `compose.image.yaml`，使用明确的版本镜像进行部署、升级和回滚。

### Fixes

- 修正任务终态判断：执行或输出达到限制、模型拒绝及未知结束原因不再误报完成；保存部分输出和原因，完成进程清理后继续队列。

### Documentation

- 区分本地 Node 的 `WORKSPACE_ROOT` 与 Docker 容器内固定工作区，避免示例配置误导。
- 补充宿主机项目目录挂载、Portainer 镜像部署及版本发布流程。
