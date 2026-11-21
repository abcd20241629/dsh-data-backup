// 冒烟测试（tests/smoke.mjs）
//
// 不碰真实数据：造一个假的 DSH_HOME（几个小目录），把备份根放在系统临时目录，
// 跑一遍 备份 → 校验 → 改内容 → 还原，确认整条链子是通的。
//
// 跑法：node tests/smoke.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  DEFAULTS,
  patchConfig,
  planRetention,
  snapshotId,
  idDate,
  weekKey,
  loadConfig,
  saveConfig,
  listSnapshotIds,
} from '../lib/config.js'
import { buildPlan, measureSource, GLOBAL_EXCLUDE } from '../lib/plan.js'
import { humanBytes, humanMs, excluded, walk, pool, copyOne, dirSize, rmrf, freeSpace } from '../lib/fsutil.js'
import { runBackup, state as runState } from '../lib/snapshot.js'
import { verifySnapshot, verifyRoot } from '../lib/verify.js'
import { restoreSnapshot, listRestorable, safetyDirFor } from '../lib/restore.js'

// ---------- 小工具 ----------

async function mkfile(p, text) {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, text, 'utf8')
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

let TMP = null
async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'dshdb-'))
  const dshHome = join(root, 'dshhome')
  const backupRoot = join(root, '备份')
  await mkdir(dshHome, { recursive: true })
  await mkdir(backupRoot, { recursive: true })

  // 会话：两个 .zstd 分片 + 子目录
  await mkfile(join(dshHome, 'sessions', 'ws-a', 's1.zstd'), 'session-one-content')
  await mkfile(join(dshHome, 'sessions', 'ws-a', 's2.zstd'), 'session-two-content')
  await mkfile(join(dshHome, 'sessions', 'index.jsonl'), '{"id":"s1"}\n')

  // 技能：SKILL.md + references
  await mkfile(join(dshHome, 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  await mkfile(join(dshHome, 'skills', 'demo', 'references', 'a.md'), 'ref a\n')

  // 会被剪掉的东西
  await mkfile(join(dshHome, 'sessions', 'node_modules', 'x.js'), 'should not be copied')
  await mkfile(join(dshHome, 'sessions', 'debug.log'), 'should not be copied')
  await mkfile(join(dshHome, 'skills', 'demo', '__pycache__', 'c.pyc'), 'nope')

  return { root, dshHome, backupRoot }
}

const slimPlan = (dshHome) => [
  {
    id: 'sessions',
    label: '会话数据',
    note: 'test',
    sources: [{ kind: 'dir', from: join(dshHome, 'sessions'), to: 'sessions', optional: true }],
  },
  {
    id: 'skills',
    label: '技能数据',
    note: 'test',
    sources: [{ kind: 'dir', from: join(dshHome, 'skills'), to: 'skills', optional: true }],
  },
]

const testCfg = (backupRoot) => ({
  ...DEFAULTS,
  backupRoot,
  concurrency: 4,
  categoryCapBytes: 50 * 1024 * 1024,
  withAttachments: false,
  withCodex: false,
  retentionDaily: 7,
  retentionWeekly: 4,
})

// ---------- 纯函数 ----------

test('config: DEFAULTS 与 patchConfig', () => {
  assert.equal(DEFAULTS.backupRoot, 'F:\\dsh重要数据备份')
  assert.equal(DEFAULTS.retentionDaily, 7)

  const base = { ...DEFAULTS }
  const next = patchConfig(base, {
    retentionDaily: 3,
    dailyAt: '04:30',
    enabled: false,
    withCodex: false,
    backupRoot: 'E:\\bk',
    garbage: 'ignored',
  })
  assert.equal(next.retentionDaily, 3)
  assert.equal(next.dailyAt, '04:30')
  assert.equal(next.enabled, false)
  assert.equal(next.withCodex, false)
  assert.equal(next.backupRoot, 'E:\\bk')
  assert.equal('garbage' in next, false)

  // 非法值不该写进去
  const bad = patchConfig(base, { dailyAt: '99:99', retentionDaily: -1, backupRoot: '   ' })
  assert.equal(bad.dailyAt, DEFAULTS.dailyAt)
  assert.equal(bad.retentionDaily, DEFAULTS.retentionDaily)
  assert.equal(bad.backupRoot, DEFAULTS.backupRoot)
})

test('config: 快照 id 与周键', () => {
  const d = new Date(2026, 10, 21, 3, 0, 0) // 2026-11-21 03:00:00
  const id = snapshotId(d)
  assert.equal(id, '2026-11-21_030000')
  const back = idDate(id)
  assert.equal(back.getFullYear(), 2026)
  assert.equal(back.getMonth() + 1, 11)
  assert.equal(back.getDate(), 21)
  assert.equal(idDate('not-an-id'), null)
  assert.match(weekKey(d), /^\d{4}-W\d{2}$/)
})

test('config: 保留策略（7 天 + 4 周）', () => {
  // 造 40 天、每天两份
  const ids = []
  for (let i = 0; i < 40; i += 1) {
    const d = new Date(2026, 8, 1 + i, 3, 0, 0)
    ids.push(snapshotId(d))
    const d2 = new Date(2026, 8, 1 + i, 15, 0, 0)
    ids.push(snapshotId(d2))
  }
  const { keep, drop } = planRetention(ids, { retentionDaily: 7, retentionWeekly: 4 })
  assert.equal(keep.length + drop.length, ids.length)
  assert.ok(drop.length > 0)

  // 最近 7 天的「每天最后一份」必须在 keep 里
  const byDay = new Map()
  for (const id of ids) {
    const d = idDate(id)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    byDay.set(k, id)
  }
  const dayKeys = [...byDay.keys()].sort().slice(-7)
  for (const k of dayKeys) assert.ok(keep.includes(byDay.get(k)), `应保留 ${k} 的最后一份`)

  // 最新一份永远保留
  assert.ok(keep.includes(ids[ids.length - 1]))

  // 空列表不炸
  assert.deepEqual(planRetention([]), { keep: [], drop: [] })
})

test('plan: buildPlan 覆盖到所有关键分类', () => {
  const cats = buildPlan({ dshHome: 'D:\\dsh\\.dsh', withCodex: true, withAttachments: true })
  const ids = cats.map((c) => c.id)
  for (const need of ['sessions', 'attachments', 'skills', 'memory', 'plugin-data', 'config', 'plugin-src', 'codex']) {
    assert.ok(ids.includes(need), `缺分类 ${need}`)
  }
  for (const c of cats) {
    assert.ok(c.label && c.label.length > 0)
    assert.ok(Array.isArray(c.sources) && c.sources.length > 0)
    for (const s of c.sources) {
      assert.ok(s.kind === 'dir' || s.kind === 'glob')
      assert.ok(s.to)
      if (s.kind === 'dir') assert.ok(s.from)
      else assert.ok(s.fromDir && s.match instanceof RegExp)
    }
  }
  // 关掉两个可选项就真的少两类
  const lean = buildPlan({ dshHome: 'D:\\dsh\\.dsh', withCodex: false, withAttachments: false }).map((c) => c.id)
  assert.ok(!lean.includes('codex'))
  assert.ok(!lean.includes('attachments'))
})

test('fsutil: humanBytes / humanMs / excluded', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(1023), '1023 B')
  assert.equal(humanBytes(1024), '1.0 KB')
  assert.equal(humanBytes(1536), '1.5 KB')
  assert.equal(humanBytes(NaN), '?')
  assert.match(humanMs(500), /ms$/)
  assert.match(humanMs(1500), /s$/)
  assert.match(humanMs(90000), /分/)

  assert.equal(excluded('node_modules/x.js', GLOBAL_EXCLUDE), true)
  assert.equal(excluded('a/.git/config', GLOBAL_EXCLUDE), true)
  assert.equal(excluded('logs/run.txt', GLOBAL_EXCLUDE), true)
  assert.equal(excluded('debug.log', GLOBAL_EXCLUDE), true)
  assert.equal(excluded('skills/demo/SKILL.md', GLOBAL_EXCLUDE), false)
})

test('fsutil: walk 剪枝 + copyOne 往返', async () => {
  const { dshHome, root } = await makeSandbox()
  const listing = await walk(join(dshHome, 'sessions'), GLOBAL_EXCLUDE)
  const rels = listing.files.map((f) => f.rel.replace(/\\/g, '/')).sort()
  assert.deepEqual(rels, ['index.jsonl', 'ws-a/s1.zstd', 'ws-a/s2.zstd'])
  assert.ok(listing.skipped >= 2)

  const dst = join(root, 'copy-target', 's1.zstd')
  const r = await copyOne(listing.files.find((f) => f.rel.endsWith('s1.zstd')).abs, dst)
  assert.equal(r.ok, true)
  assert.equal(await readFile(dst, 'utf8'), 'session-one-content')

  // 并发池：五个任务都跑到
  const hits = []
  const errs = await pool([1, 2, 3, 4, 5], async (n) => {
    hits.push(n)
  }, 3)
  assert.equal(errs.length, 0)
  assert.deepEqual(hits.sort(), [1, 2, 3, 4, 5])

  // 目录体积
  const sz = await dirSize(join(dshHome, 'sessions'))
  assert.ok(sz.files >= 3 && sz.bytes > 0)
  assert.ok(await freeSpace(root))
})

// ---------- 端到端 ----------

test('端到端：备份 → 校验 → 还原', async () => {
  const { root, dshHome, backupRoot } = await makeSandbox()
  TMP = root
  const cfg = testCfg(backupRoot)

  const result = await runBackup({
    dshHome,
    cfg,
    reason: '测试',
    planOverride: slimPlan(dshHome),
  })

  assert.equal(result.ok, true, `备份应当成功，实际：${result.error || ''}`)
  assert.equal(result.status, 'ok')
  assert.ok(result.files >= 5, `应拷到至少 5 个文件，实际 ${result.files}`)

  const id = result.id
  assert.match(id, /^\d{4}-\d{2}-\d{2}_\d{6}$/)

  // 分类目录与内容
  const sessDir = join(backupRoot, '会话数据', id, 'sessions')
  assert.ok(await exists(join(sessDir, 'ws-a', 's1.zstd')))
  assert.ok(await exists(join(sessDir, 'index.jsonl')))
  // 剪掉的东西不该出现在快照里
  assert.equal(await exists(join(sessDir, 'node_modules')), false)
  assert.equal(await exists(join(sessDir, 'debug.log')), false)

  // 附属文件
  assert.ok(await exists(join(backupRoot, '_README.md')))
  assert.ok(await exists(join(backupRoot, '_restore.ps1')))
  assert.ok(await exists(join(backupRoot, '_manifests', `${id}.json`)))

  // manifest 结构
  const manifest = JSON.parse(await readFile(join(backupRoot, '_manifests', `${id}.json`), 'utf8'))
  assert.equal(manifest.id, id)
  assert.equal(manifest.reason, '测试')
  assert.equal(manifest.status, 'ok')
  assert.ok(Array.isArray(manifest.targets) && manifest.targets.length >= 2)
  const tSess = manifest.targets.find((t) => t.snapRel.includes('/sessions'))
  assert.ok(tSess, 'targets 里应有 sessions')
  assert.equal(tSess.dest, join(dshHome, 'sessions'))
  assert.ok(manifest.host && manifest.host.node)

  // 历史与列表
  const list = await listSnapshotIds(backupRoot)
  assert.ok(list.includes(id))
  const restorable = await listRestorable(backupRoot)
  assert.equal(restorable[0].id, id)
  assert.equal(restorable[0].status, 'ok')

  // 备份根结构自检
  const rootCheck = await verifyRoot(backupRoot)
  assert.equal(rootCheck.ok, true, `根缺东西：${rootCheck.missing.join(',')}`)

  // ---- 校验：应通过 ----
  const v1 = await verifySnapshot({ backupRoot, id, deep: false })
  assert.equal(v1.ok, true, `浅校验应当通过，问题：${(v1.issues || []).join(' | ')}`)
  assert.ok(v1.totals.files >= 5)

  // 深校验也能过
  const v2 = await verifySnapshot({ backupRoot, id, deep: true })
  assert.equal(v2.ok, true, `深校验应当通过，问题：${(v2.issues || []).join(' | ')}`)
  assert.ok(v2.totals.hashed >= 5)

  // ---- 还原：先把活数据弄坏，再从快照还原 ----
  await writeFile(join(dshHome, 'sessions', 'ws-a', 's1.zstd'), 'BROKEN', 'utf8')
  await writeFile(join(dshHome, 'skills', 'demo', 'SKILL.md'), 'BROKEN SKILL', 'utf8')
  const restore = await restoreSnapshot({ backupRoot, id })
  assert.equal(restore.ok, true, `还原应当成功：${restore.error || ''}`)
  assert.ok(restore.safety && restore.safety.dir, '应当留下安全备份目录')
  assert.ok(await exists(join(restore.safety.dir, '_before-restore.json')))
  assert.equal(await readFile(join(dshHome, 'sessions', 'ws-a', 's1.zstd'), 'utf8'), 'session-one-content')
  assert.equal(await readFile(join(dshHome, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# demo skill\n')

  // 还原后快照本身仍然完好
  const v4 = await verifySnapshot({ backupRoot, id, deep: false })
  assert.equal(v4.ok, true, '还原后快照应当依然完整')

  // ---- 演练模式不该改盘 ----
  await writeFile(join(dshHome, 'sessions', 'ws-a', 's1.zstd'), 'AGAIN-BROKEN', 'utf8')
  const dry = await restoreSnapshot({ backupRoot, id, dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(await readFile(join(dshHome, 'sessions', 'ws-a', 's1.zstd'), 'utf8'), 'AGAIN-BROKEN')

  // ---- 弄坏快照：删掉快照里的一个文件，校验必须报出来 ----
  await rm(join(sessDir, 'ws-a', 's2.zstd'))
  const v3 = await verifySnapshot({ backupRoot, id, deep: false })
  assert.equal(v3.ok, false, '删了快照文件之后校验应当失败')
  assert.ok(v3.issues.length > 0)

  // ---- 保留策略实跑：连打 3 次（同一天），默认只留 1 份（每日最后一份） ----
  const cfg2 = { ...cfg, retentionDaily: 1, retentionWeekly: 1 }
  const results = []
  for (let i = 0; i < 3; i += 1) {
    // 错开一秒，保证 id 不撞
    await new Promise((r) => setTimeout(r, 1050))
    results.push(await runBackup({ dshHome, cfg: cfg2, reason: `连打${i}`, planOverride: slimPlan(dshHome) }))
  }
  assert.equal(results.every((r) => r.ok), true)
  const after = await listSnapshotIds(backupRoot)
  assert.equal(after.length, 1, `同日多份应当只留最后一份，实际留了 ${after.length}`)
  assert.equal(after[0], results[results.length - 1].id)

  // 清理
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

test('端到端：取消与并发保护', async () => {
  const { root, dshHome, backupRoot } = await makeSandbox()
  const cfg = testCfg(backupRoot)

  // 第一次跑起来之后立刻再起一次，应当被拒
  const p1 = runBackup({ dshHome, cfg, reason: '并发A', planOverride: slimPlan(dshHome) })
  const p2 = await runBackup({ dshHome, cfg, reason: '并发B', planOverride: slimPlan(dshHome) })
  assert.equal(p2.ok, false)
  assert.match(String(p2.error || ''), /已经有一次/)

  const r1 = await p1
  assert.equal(r1.ok, true)
  assert.equal(runState.running, false, '跑完之后 running 必须复位')

  await rm(root, { recursive: true, force: true }).catch(() => {})
})

test('safetyDirFor 形如 _before-restore/<id>_<ts>', () => {
  const d = safetyDirFor('F:\\bk', '2026-11-21_030000', new Date(2026, 10, 21, 15, 30, 5))
  assert.match(d, /_before-restore/)
  assert.match(d, /2026-11-21_030000_20261121-153005/)
})
