// 备份执行器（snapshot.js）
//
// 一次备份 = 对每个分类的每个源：走目录 → 并发拷文件 → 记账 → 写 manifest
//            → 记历史 → 按保留策略删旧快照。
//
// 设计上的几条硬规矩：
//   * 一个源坏了不拖累别的源；一个分类超体积上限就整类跳过并写 warn。
//   * 任何异常都不往上抛成宿主错误 —— 备份是后台活儿，坏了只记账。
//   * 全程只做文件操作，不调模型、不发网络请求。

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan, GLOBAL_EXCLUDE, measureSource } from './plan.js'
import { walk, pool, copyOne, humanBytes, humanMs, freeSpace, rmrf } from './fsutil.js'
import {
  snapshotId,
  loadConfig,
  appendHistory,
  listSnapshotIds,
  planRetention,
  manifestPath,
} from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(here, '..', 'assets')

const MAX_WARN = 200
const MAX_ERRORS = 200
const MAX_HOT = 50

/** 运行时状态（面板 /status 直接读它）。 */
export const state = {
  running: false,
  phase: 'idle', // idle | measuring | copying | finishing | cleaning
  id: null,
  startedAt: null,
  category: null,
  categoryLabel: null,
  source: null,
  copiedFiles: 0,
  copiedBytes: 0,
  totalFiles: 0,
  totalBytes: 0,
  error: null,
  cancelRequested: false,
  lastResult: null,
}

let currentAbort = null

export function requestCancel() {
  if (!state.running) return false
  state.cancelRequested = true
  try {
    currentAbort?.abort()
  } catch {
    /* ignore */
  }
  return true
}

/** 宿主版本 / profile 包清单 —— 重装后照着这份清单装回去。 */
async function hostInfo(dshHome) {
  const out = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    dshHome,
    profile: 'web',
    dshVersion: null,
    packages: null,
    bundles: null,
  }
  try {
    const j = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
    out.packages = j.dependencies || null
    out.bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || (j.dsh && j.dsh.bundles) || null
  } catch {
    /* 没有就算了 */
  }
  for (const p of [join(dshHome, '..', 'package.json'), join(dshHome, 'package.json')]) {
    try {
      const j = JSON.parse(await readFile(p, 'utf8'))
      if (j && j.version && String(j.name || '').includes('dsh')) {
        out.dshVersion = j.version
        break
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

/** 把 assets 里的 README / restore.ps1 贴到备份根（内容不同才覆盖）。 */
async function ensureDocs(backupRoot) {
  const items = [
    { src: join(ASSETS, 'README.备份说明.md'), dst: join(backupRoot, '_README.md') },
    { src: join(ASSETS, 'restore.ps1'), dst: join(backupRoot, '_restore.ps1') },
  ]
  const out = []
  for (const it of items) {
    try {
      const a = await readFile(it.src)
      let same = false
      try {
        const b = await readFile(it.dst)
        same = Buffer.compare(a, b) === 0
      } catch {
        same = false
      }
      if (!same) {
        await mkdir(dirname(it.dst), { recursive: true })
        await writeFile(it.dst, a)
        out.push({ file: it.dst, action: '写入了新版' })
      }
    } catch (e) {
      out.push({ file: it.dst, action: '跳过：' + String((e && e.message) || e) })
    }
  }
  return out
}

function aborted() {
  return Object.assign(new Error('已取消'), { code: 'ABORTED' })
}

/**
 * 跑一次备份。
 * @param {{dshHome: string, cfg?: object, reason?: string, signal?: AbortSignal, onDone?: (r:object)=>void}} opts
 */
export async function runBackup(opts) {
  const dshHome = opts.dshHome
  const cfg = opts.cfg || (await loadConfig(dshHome))
  const reason = opts.reason || '手动'
  const startedAt = new Date()
  const startedMs = Date.now()

  if (state.running) return { ok: false, error: '已经有一次备份在跑了' }

  state.running = true
  state.phase = 'measuring'
  state.id = snapshotId(startedAt)
  state.startedAt = startedAt.toISOString()
  state.category = null
  state.categoryLabel = null
  state.source = null
  state.copiedFiles = 0
  state.copiedBytes = 0
  state.totalFiles = 0
  state.totalBytes = 0
  state.error = null
  state.cancelRequested = false

  const abort = new AbortController()
  currentAbort = abort
  if (opts.signal) opts.signal.addEventListener('abort', () => abort.abort(), { once: true })

  const backupRoot = cfg.backupRoot
  const id = state.id
  const warnings = []
  const hot = []
  const errors = []
  const categories = []
  const targets = []

  const warn = (msg, detail) => {
    if (warnings.length >= MAX_WARN) return
    warnings.push(detail === undefined ? msg : { msg, detail })
  }
  const noteError = (rec) => {
    if (errors.length < MAX_ERRORS) errors.push(rec)
  }

  let status = 'ok'
  let finishedAt = null
  let host = null

  try {
    await mkdir(join(backupRoot, '_manifests'), { recursive: true })
    await mkdir(join(backupRoot, '_state'), { recursive: true })

    const fsInfo = await freeSpace(backupRoot)
    // 正常走 buildPlan；测试可以塞一份精简 plan 进来，不碰真实目录。
    const plan = opts.planOverride || buildPlan({
      dshHome,
      withAttachments: cfg.withAttachments,
      withCodex: cfg.withCodex,
    })

    // ---- 1) 预估体积（只 stat） ----
    state.phase = 'measuring'
    let estimated = 0
    const estimatedByCat = new Map()
    for (const cat of plan) {
      let catBytes = 0
      for (const src of cat.sources) {
        const m = await measureSource(src)
        if (m) catBytes += m.bytes
      }
      estimatedByCat.set(cat.id, catBytes)
      estimated += catBytes
    }
    state.totalBytes = estimated
    state.totalFiles = 0

    if (fsInfo && fsInfo.free < estimated * 1.15) {
      warn(
        `磁盘剩余 ${humanBytes(fsInfo.free)}，这次预计要 ${humanBytes(estimated)}（含 15% 余量），空间可能不够。`,
      )
    }

    await ensureDocs(backupRoot)

    // ---- 2) 逐分类拷贝 ----
    state.phase = 'copying'
    for (const cat of plan) {
      if (abort.signal.aborted) throw aborted()
      state.category = cat.id
      state.categoryLabel = cat.label

      const catDir = join(backupRoot, cat.label, id)
      const catBytes = estimatedByCat.get(cat.id) || 0
      const catRec = {
        id: cat.id,
        label: cat.label,
        note: cat.note,
        dir: `${cat.label}\\${id}`,
        status: 'ok',
        sources: [],
        files: 0,
        bytes: 0,
      }

      if (catBytes > cfg.categoryCapBytes) {
        catRec.status = 'skipped'
        catRec.skippedReason = `预计 ${humanBytes(catBytes)}，超过单类上限 ${humanBytes(cfg.categoryCapBytes)}`
        warn(`${cat.label} 预计 ${humanBytes(catBytes)}，超过单类上限，本次整类跳过。`)
        categories.push(catRec)
        continue
      }

      for (const src of cat.sources) {
        if (abort.signal.aborted) throw aborted()
        const srcRec = {
          from: src.kind === 'dir' ? src.from : src.fromDir,
          to: src.to,
          kind: src.kind,
          status: 'ok',
          files: 0,
          bytes: 0,
          skipped: 0,
          hot: 0,
        }
        state.source = src.to

        if (src.kind === 'dir') {
          let st = null
          try {
            st = await stat(src.from)
          } catch {
            st = null
          }
          if (!st || !st.isDirectory()) {
            srcRec.status = 'missing'
            if (!src.optional) warn(`源目录不存在：${src.from}`)
            catRec.sources.push(srcRec)
            continue
          }

          const dstRoot = join(catDir, src.to)
          const rules = [...GLOBAL_EXCLUDE, ...((src.exclude) || [])]
          let listing
          try {
            listing = await walk(src.from, rules, {
              signal: abort.signal,
              onProgress: (n) => {
                state.totalFiles = Math.max(state.totalFiles, state.copiedFiles + n)
              },
            })
          } catch (e) {
            if (e && e.code === 'ABORTED') throw e
            srcRec.status = 'failed'
            srcRec.error = String((e && e.message) || e)
            noteError({ category: cat.id, from: src.from, error: srcRec.error })
            catRec.sources.push(srcRec)
            catRec.status = 'partial'
            continue
          }

          state.totalFiles = Math.max(state.totalFiles, state.copiedFiles + listing.files.length)

          const results = await pool(
            listing.files,
            async (f) => {
              if (abort.signal.aborted) throw aborted()
              const dst = join(dstRoot, f.rel)
              const r = await copyOne(f.abs, dst)
              if (r.ok) {
                srcRec.files += 1
                srcRec.bytes += Number.isFinite(r.size) ? r.size : f.size
                state.copiedFiles += 1
                state.copiedBytes += Number.isFinite(r.size) ? r.size : f.size
              } else if (r.hot) {
                srcRec.hot += 1
                if (hot.length < MAX_HOT) hot.push({ from: f.abs, reason: r.error })
              } else {
                srcRec.status = 'partial'
                noteError({ category: cat.id, from: f.abs, error: r.error })
              }
            },
            cfg.concurrency,
          )
          for (const e of results) {
            if (e && e.code === 'ABORTED') throw e
          }
          srcRec.skipped = listing.skipped
          if (listing.errors.length) {
            srcRec.status = 'partial'
            for (const e of listing.errors.slice(0, 20)) {
              noteError({ category: cat.id, from: e.path, error: e.error })
            }
          }
          targets.push({
            snapRel: `${cat.label}/${id}/${src.to}`,
            dest: src.from,
            kind: 'dir',
            files: srcRec.files,
            bytes: srcRec.bytes,
            empty: srcRec.files === 0,
            note: '整目录覆盖',
          })
        } else {
          // glob：只列 fromDir 这一层，按 match 挑文件
          let names = []
          try {
            names = (await readdir(src.fromDir)).filter((n) => src.match.test(n))
          } catch {
            names = []
          }
          if (names.length === 0) {
            srcRec.status = 'missing'
            if (!src.optional) warn(`源目录里没匹配到文件：${src.fromDir}`)
            catRec.sources.push(srcRec)
            continue
          }
          const dstRoot = join(catDir, src.to)
          for (const name of names) {
            if (abort.signal.aborted) throw aborted()
            src.match.lastIndex = 0
            const abs = join(src.fromDir, name)
            let st = null
            try {
              st = await stat(abs)
            } catch {
              st = null
            }
            if (!st || !st.isFile()) continue
            try {
              const r = await copyOne(abs, join(dstRoot, name))
              if (r.ok) {
                srcRec.files += 1
                srcRec.bytes += Number.isFinite(r.size) ? r.size : st.size
                state.copiedFiles += 1
                state.copiedBytes += Number.isFinite(r.size) ? r.size : st.size
              } else if (r.hot) {
                srcRec.hot += 1
                if (hot.length < MAX_HOT) hot.push({ from: abs, reason: r.error })
              } else {
                srcRec.status = 'partial'
                noteError({ category: cat.id, from: abs, error: r.error })
              }
            } catch (e) {
              srcRec.status = 'partial'
              noteError({ category: cat.id, from: abs, error: String((e && e.message) || e) })
            }
          }
          targets.push({
            snapRel: `${cat.label}/${id}/${src.to}`,
            dest: src.fromDir,
            kind: 'into-dir',
            files: srcRec.files,
            bytes: srcRec.bytes,
            empty: srcRec.files === 0,
            note: '把目录内文件拷回该目录（不删原有其它文件）',
          })
        }

        if (srcRec.status === 'failed' || srcRec.status === 'partial') catRec.status = 'partial'
        catRec.sources.push(srcRec)
        catRec.files += srcRec.files
        catRec.bytes += srcRec.bytes
        state.source = null
      }

      categories.push(catRec)
      state.category = null
      state.categoryLabel = null
    }

    // ---- 3) 收尾：manifest + 保留策略 ----
    state.phase = 'finishing'
    finishedAt = new Date()
    host = await hostInfo(dshHome)

    const totalFiles = categories.reduce((a, c) => a + c.files, 0)
    const totalBytes = categories.reduce((a, c) => a + c.bytes, 0)

    if (errors.length || hot.length) status = 'partial'

    const manifest = {
      version: 1,
      id,
      reason,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Date.now() - startedMs,
      dshHome,
      backupRoot,
      host,
      totals: {
        files: totalFiles,
        bytes: totalBytes,
        categories: categories.length,
        errors: errors.length,
        hot: hot.length,
      },
      categories,
      targets,
      warnings,
      errors,
      hot,
    }

    await mkdir(dirname(manifestPath(backupRoot, id)), { recursive: true })
    await writeFile(manifestPath(backupRoot, id), JSON.stringify(manifest, null, 2), 'utf8')

    // 保留策略
    let retention = { keep: [], drop: [] }
    try {
      const old = await listSnapshotIds(backupRoot)
      const all = [...new Set([...old, id])]
      retention = planRetention(all, {
        retentionDaily: cfg.retentionDaily,
        retentionWeekly: cfg.retentionWeekly,
      })
      if (retention.drop.length) {
        state.phase = 'cleaning'
        let tops = []
        try {
          tops = (await readdir(backupRoot, { withFileTypes: true }))
            .filter((t) => t.isDirectory() && !t.name.startsWith('_'))
            .map((t) => t.name)
        } catch {
          tops = []
        }
        for (const dropId of retention.drop) {
          for (const top of tops) {
            await rmrf(join(backupRoot, top, dropId))
          }
          await rmrf(manifestPath(backupRoot, dropId))
        }
      }
    } catch (e) {
      warn('清理旧快照时出错：' + String((e && e.message) || e))
    }

    const result = {
      ok: true,
      id,
      status,
      reason,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      durationMs: manifest.durationMs,
      files: totalFiles,
      bytes: totalBytes,
      categories,
      warnings,
      errors,
      hot,
      retention,
      manifest: manifestPath(backupRoot, id),
      host,
    }

    try {
      await appendHistory(backupRoot, {
        id,
        status,
        reason,
        at: manifest.finishedAt,
        durationMs: manifest.durationMs,
        files: totalFiles,
        bytes: totalBytes,
        errors: errors.length,
        hot: hot.length,
        dropped: retention.drop.length,
      })
    } catch {
      /* 历史写坏了不影响备份本身 */
    }

    state.lastResult = result
    state.running = false
    state.phase = 'idle'
    if (opts.onDone) {
      try {
        opts.onDone(result)
      } catch {
        /* ignore */
      }
    }
    return result
  } catch (e) {
    const cancelled = !!(e && e.code === 'ABORTED')
    status = cancelled ? 'cancelled' : 'failed'
    state.error = String((e && e.message) || e)
    if (!cancelled) {
      noteError({ category: state.category, from: state.source, error: state.error })
    }

    finishedAt = new Date()
    if (!host) {
      try {
        host = await hostInfo(dshHome)
      } catch {
        host = null
      }
    }
    const totalFiles = categories.reduce((a, c) => a + c.files, 0)
    const totalBytes = categories.reduce((a, c) => a + c.bytes, 0)

    const manifest = {
      version: 1,
      id,
      reason,
      status,
      error: state.error,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Date.now() - startedMs,
      dshHome,
      backupRoot,
      host,
      totals: {
        files: totalFiles,
        bytes: totalBytes,
        categories: categories.length,
        errors: errors.length,
        hot: hot.length,
      },
      categories,
      targets,
      warnings,
      errors,
      hot,
    }
    try {
      await mkdir(dirname(manifestPath(backupRoot, id)), { recursive: true })
      await writeFile(manifestPath(backupRoot, id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
    try {
      await appendHistory(backupRoot, {
        id,
        status,
        reason,
        at: manifest.finishedAt,
        durationMs: manifest.durationMs,
        files: totalFiles,
        bytes: totalBytes,
        errors: errors.length,
        hot: hot.length,
        error: state.error,
      })
    } catch {
      /* ignore */
    }

    const result = {
      ok: false,
      id,
      status,
      reason,
      error: state.error,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      durationMs: manifest.durationMs,
      files: totalFiles,
      bytes: totalBytes,
      categories,
      warnings,
      errors,
      hot,
      retention: { keep: [], drop: [] },
      manifest: manifestPath(backupRoot, id),
      host,
    }
    state.lastResult = result
    state.running = false
    state.phase = 'idle'
    if (opts.onDone) {
      try {
        opts.onDone(result)
      } catch {
        /* ignore */
      }
    }
    return result
  } finally {
    currentAbort = null
    state.category = null
    state.categoryLabel = null
    state.source = null
  }
}

/** 给面板用的一句话进度。 */
export function progressText() {
  if (!state.running) return '空闲'
  const parts = []
  if (state.categoryLabel) parts.push(state.categoryLabel)
  if (state.source) parts.push(state.source)
  const where = parts.length ? parts.join(' / ') : '准备中'
  return `${where} · 已拷 ${state.copiedFiles} 个文件 / ${humanBytes(state.copiedBytes)}`
}

export function startedAgo() {
  if (!state.startedAt) return null
  return humanMs(Date.now() - new Date(state.startedAt).getTime())
}
