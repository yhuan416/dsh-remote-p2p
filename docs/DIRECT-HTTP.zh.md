# 无 ssh 的 direct + grant 拓扑（2026-11-23 落地）

## 结论

DSH web 可以被局域网其它机器直接访问，前提是**绑定具体网卡 IP**；没有"请求源 IP"白名单限制。
我们已把 n100 的两个 dsh 实例绑到 `192.168.4.50`，hub 的远端全部改成 `direct + auth: grant`，**ssh 隧道清零**。

## DSH 的硬约束（源码 + 实测）

| 约束 | 行为 | 应对 |
|---|---|---|
| 禁止 wildcard 绑定 | `dsh web --host` 只接受具体 IPv4/IPv6 字面量，`0.0.0.0` 被拒绝 | 在 profile 的 `webserver.host` 写具体网卡 IP（如 `192.168.4.50`）|
| `/api` 的 Host fence | 只接受 loopback、监听绑定 IP 的字面量、或 `--trusted-host` 声明的 authority | 用绑定 IP 访问即可；用域名访问要加 `--trusted-host <域名>` |
| 源 IP 检查 | **没有**（dsh 各包无 remoteAddress 判断）；无 cookie 时仍 401 | 认证靠 token→cookie 与 grant 签名 |

实测（n100 临时实例绑 `192.168.4.50:3098`，WSL 访问）：`/?token=` 303、根 200、**WS upgrade 101**、无 cookie 401。

## 当前拓扑

```
hub (WSL, 127.0.0.1:3080)
  ├─ remote n100            direct → http://192.168.4.50:3080  auth grant  (nodeId 8b9942205cf854dd)
  └─ remote mining-mcp-kit  direct → http://192.168.4.50:3084  auth grant  (nodeId d9bd95c8edc63470)
n100 dsh-web    : 192.168.4.50:3080  grantPolicy strict
n100 mcp-kit    : 192.168.4.50:3084  grantPolicy strict
```

- 双方 nodeId/公钥已互相固定：n100 侧在 `~/.dsh/peers.json` / `~/.dsh-instances/mcp-kit/peers.json` 批准了 hub 公钥；
  hub 侧 `remote-hosts.json` 每条带 `peerPublicKey` + `paired: true`。
- 明文 token 不再跨机传输：cookie 由对端进程内用 `authenticatedUrl` 自取。

## 配置要点

n100（两个 profile 的 `cordis.patch.yml`）：

```yaml
- id: webserver
  config:
    host: 192.168.4.50
    port: 3080        # 或 3084
- id: remote-p2p
  config:
    grantPolicy: strict
```

hub（`~/.dsh/remote-hosts.json`）：

```json
{"id":"n100","transport":"direct","upstream":"http://192.168.4.50:3080","auth":"grant",
 "nodeId":"8b9942205cf854dd","peerPublicKey":"<对端公钥>","paired":true}
```

## 注意

1. 绑 LAN IP 后 `127.0.0.1:<port>` **不再监听**：本机健康检查/脚本里的 `curl 127.0.0.1:3084` 要换成 LAN IP。
2. 暴露面扩大：DSH 启动会打印 "restrict this port to a trusted proxy or network"；如需收紧，用防火墙只放行 hub 的 IP。
3. 换网卡 IP / 换主机时，`peerPublicKey` 不受影响（身份跟着 DSH_HOME 走），但 upstream/authority 要更新。
4. 若以后用 DNS 名而非 IP 访问，需 `--trusted-host <域名>`，且 cookie 的 authority 会变成域名——届时要让 identity/exchange 按请求 Host 取 authority（当前实现按绑定 origin）。
