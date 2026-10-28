/**
 * dsh-managed-agent —— 受管设备代理（Host 侧）
 *
 * 它只做四件事，全部是"旁路"：
 *   1. 读取本机设备凭据（`~/.dsh/managed-agent.json`，由 `node admin/enroll.mjs` 生成，0600）
 *   2. 周期上报**事实**：DSH 版本、patch 指纹、插件清单、机器名 —— **不上报任何对话内容**
 *   3. 按平台返回处理状态：pending（待审批）/ revoked（已吊销）/ unauthorized（凭据失效）
 *   4. 提供一个**本地只读**状态页（`/managed-agent/v1/`），显示"我在不在管、最后一次上报成功没"
 *
 * 三条不可让步的实现约束（对应方案 §7.2）：
 *   · **采集是旁路**：任何异常只记日志，绝不 throw 到宿主；绝不影响会话。
 *   · **不上报内容**：payload 里没有提示词、回复、文件内容、工具参数；连工作区路径都不带。
 *   · **不在本机做判定**：`drifted / outdated` 由**服务端**比对基线后给出，插件只显示结果。
 *     客户端能改，所以客户端永远不是判定方 —— 这是"发现≠阻止"的一致性要求。
 *
 * 为什么失败时只保留"最后一次待发心跳"，而不是事件队列：
 *   心跳是**状态快照**，不是事件流。把三小时前的心跳重放上去，只会把 lastSeenAt 写成过去时，
 *   让平台误判"这台机器三小时前还活着"。所以重放的正确语义是：**只补发最新那一份**。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'managed-agent'

/** 需要宿主提供的能力：WebServer（挂本地只读状态页） */
export const inject = ['webServer']

export const Config = (z) =>
  z
    .object({
      enabled: z.boolean().default(true),
      /** 平台 API 前缀；留空则用凭据文件里的 endpoint */
      endpoint: z.string().default(''),
      /** 心跳周期（分钟），最小 1 */
      heartbeatMinutes: z.number().min(1).max(1440).default(15),
      /** 设备凭据文件；留空用 <DSH_HOME>/managed-agent.json */
      deviceTokenFile: z.string().default(''),
      /** patch 指纹来源；留空用 <DSH_HOME>/profiles/<profile>/cordis.patch.yml */
      patchFile: z.string().default(''),
      /** profile 名，默认 desktop */
      profile: z.string().default(''),
      /** 机器显示名，默认 hostname */
      machineLabel: z.string().default(''),
      /** DSH 版本；留空尝试环境变量，再退化为 unknown */
      dshVersion: z.string().default(''),
      /** 本地只读状态页前缀 */
      statusPath: z.string().default('/managed-agent/v1'),
      /** 单次请求超时（毫秒） */
      timeoutMs: z.number().min(1000).max(60_000).default(10_000),
    })
    .describe('受管设备代理：周期上报版本/patch 指纹/插件清单，提供本地只读状态页')

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数（可单独测试）
// ─────────────────────────────────────────────────────────────────────────────

export function dshHomeOf(ctx) {
  return ctx?.get?.('dshHome') ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
}

/** 计算文件 sha256；文件不存在返回 null（不是错误：新机器可能还没渲染 patch） */
export function fingerprintFile(file) {
  try {
    if (!file || !existsSync(file)) return null
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
  } catch {
    return null
  }
}

/** 版本比较：只比较数字段，`0.2.1-rc.3` vs `0.2.0` → 1 */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** 读 profile 的插件清单（名称 + 版本）。只读元数据，不碰任何会话内容。 */
export function readPluginList(profileDir) {
  try {
    const pkgFile = join(profileDir, 'package.json')
    if (!existsSync(pkgFile)) return []
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const deps = Object.entries(pkg.dependencies ?? {}).map(([depName, version]) => ({
      name: depName,
      version: String(version).replace(/^link:/, 'link:'),
    }))
    const bundles = (pkg.dsh?.profile?.bundles ?? []).map((bundle) => ({ name: bundle, version: 'bundle' }))
    return [...bundles, ...deps]
  } catch {
    return []
  }
}

/**
 * 组装本次上报的"事实"。
 * 注意这里**没有**工作区路径、会话 id、提示词 —— 这是合规承诺，不是遗漏。
 */
/**
 * 解析 DSH 版本。
 * 插件运行在宿主进程里，但官方没有稳定的"版本服务"，所以按可靠性排序兜底：
 *   1. 配置显式指定（最稳，部署脚本可以注入）
 *   2. 宿主可能提供的服务（dshVersion / appVersion）
 *   3. 环境变量（DSH_VERSION / DSH_APP_VERSION）
 *   4. `<DSH_HOME>/app-version` 文件 —— **部署脚本在安装时写入**，这是推荐的长期做法
 * 全都拿不到就报 unknown；平台侧不会因此误判"版本落后"。
 */
export function resolveDshVersion({ ctx, config, home }) {
  if (config.dshVersion) return config.dshVersion
  for (const key of ['dshVersion', 'appVersion']) {
    const value = ctx?.get?.(key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const env = process.env.DSH_VERSION || process.env.DSH_APP_VERSION
  if (env && env.trim()) return env.trim()
  try {
    const file = join(home, 'app-version')
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      if (text) return text
    }
  } catch { /* 忽略 */ }
  return 'unknown'
}

export function collectFacts({ ctx, config, home }) {
  const profile = config.profile || process.env.DSH_PROFILE || 'desktop'
  const profileDir = join(home, 'profiles', profile)
  const patchFile = config.patchFile || join(profileDir, 'cordis.patch.yml')
  return {
    schema: 1,
    kind: 'dsh-managed-agent/heartbeat',
    machineLabel: config.machineLabel || hostname().replace(/\.local$/, ''),
    dshVersion: resolveDshVersion({ ctx, config, home }),
    patchFingerprint: fingerprintFile(patchFile),
    patchFile: config.patchFile ? resolve(config.patchFile) : null,
    plugins: readPluginList(profileDir),
    reportedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 凭据与待发心跳
// ─────────────────────────────────────────────────────────────────────────────

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file, value, mode = 0o600) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode })
  try { chmodSync(file, mode) } catch { /* Windows 无 chmod 语义 */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主逻辑
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建代理实例。apply() 只是把它挂到宿主上；测试可以直接构造它。
 * 返回对象上的方法都是**安全**的：内部 catch 一切异常，只更新 state 与日志。
 */
export function createAgent(ctx, config, { fetchImpl = globalThis.fetch } = {}) {
  const home = dshHomeOf(ctx)
  const credentialFile = config.deviceTokenFile || join(home, 'managed-agent.json')
  const pendingFile = join(dirname(credentialFile), 'managed-agent-pending.json')
  const statusPath = (config.statusPath || '/managed-agent/v1').replace(/\/+$/, '')
  const logger = ctx?.logger

  const state = {
    enrolled: false,
    employee: null,
    machineId: null,
    endpoint: null,
    lastHeartbeatAt: null,
    lastAttemptAt: null,
    lastResult: 'idle',          // idle | ok | pending | revoked | unauthorized | offline | not-enrolled
    lastError: null,
    serverStatus: null,
    compliance: 'unknown',        // 服务端判定结果，原样展示
    quotaState: null,             // M3/M6 后由服务端下发
    pendingSince: null,
    heartbeatCount: 0,
  }

  const log = {
    info: (msg) => logger?.info?.(`[managed-agent] ${msg}`),
    warn: (msg) => logger?.warn?.(`[managed-agent] ${msg}`),
    error: (msg) => logger?.error?.(`[managed-agent] ${msg}`),
  }

  function loadCredential() {
    const credential = readJsonFile(credentialFile)
    if (!credential?.deviceToken) {
      state.enrolled = false
      state.lastResult = 'not-enrolled'
      return null
    }
    state.enrolled = true
    state.employee = credential.employee ?? null
    state.machineId = credential.machineId ?? null
    // 容错：老版本 enroll 写入的 endpoint 可能没有 `/api/v1` 前缀。
    // 插件按 `${endpoint}/heartbeat` 拼地址，所以这里统一补齐，避免"凭据有效但一直 offline"。
    const rawEndpoint = String(config.endpoint || credential.endpoint || '').replace(/\/+$/, '')
    state.endpoint = !rawEndpoint ? '' : (/\/api\/v\d+$/.test(rawEndpoint) ? rawEndpoint : `${rawEndpoint}/api/v1`)
    return credential
  }

  function savePending(payload) {
    try {
      writeJsonFile(pendingFile, payload)
      state.pendingSince = state.pendingSince ?? new Date().toISOString()
    } catch (error) {
      log.warn(`写入待发心跳失败（忽略）：${error?.message ?? error}`)
    }
  }

  function clearPending() {
    try {
      if (existsSync(pendingFile)) writeJsonFile(pendingFile, { cleared: true })
      state.pendingSince = null
    } catch { /* 忽略 */ }
  }

  /** 吊销：清除本地令牌（保留工号/机器信息用于展示），并停止后续心跳 */
  function markRevoked(credential) {
    try {
      writeJsonFile(credentialFile, {
        ...credential,
        deviceToken: null,
        revokedAt: new Date().toISOString(),
        status: 'revoked',
      })
    } catch (error) {
      log.warn(`清除本地凭据失败（忽略）：${error?.message ?? error}`)
    }
    state.enrolled = false
    state.lastResult = 'revoked'
    log.warn('设备已被平台吊销，本地令牌已清除。请联系平台组重新注册。')
  }

  async function sendHeartbeat(payload) {
    const credential = loadCredential()
    if (!credential) return { skipped: true }

    const url = `${state.endpoint}/heartbeat`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      state.lastAttemptAt = new Date().toISOString()
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential.deviceToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = await res.json().catch(() => null)

      if (res.ok) {
        state.lastHeartbeatAt = new Date().toISOString()
        state.lastResult = 'ok'
        state.lastError = null
        state.serverStatus = body?.status ?? 'active'
        state.compliance = body?.compliance ?? 'unknown'
        state.quotaState = body?.quotaState ?? null
        state.heartbeatCount += 1
        clearPending()
        return { ok: true, body }
      }

      if (res.status === 403 && body?.error === 'pending') {
        state.lastResult = 'pending'
        state.lastError = body?.hint ?? '待平台组批准'
        state.serverStatus = 'pending'
        clearPending()
        return { ok: false, pending: true }
      }

      if (res.status === 403 && body?.error === 'revoked') {
        markRevoked(credential)
        clearPending()
        return { ok: false, revoked: true }
      }

      if (res.status === 401) {
        state.lastResult = 'unauthorized'
        state.lastError = body?.hint ?? '设备令牌无效'
        savePending(payload)
        return { ok: false, unauthorized: true }
      }

      // 其它状态码：当成暂时失败，留待下次重试
      state.lastResult = 'offline'
      state.lastError = `HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`
      savePending(payload)
      return { ok: false, status: res.status }
    } catch (error) {
      state.lastResult = 'offline'
      state.lastError = error?.name === 'AbortError' ? '请求超时' : String(error?.message ?? error)
      savePending(payload)
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 一次心跳：优先补发上次没发出去的那份，否则采集新事实 */
  async function tick(reason = 'interval') {
    const pending = readJsonFile(pendingFile)
    const payload = pending && pending.kind === 'dsh-managed-agent/heartbeat'
      ? { ...pending, replayedAt: new Date().toISOString() }
      : collectFacts({ ctx, config, home })
    const result = await sendHeartbeat(payload)
    if (result?.ok) log.info(`心跳成功（${reason}）：${state.compliance} / ${state.serverStatus}`)
    else if (result?.pending) log.info(`心跳被受理但设备待审批（${reason}）`)
    else if (!result?.skipped) log.warn(`心跳未成功（${reason}）：${state.lastResult} ${state.lastError ?? ''}`.trim())
    return result
  }

  // ── 本地只读状态页 ────────────────────────────────────────────────────
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))

  function statusSnapshot() {
    return {
      schema: 1,
      enrolled: state.enrolled,
      employee: state.employee,
      machineId: state.machineId,
      endpoint: state.endpoint,
      lastHeartbeatAt: state.lastHeartbeatAt,
      lastAttemptAt: state.lastAttemptAt,
      lastResult: state.lastResult,
      lastError: state.lastError,
      serverStatus: state.serverStatus,
      compliance: state.compliance,
      quotaState: state.quotaState,
      pendingSince: state.pendingSince,
      heartbeatCount: state.heartbeatCount,
      facts: collectFacts({ ctx, config, home }),
      readOnly: true,
      note: '本页只读：设备状态由平台判定，插件不提供任何修改入口。',
    }
  }

  function statusHtml() {
    const snap = statusSnapshot()
    const resultLabel = {
      idle: '尚未上报', ok: '上报正常', pending: '待平台组批准', revoked: '设备已被吊销',
      unauthorized: '设备令牌失效', offline: '平台不可达', 'not-enrolled': '本机尚未注册',
    }[snap.lastResult] ?? snap.lastResult
    const complianceLabel = {
      ok: '合规', drifted: '配置已漂移', outdated: '版本落后', revoked: '已吊销', unknown: '未知',
    }[snap.compliance] ?? snap.compliance
    const tone = snap.compliance === 'ok' ? '#0b6b43'
      : snap.compliance === 'drifted' || snap.compliance === 'outdated' ? '#8a5a00'
        : snap.compliance === 'revoked' ? '#a3231c' : '#5b6472'
    const rows = [
      ['工号', snap.employee ?? '—'],
      ['机器 ID', snap.machineId ?? '—'],
      ['平台', snap.endpoint ?? '—'],
      ['最后上报', snap.lastHeartbeatAt ?? '—'],
      ['上报结果', resultLabel],
      ['合规状态', complianceLabel],
      ['DSH 版本', snap.facts.dshVersion],
      ['patch 指纹', snap.facts.patchFingerprint ? `${snap.facts.patchFingerprint.slice(0, 23)}…` : '未找到 patch 文件'],
      ['插件数', String(snap.facts.plugins.length)],
      ['待发心跳', snap.pendingSince ? `自 ${snap.pendingSince}` : '无'],
    ]
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>受管设备状态</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f2f5f9;color:#1c2531;
       font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:100%;max-width:620px;background:#fff;border:1px solid #dbe2ec;border-radius:12px;padding:26px 30px}
  h1{font-size:17px;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin:0 0 18px}
  .bar{height:3px;width:56px;background:${tone};border-radius:2px;margin-bottom:16px}
  dl{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;margin:0 0 16px;padding:14px 16px;
     background:#f7f9fc;border:1px solid #e5ebf3;border-radius:10px}
  dt{color:#64748b;font-size:13px}dd{margin:0;word-break:break-all}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
  .note{padding:10px 12px;border-radius:8px;font-size:12.5px;background:#eef4fd;border:1px solid #cfe0f7;color:#1a4f8a}
</style></head><body><div class="card">
  <div class="bar"></div><h1>受管设备状态</h1>
  <p class="sub">只读页面：数据来自本机凭据与最近一次上报结果；状态判定在平台侧完成。</p>
  <dl>${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${/指纹|机器 ID/.test(key) ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</dd>`).join('')}</dl>
  <p class="note">${escapeHtml(snap.note)}</p>
</div></body></html>`
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://managed-agent.invalid')
      const route = url.pathname.slice(statusPath.length) || '/'
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'read-only', hint: '本插件只提供只读状态，不提供任何修改接口。' })
        return
      }
      if (route === '/' || route === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(statusHtml())
        return
      }
      if (route === '/status') { sendJson(res, 200, { ok: true, ...statusSnapshot() }); return }
      if (route === '/health') { sendJson(res, 200, { ok: true, enrolled: state.enrolled, lastResult: state.lastResult }); return }
      sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      try { sendJson(res, 500, { ok: false, error: 'internal', detail: String(error?.message ?? error) }) } catch { /* 忽略 */ }
    }
  }

  return { state, tick, handle, statusSnapshot, statusHtml, loadCredential, paths: { credentialFile, pendingFile }, statusPath }
}

export function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger?.info?.('[managed-agent] 已禁用')
    return
  }

  const agent = createAgent(ctx, config)
  const credential = agent.loadCredential()
  if (!credential) {
    ctx.logger?.info?.(`[managed-agent] 本机尚未注册（缺少 ${agent.paths.credentialFile}），状态页仍可用；运行 node admin/enroll.mjs 完成注册`)
  }

  // 本地只读状态页：挂在 DSH 自带 WebServer 上，受浏览器门禁保护
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: agent.statusPath, handler: (req, res) => void agent.handle(req, res) }),
    'managed-agent: read-only status page',
  )

  // 心跳定时器：先跑一次（尽快让平台看到这台机器），之后按周期
  const intervalMs = config.heartbeatMinutes * 60_000
  const timer = setInterval(() => { void agent.tick('interval') }, intervalMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'managed-agent: heartbeat timer')
  void agent.tick('startup')

  ctx.logger?.info?.(`[managed-agent] 心跳每 ${config.heartbeatMinutes} 分钟；状态页 ${agent.statusPath}/`)
  return agent
}
