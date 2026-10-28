#!/usr/bin/env node
/**
 * verify.mjs —— dsh-managed-agent 自检
 *
 * 两层：
 *   A. 单元（默认运行）：假宿主 / 假 fetch，验证"上报什么、失败怎么处理、吊销怎么清凭据、状态页只读"
 *   B. 集成（可选）：设置 MANAGED_AGENT_PLATFORM 与 MANAGED_AGENT_TOKEN 后，
 *      用真实平台跑一次心跳。**不会**在 CI 里运行（没有平台）。
 *
 * 用法：
 *   node test/verify.mjs
 *   MANAGED_AGENT_PLATFORM=http://127.0.0.1:8788/api/v1 MANAGED_AGENT_TOKEN=dshdev-… node test/verify.mjs
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectFacts, compareVersions, createAgent, normalizeConfig } from '../index.js'
import { apply } from '../index.js'

const TMP = join(tmpdir(), 'dsh-managed-agent-test')
let pass = 0
let fail = 0
const failures = []
const chk = (label, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  \u001b[32m✓\u001b[0m ${label}`) }
  else { fail += 1; failures.push(label); console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` \u001b[2m— ${detail}\u001b[0m` : ''}`) }
}

// ── 假宿主 ────────────────────────────────────────────────────────────
function fakeCtx(home, logs = []) {
  const routes = []
  const disposers = []
  return {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    get: (key) => (key === 'dshHome' ? home : undefined),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: { register: (desc) => { routes.push(desc); return () => {} } },
    _routes: routes,
    _disposers: disposers,
  }
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

async function makeHome({ patch = 'managed-patch-v1', token = 'dshdev-test-token', endpoint = 'http://127.0.0.1:9/api/v1' } = {}) {
  const home = join(TMP, `home-${randomBytes(4).toString('hex')}`)
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), `# ${patch}\n- id: demo\n  config: {}\n`)
  await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-managed-agent': '^0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-managed-agent'] } },
  }, null, 2))
  if (token) {
    await writeFile(join(home, 'managed-agent.json'), JSON.stringify({
      schema: 1, endpoint, machineId: 'machine-test-01', machineLabel: 'test-box',
      employee: 'EMP0001', deviceToken: token, status: 'active',
    }, null, 2), { mode: 0o600 })
  }
  return home
}

const baseConfig = (extra = {}) => ({
  enabled: true, endpoint: '', heartbeatMinutes: 15, deviceTokenFile: '', patchFile: '',
  profile: '', machineLabel: '', dshVersion: '', statusPath: '/managed-agent/v1', timeoutMs: 5000, ...extra,
})

// ── A. 单元 ───────────────────────────────────────────────────────────
async function unitTests() {
  console.log('\nA) 单元（假宿主 / 假 fetch）')

  const home = await makeHome()
  const ctx = fakeCtx(home)
  const facts = collectFacts({ ctx, config: baseConfig({ dshVersion: '0.2.1-rc.3' }), home })
  const expected = `sha256:${createHash('sha256').update(readFileSync(join(home, 'profiles/desktop/cordis.patch.yml'))).digest('hex')}`
  chk('采集到 DSH 版本', facts.dshVersion === '0.2.1-rc.3', facts.dshVersion)
  chk('patch 指纹为文件 sha256', facts.patchFingerprint === expected, String(facts.patchFingerprint))
  chk('插件清单来自 profile（bundle + 依赖）', facts.plugins.length >= 2, JSON.stringify(facts.plugins.map((p) => p.name)))
  chk('上报内容不含工作区路径/提示词字段', !JSON.stringify(facts).match(/cwd|prompt|content|workspace/i))
  const normalized = normalizeConfig({ heartbeatMinutes: 0, timeoutMs: 1e9, statusPath: 'nope' })
  chk('配置归一化：范围钳制与路径兜底',
    normalized.heartbeatMinutes === 1 && normalized.timeoutMs === 60_000 && normalized.statusPath === '/managed-agent/v1',
    JSON.stringify(normalized))
  chk('版本比较：0.2.1-rc.3 > 0.2.0', compareVersions('0.2.1-rc.3', '0.2.0') === 1)
  chk('版本比较：0.2.0 < 0.2.1', compareVersions('0.2.0', '0.2.1') === -1)

  // 版本从 <DSH_HOME>/app-version 读取（部署脚本写入）
  await writeFile(join(home, 'app-version'), '0.2.1-rc.3\n')
  chk('版本可从 <DSH_HOME>/app-version 读取',
    collectFacts({ ctx, config: baseConfig(), home }).dshVersion === '0.2.1-rc.3')

  // endpoint 容错：老凭据没带 /api/v1
  const legacyHome = await makeHome({ endpoint: 'http://127.0.0.1:9' })
  let legacyUrl = null
  const legacyAgent = createAgent(fakeCtx(legacyHome), baseConfig(), {
    fetchImpl: async (url) => { legacyUrl = url; return jsonResponse(200, { ok: true, status: 'active', compliance: 'ok' }) },
  })
  await legacyAgent.tick('legacy')
  chk('老凭据缺少 /api/v1 时自动补齐', legacyUrl === 'http://127.0.0.1:9/api/v1/heartbeat', String(legacyUrl))

  // 未注册
  const bareHome = await makeHome({ token: null })
  const bareAgent = createAgent(fakeCtx(bareHome), baseConfig(), { fetchImpl: async () => { throw new Error('should not call') } })
  const bareResult = await bareAgent.tick('test')
  chk('未注册时不上报、状态为 not-enrolled', bareResult?.skipped === true && bareAgent.state.lastResult === 'not-enrolled')

  // 正常 200
  let captured = null
  const okAgent = createAgent(fakeCtx(home), baseConfig({ dshVersion: '0.2.1-rc.3' }), {
    fetchImpl: async (url, init) => { captured = { url, init }; return jsonResponse(200, { ok: true, status: 'active', compliance: 'ok' }) },
  })
  const okResult = await okAgent.tick('test')
  chk('心跳成功：状态 ok / compliance 来自服务端',
    okResult?.ok === true && okAgent.state.lastResult === 'ok' && okAgent.state.compliance === 'ok')
  chk('心跳请求带 Bearer 设备令牌', /^Bearer dshdev-/.test(captured.init.headers.authorization))
  chk('心跳 URL 指向 /heartbeat', captured.url === 'http://127.0.0.1:9/api/v1/heartbeat')

  // 网络失败 → 待发文件；恢复后补发同一份
  let failMode = true
  let replayPayload = null
  const offlineAgent = createAgent(fakeCtx(home), baseConfig({ dshVersion: '0.2.1-rc.3' }), {
    fetchImpl: async (url, init) => {
      if (failMode) throw new Error('ECONNREFUSED')
      replayPayload = JSON.parse(init.body)
      return jsonResponse(200, { ok: true, status: 'active', compliance: 'ok' })
    },
  })
  await offlineAgent.tick('test')
  chk('平台不可达：记为 offline 且写入待发心跳',
    offlineAgent.state.lastResult === 'offline' && existsSync(offlineAgent.paths.pendingFile))
  failMode = false
  await offlineAgent.tick('test')
  chk('恢复后补发的是同一份快照（带 replayedAt）',
    Boolean(replayPayload?.replayedAt) && replayPayload?.patchFingerprint === facts.patchFingerprint)
  chk('补发成功后清空待发标记', offlineAgent.state.pendingSince === null)

  // 403 pending
  const pendingAgent = createAgent(fakeCtx(home), baseConfig(), {
    fetchImpl: async () => jsonResponse(403, { ok: false, error: 'pending', hint: '待批准' }),
  })
  await pendingAgent.tick('test')
  chk('待审批：状态 pending 且不清凭据',
    pendingAgent.state.lastResult === 'pending' && existsSync(pendingAgent.paths.credentialFile))

  // 403 revoked → 清令牌
  const revokedHome = await makeHome()
  const revokedAgent = createAgent(fakeCtx(revokedHome), baseConfig(), {
    fetchImpl: async () => jsonResponse(403, { ok: false, error: 'revoked' }),
  })
  await revokedAgent.tick('test')
  const revokedFile = JSON.parse(await readFile(revokedAgent.paths.credentialFile, 'utf8'))
  chk('吊销：本地令牌被清除、文件保留工号用于展示',
    revokedFile.deviceToken === null && revokedFile.status === 'revoked' && revokedFile.employee === 'EMP0001')
  chk('吊销：状态为 revoked 且不再上报', revokedAgent.state.lastResult === 'revoked' && revokedAgent.state.enrolled === false)

  // 401 → unauthorized + 待发
  const unauthHome = await makeHome()
  const unauthAgent = createAgent(fakeCtx(unauthHome), baseConfig(), {
    fetchImpl: async () => jsonResponse(401, { ok: false, error: 'unauthorized' }),
  })
  await unauthAgent.tick('test')
  chk('令牌失效：状态 unauthorized 且保留待发',
    unauthAgent.state.lastResult === 'unauthorized' && existsSync(unauthAgent.paths.pendingFile))

  // 状态页只读
  const htmlCtx = fakeCtx(home)
  const statusAgent = createAgent(htmlCtx, baseConfig())
  statusAgent.loadCredential()
  const html = statusAgent.statusHtml()
  chk('状态页包含工号/合规/上报结果', html.includes('EMP0001') && html.includes('合规状态') && html.includes('上报结果'))
  chk('状态页标注只读', html.includes('只读'))
  const snapshot = statusAgent.statusSnapshot()
  chk('状态接口 readOnly=true 且不含令牌', snapshot.readOnly === true && !JSON.stringify(snapshot).includes('dshdev-'))
  let statusCode = 0
  statusAgent.handle({ method: 'POST', url: '/managed-agent/v1/status' }, { writeHead: (code) => { statusCode = code }, end: () => {} })
  chk('状态接口拒绝写操作（405）', statusCode === 405)

  // apply() 挂路由与清理
  const applyCtx = fakeCtx(home)
  apply(applyCtx, baseConfig({ heartbeatMinutes: 60 }))
  chk('apply 注册了本地状态页路由', applyCtx._routes.length === 1 && applyCtx._routes[0].path === '/managed-agent/v1')
  chk('apply 注册了定时器清理函数', applyCtx._disposers.length >= 1)
  for (const dispose of applyCtx._disposers) { try { dispose() } catch { /* 忽略 */ } }
}

// ── B. 集成（可选，需要真实平台）───────────────────────────────────────
async function integrationTests() {
  const platform = process.env.MANAGED_AGENT_PLATFORM
  const token = process.env.MANAGED_AGENT_TOKEN
  console.log('\nB) 集成（真实平台）')
  if (!platform || !token) {
    console.log('  \u001b[2m— 跳过：设置 MANAGED_AGENT_PLATFORM 与 MANAGED_AGENT_TOKEN 后可运行\u001b[0m')
    return
  }
  const home = await makeHome({ token, endpoint: platform })
  const agent = createAgent(fakeCtx(home), baseConfig({ dshVersion: '0.2.1-rc.3' }))
  const result = await agent.tick('integration')
  chk('真实平台接受心跳', result?.ok === true, agent.state.lastError ?? '')
  chk('平台返回了合规判定', typeof agent.state.compliance === 'string' && agent.state.compliance !== 'unknown', agent.state.compliance)
}

async function main() {
  console.log('\u001b[1mdsh-managed-agent 自检\u001b[0m')
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })
  await unitTests()
  await integrationTests()
  console.log('')
  console.log(`结果：通过 \u001b[32m${pass}\u001b[0m 失败 ${fail ? `\u001b[31m${fail}\u001b[0m` : 0}`)
  if (fail) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  · ${item}`)
    process.exit(1)
  }
  console.log('\n\u001b[32m全部通过\u001b[0m')
}

main().catch((error) => {
  console.error(`自检异常：${error?.stack ?? error}`)
  process.exit(1)
})
