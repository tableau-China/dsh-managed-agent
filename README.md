# dsh-managed-agent

[![CI](https://github.com/tableau-China/dsh-managed-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/tableau-China/dsh-managed-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> DeepSeek Harness（DSH）受管设备代理插件。
> 把「这台机器在不在管、配置有没有被改、版本是不是落后」变成平台侧可见的事实，
> 并在本机提供一个**只读**状态页。

配套的管理平台（人员 / 设备 / 注册码 / 用量 / 模型授权 / 审计）是独立服务端，不在本仓库。
本插件只依赖平台的两个 HTTP 接口，契约见下文，可对接任何同契约实现。

- 零运行时依赖（只用 Node 内置模块）
- 只上报**事实与计数**：不上报提示词、回复、文件内容、工具参数、工作区路径
- 采集是**旁路**：任何异常只记日志，绝不影响会话
- 本机只读：不提供任何修改配置或管理他人的入口

---

## 它做什么（四件事）

| # | 行为 | 说明 |
|---|---|---|
| 1 | 读设备凭据 | `~/.dsh/managed-agent.json`（0600），由平台的注册流程下发 |
| 2 | 周期上报**事实** | DSH 版本、profile patch 指纹、插件清单、机器名 |
| 3 | 按平台返回处理状态 | `pending` 待审批 / `revoked` 已吊销 / `401` 凭据失效 / 网络不可达 |
| 4 | 本地只读状态页 | `/managed-agent/v1/`（挂在 DSH 自带 WebServer 上，受浏览器门禁保护） |

**绝不做的事**：不上报提示词、回复、文件内容、工具参数、工作区路径；
不在本机判定合规（判定权在平台，见下文）；不提供任何写入口。

## 安装

插件以 DSH bundle 形式分发（`dsh.bundle.patch`），三种装法任选：

```bash
# 方式一：本地 link（开发/内网 tgz 分发均可）
#   1) 放进 profile 的依赖
#      "dsh-managed-agent": "link:/path/to/dsh-managed-agent"
#   2) 加进 profile 的 dsh.profile.bundles 列表
#   3) 建软链：ln -s /path/to/dsh-managed-agent ~/.dsh/profiles/<profile>/node_modules/dsh-managed-agent

# 方式二：从企业插件市场索引安装（DSH 官方 Discover 页）
#   profile 的 cordis.patch.yml 里配置内网索引：
#   - id: plugin-market
#     config:
#       indexes: ["http://dsh-admin.intra/api/v1/market/index.json"]

# 方式三：本地 tgz
#   npm pack && 在 profile 里 npm install /path/to/dsh-managed-agent-0.1.0.tgz
```

装好后重启 DSH，插件会在启动时上报一次，之后按 `heartbeatMinutes` 周期上报。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: managed-agent
  name: dsh-managed-agent
  config:
    enabled: true
    heartbeatMinutes: 15
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册定时器，进程内零开销 |
| `endpoint` | `''` | 平台 API 前缀；留空用凭据文件里的 `endpoint` |
| `heartbeatMinutes` | `15` | 心跳周期（分钟） |
| `deviceTokenFile` | `''` | 凭据文件；留空用 `<DSH_HOME>/managed-agent.json` |
| `patchFile` | `''` | 指纹来源；留空用 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` |
| `profile` | `desktop` | profile 名 |
| `machineLabel` | hostname | 机器显示名 |
| `dshVersion` | 自动 | 版本号；留空依次尝试宿主服务 → 环境变量 → `<DSH_HOME>/app-version` |
| `statusPath` | `/managed-agent/v1` | 本地只读状态页前缀 |
| `timeoutMs` | `10000` | 单次请求超时 |

## 实现说明：为什么不导出 `Config`

本机 DSH 的 cordis 4 在 `resolveConfig` 里是这样读插件配置的：

```js
runtime.Config["~standard"].validate(config)   // Config 必须是 Standard Schema 对象
```

写成 `export const Config = (z) => z.object(...)`（工厂函数）会让 `Config["~standard"]` 是
`undefined`，插件在**加载阶段**就抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，
DSH 插件列表里显示"异常"。官方插件（如 `@deepseek-ai/dsh-session-stats`）与
`dsh-workload-report` 都**不导出 Config**。

所以本插件把默认值与范围约束放在内部的 `normalizeConfig()`，在 `apply` 里先归一化再使用。

## 与平台的契约

### 1. 设备凭据文件（`<DSH_HOME>/managed-agent.json`，0600）

```jsonc
{
  "schema": 1,
  "endpoint": "https://dsh-admin.intra/api/v1",   // 必须带 API 前缀
  "machineId": "9f3c1a2b-…",                      // 本机安装 UUID
  "machineLabel": "dev-zhang.mbp",
  "employee": "EMP0042",
  "deviceToken": "dshdev-…",                      // 平台签发的设备令牌
  "status": "active"
}
```

> 老凭据若 `endpoint` 没有 `/api/v1`，插件会自动补齐（避免"凭据有效但一直 offline"）。

### 2. 心跳

```http
POST {endpoint}/heartbeat
Authorization: Bearer <deviceToken>
Content-Type: application/json

{
  "schema": 1,
  "kind": "dsh-managed-agent/heartbeat",
  "machineLabel": "dev-zhang.mbp",
  "dshVersion": "0.2.1-rc.3",
  "patchFingerprint": "sha256:…",
  "plugins": [{ "name": "dsh-managed-agent", "version": "0.1.0" }],
  "reportedAt": "2026-10-28T…Z"
}
```

平台返回：

```jsonc
{ "ok": true, "status": "active", "employee": "EMP0042", "compliance": "ok" }
```

| 平台返回 | 插件行为 |
|---|---|
| `200` | 记 `ok`，清空待发快照 |
| `403 {"error":"pending"}` | 记 `pending`，**不清凭据**（批准后自动恢复） |
| `403 {"error":"revoked"}` | **清除本地令牌**（文件保留工号/机器信息用于展示），停止上报 |
| `401` | 记 `unauthorized`，保留待发，提示重新注册 |
| 其它 / 网络不可达 | 记 `offline`，把**最新一份**心跳写入 `managed-agent-pending.json`，下周期补发 |

> 为什么只保留最新一份、而不是事件队列：心跳是**状态快照**，不是事件流。
> 重放三小时前的快照只会把 `lastSeenAt` 写成过去时，让平台误判"这台机器三小时前还活着"。

## 合规判定为什么在平台侧

| 结果 | 判定依据（平台） |
|---|---|
| `ok` | 指纹与基线一致、版本达标 |
| `drifted` | 指纹 ≠ 基线（基线 = 平台统一值，或该设备首次心跳） |
| `outdated` | `dshVersion` < 平台要求的最低版本 |
| `revoked` | 设备被吊销 |

插件只把平台返回的 `compliance` **原样展示**。理由：客户端能改，客户端永远不是判定方。
这是"配置漂移可被发现（发现≠阻止，是证据不是边界）"的落地方式。

## 本地状态页

- `GET /managed-agent/v1/` → HTML（只读）
- `GET /managed-agent/v1/status` → JSON
- 其它方法 → `405 read-only`

显示：工号、机器 ID、平台地址、最后上报时间、上报结果、合规状态、DSH 版本、
patch 指纹前 23 位、插件数、待发心跳。**没有**任何修改入口。

## 自检

```bash
node test/verify.mjs        # 25 项单元检查，不需要 DSH、不需要平台、不需要外网
```

可选集成检查（连真实平台跑一次心跳）：

```bash
MANAGED_AGENT_PLATFORM=http://127.0.0.1:8788/api/v1 \
MANAGED_AGENT_TOKEN=dshdev-… \
node test/verify.mjs
```

CI 在 Node 22 / 24 上跑单元检查（见 `.github/workflows/ci.yml`）。

## 已知限制

1. **没有 React 设置页**：状态页由宿主直接输出 HTML（零构建、零依赖）。
   要做进 DSH 设置界面需要 `dsh.client` + 前端打包，属后续版本。
2. **插件清单**取 profile 的 `bundles + dependencies` 元数据，不是运行时加载器快照。
3. **不含用量**：用量由另一条采集通道负责（`dsh-usage-telemetry`），本插件只报状态。
4. 待审批 / 吊销的提示只写日志与状态页，未做桌面通知。
5. DSH 没有稳定的版本服务，`dshVersion` 依赖部署脚本写入 `<DSH_HOME>/app-version`；
   读不到时报 `unknown`，平台不会因此误判"版本落后"。

## License

MIT © XILEJUN
