# dsh-data-backup

DSH（DeepSeek Harness）的**重要数据全量快照备份**插件。

把 DSH 的命根子——会话、附件、技能、人格记忆、插件数据、配置与密钥、插件源码——按分类做成时间点快照，落到独立备份盘。DSH 哪怕整台重装，凭 `_restore.ps1` 也能把体验原样搬回来。

**纯本地文件操作，不调用任何模型，不产生任何模型费用。**

---

## 它解决什么问题

装了一堆插件、攒了几百轮会话、养了一个数字生命、写了几十个技能之后，DSH 的价值已经不在「程序」里，而在 `~/.dsh` 那堆目录里：

- `sessions/` 一丢，所有对话历史没了；
- `skills/` 一丢，所有技能和它们的 `references/`、`scripts/` 没了；
- `plugins-data/` 一丢，行程、Aurabot、语音、项目笔记全空；
- `.credentials.yaml` 一丢，所有登录态要重扫；
- `profiles/web/package.json` 一丢，插件清单要凭记忆重装。

这个插件就是给这些目录做定点快照，并且**备份产物自带还原脚本**——不是「只有插件能读的私有格式」，而是一个能用手拷、能独立还原的普通目录树。

## 备什么

| 分类 | 内容 |
| --- | --- |
| 会话数据 | `sessions/`：每轮对话、工具调用、会话索引（`.zstd` 分片） |
| 会话附件 | `attachments/`：历史会话里挂过的图片与文件 |
| 技能数据 | `skills/` + `agent-reach-home/`：`SKILL.md` 与配套 `references/`、`scripts/`、`assets/` |
| 记忆与人格 | `digital-life/`、`fish-memory/`、`memory-core/`、日记与夜话配置 |
| 插件数据 | `plugins-data/`、`storages/`、行程、Aurabot、语音、项目笔记、注入器 |
| 配置与密钥 | `.credentials.yaml`、`AGENTS.md`、cordis 装配、profile 依赖清单、本地 tgz、启动脚本 |
| 插件清单 | 每个插件的来源地址 + 版本 + 装回命令（`plugin-list.md` / `.json`），重装照这份拉起 |
| 插件源码 | 本地 link 的插件包（已剪 `node_modules`、`.git`） |
| Codex 数据 | `~/.codex`：会话、技能、插件、sqlite 索引（可关） |

**不备**能重建的东西：`node_modules`、`.git`、`.pnpm-store`、`__pycache__`、`logs`、`*.log`、`cache`、浏览器 profile、`shots` 视频素材。

## 备份产物长什么样

```
F:\dsh重要数据备份\
├─ _README.md              ← 给未来的自己看的说明
├─ _restore.ps1            ← 独立还原脚本（纯 ASCII，不需要 DSH）
├─ _manifests\<id>.json    ← 清单：文件数、字节数、原路径映射
├─ _state\history.json     ← 备份历史
├─ _before-restore\        ← 还原前自动存的后悔药
├─ 会话数据\<id>\sessions\...
├─ 技能数据\<id>\skills\...
├─ 插件清单\<id>\plugin-list.md   ← 插件名录：来源 + 版本 + 装回命令
└─ ...
```

`<id>` 是 `YYYY-MM-DD_HHmmss`（本地时间），字典序即时间序。

`_manifests/<id>.json` 里的 `targets` 是还原的关键：

```json
{ "snapRel": "会话数据/2026-11-21_030000/sessions", "dest": "D:\\dsh\\.dsh\\sessions" }
```

左边是快照里的目录，右边是它原来所在的绝对路径。照着拷就能还原，不依赖本插件。

## 保留策略

- 最近 **7 天**：每天留最后一份
- 每周留一份，保留 **4 周**
- 最新一份永远保留

按默认体积算，稳态约 11 份 × 1GB ≈ 11GB。磁盘剩余不足预估的 1.15 倍会在面板与 manifest 里告警；单类超过 `categoryCapBytes`（默认 12 GiB）整类跳过，绝不把盘写爆。

## 装

```bash
# 从 GitHub
dsh plugin install abcd20241629/dsh-data-backup
```

或本地 link：

```bash
cd D:\dsh\plugins
git clone https://github.com/abcd20241629/dsh-data-backup.git
# 然后在 profile 里装：dev_install_package / dev_inject_plugin
```

装完在 **设置 → 数据备份** 里能看到面板。

## 用

- **自动**：每天 `dailyAt`（默认 `03:00`）跑一次全量快照。
- **手动**：面板「立即备份」，或让 agent 调 `backup_run`。
- **校验**：面板「校验」或 `backup_verify`。浅校验比重走一遍文件数/字节数；深校验逐文件算 sha256。
- **还原**：面板「还原」或 `_restore.ps1`。还原前自动把即将被覆盖的内容抄到 `_before-restore/`。
- **清单**：面板「清单」列出那份快照里的插件名录（名字 / 来源 git 地址或 npm 包 / 版本 / 装回命令）。

还原是**合并式**的：同名文件被快照版本替换，目标目录里快照没有的文件保留。最坏情况是「没还原干净」，不会「把新东西抹了」。

## 重装 DSH 之后

1. 装回 DSH 本体（`D:\dsh`）与 pnpm 依赖。
2. 把 `配置与密钥\<id>\` 里的 `.credentials.yaml`、`AGENTS.md`、`profiles\web\package.json`、`cordis*.yml` 拷回原位。
3. 打开 `插件清单\<id>\plugin-list.md`，逐个照命令装：
   - git 来源：`git clone <repo> D:\dsh\plugins\<name>` 再 `dev_install_package`；
   - npm 来源：`npm i <name>@<version>`；
   - vendor tgz：拷回 `配置与密钥\<id>\...` 里的 tgz 再 `file:` 装。
4. 跑 `_restore.ps1 -Snapshot <id>` 把会话、技能、记忆、插件数据放回去。
5. 重启 DSH，登录还在、记忆还在、会话列表还在。

插件源码不必备份——有地址就能重新拉；备份的是**地址簿**。

## 给 agent 的工具

| 工具 | 干什么 |
| --- | --- |
| `backup_run` | 立刻跑一次备份（后台，返回 id） |
| `backup_status` | 看进度、上次结果、配置、历史 |
| `backup_list` | 列所有可还原快照 |
| `backup_verify` | 校验某份快照 |

## 配置

`<DSH_HOME>/plugins-data/dsh-data-backup/config.json`：

```json
{
  "enabled": true,
  "backupRoot": "F:\\dsh重要数据备份",
  "dailyAt": "03:00",
  "retentionDaily": 7,
  "retentionWeekly": 4,
  "withAttachments": true,
  "withCodex": true,
  "concurrency": 8,
  "categoryCapBytes": 12884901888,
  "deepVerify": false
}
```

面板改的就是这份文件，改完即生效（定时器每 30 秒重读一次）。

## 开发

```bash
npm test        # node tests/smoke.mjs，全在临时目录里跑，不碰真实数据
```

结构：

```
lib/plan.js      数据契约：哪些目录算命根子（备份/校验/还原都读这里）
lib/fsutil.js    走目录、剪枝、并发拷贝、体积
lib/config.js    配置、快照命名、保留策略（纯函数）
lib/snapshot.js  备份执行器
lib/verify.js    校验
lib/restore.js   还原
lib/plugins.js   插件名录：扫 profile 依赖 + git 远端 + 实际版本，产出 plugin-list.md/json
lib/host.js      宿主半边：路由 / 定时 / 工具
lib/client.js    网页半边：设置页面板
assets/          _README.md 与 _restore.ps1 的模板
```

改备份范围只需要改 `lib/plan.js` 一处。

## 许可

MIT
