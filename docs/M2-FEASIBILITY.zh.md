# M2（节点身份 + 签名 token）可行性确认

> 2026-11-23。目标：把"节点互相关联"从 ssh 读明文 token 变成"节点身份 + 短时签名授权"，为 M3 出站通道铺路。
> 结论：**可行**，关键三项能力已在本机真实 dsh 进程上实测。

## 1. 实测证据（`GET /api/remote-hosts/self-check`）

临时 DSH_HOME 起一个 dsh web（0.2.2-rc.5，插件 0.1.2），调用探针返回：

```json
{ "ed25519": true, "fingerprint": "ee885c15d3b4d9cb",
  "launchTokenAvailable": true, "cookieExchange": true, "detail": "status 303", "webPort": 3097 }
```

三项分别证明：

| 能力 | 探针做了什么 | 意义 |
|---|---|---|
| `ed25519` | `generateKeyPairSync('ed25519')` → `sign` → `verify` → `sha256(spki)[:16]` 作 nodeId | 节点身份/签名授权可用，无外部依赖 |
| `launchTokenAvailable` | `ctx.connection.authenticatedUrl(origin + '/')` 里能取到 token | 插件进程内有官方途径拿到本进程 launch token（remote-agent 一直这么用）|
| `cookieExchange` | 在**服务端** `fetch(authenticatedUrl)`（redirect manual）→ 收到 303 + `Set-Cookie` | **不需要把明文 token 交给对端**：后端插件可以自己换取 DSH cookie，再把 cookie 返给已配对的 peer |

## 2. 设计（最小可用 M2）

### 2.1 节点身份

`$DSH_HOME/node-identity.json`（0600，首次启动生成）：

```json
{ "version": 1, "nodeId": "<sha256(spki)前16位hex>", "publicKey": "<spki base64>",
  "privateKey": "<pkcs8 base64>", "createdAt": 1795403710169 }
```

身份文件（沿用 `remote-agent.json` 路径）增加 `nodeId` / `publicKey` / `grant`；`token` 保留一个版本做兼容，
之后可以只剩 grant。

### 2.2 授权（grant）

`grant = base64url(payload) + '.' + base64url(ed25519(payload))`，payload：

```json
{ "iss": "<nodeId>", "aud": "<peerNodeId>|*", "scope": ["session-exchange"],
  "iat": 1795403710, "exp": 1795404010, "nonce": "<随机>" }
```

- TTL 5 分钟、一次性 nonce、scope 只允许"换 cookie"；
- 对端用 **配对时固定的公钥** 验签；未配对节点拒绝（显式配对，不是 TOFU）。

### 2.3 后端端点（同一插件的 backend 能力）

| 端点 | 作用 |
|---|---|
| `GET /api/remote-p2p/identity` | 公开：`nodeId` / `publicKey` / 版本 / webPort（不含 token）|
| `POST /api/remote-p2p/exchange` | 入参 `{grant, from}`：验签 → 校验 aud/exp/nonce → 服务端换 cookie → 返回 `Set-Cookie` 值 |
| `POST /api/remote-p2p/pair/*` | 配对（见 2.4）|

### 2.4 配对与 registry

`$DSH_HOME/peers.json`：`{peers:[{nodeId, publicKey, label, transport, addedAt, lastSeen}]}`；
启动时读旧 `remote-hosts.json` 并迁移（ssh 条目按 pubkey 未知处理，首次 exchange 时 TOFU 或提示确认）。

配对流程（M2 用 CLI/配置，M4 再做 UI）：一方生成短码并打印自己的 nodeId/pubkey → 另一方输入短码提交
`/api/remote-p2p/pair/request` → 双方落库公钥。**加密部分已具备，剩余是 UX。**

### 2.5 viewer 侧

- connector 抽象：`ssh-tunnel`（现状）+ `direct-http`（无 ssh，只要 HTTP 可达）；
- 取 cookie 顺序：`/identity` + `/exchange`（签名授权）→ 失败回退旧 `tokenFile`（ssh）路径；
- 配置卡片展示：nodeId/指纹、peer 的 paired 状态、每个 peer 的 transport。

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| DSH 服务端 cookie 交换接口漂移（`authenticatedUrl` / 303）| 已有 remote-agent 依赖同一接口；`self-check` 作为回归探针，升级 dsh 后先跑它 |
| 多 viewer 并发 exchange | 每次返回独立 cookie；nonce 一次性、TTL 短 |
| 时钟偏差 | grant 允许 ±60s，失败时回退旧路径 |
| 配对 UX 未做 | M2 先支持"配置/CLI 配对"，UI 放 M4；旧 ssh 路径保留一个版本 |
| 兼容 | `remote-hosts.json`、`remote-agent.json`、ssh 传输都继续可用 |

## 4. 工作量与验收

| 项 | 估时 |
|---|---|
| 身份生成/签名/验签 + grant + `/identity` `/exchange` | 0.5–1 天 |
| peers.json + 配对（CLI/配置）+ 旧数据迁移 | 0.5 天 |
| viewer connector（direct-http + 签名取 cookie + 回退）| 0.5 天 |
| 测试（离线 + 两实例互连冒烟）+ 文档 + 配置卡片显示 | 0.5 天 |

**验收标准**：
1. 两台机器/两个 DSH_HOME，`direct-http` 配对后能打开对方面板；
2. 全程不读取对端明文 token（不看 `remote-agent.json` 的 token 字段也能工作）；
3. 撤销 peer（删公钥/记录）后 exchange 立即失败；
4. 旧 ssh 远端配置不受影响。
