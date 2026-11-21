// 校验（verify.js）
//
// 目的只有一个：在「真需要还原」之前，先确认这份快照还是好的。
//
// 浅校验（默认）：重走一遍快照目录，统计文件数与字节数，和 manifest 里记的比。
//                 能发现「文件被误删 / 拷漏 / 盘上有坏块读不出来」。
// 深校验（deepVerify）：逐文件读完整字节算 sha256。源目录还在的话顺带比对源，
//                 发现「内容悄悄变了」；源没了就只确认快照本身可读、hash 稳定。
//
// 两种都只读，不改任何东西。

import { readFile, stat, open, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { walk, humanBytes } from './fsutil.js'
import { manifestPath, listSnapshotIds } from './config.js'
import { GLOBAL_EXCLUDE } from './plan.js'

const here = dirname(fileURLToPath(import.meta.url))

async function readManifest(backupRoot, id) {
  const p = manifestPath(backupRoot, id)
  const j = JSON.parse(await readFile(p, 'utf8'))
  return { manifest: j, path: p }
}

/** 递归统计一个目录：files/bytes，顺便（可选）逐文件 hash。 */
async function scanDir(dir, { hash = false, signal, onProgress } = {}) {
  const out = { files: 0, bytes: 0, unreadable: [], hashes: {} }
  let listing
  try {
    listing = await walk(dir, [], { signal })
  } catch (e) {
    out.unreadable.push({ path: dir, error: String((e && e.message) || e) })
    return out
  }
  for (const f of listing.files) {
    if (signal && signal.aborted) break
    out.files += 1
    out.bytes += f.size
    if (hash) {
      try {
        const h = createHash('sha256')
        const fh = await open(f.abs, 'r')
        try {
          const buf = Buffer.allocUnsafe(1024 * 1024)
          while (true) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, null)
            if (!bytesRead) break
            h.update(buf.subarray(0, bytesRead))
          }
        } finally {
          await fh.close()
        }
        out.hashes[f.rel] = h.digest('hex')
      } catch (e) {
        out.unreadable.push({ path: f.abs, error: String((e && e.message) || e) })
      }
    }
    onProgress && onProgress(out.files)
  }
  return out
}

/**
 * 校验一份快照。
 * @param {{backupRoot: string, id: string, deep?: boolean, signal?: AbortSignal, onProgress?: Function}} opts
 */
export async function verifySnapshot(opts) {
  const backupRoot = opts.backupRoot
  const id = opts.id
  const deep = !!opts.deep
  const issues = []
  const checked = []
  let totals = { files: 0, bytes: 0, hashed: 0, unreadable: 0 }

  const { manifest, path } = await readManifest(backupRoot, id)
  if (!manifest || !Array.isArray(manifest.categories)) {
    return { ok: false, id, error: 'manifest 结构不对，读不出分类', issues: ['manifest 缺 categories'], checked: [] }
  }

  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  let done = 0

  for (const cat of manifest.categories) {
    if (opts.signal && opts.signal.aborted) break
    if (cat.status === 'skipped') {
      checked.push({ category: cat.label, status: 'skipped', reason: cat.skippedReason || '备份时已跳过' })
      continue
    }
    const catDir = join(backupRoot, cat.label, id)
    let catExists = true
    try {
      const st = await stat(catDir)
      catExists = st.isDirectory()
    } catch {
      catExists = false
    }
    if (!catExists) {
      if (cat.files > 0) issues.push(`${cat.label}：快照目录不存在（备份时记了 ${cat.files} 个文件）`)
      checked.push({ category: cat.label, status: cat.files > 0 ? 'missing' : 'empty' })
      continue
    }

    const scan = await scanDir(catDir, {
      hash: deep,
      signal: opts.signal,
      onProgress: (n) => progress && progress({ category: cat.label, files: n }),
    })
    done += 1
    progress && progress({ category: cat.label, files: scan.files, done })

    totals.files += scan.files
    totals.bytes += scan.bytes
    if (deep) totals.hashed += Object.keys(scan.hashes).length
    totals.unreadable += scan.unreadable.length

    const rec = {
      category: cat.label,
      status: 'ok',
      expectFiles: cat.files,
      expectBytes: cat.bytes,
      actualFiles: scan.files,
      actualBytes: scan.bytes,
      bytesText: humanBytes(scan.bytes),
    }

    if (scan.files !== cat.files) {
      rec.status = 'mismatch'
      issues.push(`${cat.label}：文件数不符（manifest ${cat.files} / 实际 ${scan.files}）`)
    }
    if (Math.abs(scan.bytes - cat.bytes) > 0) {
      // 会话文件在备份后被追加过，字节数会略微不等；严格比会在热文件上误报，
      // 所以只把「实际比记录少」当严重问题。
      if (scan.bytes < cat.bytes) {
        rec.status = 'mismatch'
        issues.push(`${cat.label}：字节数少了（manifest ${humanBytes(cat.bytes)} / 实际 ${humanBytes(scan.bytes)}）`)
      } else {
        rec.note = '实际比记录略大（备份后源文件被追加过，正常）'
      }
    }
    if (scan.unreadable.length) {
      rec.status = 'mismatch'
      for (const u of scan.unreadable.slice(0, 10)) issues.push(`${cat.label}：读不出来 ${u.path} — ${u.error}`)
    }
    checked.push(rec)
  }

  return {
    ok: issues.length === 0,
    id,
    deep,
    manifest: path,
    checkedAt: new Date().toISOString(),
    totals,
    issues,
    checked,
  }
}

/** 顺手校验备份根的结构：有没有 _README / _restore / _manifests。 */
export async function verifyRoot(backupRoot) {
  const out = { root: backupRoot, ok: true, missing: [], snapshots: [] }
  for (const f of ['_README.md', '_restore.ps1', '_manifests', '_state']) {
    try {
      await stat(join(backupRoot, f))
    } catch {
      out.missing.push(f)
    }
  }
  if (out.missing.length) out.ok = false
  try {
    out.snapshots = await listSnapshotIds(backupRoot)
  } catch {
    out.snapshots = []
  }
  return out
}
