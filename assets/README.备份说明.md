# DSH 重要数据备份 · 说明

这个目录是 **DSH（DeepSeek Harness）重要数据的全量快照仓库**，由 `dsh-data-backup` 插件每天自动写入，也可以手动触发。

一句话：**DSH 哪怕整台重装，照这份备份也能把体验原样搬回来。**

---

## 一、这里面有什么

每个快照是一个独立时间点，目录名就是快照 id（`YYYY-MM-DD_HHmmss`，本地时间）。

```
F:\dsh重要数据备份\
├─ _README.md              ← 你正在看的这份
├─ _restore.ps1            ← 独立还原脚本（不依赖 DSH，纯 PowerShell）
├─ _manifests\             ← 每份快照的清单（文件数、字节数、原路径映射）
│   └─ 2026-11-21_030000.json
├─ _state\                 ← 备份历史、还原报告
│   ├─ history.json
│   └─ restore-20261121-153000.json
├─ _before-restore\        ← 还原前自动存的后悔药，按快照 id_时间戳 分目录
├─ 会话数据\               ← sessions：每一轮对话、工具调用、会话索引（.zstd 分片）
├─ 会话附件\               ← attachments：历史会话里挂过的图片与文件
├─ 技能数据\               ← skills + agent-reach-home：SKILL.md 与配套 references/scripts/assets
├─ 记忆与人格\             ← digital-life / fish-memory / memory-core / 日记与夜话配置
├─ 插件数据\               ← plugins-data / storages / 行程 / Aurabot / 语音 / 项目笔记 / 注入器
├─ 配置与密钥\             ← .credentials.yaml、AGENTS.md、cordis 装配、profile 依赖清单、本地 tgz、启动脚本
├─ 插件清单\               ← 每个插件的来源地址 + 版本 + 装回命令（plugin-list.md / plugin-list.json）
├─ 插件源码\               ← 本地 link 的插件包（已剪 node_modules / .git）
└─ Codex 数据\             ← ~/.codex（会话、技能、插件、sqlite 索引）
```

每个分类下面再按快照 id 分：`会话数据\2026-11-21_030000\sessions\...`

## 二、哪些东西**不**在里面（能重建的，故意不备）

- `node_modules`、`.git`、`.pnpm-store`、`__pycache__`（重装/`pnpm i` 就能回来）
- `logs`、`*.log`、`*.err`、`*.out`（纯日志）
- `shots`（视频素材 1.8G，属于作品不属于 DSH 的状态）
- 浏览器 profile（`dsh-builtin-browser-host`）
- 各类 `cache`（纯缓存）

体积大头是 `profiles/web/node_modules`（820MB），剪掉它之后一份快照大约 1GB 出头。

## 三、保留策略

- 最近 **7 天**：每天留最后一份
- 每周留一份，保留 **4 周**
- 最新一份永远保留

按默认体积算，稳态占用约 11 份 × 1GB ≈ 11GB。F 盘空间不够时会在面板里提前告警，且单类超过 12GB 会整类跳过而不是把盘写爆。

## 四、怎么还原

### 方式 A：在 DSH 面板里点（当前 DSH 还能跑）

设置 → 数据备份 → 选快照 → 还原。
它会先自动把「即将被覆盖的东西」抄到 `_before-restore\`，再覆盖。

### 方式 B：独立脚本（DSH 已经跑不起来 / 甚至没装）

```
# 先关掉 DSH
cd /d F:\dsh重要数据备份
# 看看有哪些快照
powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -List
# 还原最新一份
powershell -ExecutionPolicy Bypass -File .\_restore.ps1
# 还原指定一份
powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -Snapshot 2026-11-21_030000
# 只演练不写盘
powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -DryRun
```

脚本只做三件事：**先存后悔药 → 再把快照拷回原路径 → 最后告诉你哪几项成功**。
全程纯 ASCII、不调网络、不需要 DSH。

### 方式 C：手工拷（最笨但最稳）

`_manifests\<id>.json` 里有一份 `targets` 清单，长这样：

```json
{ "snapRel": "会话数据/2026-11-21_030000/sessions", "dest": "D:\\dsh\\.dsh\\sessions" }
```

意思是：把左边这个目录里的东西，拷回右边这个路径。照着一条条拷就行。

## 五、重装 DSH 之后（最常走的场景）

1. 装回 DSH 本体与 pnpm 依赖（`D:\dsh`）。
2. 拷回门面：`配置与密钥\<id>\` 里的 `.credentials.yaml`、`AGENTS.md`、`profiles\web\package.json`、`cordis*.yml`、启动脚本。
3. 打开 `插件清单\<id>\plugin-list.md`，**照着装插件**：
   - `git` 来源 → `git clone <地址> D:\dsh\plugins\<name>`，再在 profile 里装；
   - `npm` 来源 → `npm i <包名>@<版本>`；
   - `vendor tgz` → 从 `配置与密钥\<id>\` 里找同名 tgz 装。
4. `_restore.ps1 -Snapshot <id>` 把会话、技能、记忆、插件数据放回去。
5. 重启 DSH —— 登录态、记忆、会话列表都还在。

插件源码故意不重点备份：**有地址就能重新拉，地址簿比源码更值钱**。

## 六、还原之后

1. **重启 DSH**（`D:\dsh\dsh.cmd` 或原来的启动方式）。
2. 如果插件没自己回来，看 `配置与密钥\...\profiles\web\package.json` 里的依赖清单和 `cordis.patch.yml` 的装配块。
3. 密钥是**明文**存在 `配置与密钥` 里 —— 这个目录别上传 GitHub、别丢进公开网盘。

## 七、注意

- **合并式还原**：同名文件被快照版本替换，目标目录里快照没有的文件**保留**。最坏情况是「没还原干净」，不会「把新东西抹了」。
- 会话文件在备份途中可能还在被写入，这类文件会被记为「热文件」写进 manifest，下次备份会补上。看到 `hot > 0` 不用慌。
- 备份是**纯文件拷贝**，不产生任何模型调用费用。
- 目录权限：插件会尽量把权限收紧到当前用户，但 Windows 上请自己确认一遍——这目录里躺着登录态。
