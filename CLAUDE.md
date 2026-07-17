# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

NAPM 升级服务 — an upgrade orchestration service for the NAPM (观枢·智维) platform. It manages lifecycle operations (version tracking, backups, rollout) across all component types: **OpenClaw** (CLI/AI runtime), **frontend** (web admin panel), **skills** (plugins in `~/.openclaw/workspace/skills/`), and **full-stack** (all-in-one).

## Commands

| Command | Description |
|---|---|
| `npm start` | Start the service (`node src/index.js`) |
| `npm run dev` | Start with watch mode (`node --watch src/index.js`) |
| `npm test` | Run 54 tests — `node --test test/**/*.test.js` (Node.js native test runner) |
| `npm run db:init` | Initialize the DB schema and seed component registry (`node src/database/init.js`) |
| `node tools/package.js --help` | CLI 打包签名工具 |

## 远端开发测试服务器

| 项目 | 值 |
|---|---|
| 地址 | `101.254.114.237` |
| 用户名 | `netinside` |
| 密码 | `netinside_123` |

SSH 连接: `ssh netinside@101.254.114.237`

## Architecture

```
src/
├── index.js                 # Express app bootstrap, middleware wiring, route mounting
├── config.js                # All config from env vars (dotenv), port 18900 default
├── database/
│   ├── connection.js        # Singleton SQLite (better-sqlite3), WAL mode, FK enforcement
│   ├── schema.js            # Idempotent DDL — all CREATE TABLE/INDEX use IF NOT EXISTS
│   ├── seed.js              # Auto-discovers components on first run; skips if data exists
│   └── init.js              # Standalone CLI entry: runs schema + seed, then exits
├── middleware/
│   ├── auth.js              # Reads X-Authenticated-User header set by Caddy reverse proxy
│   ├── logger.js            # Structured JSON access log
│   └── errorHandler.js      # Unified JSON error responses + createError() helper
├── routes/
│   ├── health.js            # GET /health
│   ├── status.js            # GET /api/v1/upgrade/status
│   ├── validate.js          # POST /api/v1/upgrade/validate (upload + validate + save ZIP)
│   └── upgrade.js           # POST /execute, GET /tasks, GET /tasks/:id, POST /rollback, GET /backups
├── services/
│   ├── UpgradeValidator.js  # ZIP 解析 → SHA256 校验 → RSA 签名 → 兼容性检查 → 影响评估
│   ├── UpgradeEngine.js     # 任务状态机 + 步骤追踪 + 文件锁 + 自动/手动回滚
│   ├── SkillUpgrader.js     # 单 Skill: 原子替换 + 热加载 (touch SKILL.md)
│   ├── BundleUpgrader.js    # 批量 Skill: 合并替换 + 并行冒烟 + 自动注册新 Skill
│   ├── OpenClawUpgrader.js  # OpenClaw: systemctl restart + 健康轮询 (60s) + JSON 配置合并
│   ├── FrontendUpgrader.js  # 前端: 静态文件原子替换 + 首次部署 + HTTP 冒烟
│   ├── FullStackUpgrader.js # 全栈: 委派模式 → OpenClaw→Skills→Frontend → 级联回滚
│   ├── MaintenanceMode.js   # 维护模式: 内存 + DB 标志，支持重启恢复
│   └── BackupCleaner.js     # node-cron 每天 02:00 清理旧备份 (保留 N 个版本)
├── tools/
│   └── package.js           # CLI 打包签名工具 (skill/bundle/openclaw/frontend)
└── config/
    ├── public.pem           # RSA 公钥 (可提交)
    └── private.pem          # RSA 私钥 (gitignored, 仅用于测试签名)
```

## Design document

The detailed design specification is at [docs/2026-07-16-NAPM升级模块详细设计.md](docs/2026-07-16-NAPM升级模块详细设计.md). This is the authoritative reference for all API contracts, upgrade flows, and database schema. All implementation decisions should align with it.

## Implementation progress

See design document §17 for the full phased plan.

```
Phase 1 — 基础设施           ████████████ ✅
Phase 2 — Skill 升级         ████████████ ✅
Phase 3 — OpenClaw + 前端    ████████████ ✅
Phase 4 — 全栈 + 高级        ████████████ ✅
Phase 5 — 管理前端           ⬜ 未开始
```

### Phase 1: 基础设施
| # | 任务 | 状态 |
|---|---|---|
| 1.1 | OpenClaw systemd 化 (需服务器端操作) | ⬜ |
| 1.2 | Express 框架 + 中间件 | ✅ |
| 1.3 | SQLite Schema (5 tables + 7 indexes) | ✅ |
| 1.4 | 组件自动发现 (seed) + Config | ✅ |
| 1.5 | GET /health, GET /status | ✅ |
| 1.6 | Caddy 路由配置 (需服务器端操作) | ⬜ |

### Phase 2: Skill 升级
| # | 任务 | 文件 |
|---|---|---|
| 2.1 | 包校验器 | `UpgradeValidator.js` |
| 2.2 | POST /validate API | `routes/validate.js` |
| 2.3 | 单 Skill 升级引擎 | `SkillUpgrader.js` |
| 2.4 | 批量 Skill 升级引擎 | `BundleUpgrader.js` |
| 2.5 | 异步任务引擎 | `UpgradeEngine.js` |
| 2.6 | POST /execute, GET /tasks | `routes/upgrade.js` |
| 2.7 | POST /rollback, GET /backups | `routes/upgrade.js` |

### Phase 3: OpenClaw + 前端
| # | 任务 | 文件 |
|---|---|---|
| 3.1 | 维护模式管理 | `MaintenanceMode.js` |
| 3.2 | OpenClaw 升级引擎 | `OpenClawUpgrader.js` |
| 3.3 | 前端升级引擎 | `FrontendUpgrader.js` |
| 3.4 | 回滚逻辑完善 | engine-level |

### Phase 4: 全栈 + 高级
| # | 任务 | 文件 |
|---|---|---|
| 4.1 | 全栈升级引擎 | `FullStackUpgrader.js` |
| 4.2 | 备份定时清理 | `BackupCleaner.js` |
| 4.3 | CLI 打包签名工具 | `tools/package.js` |

---

## API 路由总览

| Method | Path | Description |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/v1/upgrade/status` | 组件清单 + 维护模式状态 |
| POST | `/api/v1/upgrade/validate` | 上传 ZIP → 全校验 → 创建 pending 任务 → 保存包文件 |
| POST | `/api/v1/upgrade/execute` | 执行 pending 任务 (202 async, body: `{task_id}`) |
| GET | `/api/v1/upgrade/tasks` | 任务列表 (`?status=&component=&limit=&offset=`) |
| GET | `/api/v1/upgrade/tasks/:id` | 任务详情 + 步骤进度 + `progress_percent` |
| POST | `/api/v1/upgrade/rollback` | 手动回滚 (202 async, body: `{component, target_version?}`) |
| GET | `/api/v1/upgrade/backups` | 备份列表 (`?component=`) |

## 升级器对比矩阵

| 特性 | SkillUpgrader | BundleUpgrader | OpenClawUpgrader | FrontendUpgrader | FullStackUpgrader |
|---|---|---|---|---|---|
| 替换策略 | 单目录 swap | 合并 swap | dist/ 覆盖 | dist/ swap | 委派子升级器 |
| 备份范围 | 单个 Skill | 整个 skills/ | npm 全局包+配置 | 静态目录 | 全部组件 |
| 生效方式 | touch SKILL.md | touch 全部 SKILL.md | systemctl restart | 无 (静态文件) | 混合 |
| 冒烟测试 | 文件存在性 | 并行检查全部 | HTTP 健康轮询(60s) | HTTP curl | 逐组件验证 |
| 维护模式 | ❌ | ❌ | ✅ | ❌ | ✅ |
| 回滚 | 单目录恢复 | 整目录恢复 | 目录恢复+重启 | 目录恢复 | 级联回滚 |
| 首次部署 | ❌ | ✅ 自动注册 | ❌ | ✅ 自动注册 | ✅ |

## UpgradeEngine 状态机

```
pending → running → success
                  → failed (pre_backup 失败)
                  → rolling_back → rolled_back
                                 → failed (回滚失败 → 标记 degraded → 人工介入)
```

- **步骤追踪**: `steps` JSON 数组，每步记录 `{step, status, message, started_at, finished_at}`
- **并发锁**: `proper-lockfile`，按组件粒度 (`UPGRADE_LOCK:<name>`)，Windows 降级为 no-op
- **自动回滚**: backup 之后的任何步骤失败 → 自动 `upgrader.rollback()` + `upgrader.smokeTest()`
- **依赖注入**: 所有 upgrader + engine 支持 `{db, config}` 构造参数，测试可用临时目录

## 关键设计决策

- **Auth model**: Caddy Basic Auth → `X-Authenticated-User` header → 提取 operator，升级服务自身不做认证
- **Database**: SQLite 单文件 (`better-sqlite3`)，WAL 模式，5 张表：`components`, `upgrade_tasks`, `backups`, `audit_log`, `schema_version`
- **Seed**: 仅在 `components` 表为空时执行。扫描 `NAPM_UPGRADE_SKILLS_ROOT`，从 `VERSION` 或 `package.json` 读版本
- **Logging**: 结构化 JSON on stdout，无文件日志
- **包校验链路**: ZIP → Manifest 解析 → 字段校验 → SHA256 逐文件比对 → RSA 签名验证 → 兼容性检查 → 影响评估
- **签名机制**: RSA-SHA256 over canonical digest (`{path}:{sha256}\n` per file, sorted)。测试密钥对在 `config/`
- **semver 兼容**: 自动规范化逗号分隔约束 `>=1.2.0, <2.0.0` → `>=1.2.0 <2.0.0`
- **原子替换**: 所有 upgrader 使用 `cp → .new → mv` 模式，同文件系统的 `rename` 是原子的
- **文档先行**: 每完成一部分工作同步输出文档，不等全部做完再补

## 测试覆盖

| 文件 | 用例 | 覆盖内容 |
|---|---|---|
| `test/upgrade-validator.test.js` | 20 | 包校验: 正常/签名/哈希/版本/兼容性/边界 |
| `test/upgrade-engine.test.js` | 13 | 状态机/Skill 各步骤/自动回滚/手动回滚/任务查询 |
| `test/bundle-upgrader.test.js` | 8 | 批量升级/合并替换/包外保留/预检失败/空bundle |
| `test/platform-upgrader.test.js` | 7 | Frontend 升级+首次部署+回滚, OpenClaw preCheck+backup |
| `test/fullstack-cleaner.test.js` | 6 | FullStack 预检+备份, BackupCleaner 清理+不删除, CLI help |
| **总计** | **54** | `npm test` — 54 pass / 0 fail, ~40s |

## 升级类型 → Upgrader 映射

| `manifest.type` | Upgrader | 路由 status |
|---|---|---|
| `skill-single` | `SkillUpgrader` | ✅ |
| `skill-bundle` | `BundleUpgrader` | ✅ |
| `openclaw` | `OpenClawUpgrader` | ✅ |
| `frontend` | `FrontendUpgrader` | ✅ |
| `full-stack` | `FullStackUpgrader` | ✅ |
