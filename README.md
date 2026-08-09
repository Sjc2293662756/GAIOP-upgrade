# GAIOP-upgrade

> 当前详细文档入口：[docs/README.md](docs/README.md)；237生产映射与安全边界见[2026-07-30生产适配基线](docs/2026-07-30-GAIOP升级模块237生产适配基线.md)。`docs` 中2026-07-16至17的NAPM路径和Caddy直连方案仅保留为历史设计。

GAIOP 系统升级模块。浏览器不直接访问本服务；正式链路为：

```text
GAIOP Admin 页面 -> Admin BFF -> 回环地址上的 GAIOP-upgrade
```

## 生产边界

- 生产环境必须配置 `GAIOP_UPGRADE_INTERNAL_TOKEN`，缺少时拒绝启动。
- 默认只监听 `127.0.0.1`。
- `/health` 用于本机存活检查，其他接口需要内部 Token 和操作者身份。
- Admin 前端目标必须是独立 `dist` 目录，不能指向包含 BFF 的应用根目录。
- OpenClaw 重启只能通过固定的用户级 systemd 辅助程序执行。
- ZIP 包会校验签名、清单、组件名称、声明文件、重复条目和路径穿越。
- 成功任务删除上传包；失败或回滚任务保留包供排查。
- 独立留存清理 one-shot 与 systemd timer 只管理升级服务自己的 `staging`、严格 UUID 升级包和受控回滚备份；生产自动删除总开关默认关闭。
- `failed`、`rolled_back` 包至少保留 7 天；备份同时满足超过 90 天且超出每组件最近 5 个可用备份组时才可清理。

## 237 运行映射

| 对象 | 路径或服务 |
|---|---|
| 服务代码 | `/opt/gaiop/upgrade` |
| 状态数据库 | `/var/lib/gaiop/upgrade/upgrade.db` |
| 包暂存 | `/var/lib/gaiop/upgrade/staging` |
| 备份根 | `/var/backups/gaiop/upgrade` |
| Admin 前端 | `/opt/gaiop/admin/dist` |
| OpenClaw | `/home/netinside/.npm-global/lib/node_modules/openclaw` |
| Skills | `/home/netinside/.openclaw/workspace/skills` |
| Gateway 服务 | `netinside` 用户级 `openclaw-gateway.service` |
| 升级服务 | `gaiop-upgrade.service` |

systemd 单元、环境变量示例和固定 Gateway 辅助程序位于 `deploy/`。正式环境文件不得提交到 Git。
旧的进程内定时备份清理已移除；自动清理只允许由 `gaiop-upgrade-retention-cleanup.timer` 触发，且首次真实启用前必须完成生产只读候选核查并单独确认。

## 验证

```bash
npm ci --omit=dev
npm test
```

2026-07-27 的 237 适配、部署、失败回滚和验收详情记录在
`GAIOP-Admin/docs/05-部署运维/2026-07-27-237系统升级模块适配与正式部署记录.md`。
