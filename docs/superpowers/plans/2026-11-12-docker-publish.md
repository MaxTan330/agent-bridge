# Docker publishing implementation plan

**Goal:** Build and publish AgentBridge to GHCR using GitHub Actions, and document image deployment alongside source deployment.

**Architecture:** Release Please maintains package.json, changelog and its manifest through release PRs. Merging creates a GitHub Release and directly calls the reusable image workflow with the exact release tag. Verify all version records, run type checking and tests, then build with the existing Dockerfile and bundle smoke check. PR/main builds do not publish. Images use the package version only, with no latest tag. Preserve source Compose and add independent image deployment with identical runtime settings.

**Tech stack:** GitHub Actions, Docker Buildx, GHCR, Node 26, pnpm.

- [x] Add Release Please, package-derived version validation and reusable image workflow; allow manual retry of existing releases.
- [x] Add image-only Compose configuration and document versions, changelog, package visibility, pull/update commands and Portainer use.
- [x] Finish workspace example clarification and host mount documentation.
- [x] Validate workflow with actionlint, parse Compose YAML, compare runtime settings, run existing checks and inspect diff. Typecheck, 106 tests, build and bundle smoke check pass. Docker execution requires a Docker-enabled host; actual GHCR publication requires pushing the workflow.

## Final release hardening

- [x] Derive runtime/CLI version from package.json and verify the bundled version independently of cwd.
- [x] Sign the Buildx digest with Cosign/OIDC in a separate job, verify workflow identity and version/revision annotations, and gate publication on main.
- [x] Document digest verification, signature failure recovery and Compose deployment selection. Final validation: 187 tests, typecheck, build, bundle smoke check, actionlint and static workflow/Compose checks passed. Real Docker publication and keyless signing remain for the first release run.
