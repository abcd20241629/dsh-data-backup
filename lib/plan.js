// 数据契约（plan.js）
//
// 这里是「哪些东西算 DSH 的命根子」的唯一真相。备份、校验、还原三处都读它，
// 所以改范围只需要改这一个文件。
//
// 每条源有两种形态：
//   kind: 'dir'   —— 一个目录整棵拷（按 exclude 正则剪枝）
//   kind: 'glob'  —— 只列 fromDir 这一层，按 match 正则挑文件（不含子目录）
//
// from / fromDir 是绝对路径；to 是快照内相对路径（相对该分类的目录）。
// optional: true 表示「没有也不算错」——大部分源都该是 optional，重装后的机器
// 上东西不全才是常态。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { excluded } from './fsutil.js'

/** 全局都剪掉的东西：能重建的、纯缓存的、纯日志的。 */
export const GLOBAL_EXCLUDE = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.pnpm-store([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /\.pyc$/,
  /(^|[\\/])logs?([\\/]|$)/,
  /\.(log|err|out)$/i,
]

/** 每个分类的体积上限（字节）。超了就跳过整类并在 manifest 里写 warn，避免某天把盘写爆。 */
export const DEFAULT_CATEGORY_CAP = 12 * 1024 * 1024 * 1024

/**
 * 生成数据计划。
 * @param {{dshHome?: string, userHome?: string, withCodex?: boolean, withAttachments?: boolean}} opts
 */
export function buildPlan(opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const userHome = opts.userHome || homedir()
  const withCodex = opts.withCodex !== false
  const withAttachments = opts.withAttachments !== false

  /** @type {Array<import('./plan.js').Category>} */
  const cats = []

  // 1) 会话 —— 每一次对话的原文与工具调用轨迹，丢了就真没了
  cats.push({
    id: 'sessions',
    label: '会话数据',
    note: '每一轮对话、工具调用、会话索引（.zstd 分片）',
    sources: [{ kind: 'dir', from: join(dshHome, 'sessions'), to: 'sessions', optional: true }],
  })

  // 2) 会话附件 —— 旧会话里那些图片/文件，光有会话文本恢复不了
  if (withAttachments) {
    cats.push({
      id: 'attachments',
      label: '会话附件',
      note: '历史会话里挂过的图片与文件（v1/file-objects 等）',
      sources: [{ kind: 'dir', from: join(dshHome, 'attachments'), to: 'attachments', optional: true }],
    })
  }

  // 3) 技能 —— 技能本体 + 技能配套（references / scripts / assets）
  cats.push({
    id: 'skills',
    label: '技能数据',
    note: '全部 SKILL.md 与配套 references/scripts/assets',
    sources: [
      { kind: 'dir', from: join(dshHome, 'skills'), to: 'skills', optional: true },
      // agent-reach 这类「技能配套」装在 dsh 根下；venv 可重建，剪掉
      {
        kind: 'dir',
        from: join(dshHome.replace(/[\\/]\.dsh$/, ''), 'agent-reach-home'),
        to: 'agent-reach-home',
        // 只留配置与登录态；浏览器二进制、下载的 CLI、pip/D3D 缓存全可重建
        exclude: [
          /^\.agent-reach[\\/](cache|cloak-binaries|tools|browser|browser-locks)([\\/]|$)/,
          /^appdata([\\/]|$)/,
        ],
        optional: true,
      },
    ],
  })

  // 4) 记忆与人格 —— 她是谁、记得什么，比会话更不可再生
  cats.push({
    id: 'memory',
    label: '记忆与人格',
    note: '人设卡、记忆库、工作区、日记、夜话配置',
    sources: [
      { kind: 'dir', from: join(dshHome, 'digital-life'), to: 'digital-life', optional: true },
      { kind: 'dir', from: join(dshHome, 'fish-memory'), to: 'fish-memory', optional: true },
      { kind: 'dir', from: join(dshHome, 'fish-memory-backup'), to: 'fish-memory-backup', optional: true },
      { kind: 'dir', from: join(dshHome, 'memory-core'), to: 'memory-core', optional: true },
      { kind: 'dir', from: join(dshHome, 'soul-md.pre-migration'), to: 'soul-md.pre-migration', optional: true },
      {
        kind: 'glob',
        fromDir: dshHome,
        to: 'root',
        match: /^(whale-diary.*\.md|whale-night.*\.json|whale-listen\.json|whale-log\.jsonl|whale-sched-status\.json|whale-tick-diag\.json|bili-whale\.config\.json)$/,
        optional: true,
      },
    ],
  })

  // 5) 插件数据 —— 插件自己的库/状态，重装插件是空的，数据全在这儿
  cats.push({
    id: 'plugin-data',
    label: '插件数据',
    note: '各插件落盘的数据目录（行程、Aurabot、语音、项目笔记、注入器等）',
    sources: [
      { kind: 'dir', from: join(dshHome, 'plugins-data'), to: 'plugins-data', optional: true },
      { kind: 'dir', from: join(dshHome, 'storages'), to: 'storages', optional: true },
      { kind: 'dir', from: join(dshHome, 'trip-planner'), to: 'trip-planner', optional: true },
      { kind: 'dir', from: join(dshHome, 'trip-planner-backup-20261114-141907'), to: 'trip-planner-backup', optional: true },
      { kind: 'dir', from: join(dshHome, 'bili-life'), to: 'bili-life', optional: true },
      { kind: 'dir', from: join(dshHome, 'napcat-manager'), to: 'napcat-manager', optional: true },
      { kind: 'dir', from: join(dshHome, 'minimax-voice'), to: 'minimax-voice', optional: true },
      { kind: 'dir', from: join(dshHome, 'project-notes'), to: 'project-notes', optional: true },
      { kind: 'dir', from: join(dshHome, 'super-injector'), to: 'super-injector', optional: true },
      { kind: 'dir', from: join(dshHome, 'speak-up'), to: 'speak-up', optional: true },
      { kind: 'dir', from: join(dshHome, 'whale-work'), to: 'whale-work', optional: true },
      { kind: 'dir', from: join(dshHome, 'whale-audio'), to: 'whale-audio', optional: true },
      { kind: 'dir', from: join(dshHome, 'whale-bubble-imgs'), to: 'whale-bubble-imgs', optional: true },
      { kind: 'dir', from: join(dshHome, 'whale-roles'), to: 'whale-roles', optional: true },
      { kind: 'dir', from: join(dshHome, 'llm-deepseek'), to: 'llm-deepseek', optional: true },
      { kind: 'dir', from: join(dshHome, 'graded-state'), to: 'graded-state', optional: true },
    ],
  })

  // 6) 配置与密钥 —— 重装后「不用重新配一遍」的关键
  cats.push({
    id: 'config',
    label: '配置与密钥',
    note: '凭据、全局约定、cordis 装配、profile 依赖清单、本地 tgz 插件、启动脚本',
    sources: [
      { kind: 'dir', from: join(dshHome, 'vendor'), to: 'vendor', optional: true },
      {
        kind: 'glob',
        fromDir: dshHome,
        to: 'dsh-home-root',
        match: /^(\.anonymous-user-id|\.credentials\.yaml|AGENTS\.md|cordis\.patch\.yml|settings\.yaml\.imported|graded-settings\.json|fish-memory-config\.json|speak-up-config\.json|restart-web\.ps1)$/,
        optional: true,
      },
      {
        kind: 'glob',
        fromDir: join(dshHome, 'profiles', 'web'),
        to: 'profiles/web',
        match: /^(cordis\.patch\.yml|cordis\.yml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
        optional: true,
      },
      { kind: 'dir', from: join(dshHome, 'profiles', 'web', '.dsh-market'), to: 'profiles/web/.dsh-market', optional: true },
      { kind: 'dir', from: join(dshHome, 'profiles', 'web', '.plugin-manager'), to: 'profiles/web/.plugin-manager', optional: true },
      {
        kind: 'glob',
        fromDir: join(dshHome, 'profiles'),
        to: 'profiles-other',
        match: /.*/,
        optional: true,
      },
      // DSH 根目录的启动/守护脚本：重装后「怎么把它跑起来」全靠这些
      {
        kind: 'glob',
        fromDir: dshHome.replace(/[\\/]\.dsh$/, ''),
        to: 'dsh-root',
        match: /^(dsh\.cmd|launcher\.mjs|package\.json|pnpm-lock\.yaml|dsh-web-autostart\.ps1|dsh-web-autostart\.vbs|dsh-web-restart\.ps1|restart-dsh\.ps1|restart-host\.ps1|restart-guardian-single\.ps1|start-mobile\.ps1|proxy-mobile\.mjs|ws-diag\.mjs|启动DSH手机访问\.cmd|napcat-[a-z-]+\.ps1|napcat-[a-z-]+\.vbs)$/i,
        optional: true,
      },
    ],
  })

  // 7) 插件源码 —— 本地 link 的插件，GitHub 上不一定有，丢了就得重写
  cats.push({
    id: 'plugin-src',
    label: '插件源码',
    note: '本地 link 装配的插件包（先剪 node_modules/.git，留 dist 与 lib）',
    sources: [
      { kind: 'dir', from: join(dshHome.replace(/[\\/]\.dsh$/, ''), 'plugins'), to: 'dsh-plugins', optional: true },
      { kind: 'dir', from: 'D:\\插件创造\\行程插件', to: '插件创造-行程插件', optional: true },
      { kind: 'dir', from: 'D:\\插件创造\\项目笔记\\dsh-project-notes', to: '插件创造-项目笔记', optional: true },
      { kind: 'dir', from: 'D:\\插件创造\\dsh-data-backup', to: '插件创造-dsh-data-backup', exclude: [/(^|[\\/])\.git([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/], optional: true },
      { kind: 'dir', from: 'D:\\agent-desktop\\dsh-agent-desktop', to: 'agent-desktop', optional: true },
    ],
  })

  // 8) Codex 数据 —— 不在 DSH 里，但主人刚丢过一次；默认带上，可在设置里关
  if (withCodex) {
    const codex = join(userHome, '.codex')
    cats.push({
      id: 'codex',
      label: 'Codex 数据',
      note: 'Codex 的会话、技能、插件与索引（DSH 之外，但同样不可再生）',
      sources: [
        {
          kind: 'dir',
          from: codex,
          to: 'codex',
          optional: true,
          exclude: [
            /(^|[\\/])\.sandbox([\\/]|$)/,
            /(^|[\\/])\.tmp([\\/]|$)/,
            /(^|[\\/])tmp([\\/]|$)/,
            /(^|[\\/])logs_\d+\.sqlite/,
            /(^|[\\/])\.sandbox-secrets([\\/]|$)/,
          ],
        },
      ],
    })
  }

  return cats
}

/** 估算一个源的体积（只 stat，不读内容）。不存在返回 null。 */
export function measureSource(src) {
  try {
    if (src.kind === 'dir') {
      if (!existsSync(src.from)) return null
      const rules = [...GLOBAL_EXCLUDE, ...(src.exclude || [])]
      let bytes = 0
      let files = 0
      const stack = [['', src.from]]
      while (stack.length) {
        const [rel, dir] = stack.pop()
        let ents
        try {
          ents = readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const e of ents) {
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (excluded(childRel, rules)) continue
          const p = join(dir, e.name)
          if (e.isDirectory()) stack.push([childRel, p])
          else if (e.isFile()) {
            try {
              bytes += statSync(p).size
              files += 1
            } catch {
              /* 消失的文件不算 */
            }
          }
        }
      }
      return { bytes, files }
    }
    if (src.kind === 'glob') {
      if (!existsSync(src.fromDir)) return null
      let bytes = 0
      let files = 0
      for (const name of readdirSync(src.fromDir)) {
        if (!src.match.test(name)) continue
        try {
          const st = statSync(join(src.fromDir, name))
          if (st.isFile()) {
            bytes += st.size
            files += 1
          }
        } catch {
          /* ignore */
        }
      }
      return { bytes, files }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * @typedef {Object} Source
 * @property {'dir'|'glob'} kind
 * @property {string} [from]
 * @property {string} [fromDir]
 * @property {string} to
 * @property {RegExp} [match]
 * @property {RegExp[]} [exclude]
 * @property {boolean} [optional]
 *
 * @typedef {Object} Category
 * @property {string} id
 * @property {string} label
 * @property {string} note
 * @property {Source[]} sources
 */
