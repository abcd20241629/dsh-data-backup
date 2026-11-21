// 文件系统小工具（fsutil.js）
//
// 只做四件事：走目录、按规则剪枝、按并发池拷文件、把人话单位换算。
// 刻意不依赖 externa 命令（robocopy / xcopy），这样换机器、换系统语言都不会突然失灵。

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, copyFile, unlink, rmdir, open } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** 统一成正斜杠，方便写排除正则。 */
export const posix = (p) => p.split(sep).join('/')

export function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = n
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

export function humanMs(ms) {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function mkdirp(p) {
  await mkdir(p, { recursive: true })
}

/** 判断某个相对路径是否该剪掉。 */
export function excluded(relPosix, rules) {
  if (!rules || rules.length === 0) return false
  for (const r of rules) {
    r.lastIndex = 0
    if (r.test(relPosix)) return true
  }
  return false
}

/**
 * 走一棵目录树，返回文件清单。
 * @param {string} root
 * @param {RegExp[]} rules
 * @param {{signal?: AbortSignal, onProgress?: (n:number, bytes:number)=>void}} [opts]
 * @returns {Promise<{files: Array<{abs:string, rel:string, size:number, mtimeMs:number}>, skipped:number, errors:Array<{path:string, error:string}>}>}
 */
export async function walk(root, rules = [], opts = {}) {
  const files = []
  const errors = []
  let skipped = 0
  let bytes = 0
  const stack = ['']
  while (stack.length) {
    if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
    const rel = stack.pop()
    const dir = rel ? join(root, rel) : root
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch (e) {
      errors.push({ path: dir, error: String(e?.message || e) })
      continue
    }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (excluded(childRel, rules)) {
        skipped += 1
        continue
      }
      if (e.isDirectory()) {
        stack.push(childRel)
        continue
      }
      if (!e.isFile()) continue // 符号链接/设备：不跟，避免绕圈
      const abs = join(root, childRel)
      try {
        const st = await stat(abs)
        files.push({ abs, rel: childRel, size: st.size, mtimeMs: st.mtimeMs })
        bytes += st.size
      } catch (err) {
        errors.push({ path: abs, error: String(err?.message || err) })
      }
    }
    opts.onProgress?.(files.length, bytes)
  }
  return { files, skipped, errors }
}

/**
 * 并发池：最多同时跑 concurrency 个任务，收集每个任务的错误。
 * @template T
 * @param {T[]} items
 * @param {(item:T, index:number)=>Promise<any>} worker
 * @param {number} concurrency
 */
export async function pool(items, worker, concurrency = 8) {
  const errors = []
  let cursor = 0
  const n = Math.max(1, Math.min(64, Math.floor(concurrency) || 8))
  const runners = Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        await worker(items[i], i)
      } catch (e) {
        errors.push(e)
      }
    }
  })
  await Promise.all(runners)
  return errors
}

/**
 * 拷一个文件：先记源大小/时间 → 拷 → 再记一次；变了就重试一次，
 * 还变就当成「热文件」返回 warning（会话正在写的时候会遇到）。
 */
export async function copyOne(srcAbs, dstAbs, retries = 1) {
  await mkdirp(dirname(dstAbs))
  let last = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let before
    try {
      before = await stat(srcAbs)
    } catch (e) {
      if (e?.code === 'ENOENT') return { ok: false, hot: true, error: '源文件在备份途中消失' }
      throw e
    }
    try {
      await copyFile(srcAbs, dstAbs)
    } catch (e) {
      if (e?.code === 'ENOENT') return { ok: false, hot: true, error: '源文件在备份途中消失' }
      throw e
    }
    let after
    try {
      after = await stat(srcAbs)
    } catch {
      return { ok: false, hot: true, error: '源文件在备份途中消失' }
    }
    last = after
    const stable = after.size === before.size && Math.abs(after.mtimeMs - before.mtimeMs) < 1
    if (stable) {
      let dstSize = -1
      try {
        dstSize = (await stat(dstAbs)).size
      } catch {
        /* ignore */
      }
      if (dstSize === before.size) return { ok: true, size: before.size }
      return { ok: false, error: `拷贝后大小不符（源 ${before.size} / 目标 ${dstSize}）` }
    }
  }
  return { ok: false, hot: true, size: last?.size, error: '文件仍在写入，本次记为热文件（下次备份会补上）' }
}

/** 删一个目录树（用于清理旧快照）。找不到就当成功。 */
export async function rmrf(p) {
  let ok = true
  try {
    const st = await stat(p)
    if (!st.isDirectory()) {
      await unlink(p)
      return true
    }
  } catch {
    return true
  }
  const stack = [p]
  const dirs = []
  while (stack.length) {
    const dir = stack.pop()
    dirs.push(dir)
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      ok = false
      continue
    }
    for (const e of ents) {
      const child = join(dir, e.name)
      if (e.isDirectory()) stack.push(child)
      else {
        try {
          await unlink(child)
        } catch {
          ok = false
        }
      }
    }
  }
  for (const d of dirs.reverse()) {
    try {
      await rmdir(d)
    } catch {
      ok = false
    }
  }
  return ok
}

/** 目录体积（只 stat）。 */
export async function dirSize(root) {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          bytes += (await stat(p)).size
          files += 1
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { bytes, files }
}

/** 剩余空间（字节）。Windows 用 fs.statfs 拿不到时退回 null。 */
export async function freeSpace(dirPath) {
  try {
    let p = dirPath
    while (p && p !== dirname(p)) {
      try {
        const st = await stat(p)
        if (st.isDirectory()) break
      } catch {
        /* 往上找 */
      }
      p = dirname(p)
    }
    const { statfs } = await import('node:fs/promises')
    const s = await statfs(p)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch {
    return null
  }
}

export { exists, mkdirp, relative, join }
