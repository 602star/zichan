# Cloudflare + 1Panel 反向代理与真实 IP

适用于“浏览器 → Cloudflare 代理 → 1Panel OpenResty → `http://127.0.0.1:34567`”的部署。下面保留现有上游地址和转发设置，补充可信真实 IP 恢复，并覆盖传给业务服务的 `X-Forwarded-For`。

## 在 1Panel 修改反向代理

1. 先备份当前站点的反向代理配置。
2. 找到下面这类 `location ^~ /` 配置，将其整体替换为下方内容。若同一 `location` 已有 realip 指令，应合并为一份。
3. 在 1Panel 中检查配置；只有实际 OpenResty 的 `nginx -t` 通过后才保存重载。出现 `unknown directive` 时先核对 realip 模块，不能带着错误重载。
4. 重新登录记账应用和管理后台，按下文核对日志及实际运行版本。

真实 IP 指令可放在 `http`、`server` 或 `location` 中。这份配置直接放入反代编辑器的 `location`，不要求额外创建文件或猜测容器内的 include 路径。

## 可直接粘贴的配置

```nginx
location ^~ / {
    # 只信任 Cloudflare 节点提供的真实访客 IP
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;

    set_real_ip_from 2400:cb00::/32;
    set_real_ip_from 2606:4700::/32;
    set_real_ip_from 2803:f800::/32;
    set_real_ip_from 2405:b500::/32;
    set_real_ip_from 2405:8100::/32;
    set_real_ip_from 2a06:98c0::/29;
    set_real_ip_from 2c0f:f248::/32;

    real_ip_header CF-Connecting-IP;
    real_ip_recursive on;

    proxy_pass http://127.0.0.1:34567;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header REMOTE-HOST $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_http_version 1.1;

    add_header X-Cache $upstream_cache_status;
    add_header Cache-Control no-cache;
    proxy_ssl_server_name off;
    proxy_ssl_name $proxy_host;
}
```

## 为什么这样配置

- `real_ip_header CF-Connecting-IP` 仅采信 `set_real_ip_from` 中的来源，把 `$remote_addr` 恢复成访客地址。
- `X-Forwarded-For $remote_addr` 随后覆盖客户端带入的代理链，避免业务服务把 Cloudflare 节点误当成访客。仅把 `$proxy_add_x_forwarded_for` 改掉而不先恢复真实 IP，仍可能转发节点地址。
- OpenResty 的真实 IP 信任列表和业务容器的 `TRUSTED_PROXIES` 是两层配置。前者填 Cloudflare 网段；后者限定到实际连接业务容器的 OpenResty／网桥对端，不能拿日志里的两个 Cloudflare 节点地址代替。后端端口应限制为代理可访问。
- 这里保留 `$scheme`，适用于 Cloudflare 使用 **Full (strict)**、源站为 HTTPS 的场景。若源站走 HTTP 或还有 Tunnel、Worker、其他反代，应先核对完整协议与地址链，不能直接把所有代理头都设为可信。

不要把真实 IP 信任列表扩大成 `0.0.0.0/0`、`::/0` 或整个私网，也不要无条件转发任意请求的 `$http_cf_connecting_ip`。官方网段按 2026-11-23 核对，后续需随 Cloudflare 官方清单更新。

## 保存后的验证

1. 从公网域名打开 `/api/health`，核对实际运行版本。0.7.2 包含登录取消 IP 硬绑定的修复；仅修改基础镜像标签不一定替换持久化的 `runtime/current`，升级按[生产签名包自更新](production-self-update.md)操作。
2. 分别登录记账应用与管理后台，查看新请求的日志。`ip` 应为真实访客出口地址；0.7.2 的 `peerIp` 为直接连接应用的代理地址，`ipSource` 在采信合法 XFF 时为 `trusted_xff`。
3. 正常跨 IP 的 OPAQUE 登录继续校验密码和两步验证，来源变化只记录信息事件。超时为 `LOGIN_STATE_EXPIRED`，状态失效为 `LOGIN_STATE_INVALID`，错误证明为 `INVALID_CREDENTIALS`。

| 现象 | 优先核对 |
| --- | --- |
| 日志仍显示 Cloudflare 节点地址 | 配置是否在实际 OpenResty 生效、访客 IP 头是否存在、是否还有中间代理 |
| 日志变成回环／网桥地址 | 应用的 `TRUSTED_PROXIES` 是否包含实际直连代理 |
| `SESSION_ORIGIN_REJECTED` 或 HTTPS 要求错误 | 公共 Host、实际协议及可信 `X-Forwarded-Proto`；与登录 IP 变化分开排查 |
| `Session refresh failed` | 展开 `detail.reason`，区分 Cookie 缺失、会话过期、撤销及凭据不匹配 |

## 隔离验证与回退

可在有 Docker 的 Linux 测试机运行 `bash tools/deployment/test-cloudflare-realip.sh`。脚本校验本文可粘贴配置与网段模板一致，并在无外部网络的容器内验证配置语法、可信 IPv4／IPv6、非可信来源伪造头及非法 IP，不重载现有站点。该测试已在指定 Linux 测试机通过，不能代替实际公网链路验收。

如果实际站点检查不通过或改动后出现问题，恢复保存前的反代配置，检查通过后再重载；不需要删除业务数据、服务器身份或账本来回退反代设置。

官方依据：[Nginx realip 模块](https://nginx.org/en/docs/http/ngx_http_realip_module.html)、[Cloudflare IPv4](https://www.cloudflare.com/ips-v4)、[Cloudflare IPv6](https://www.cloudflare.com/ips-v6)、[恢复真实访客 IP](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)。也可使用[独立网段模板](../../scripts/production/cloudflare-realip.conf)，在已确认可读路径后于 `server` 或 `location` 中 include。
