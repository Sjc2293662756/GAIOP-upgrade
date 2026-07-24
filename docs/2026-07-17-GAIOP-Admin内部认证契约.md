# GAIOP-Admin 内部认证契约

## 目的

升级服务是 ISO 内部的受限组件。GAIOP-Admin 浏览器页面只能调用 Admin BFF，不能直接访问升级服务或获得服务器目录、内部地址和服务令牌。

## 配置

- 升级服务读取 GAIOP_UPGRADE_INTERNAL_TOKEN；
- Admin BFF 使用相同令牌调用升级服务；
- 部署侧以安全文件或环境变量注入，仓库、页面、接口响应和日志均不得保存或返回令牌明文。

## 请求头

当令牌已配置时，除 health 外的接口必须携带：

- X-GAIOP-Upgrade-Token
- X-GAIOP-Upgrade-Actor

服务对令牌进行常量时间比较；缺少或不匹配时返回 401 UPGRADE_INTERNAL_AUTH_REQUIRED。缺少操作者时返回 400 UPGRADE_ACTOR_REQUIRED。

## 兼容与部署

令牌为空时，保留既有 Caddy 反向代理注入 X-Authenticated-User 的本地开发兼容方式。正式 ISO 部署必须配置令牌，并将升级服务绑定到内部网络；健康检查可以访问 health，但不能据此访问升级功能。
