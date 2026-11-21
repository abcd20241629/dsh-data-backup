// DSH 重要数据备份 · 宿主半边（host.js）
//
// 干什么：
//   * 每天到点（默认 03:00）自动跑一次全量快照备份，不调模型、不发网络请求；
//   * 面板上能手动备份、取消、校验、还原、改配置；
//   * 给 agent 注册几个工具（backup_run / backup_status / backup_list / backup_verify）；
//   * 备份产物自带 _README.md 与 _restore.ps1 —— DSH 全新装一遍也能照它还原。
//
// 落盘位置：<backupRoot>\{分类中文名}\{快照id}\{源名}\...
// 状态与配置：<DSH_HOME>\plugins-data\dsh-data-backup\{config.json,state.json}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

import {
  DEFAULTS,
  loadConfig,
  saveConfig,
  patchConfig,
  loadHistory,
  listSnapshotIds,
  manifestPath,
} from './config.js'
import { buildPlan, measureSource } from './plan.js'
import { humanBytes } from './fsutil.js'
import { runBackup, state as runState, requestCancel, progressText } from './snapshot.js'
import { verifySnapshot, verifyRoot } from './verify.js'
import { restoreSnapshot, listRestorable } from './restore.js'

export const name = 'data-backup'

/** 用到宿主这些服务；缺了就不注册对应部分，绝不 crash。 */
export const inject = ['webServer', 'tools']

const ROUTE_PREFIX = '/data-backup'
const HERE = dirname(fileURLToPath(import.meta.url))

const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch {
    return '?'
  }
})()

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function msgOf(e) {
  return String((e && e.message) || e) || 'unknown'
}

/** 自动备份的「今天跑过没」记在内存 + 落盘（重启不重复跑）。 */
function autoStatePath() {
  return join(dshHome(), 'plugins-data', 'dsh-data-backup', 'auto-state.json')
}

function readAutoState() {
  try {
    return JSON.parse(readFileSync(autoStatePath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeAutoState(o) {
  try {
    const p = autoStatePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(o, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

const pad = (n) => String(n).padStart(2, '0')
const todayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 到点了没：现在 HH:mm >= dailyAt。 */
function dueNow(dailyAt, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(dailyAt || ''))
  if (!m) return false
  const target = Number(m[1]) * 60 + Number(m[2])
  const cur = now.getHours() * 60 + now.getMinutes()
  return cur >= target
}

/** 把目录用资源管理器打开（Windows）；失败就算了。 */
function openInExplorer(dir) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: '只有 Windows 支持这个按钮' })
    try {
      execFile('explorer.exe', [dir], { windowsHide: true }, () => resolve({ ok: true }))
    } catch (e) {
      resolve({ ok: false, error: msgOf(e) })
    }
  })
}

export function apply(ctx) {
  const log = []
  const 记 = (t) => {
    log.push({ at: new Date().toISOString(), text: String(t) })
    if (log.length > 120) log.shift()
  }

  const cleanups = []
  const web = ctx && ctx.webServer

  // ---------- 路由 ----------

  const send = (res, obj, code = 200) => {
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    } catch {
      /* 客户端已经走了 */
    }
  }

  const readBody = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch {
      return {}
    }
    if (!body) return {}
    try {
      return JSON.parse(body)
    } catch {
      return {}
    }
  }

  const queryOf = (req) => {
    try {
      const u = new URL(req.url || '/', 'http://x')
      return Object.fromEntries(u.searchParams.entries())
    } catch {
      return {}
    }
  }

  const route = (path, handler) => {
    if (!web || typeof web.register !== 'function') return
    let off
    try {
      off = web.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            const out = await handler(req, res)
            if (out !== undefined) send(res, out)
          } catch (e) {
            send(res, { ok: false, error: msgOf(e) })
          }
        },
      })
    } catch (e) {
      记(`注册路由 ${path} 失败：${msgOf(e)}`)
      return
    }
    if (typeof off === 'function') cleanups.push(off)
  }

  // 全部现状（面板首屏）
  route(`${ROUTE_PREFIX}/api/overview`, async () => {
    const home = dshHome()
    const cfg = await loadConfig(home)
    const history = await loadHistory(cfg.backupRoot, 20)
    let snapshots = []
    try {
      snapshots = await listRestorable(cfg.backupRoot)
    } catch (e) {
      记('列快照失败：' + msgOf(e))
    }
    let rootCheck = null
    try {
      rootCheck = await verifyRoot(cfg.backupRoot)
    } catch (e) {
      rootCheck = { ok: false, error: msgOf(e) }
    }
    const auto = readAutoState()
    return {
      ok: true,
      version: 版本,
      dshHome: home,
      config: cfg,
      defaults: DEFAULTS,
      running: runState.running,
      progress: {
        phase: runState.phase,
        id: runState.id,
        text: progressText(),
        copiedFiles: runState.copiedFiles,
        copiedBytes: runState.copiedBytes,
        copiedText: humanBytes(runState.copiedBytes),
        totalBytes: runState.totalBytes,
        totalText: humanBytes(runState.totalBytes),
        startedAt: runState.startedAt,
      },
      lastResult: runState.lastResult,
      auto,
      history,
      snapshots: snapshots.slice(0, 30),
      rootCheck,
      log: log.slice(-30),
    }
  })

  // 触发一次备份
  route(`${ROUTE_PREFIX}/api/run`, async (req) => {
    if (runState.running) return { ok: false, error: '已经有一次备份在跑了', id: runState.id }
    const home = dshHome()
    const cfg = await loadConfig(home)
    const body = await readBody(req)
    const reason = String((body && body.reason) || '手动')
    记(`开始备份（${reason}）→ ${cfg.backupRoot}`)
    // 不 await：让面板能立刻拿到「开始了」，进度靠 /overview 轮询
    void runBackup({
      dshHome: home,
      cfg,
      reason,
      onDone: (r) => {
        记(`备份结束（${r.status}）：${r.files} 个文件 / ${humanBytes(r.bytes)}`)
        if (r.status === 'ok' || r.status === 'partial') {
          const a = readAutoState()
          if (reason === '自动') {
            a.lastAutoDay = todayKey()
            a.lastAutoId = r.id
            writeAutoState(a)
          }
        }
      },
    }).catch((e) => 记('备份异常：' + msgOf(e)))
    return { ok: true, started: true, id: runState.id, reason, backupRoot: cfg.backupRoot }
  })

  // 取消
  route(`${ROUTE_PREFIX}/api/cancel`, async () => {
    const ok = requestCancel()
    记(ok ? '请求取消备份' : '没有在跑的备份')
    return { ok, cancelled: ok }
  })

  // 改配置
  route(`${ROUTE_PREFIX}/api/config`, async (req) => {
    const home = dshHome()
    const cfg = await loadConfig(home)
    if ((req.method || 'GET').toUpperCase() === 'GET') return { ok: true, config: cfg, defaults: DEFAULTS }
    const patch = await readBody(req)
    const next = patchConfig(cfg, patch)
    await saveConfig(home, next)
    记('配置已更新')
    return { ok: true, config: next }
  })

  // 预估计划（会全盘 stat 一遍，可能慢几秒）
  route(`${ROUTE_PREFIX}/api/plan`, async () => {
    const home = dshHome()
    const cfg = await loadConfig(home)
    const plan = buildPlan({ dshHome: home, withAttachments: cfg.withAttachments, withCodex: cfg.withCodex })
    const out = []
    let total = 0
    for (const cat of plan) {
      let bytes = 0
      let files = 0
      const sources = []
      for (const src of cat.sources) {
        const m = measureSource(src)
        if (m) {
          bytes += m.bytes
          files += m.files
          sources.push({
            from: src.kind === 'dir' ? src.from : src.fromDir,
            kind: src.kind,
            bytes: m.bytes,
            bytesText: humanBytes(m.bytes),
            files: m.files,
          })
        } else {
          sources.push({ from: src.kind === 'dir' ? src.from : src.fromDir, kind: src.kind, missing: true })
        }
      }
      total += bytes
      out.push({
        id: cat.id,
        label: cat.label,
        note: cat.note,
        bytes,
        bytesText: humanBytes(bytes),
        files,
        overCap: bytes > cfg.categoryCapBytes,
        sources,
      })
    }
    return { ok: true, categories: out, totalBytes: total, totalText: humanBytes(total), cap: cfg.categoryCapBytes, capText: humanBytes(cfg.categoryCapBytes) }
  })

  // 校验一份快照
  route(`${ROUTE_PREFIX}/api/verify`, async (req) => {
    const body = await readBody(req)
    const home = dshHome()
    const cfg = await loadConfig(home)
    const id = String((body && body.id) || '')
    if (!id) return { ok: false, error: '要给 id' }
    const deep = body.deep === undefined ? cfg.deepVerify : Boolean(body.deep)
    记(`校验快照 ${id}（${deep ? '深' : '浅'}）`)
    const r = await verifySnapshot({ backupRoot: cfg.backupRoot, id, deep })
    记(`校验 ${id}：${r.ok ? '通过' : `发现 ${r.issues.length} 个问题`}`)
    return r
  })

  // 还原
  route(`${ROUTE_PREFIX}/api/restore`, async (req) => {
    const body = await readBody(req)
    const home = dshHome()
    const cfg = await loadConfig(home)
    const id = String((body && body.id) || '')
    if (!id) return { ok: false, error: '要给 id' }
    if (!body.dryRun && !body.confirm) return { ok: false, error: '还原要带 confirm: true' }
    记(`开始还原 ${id}${body.dryRun ? '（演练）' : ''}`)
    const r = await restoreSnapshot({
      backupRoot: cfg.backupRoot,
      id,
      targets: body.targets,
      dryRun: Boolean(body.dryRun),
    })
    记(`还原 ${id} 结束：${r.ok ? '成功' : '有问题'}`)
    return r
  })

  // 看某份 manifest 原文
  route(`${ROUTE_PREFIX}/api/manifest`, async (req) => {
    const q = queryOf(req)
    const cfg = await loadConfig(dshHome())
    const id = String(q.id || '')
    if (!id) return { ok: false, error: '要给 id' }
    const p = manifestPath(cfg.backupRoot, id)
    try {
      return { ok: true, id, path: p, manifest: JSON.parse(await readFile(p, 'utf8')) }
    } catch (e) {
      return { ok: false, error: msgOf(e), path: p }
    }
  })

  // 插件清单：把某份快照里生成的 plugin-list.md / .json 读出来给面板看
  route(`${ROUTE_PREFIX}/api/plugin-list`, async (req) => {
    const q = queryOf(req)
    const cfg = await loadConfig(dshHome())
    const id = String(q.id || '')
    const dir = join(cfg.backupRoot, '插件清单', id)
    const mdPath = join(dir, 'plugin-list.md')
    const jsonPath = join(dir, 'plugin-list.json')
    try {
      const md = await readFile(mdPath, 'utf8')
      let list = null
      try {
        list = JSON.parse(await readFile(jsonPath, 'utf8'))
      } catch {
        list = null
      }
      return { ok: true, id, dir, md, count: list ? list.count : null, entries: list ? list.entries : [] }
    } catch (e) {
      return { ok: false, id, dir, error: msgOf(e) }
    }
  })

  // 在资源管理器里打开备份根
  route(`${ROUTE_PREFIX}/api/open-root`, async () => {
    const cfg = await loadConfig(dshHome())
    return openInExplorer(cfg.backupRoot)
  })

  // 自检（注入后立刻能看）
  route(`${ROUTE_PREFIX}/api/ping`, async () => ({ ok: true, name, version: 版本, hasWeb: Boolean(web), log: log.slice(-10) }))

  // ---------- 定时自动备份 ----------

  const tick = async () => {
    try {
      const cfg = await loadConfig(dshHome())
      if (!cfg.enabled) return
      if (runState.running) return
      const auto = readAutoState()
      const day = todayKey()
      if (auto.lastAutoDay === day) return // 今天已经跑过
      if (!dueNow(cfg.dailyAt)) return
      记(`到点（${cfg.dailyAt}），开始自动备份`)
      void runBackup({
        dshHome: dshHome(),
        cfg,
        reason: '自动',
        onDone: (r) => {
          记(`自动备份结束（${r.status}）：${r.files} 个文件 / ${humanBytes(r.bytes)}`)
          const a = readAutoState()
          a.lastAutoDay = day
          a.lastAutoId = r.id
          a.lastStatus = r.status
          writeAutoState(a)
        },
      }).catch((e) => 记('自动备份异常：' + msgOf(e)))
    } catch (e) {
      记('定时检查出错：' + msgOf(e))
    }
  }

  const timer = setInterval(() => void tick(), 30 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  cleanups.push(() => clearInterval(timer))
  // 起来 20 秒后先看一次（避开启动高峰）
  const bootTimer = setTimeout(() => void tick(), 20 * 1000)
  if (typeof bootTimer.unref === 'function') bootTimer.unref()
  cleanups.push(() => clearTimeout(bootTimer))

  // ---------- 工具 ----------

  const defineTool = (def) => {
    const properties = {}
    const required = []
    for (const [k, v] of Object.entries(def.parameters || {})) {
      const p = { type: v.type, description: v.description }
      if (v.enum) p.enum = v.enum
      if (v.items) p.items = v.items
      properties[k] = p
      if (v.required) required.push(k)
    }
    return {
      name: def.name,
      description: def.description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      },
      execute: def.execute,
    }
  }

  const tools = [
    {
      name: 'backup_run',
      description:
        '立刻把 DSH 的重要数据（会话/附件/技能/记忆/插件数据/配置密钥/插件源码/Codex）备份一份全量快照到 F 盘。' +
        '纯文件拷贝，不调模型。要跑几十秒到几分钟，返回一个 id，之后用 backup_status 看进度。',
      parameters: {
        reason: { type: 'string', description: '为什么备份（记进历史），例如「手动」「装插件前」' },
      },
      async execute(args = {}) {
        if (runState.running) return { ok: false, error: '已经有一次备份在跑了', id: runState.id }
        const home = dshHome()
        const cfg = await loadConfig(home)
        const reason = String(args.reason || '手动')
        记(`[工具] 开始备份（${reason}）`)
        void runBackup({
          dshHome: home,
          cfg,
          reason,
          onDone: (r) => 记(`[工具] 备份结束（${r.status}）：${r.files} 个文件 / ${humanBytes(r.bytes)}`),
        }).catch((e) => 记('[工具] 备份异常：' + msgOf(e)))
        return { ok: true, started: true, id: runState.id, backupRoot: cfg.backupRoot, note: '跑起来了，用 backup_status 看进度' }
      },
    },
    {
      name: 'backup_status',
      description: '看备份现在在跑什么、上次备份的结果、已有的快照列表和历史。',
      parameters: {},
      async execute() {
        const home = dshHome()
        const cfg = await loadConfig(home)
        const history = await loadHistory(cfg.backupRoot, 10)
        let snapshots = []
        try {
          snapshots = await listSnapshotIds(cfg.backupRoot)
        } catch {
          snapshots = []
        }
        return {
          ok: true,
          running: runState.running,
          progress: progressText(),
          phase: runState.phase,
          currentId: runState.id,
          copied: { files: runState.copiedFiles, bytes: runState.copiedBytes, text: humanBytes(runState.copiedBytes) },
          lastResult: runState.lastResult
            ? {
                id: runState.lastResult.id,
                status: runState.lastResult.status,
                files: runState.lastResult.files,
                bytesText: humanBytes(runState.lastResult.bytes),
                finishedAt: runState.lastResult.finishedAt,
              }
            : null,
          backupRoot: cfg.backupRoot,
          config: cfg,
          snapshots: snapshots.slice(-20),
          history: history.slice(-10),
        }
      },
    },
    {
      name: 'backup_list',
      description: '列出备份根下所有可还原的快照（id、时间、体积、分类）。',
      parameters: {},
      async execute() {
        const cfg = await loadConfig(dshHome())
        const list = await listRestorable(cfg.backupRoot)
        return { ok: true, backupRoot: cfg.backupRoot, count: list.length, snapshots: list }
      },
    },
    {
      name: 'backup_verify',
      description: '校验一份快照还能不能用。deep=true 会逐文件算 sha256（慢）。',
      parameters: {
        id: { type: 'string', description: '快照 id，例如 2026-11-21_030000', required: true },
        deep: { type: 'boolean', description: '是否做深校验（逐文件 sha256）' },
      },
      async execute(args = {}) {
        const id = String(args.id || '')
        if (!id) return { ok: false, error: '要给 id' }
        const cfg = await loadConfig(dshHome())
        return verifySnapshot({ backupRoot: cfg.backupRoot, id, deep: Boolean(args.deep) })
      },
    },
  ]

  try {
    const 服务 = ctx && ctx.tools
    if (服务 && typeof 服务.register === 'function') {
      const mark = Symbol.for('dsh.data-backup.tools')
      if (!ctx[mark]) {
        let n = 0
        for (const t of tools) {
          try {
            服务.register(defineTool(t))
            n += 1
          } catch (e) {
            记(`注册工具 ${t.name} 失败：${msgOf(e)}`)
          }
        }
        if (n > 0) ctx[mark] = true
        记(`已注册 ${n} 个工具`)
      }
    } else {
      记('ctx.tools 不可用，跳过工具注册（面板照常可用）')
    }
  } catch (e) {
    记('工具注册整体失败：' + msgOf(e))
  }

  // ---------- 清理 ----------

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const c of cleanups) {
          try {
            c()
          } catch {
            /* ignore */
          }
        }
      }, 'data-backup: 路由与定时器')
    } catch {
      /* 有的宿主不让包，就算了 */
    }
  }

  记(`data-backup ${版本} 已装配：备份根 ${join(dshHome(), 'plugins-data', 'dsh-data-backup')}`)
  return undefined
}
