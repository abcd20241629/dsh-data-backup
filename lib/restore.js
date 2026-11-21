// 还原（restore.js）
//
// 还原是危险动作，所以顺序固定：
//   1) 先把「这次会被覆盖的目标」整个抄到 _before-restore/<id>_<ts>/ —— 后悔药
//   2) 再按 manifest 里的 targets 逐项把快照内容拷回去（合并式，不删目标里多出来的文件）
//   3) 逐项记账，谁成功谁失败都写清楚
//
// 特别说明：这里做的是「合并式覆盖」——同名文件被快照版本替换，目标目录里
// 快照没有的文件原样留着。这样最坏情况是「没还原干净」，而不是「把新东西抹了」。

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { walk, pool, copyOne, humanBytes, rmrf } from './fsutil.js'
import { manifestPath, loadHistory } from './config.js'

export const restoreState = {
  running: false,
  phase: 'idle',
  id: null,
  target: null,
  doneFiles: 0,
  doneBytes: 0,
  totalFiles: 0,
  safetyDir: null,
  error: null,
  lastResult: null,
}

function aborted() {
  return Object.assign(new Error('已取消'), { code: 'ABORTED' })
}

export function safetyDirFor(backupRoot, id, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const ts = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  return join(backupRoot, '_before-restore', `${id}_${ts}`)
}

/** 把一个目录整棵抄到另一个目录（用于还原前的安全备份）。 */
async function copyTree(src, dst, { signal, onFile } = {}) {
  let listing
  try {
    listing = await walk(src, [], { signal })
  } catch {
    return { files: 0, bytes: 0, skipped: true }
  }
  let files = 0
  let bytes = 0
  const errs = await pool(
    listing.files,
    async (f) => {
      if (signal && signal.aborted) throw aborted()
      const r = await copyOne(f.abs, join(dst, f.rel))
      if (r.ok) {
        files += 1
        bytes += Number.isFinite(r.size) ? r.size : f.size
        onFile && onFile(files, bytes)
      }
    },
    8,
  )
  for (const e of errs) if (e && e.code === 'ABORTED') throw e
  return { files, bytes, errors: errs.map((e) => String((e && e.message) || e)) }
}

/**
 * 还原一份快照。
 * @param {{backupRoot: string, id: string, targets?: string[], dryRun?: boolean, signal?: AbortSignal}} opts
 *   targets：只还原 manifest 里 snapRel 匹配的部分（空 = 全还原）
 */
export async function restoreSnapshot(opts) {
  const backupRoot = opts.backupRoot
  const id = opts.id
  const dryRun = !!opts.dryRun
  const signal = opts.signal

  if (restoreState.running) return { ok: false, error: '已经有一次还原在跑了' }

  restoreState.running = true
  restoreState.phase = 'reading'
  restoreState.id = id
  restoreState.target = null
  restoreState.doneFiles = 0
  restoreState.doneBytes = 0
  restoreState.totalFiles = 0
  restoreState.safetyDir = null
  restoreState.error = null

  const steps = []
  let safety = null

  try {
    const manifest = JSON.parse(await readFile(manifestPath(backupRoot, id), 'utf8'))
    const allTargets = Array.isArray(manifest.targets) ? manifest.targets : []
    if (allTargets.length === 0) {
      throw new Error('这份快照的 manifest 里没有 targets，没法还原（可能是老版本或备份失败）')
    }
    const want = Array.isArray(opts.targets) && opts.targets.length ? new Set(opts.targets) : null
    const targets = want ? allTargets.filter((t) => want.has(t.snapRel) || want.has(t.dest)) : allTargets

    // ---- 1) 安全快照 ----
    restoreState.phase = 'safety'
    if (!dryRun) {
      const sdir = safetyDirFor(backupRoot, id)
      restoreState.safetyDir = sdir
      await mkdir(sdir, { recursive: true })
      const rec = { dir: sdir, items: [] }
      for (const t of targets) {
        if (t.kind === 'generated') {
          rec.items.push({ dest: '', skipped: true, reason: '清单文件，无需存后悔药' })
          continue
        }
        let st = null
        try {
          st = await stat(t.dest)
        } catch {
          st = null
        }
        if (!st) {
          rec.items.push({ dest: t.dest, skipped: true, reason: '目标本来就不存在' })
          continue
        }
        const sub = t.dest.replace(/[\\/:]/g, '_')
        if (st.isDirectory()) {
          const r = await copyTree(t.dest, join(sdir, sub), { signal })
          rec.items.push({ dest: t.dest, kind: 'dir', files: r.files, bytes: r.bytes })
        } else {
          try {
            const r = await copyOne(t.dest, join(sdir, sub))
            rec.items.push({ dest: t.dest, kind: 'file', files: r.ok ? 1 : 0, bytes: r.size || 0 })
          } catch (e) {
            rec.items.push({ dest: t.dest, error: String((e && e.message) || e) })
          }
        }
      }
      safety = rec
      await writeFile(join(sdir, '_before-restore.json'), JSON.stringify({ id, at: new Date().toISOString(), rec }, null, 2), 'utf8')
    }

    // ---- 2) 逐项拷回 ----
    restoreState.phase = 'restoring'
    for (const t of targets) {
      if (signal && signal.aborted) throw aborted()
      if (t.kind === 'generated') {
        steps.push({ dest: '', snapRel: t.snapRel, status: 'skipped', reason: '清单文件只供查看，不还原回活数据' })
        continue
      }
      restoreState.target = t.dest
      const snapDir = join(backupRoot, ...String(t.snapRel || '').split('/'))
      let st = null
      try {
        st = await stat(snapDir)
      } catch {
        st = null
      }
      if (!st || !st.isDirectory()) {
        // 源为空目录（没备份到任何文件）不算失败，只是没什么可还原
        const empty = t.empty || t.files === 0
        steps.push({
          dest: t.dest,
          snapRel: t.snapRel,
          status: empty ? 'empty' : 'missing',
          reason: empty ? '这个源当时是空的' : '快照里没这个目录',
        })
        continue
      }

      if (dryRun) {
        const listing = await walk(snapDir, [], { signal })
        steps.push({
          dest: t.dest,
          snapRel: t.snapRel,
          status: listing.files.length ? 'would-restore' : 'empty',
          files: listing.files.length,
        })
        continue
      }

      let listing
      try {
        listing = await walk(snapDir, [], { signal })
      } catch (e) {
        steps.push({ dest: t.dest, snapRel: t.snapRel, status: 'failed', error: String((e && e.message) || e) })
        continue
      }
      restoreState.totalFiles += listing.files.length

      let files = 0
      let bytes = 0
      let failed = 0
      const errs = await pool(
        listing.files,
        async (f) => {
          if (signal && signal.aborted) throw aborted()
          const dst = join(t.dest, f.rel)
          const r = await copyOne(f.abs, dst, 2)
          if (r.ok) {
            files += 1
            bytes += Number.isFinite(r.size) ? r.size : f.size
            restoreState.doneFiles += 1
            restoreState.doneBytes += Number.isFinite(r.size) ? r.size : f.size
          } else {
            failed += 1
          }
        },
        8,
      )
      for (const e of errs) if (e && e.code === 'ABORTED') throw e
      steps.push({
        dest: t.dest,
        snapRel: t.snapRel,
        status: failed ? 'partial' : 'ok',
        files,
        bytes,
        failed,
      })
    }

    const result = {
      ok: steps.every((s) => s.status === 'ok' || s.status === 'would-restore' || s.status === 'empty' || s.status === 'skipped'),
      id,
      dryRun,
      at: new Date().toISOString(),
      safety,
      steps,
      totals: {
        files: steps.reduce((a, s) => a + (s.files || 0), 0),
        bytes: steps.reduce((a, s) => a + (s.bytes || 0), 0),
      },
      note: '合并式还原：同名文件被替换，目标目录里快照没有的文件保留。还原完请重启 DSH。',
    }
    restoreState.lastResult = result
    restoreState.running = false
    restoreState.phase = 'idle'
    restoreState.target = null
    return result
  } catch (e) {
    const cancelled = !!(e && e.code === 'ABORTED')
    restoreState.error = String((e && e.message) || e)
    restoreState.running = false
    restoreState.phase = 'idle'
    return {
      ok: false,
      id,
      cancelled,
      error: restoreState.error,
      safety,
      steps,
      at: new Date().toISOString(),
    }
  }
}

/** 列出可还原的快照（带 manifest 摘要），给面板下拉用。 */
export async function listRestorable(backupRoot) {
  const { listSnapshotIds } = await import('./config.js')
  const ids = await listSnapshotIds(backupRoot)
  const out = []
  for (const id of ids.slice().reverse()) {
    try {
      const m = JSON.parse(await readFile(manifestPath(backupRoot, id), 'utf8'))
      out.push({
        id,
        status: m.status,
        reason: m.reason,
        finishedAt: m.finishedAt,
        files: m.totals && m.totals.files,
        bytes: m.totals && m.totals.bytes,
        bytesText: humanBytes((m.totals && m.totals.bytes) || 0),
        categories: (m.categories || []).map((c) => c.label),
      })
    } catch {
      out.push({ id, status: 'unreadable' })
    }
  }
  return out
}
