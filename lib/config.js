// 配置与保留策略（config.js）
//
// 配置落在 <dshHome>/plugins-data/dsh-data-backup/config.json —— 这个目录本身
// 也在「插件数据」分类的备份范围里，所以配置也会跟着走。
// 留一份纯函数的保留策略，方便 tests 直接断言，不用真去删盘上的东西。

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const DEFAULTS = {
  version: 1,
  /** 是否启用定时自动备份 */
  enabled: true,
  /** 备份根目录（必须在一开始的计划里写死在 F 盘） */
  backupRoot: 'F:\\dsh重要数据备份',
  /** 每天几点整跑（本地时区，HH:mm） */
  dailyAt: '03:00',
  /** 日快照保留份数 */
  retentionDaily: 7,
  /** 周快照保留份数 */
  retentionWeekly: 4,
  /** 是否把会话附件（attachments）也备上（体积大但恢复体验完整） */
  withAttachments: true,
  /** 是否带上 ~/.codex（不在 DSH 里，但丢了同样难受） */
  withCodex: true,
  /** 拷贝并发数 */
  concurrency: 8,
  /** 单类体积上限（字节）；超过就跳过整类 */
  categoryCapBytes: 12 * 1024 * 1024 * 1024,
  /** 校验时是否做 sha256 深校验（慢，但能发现悄悄烂掉的文件） */
  deepVerify: false,
}

export function configPath(dshHome) {
  return join(dshHome || process.env.DSH_HOME || '', 'plugins-data', 'dsh-data-backup', 'config.json')
}

/** HH:mm 合法化：小时 0-23、分钟 0-59，统一成两位。不合法返回 null。 */
export function normalizeClock(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60)) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

export async function loadConfig(dshHome) {
  const p = configPath(dshHome)
  let raw = null
  try {
    raw = JSON.parse(await readFile(p, 'utf8'))
  } catch {
    raw = null
  }
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  // 数值兜底，防止手改成字符串
  for (const k of ['retentionDaily', 'retentionWeekly', 'concurrency', 'categoryCapBytes']) {
    const n = Number(cfg[k])
    cfg[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS[k]
  }
  if (typeof cfg.backupRoot !== 'string' || !cfg.backupRoot.trim()) cfg.backupRoot = DEFAULTS.backupRoot
  cfg.dailyAt = normalizeClock(cfg.dailyAt) || DEFAULTS.dailyAt
  return cfg
}

export async function saveConfig(dshHome, cfg) {
  const p = configPath(dshHome)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(cfg, null, 2), 'utf8')
  return p
}

/** 只允许改这些字段，别的忽略（面板传上来的脏字段不至于把配置写坏）。 */
export const EDITABLE = new Set([
  'enabled',
  'backupRoot',
  'dailyAt',
  'retentionDaily',
  'retentionWeekly',
  'withAttachments',
  'withCodex',
  'concurrency',
  'categoryCapBytes',
  'deepVerify',
])

export function patchConfig(cfg, patch) {
  const next = { ...cfg }
  if (!patch || typeof patch !== 'object') return next
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue
    if (k === 'backupRoot') {
      if (typeof v === 'string' && v.trim()) next[k] = v.trim()
      continue
    }
    if (k === 'dailyAt') {
      const clock = normalizeClock(v)
      if (clock) next[k] = clock
      continue
    }
    if (typeof DEFAULTS[k] === 'boolean') {
      next[k] = Boolean(v)
      continue
    }
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) next[k] = Math.floor(n)
  }
  return next
}

// ---------- 快照命名与保留策略 ----------

const pad = (n) => String(n).padStart(2, '0')

/** 快照 id：2026-11-21_030000（本地时间，字典序 == 时间序）。 */
export function snapshotId(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 从 id 里取日期；不合法返回 null。 */
export function idDate(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(String(id || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

/** ISO 周键，如 2026-W47。 */
export function weekKey(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = (t.getDay() + 6) % 7 // 周一=0
  t.setDate(t.getDate() - day + 3) // 移到本周四
  const firstThu = new Date(t.getFullYear(), 0, 4)
  const fday = (firstThu.getDay() + 6) % 7
  firstThu.setDate(firstThu.getDate() - fday + 3)
  const week = 1 + Math.round((t - firstThu) / (7 * 86400000))
  return `${t.getFullYear()}-W${pad(week)}`
}

/**
 * 纯函数：给定已有 id 列表和保留规则，返回要保留哪些。
 * 规则：
 *   - 每天最后一份 → 日保留池，取最近 retentionDaily 天
 *   - 每周最后一份 → 周保留池，取最近 retentionWeekly 周
 *   - 最新一份永远保留
 */
export function planRetention(ids, { retentionDaily = 7, retentionWeekly = 4 } = {}) {
  const valid = []
  for (const id of ids) {
    const d = idDate(id)
    if (d) valid.push({ id, d })
  }
  valid.sort((a, b) => (a.d - b.d) || a.id.localeCompare(b.id))
  if (valid.length === 0) return { keep: [], drop: [] }

  const byDay = new Map()
  for (const v of valid) {
    const k = `${v.d.getFullYear()}-${pad(v.d.getMonth() + 1)}-${pad(v.d.getDate())}`
    byDay.set(k, v.id) // 后写覆盖前写 → 每天最后一份
  }
  const dayKeys = [...byDay.keys()].sort()
  const dailyKeep = new Set(dayKeys.slice(Math.max(0, dayKeys.length - retentionDaily)).map((k) => byDay.get(k)))

  const byWeek = new Map()
  for (const v of valid) {
    const k = weekKey(v.d)
    byWeek.set(k, v.id)
  }
  const weekKeys = [...byWeek.keys()].sort()
  const weeklyKeep = new Set(weekKeys.slice(Math.max(0, weekKeys.length - retentionWeekly)).map((k) => byWeek.get(k)))

  const keep = new Set([...dailyKeep, ...weeklyKeep, valid[valid.length - 1].id])
  const drop = valid.filter((v) => !keep.has(v.id)).map((v) => v.id)
  return { keep: [...keep].sort(), drop }
}

// ---------- 历史记录 ----------

export function historyPath(backupRoot) {
  return join(backupRoot, '_state', 'history.json')
}

export async function loadHistory(backupRoot, limit = 50) {
  try {
    const arr = JSON.parse(await readFile(historyPath(backupRoot), 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr.slice(-limit)
  } catch {
    return []
  }
}

export async function appendHistory(backupRoot, entry, limit = 50) {
  const arr = await loadHistory(backupRoot, 1000)
  arr.push(entry)
  const trimmed = arr.slice(-limit)
  const p = historyPath(backupRoot)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(trimmed, null, 2), 'utf8')
  return trimmed
}

/** 列出备份根下已有的快照 id（读 _manifests 目录名）。 */
export async function listSnapshotIds(backupRoot) {
  const dir = join(backupRoot, '_manifests')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((n) => idDate(n))
    .sort()
}

export function manifestPath(backupRoot, id) {
  return join(backupRoot, '_manifests', `${id}.json`)
}
