# GAIOP-upgrade

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

## 验证

```bash
npm ci --omit=dev
npm test
```

2026-07-27 的 237 适配、部署、失败回滚和验收详情记录在
`GAIOP-Admin/docs/05-部署运维/2026-07-27-237系统升级模块适配与正式部署记录.md`。
