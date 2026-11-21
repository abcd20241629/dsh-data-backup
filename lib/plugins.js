// 插件名单（plugins.js）
//
// 为什么要有这一份：插件源码备份再全，重装 DSH 后也不一定原样跑得起来；
// 真正让人「几分钟内回到熟悉的样子」的，是一张清单：
//   哪个插件 + 什么版本 + 从哪儿装（git / npm / 本地目录）。
//
// 所以这里不拷代码，只把「来源」问清楚：
//   link: → 本地目录，顺手问 git 远端
//   file: → vendor 里的 tgz
//   版本号 → npm registry，写明 install 命令
//
// 输出两份：plugin-list.json（机器读，给还原脚本用）、plugin-list.md（人读，照着装）。

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { execFile } from 'node:child_process'

const MAX_GIT_MS = 4000

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: MAX_GIT_MS, windowsHide: true, ...opts }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(String(stdout || '').trim())
    })
  })
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

async function isDir(p) {
  try {
    const st = await stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

async function gitInfo(dir) {
  if (!(await isDir(join(dir, '.git')))) return null
  const [url, branch, dirty] = await Promise.all([
    run('git', ['-C', dir, 'remote', 'get-url', 'origin']),
    run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['-C', dir, 'status', '--porcelain']),
  ])
  if (!url && !branch) return null
  return {
    url: url || '',
    branch: branch || '',
    dirty: Boolean(dirty),
    dirtyFiles: dirty ? dirty.split('\n').filter(Boolean).length : 0,
  }
}

/** 读某个目录的 package.json 里的身份信息。 */
async function pkgIdentity(dir) {
  const j = await readJson(join(dir, 'package.json'))
  if (!j) return null
  return { name: j.name || '', version: j.version || '', description: j.description || '' }
}

/** 把 dependencies 里的 spec 归类。 */
function classifySpec(name, spec) {
  const s = String(spec || '')
  if (s.startsWith('link:')) {
    return { kind: 'link', localPath: s.slice(5).trim(), spec: s }
  }
  if (s.startsWith('file:')) {
    return { kind: 'file', localPath: s.slice(5).trim(), spec: s }
  }
  if (/^(git\+|github:|git@|https?:\/\/.*\.git)/i.test(s)) {
    return { kind: 'git', spec: s }
  }
  return { kind: 'npm', spec: s }
}

/** node_modules 里实际装了什么版本（比 package.json 的 range 更准）。 */
async function installedVersion(nmDir, name) {
  const j = await readJson(join(nmDir, ...name.split('/'), 'package.json'))
  return j ? j.version || '' : ''
}

/**
 * 收集插件名单。
 * @param {{dshHome: string, extraDirs?: string[]}} opts
 */
export async function collectPluginList(opts) {
  const dshHome = opts.dshHome
  const profileDir = join(dshHome, 'profiles', 'web')
  const nmDir = join(profileDir, 'node_modules')
  const pkg = await readJson(join(profileDir, 'package.json'))
  const deps = (pkg && pkg.dependencies) || {}

  const entries = []
  const seen = new Set()

  for (const [name, spec] of Object.entries(deps)) {
    const cls = classifySpec(name, spec)
    const row = {
      name,
      spec: cls.spec,
      kind: cls.kind,
      localPath: cls.localPath || '',
      installedVersion: await installedVersion(nmDir, name),
      repo: null,
      git: null,
      note: '',
    }

    if (cls.kind === 'link' && cls.localPath) {
      const dir = cls.localPath
      const id = await pkgIdentity(dir)
      if (id) {
        row.pkgName = id.name
        row.pkgVersion = id.version
      }
      row.git = await gitInfo(dir)
      if (!row.git) row.note = '本地目录，但不是 git 仓库（重装时只能整目录拷回来）'
    } else if (cls.kind === 'file') {
      row.tgz = cls.localPath ? basename(cls.localPath) : ''
    } else if (cls.kind === 'npm') {
      row.install = `npm i ${name}@${row.installedVersion || cls.spec}`
      const pj = await readJson(join(nmDir, ...name.split('/'), 'package.json'))
      const repo = pj && pj.repository
      row.repo = typeof repo === 'string' ? repo : repo && repo.url ? repo.url : ''
      if (row.repo) row.install = row.install
    }

    entries.push(row)
    seen.add(name)
  }

  // 本地插件目录里还没登记进 profile 的，也记一笔（免得重装后忘了它）
  const extras = []
  for (const root of opts.extraDirs || []) {
    let names = []
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const n of names) {
      if (n.startsWith('.')) continue
      const dir = join(root, n)
      if (!(await isDir(dir))) continue
      const id = await pkgIdentity(dir)
      if (!id || !id.name) continue
      if (seen.has(id.name)) continue
      const git = await gitInfo(dir)
      extras.push({
        name: id.name,
        version: id.version,
        dir,
        git,
        note: '本地有、但 profile 没登记（可能已弃用，或要手动装）',
      })
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    profile: 'web',
    dshHome,
    count: entries.length,
    entries,
    extras,
  }
}

/** 生成人读的 markdown（照着这份就能把插件一条条装回来）。 */
export function renderPluginListMd(list) {
  const L = []
  L.push('# 插件名单')
  L.push('')
  L.push(`> 生成时间：${list.generatedAt}`)
  L.push('> 用途：DSH 重装后，照着这份把插件装回来。JSON 版在同目录 `plugin-list.json`。')
  L.push('')
  L.push(`共 **${list.count}** 个已登记插件。`)
  L.push('')

  const groups = [
    ['link', '本地目录（link）—— 源码在本地，git 远端是回归的关键'],
    ['npm', 'npm 包 —— 用 npm i 装回'],
    ['file', 'vendor tgz —— 从本地包文件装'],
    ['git', 'git 直接依赖'],
  ]

  for (const [kind, title] of groups) {
    const rows = list.entries.filter((e) => e.kind === kind)
    if (!rows.length) continue
    L.push(`## ${title}`)
    L.push('')
    for (const e of rows) {
      L.push(`### ${e.name}`)
      L.push('')
      if (e.installedVersion || e.pkgVersion) {
        L.push(`- 版本：\`${e.pkgVersion || e.installedVersion}\``)
      }
      if (e.localPath) L.push(`- 本地路径：\`${e.localPath}\``)
      if (e.git && e.git.url) {
        L.push(`- git：\`${e.git.url}\`${e.git.branch ? `（分支 \`${e.git.branch}\`）` : ''}`)
        if (e.git.dirty) L.push(`- ⚠ 生成时本地有 ${e.git.dirtyFiles} 个未提交改动`)
        L.push(`- 装回：\`git clone ${e.git.url}\`，再在 profile 里 \`link:\` 指过去`)
      } else if (e.kind === 'link') {
        L.push('- git：没有（整目录拷回来，或自己补一个仓库）')
      }
      if (e.kind === 'npm') {
        L.push(`- 装回：\`${e.install}\``)
        if (e.repo) L.push(`- 仓库：${e.repo}`)
      }
      if (e.kind === 'file' && e.tgz) {
        L.push(`- 包文件：\`${e.tgz}\`（在 \`<DSH_HOME>/vendor/\` 下）`)
      }
      if (e.note) L.push(`- 注意：${e.note}`)
      L.push('')
    }
  }

  if (list.extras.length) {
    L.push('## 本地有、但没登记进 profile')
    L.push('')
    for (const e of list.extras) {
      const g = e.git && e.git.url ? `，git \`${e.git.url}\`` : '，无 git 远端'
      L.push(`- \`${e.name}\`@${e.version || '?'} —— \`${e.dir}\`${g}`)
    }
    L.push('')
  }

  L.push('## 装回顺序建议')
  L.push('')
  L.push('1. 先装 DSH 本体，把 `profile` 建起来。')
  L.push('2. `npm i` 那些 npm 包（或把原来 package.json 的 dependencies 段整段贴回去再 install）。')
  L.push('3. `git clone` 本地目录类插件，按原路径放好，profile 里保留 `link:` 依赖。')
  L.push('4. vendor 里的 tgz 放回 `<DSH_HOME>/vendor/`，`file:` 依赖指过去。')
  L.push('5. 重启 DSH，逐个确认插件面板里状态是 active。')
  L.push('')
  L.push('> 这一份由 dsh-data-backup 自动生成，不需要模型参与，改了 profile 下次备份会自己更新。')
  L.push('')
  return L.join('\n')
}

/** 一次性产出 json + md 两个文本。 */
export async function buildPluginListFiles(opts) {
  const list = await collectPluginList(opts)
  return {
    list,
    json: JSON.stringify(list, null, 2),
    md: renderPluginListMd(list),
  }
}
