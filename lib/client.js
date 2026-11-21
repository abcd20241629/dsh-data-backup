// DSH 重要数据备份 · 面板半边（client.js）
//
// 挂在 设置 → 数据备份。四块内容：
//   ① 现状（在跑什么 / 上次结果 / 备份根）
//   ② 手动备份 · 取消 · 估算体积
//   ③ 配置（开关、时刻、保留份数、是否带附件与 Codex、深校验）
//   ④ 快照列表（校验 / 还原 / 看清单）

window.__ModuleLoader__.load({
  id: 'dsh-data-backup',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    const API = '/data-backup/api'

    function api(path, opts) {
      const url = API + path
      return fetch(url, opts)
        .then((r) => r.json())
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    }
    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    const fmtBytes = (n) => {
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
    const fmtTime = (iso) => {
      if (!iso) return '—'
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch {
        return iso
      }
    }
    const fmtDuration = (ms) => {
      if (!Number.isFinite(ms)) return '?'
      if (ms < 1000) return `${Math.round(ms)} ms`
      const s = ms / 1000
      if (s < 60) return `${s.toFixed(1)} 秒`
      return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`
    }

    // ---------- 小零件 ----------

    const MUTED = 'rgba(128,128,140,0.95)'
    const LINE = '1px solid rgba(128,128,140,0.28)'
    const CARD = {
      border: LINE,
      borderRadius: 10,
      padding: '14px 16px',
      marginBottom: 14,
      background: 'rgba(128,128,140,0.05)',
    }
    const BTN = {
      border: LINE,
      borderRadius: 8,
      padding: '6px 13px',
      fontSize: 13,
      cursor: 'pointer',
      background: 'transparent',
      color: 'inherit',
    }
    const BTN_PRIMARY = Object.assign({}, BTN, {
      border: '1px solid rgba(90,150,240,0.75)',
      background: 'rgba(90,150,240,0.16)',
      fontWeight: 600,
    })
    const BTN_DANGER = Object.assign({}, BTN, {
      border: '1px solid rgba(230,110,110,0.7)',
      background: 'rgba(230,110,110,0.14)',
    })
    const INPUT = {
      border: LINE,
      borderRadius: 7,
      padding: '5px 9px',
      fontSize: 13,
      background: 'rgba(0,0,0,0.18)',
      color: 'inherit',
      fontFamily: 'inherit',
    }
    const TH = { textAlign: 'left', padding: '6px 8px', fontWeight: 600, fontSize: 12, color: MUTED }
    const TD = { padding: '6px 8px', fontSize: 13, borderTop: LINE, verticalAlign: 'top' }

    function Section(props) {
      return h(
        'div',
        { style: CARD },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 } },
          h('div', { style: { fontWeight: 700, fontSize: 14 } }, props.title),
          props.hint ? h('div', { style: { fontSize: 12, color: MUTED } }, props.hint) : null,
          h('div', { style: { flex: 1 } }),
          props.right || null,
        ),
        props.children,
      )
    }

    function KV(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 } },
        h('div', { style: { color: MUTED, minWidth: 96 } }, props.k),
        h('div', { style: { flex: 1, wordBreak: 'break-all' } }, props.v),
      )
    }

    function Badge(props) {
      const tone = props.tone || 'neutral'
      const map = {
        ok: ['rgba(80,190,130,0.16)', 'rgba(80,190,130,0.6)', 'rgba(120,220,170,1)'],
        warn: ['rgba(225,175,70,0.16)', 'rgba(225,175,70,0.6)', 'rgba(240,200,110,1)'],
        bad: ['rgba(230,110,110,0.16)', 'rgba(230,110,110,0.6)', 'rgba(245,140,140,1)'],
        info: ['rgba(90,150,240,0.16)', 'rgba(90,150,240,0.6)', 'rgba(140,185,245,1)'],
        neutral: ['rgba(128,128,140,0.14)', 'rgba(128,128,140,0.4)', 'inherit'],
      }
      const c = map[tone] || map.neutral
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            lineHeight: '16px',
            padding: '1px 8px',
            borderRadius: 20,
            border: `1px solid ${c[1]}`,
            background: c[0],
            color: c[2],
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    // ---------- 主组件 ----------

    function Panel() {
      const [ov, setOv] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(null) // 字符串：正在做的操作
      const [cfg, setCfg] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [plan, setPlan] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [verifying, setVerifying] = React.useState(null)
      const [restoring, setRestoring] = React.useState(null)

      const load = React.useCallback(() => {
        api('/overview').then((r) => {
          if (r && r.ok) {
            setOv(r)
            if (!dirty) setCfg(r.config)
            setErr(null)
          } else {
            setErr((r && r.error) || '读不到状态')
          }
        })
      }, [dirty])

      React.useEffect(() => {
        load()
        const t = setInterval(() => load(), 1600)
        return () => clearInterval(t)
      }, [load])

      const running = !!(ov && ov.running)
      const progress = (ov && ov.progress) || {}
      const snapshots = (ov && ov.snapshots) || []
      const last = (ov && ov.lastResult) || null

      const cfgOf = cfg || (ov && ov.config) || {}
      const setField = (k, v) => {
        setCfg(Object.assign({}, cfgOf, { [k]: v }))
        setDirty(true)
      }

      const doRun = () => {
        setBusy('run')
        setNote(null)
        post('/run', { reason: '手动（面板）' }).then((r) => {
          setBusy(null)
          if (!r.ok) setNote({ bad: true, text: r.error || '启动失败' })
          else setNote({ text: `已开始备份 ${r.id}` })
          load()
        })
      }
      const doCancel = () => {
        setBusy('cancel')
        post('/cancel', {}).then(() => {
          setBusy(null)
          load()
        })
      }
      const doPlan = () => {
        setBusy('plan')
        setNote({ text: '正在估算体积（要全盘 stat 一遍，可能等几秒）…' })
        api('/plan').then((r) => {
          setBusy(null)
          setPlan(r && r.ok ? r : null)
          setNote(r && r.ok ? null : { bad: true, text: (r && r.error) || '估算失败' })
        })
      }
      const doSave = () => {
        setBusy('save')
        post('/config', cfgOf).then((r) => {
          setBusy(null)
          if (r && r.ok) {
            setCfg(r.config)
            setDirty(false)
            setNote({ text: '配置已保存' })
          } else {
            setNote({ bad: true, text: (r && r.error) || '保存失败' })
          }
          load()
        })
      }
      const doVerify = (id) => {
        setVerifying(id)
        setNote({ text: `正在校验 ${id} …（深校验会慢一些）` })
        post('/verify', { id, deep: !!cfgOf.deepVerify }).then((r) => {
          setVerifying(null)
          if (r && r.ok) {
            setNote({ text: `${id} 校验通过：${(r.totals && r.totals.files) || 0} 个文件正常` })
          } else if (r && r.issues) {
            setNote({ bad: true, text: `${id} 有 ${r.issues.length} 个问题：${r.issues.slice(0, 3).join('；')}` })
          } else {
            setNote({ bad: true, text: (r && r.error) || '校验失败' })
          }
        })
      }
      const doRestore = (id) => {
        const ok = window.confirm(
          `要把快照 ${id} 还原回当前机器吗？\n\n` +
            `· 会先把即将被覆盖的内容抄到 _before-restore\ 存一份后悔药\n` +
            `· 合并式还原：同名文件被替换，目标里快照没有的文件保留\n` +
            `· 还原完请重启 DSH\n\n` +
            `建议先关掉 DSH 再还原，避免正在写的会话和新旧数据打架。`,
        )
        if (!ok) return
        setRestoring(id)
        setNote({ text: `正在还原 ${id}（先做安全备份，可能要一会儿）…` })
        post('/restore', { id, confirm: true }).then((r) => {
          setRestoring(null)
          if (r && r.ok) {
            setNote({ text: `${id} 还原完成。安全备份在：${(r.safety && r.safety.dir) || '—'}。请重启 DSH。` })
          } else {
            setNote({ bad: true, text: (r && r.error) || '还原失败' })
          }
          load()
        })
      }
      const doOpen = () => {
        post('/open-root', {}).then((r) => {
          if (r && !r.ok) setNote({ bad: true, text: (r && r.error) || '打不开目录' })
        })
      }

      // ---------- 渲染 ----------

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } },
        h('div', { style: { fontWeight: 700, fontSize: 15 } }, '数据备份'),
        running ? h(Badge, { tone: 'info' }, '备份中') : null,
        h('div', { style: { flex: 1 } }),
        h(
          'div',
          { style: { fontSize: 12, color: MUTED } },
          ov && ov.version ? `dsh-data-backup v${ov.version}` : '',
        ),
      )

      const sub = h(
        'div',
        { style: { fontSize: 12.5, color: MUTED, marginBottom: 12, lineHeight: '19px' } },
        '把 DSH 的会话、附件、技能、记忆、插件数据和配置密钥做全量快照，纯文件拷贝、不调模型。',
        '哪怕 DSH 整台重装，凭这份备份也能把体验原样搬回来。',
      )

      if (err && !ov) {
        return h('div', { style: { padding: 4 } }, head, sub, h(Badge, { tone: 'bad' }, err))
      }

      // ① 现状
      const statusCard = h(
        Section,
        { title: '现在', hint: running ? progress.text : '空闲' },
        running
          ? h(
              'div',
              { style: { marginBottom: 8 } },
              h(KV, { k: '快照 id', v: progress.id || '—' }),
              h(KV, { k: '阶段', v: `${progress.phase || ''} → ${progress.text || ''}` }),
              h(
                'div',
                {
                  style: {
                    height: 6,
                    borderRadius: 4,
                    background: 'rgba(128,128,140,0.2)',
                    overflow: 'hidden',
                    margin: '8px 0 4px',
                  },
                },
                h('div', {
                  style: {
                    height: '100%',
                    width: `${
                      progress.totalBytes > 0
                        ? Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100))
                        : 3
                    }%`,
                    background: 'rgba(90,150,240,0.8)',
                    transition: 'width .4s ease',
                  },
                }),
              ),
              h(
                'div',
                { style: { fontSize: 12, color: MUTED } },
                `已拷 ${progress.copiedFiles || 0} 个文件 / ${progress.copiedText || '0 B'}` +
                  (progress.totalText ? `　预计 ${progress.totalText}` : ''),
              ),
            )
          : null,
        h(KV, { k: '备份根', v: cfgOf.backupRoot || '—' }),
        last
          ? h(
              'div',
              null,
              h(KV, {
                k: '上次结果',
                v: `${last.id} · ${last.status} · ${last.files} 个文件 / ${fmtBytes(last.bytes)} · 用时 ${fmtDuration(
                  last.durationMs,
                )}`,
              }),
              last.errors && last.errors.length
                ? h(KV, {
                    k: '其中异常',
                    v: `${last.errors.length} 条（详见 _manifests\\${last.id}.json）`,
                  })
                : null,
            )
          : h(KV, { k: '上次结果', v: '这个宿主启动后还没备份过' }),
        ov && ov.auto && ov.auto.lastAutoDay
          ? h(KV, { k: '自动备份', v: `最近一次自动备份：${ov.auto.lastAutoDay}（${ov.auto.lastAutoId || '—'}）` })
          : h(KV, { k: '自动备份', v: cfgOf.enabled ? `每天 ${cfgOf.dailyAt}（还没跑过）` : '已关闭' }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(
            'button',
            { style: BTN_PRIMARY, disabled: !!busy || running, onClick: doRun },
            running ? '正在备份…' : '立即备份',
          ),
          running ? h('button', { style: BTN_DANGER, disabled: busy === 'cancel', onClick: doCancel }, '取消') : null,
          h('button', { style: BTN, disabled: !!busy, onClick: doPlan }, busy === 'plan' ? '估算中…' : '估算体积'),
          h('button', { style: BTN, onClick: doOpen }, '打开备份目录'),
        ),
      )

      // ② 估算结果
      const planCard = plan
        ? h(
            Section,
            { title: '将要备份的内容', hint: `合计 ${plan.totalText}　单类上限 ${plan.capText}` },
            h(
              'table',
              { style: { width: '100%', borderCollapse: 'collapse' } },
              h('thead', null, h('tr', null, h('th', { style: TH }, '分类'), h('th', { style: TH }, '体积'), h('th', { style: TH }, '文件'), h('th', { style: TH }, '来源'))),
              h(
                'tbody',
                null,
                plan.categories.map((c) =>
                  h(
                    'tr',
                    { key: c.id },
                    h('td', { style: TD }, c.label, c.overCap ? h(Badge, { tone: 'warn' }, ' 超上限') : null),
                    h('td', { style: TD }, c.bytesText),
                    h('td', { style: TD }, String(c.files)),
                    h(
                      'td',
                      { style: Object.assign({}, TD, { fontSize: 11.5, color: MUTED }) },
                      c.sources.map((s) => (s.missing ? `(缺) ${s.from}` : s.from)).join('\n'),
                    ),
                  ),
                ),
              ),
            ),
          )
        : null

      // ③ 配置
      const seg = (k, options) =>
        h(
          'div',
          { style: { display: 'inline-flex', border: LINE, borderRadius: 8, overflow: 'hidden' } },
          options.map((o) =>
            h(
              'button',
              {
                key: String(o.v),
                style: Object.assign({}, BTN, {
                  border: 'none',
                  borderRadius: 0,
                  padding: '5px 12px',
                  background: String(cfgOf[k]) === String(o.v) ? 'rgba(90,150,240,0.22)' : 'transparent',
                  fontWeight: String(cfgOf[k]) === String(o.v) ? 600 : 400,
                }),
                onClick: () => setField(k, o.v),
              },
              o.label,
            ),
          ),
        )

      const cfgCard = h(
        Section,
        {
          title: '设置',
          hint: dirty ? '有未保存的改动' : '',
          right: h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            dirty ? h('button', { style: BTN, onClick: () => { setCfg(ov.config); setDirty(false) } }, '撤销') : null,
            h('button', { style: BTN_PRIMARY, disabled: !dirty || busy === 'save', onClick: doSave }, busy === 'save' ? '保存中…' : '保存'),
          ),
        },
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '10px 12px', alignItems: 'center' } },
          h('div', { style: { fontSize: 13 } }, '自动备份'),
          h('div', null, seg('enabled', [{ v: true, label: '开' }, { v: false, label: '关' }])),
          h('div', { style: { fontSize: 13 } }, '每天几点'),
          h('input', {
            style: Object.assign({}, INPUT, { width: 110 }),
            value: cfgOf.dailyAt || '',
            placeholder: '03:00',
            onChange: (e) => setField('dailyAt', e.target.value),
          }),
          h('div', { style: { fontSize: 13 } }, '保留天数'),
          h('input', {
            style: Object.assign({}, INPUT, { width: 110 }),
            type: 'number',
            value: cfgOf.retentionDaily || 7,
            onChange: (e) => setField('retentionDaily', Number(e.target.value)),
          }),
          h('div', { style: { fontSize: 13 } }, '保留周数'),
          h('input', {
            style: Object.assign({}, INPUT, { width: 110 }),
            type: 'number',
            value: cfgOf.retentionWeekly || 4,
            onChange: (e) => setField('retentionWeekly', Number(e.target.value)),
          }),
          h('div', { style: { fontSize: 13 } }, '带上会话附件'),
          h(
            'div',
            { style: { fontSize: 12.5, color: MUTED } },
            seg('withAttachments', [{ v: true, label: '带（多 360MB）' }, { v: false, label: '不带' }]),
            h('div', { style: { marginTop: 3 } }, '不带的话，旧会话里的图片和文件恢复不出来。'),
          ),
          h('div', { style: { fontSize: 13 } }, '带上 Codex 数据'),
          h(
            'div',
            { style: { fontSize: 12.5, color: MUTED } },
            seg('withCodex', [{ v: true, label: '带' }, { v: false, label: '不带' }]),
            h('div', { style: { marginTop: 3 } }, 'Codex 不在 DSH 里，但它的会话和技能同样不可再生。'),
          ),
          h('div', { style: { fontSize: 13 } }, '校验深度'),
          h(
            'div',
            { style: { fontSize: 12.5, color: MUTED } },
            seg('deepVerify', [{ v: false, label: '浅（快）' }, { v: true, label: '深·逐文件 sha256（慢）' }]),
          ),
          h('div', { style: { fontSize: 13 } }, '备份根目录'),
          h('input', {
            style: INPUT,
            value: cfgOf.backupRoot || '',
            onChange: (e) => setField('backupRoot', e.target.value),
          }),
        ),
      )

      // ④ 快照列表
      const listCard = h(
        Section,
        {
          title: '快照',
          hint: snapshots.length ? `${snapshots.length} 份可还原` : '还没有快照',
          right: h('button', { style: BTN, onClick: load }, '刷新'),
        },
        snapshots.length === 0
          ? h('div', { style: { fontSize: 13, color: MUTED } }, '点上面的「立即备份」跑第一份。')
          : h(
              'table',
              { style: { width: '100%', borderCollapse: 'collapse' } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: TH }, '快照 id'),
                  h('th', { style: TH }, '完成时间'),
                  h('th', { style: TH }, '状态'),
                  h('th', { style: TH }, '体积'),
                  h('th', { style: TH }, '文件'),
                  h('th', { style: TH }, '操作'),
                ),
              ),
              h(
                'tbody',
                null,
                snapshots.map((s) =>
                  h(
                    'tr',
                    { key: s.id },
                    h('td', { style: TD }, s.id),
                    h('td', { style: TD }, fmtTime(s.finishedAt)),
                    h(
                      'td',
                      { style: TD },
                      h(
                        Badge,
                        { tone: s.status === 'ok' ? 'ok' : s.status === 'partial' ? 'warn' : 'bad' },
                        s.status || '?',
                      ),
                    ),
                    h('td', { style: TD }, s.bytesText || '—'),
                    h('td', { style: TD }, s.files == null ? '—' : String(s.files)),
                    h(
                      'td',
                      { style: Object.assign({}, TD, { whiteSpace: 'nowrap' }) },
                      h(
                        'button',
                        {
                          style: Object.assign({}, BTN, { padding: '3px 9px', fontSize: 12, marginRight: 5 }),
                          disabled: !!verifying,
                          onClick: () => doVerify(s.id),
                        },
                        verifying === s.id ? '校验中…' : '校验',
                      ),
                      h(
                        'button',
                        {
                          style: Object.assign({}, BTN_DANGER, { padding: '3px 9px', fontSize: 12 }),
                          disabled: !!restoring || running,
                          onClick: () => doRestore(s.id),
                        },
                        restoring === s.id ? '还原中…' : '还原',
                      ),
                    ),
                  ),
                ),
              ),
            ),
        h(
          'div',
          { style: { marginTop: 10, fontSize: 12, color: MUTED, lineHeight: '18px' } },
          '保留策略：最近 ',
          String(cfgOf.retentionDaily || 7),
          ' 天每天一份 + 每周一份留 ',
          String(cfgOf.retentionWeekly || 4),
          ' 周。更早的会自动清掉。',
          h('br'),
          '还原是合并式的：同名文件被替换，目标里快照没有的文件保留。还原前会自动存后悔药到 _before-restore\\。',
        ),
      )

      const noteBar = note
        ? h(
            'div',
            {
              style: {
                fontSize: 12.5,
                padding: '8px 12px',
                borderRadius: 8,
                marginBottom: 12,
                border: note.bad ? '1px solid rgba(230,110,110,0.5)' : '1px solid rgba(90,150,240,0.45)',
                background: note.bad ? 'rgba(230,110,110,0.1)' : 'rgba(90,150,240,0.09)',
              },
            },
            note.text,
          )
        : null

      const log = (ov && ov.log) || []
      const logCard = log.length
        ? h(
            Section,
            { title: '日志', hint: '最近 30 条' },
            h(
              'div',
              { style: { fontSize: 11.5, fontFamily: 'ui-monospace, Consolas, monospace', color: MUTED, lineHeight: '17px', maxHeight: 220, overflow: 'auto' } },
              log.map((l, i) => h('div', { key: i }, `${(l.at || '').slice(11, 19)}  ${l.text}`)),
            ),
          )
        : null

      return h('div', { style: { padding: '4px 2px 20px' } }, head, sub, noteBar, statusCard, planCard, cfgCard, listCard, logCard)
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'data-backup', order: 54, label: () => '数据备份' }, Panel),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
