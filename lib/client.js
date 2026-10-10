/**
 * dsh-ujn-image — Client half（浏览器半边）。
 *
 * 这是一个 DSH 客户端插件 bundle：包根 `package.json` 的 `dsh.client` 声明让
 * 宿主把它作为 `/plugins/dsh-ujn-image/client.js` 提供给浏览器。这里只做一件事：
 * 往设置面板的 `settings.section` 槽位注册一个「济大词元文生图」页面——
 * 导航项由这个槽位自动出现，面板外壳（nav / 关闭按钮 / 键盘 Esc）全部复用
 * 设置页自带实现，不做任何 DOM 注入。
 *
 * 数据面统一走宿主半边注册的 HTTP 路由（`/dsh-ujn-image/*`），因此这里只依赖
 * `react` / `react/jsx-runtime`（平台静态模块表）和槽位注册服务 `slots`。
 * 本文件是**手写的纯 JS，不需要任何构建步骤**（与同机的 dsh-hidden-sessions
 * 做法一致）：Loader 只要求 `window.__ModuleLoader__.load({ id, factory })`
 * 这层包装，`id` 必须等于包名。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ujn-image',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    /**
     * 本文件的元素工厂，createElement 语义：`h(type, props, ...children)`。
     *
     * 注意这里**不能**写成 `const h = jsxRuntime.jsx`：`jsx` 的签名是
     * `jsx(type, config, maybeKey)`——只认三个参数。而下面全篇都按
     * createElement 的写法把子节点铺在后头传，第三个参数会被当成 React 的
     * **key** 吞掉，于是每个元素都只剩 props、子树整棵丢失。所以这里显式包一层，
     * 把子节点收进 props.children 再交给 jsx。
     */
    const h = (type, props, ...children) => {
      const { key, ...rest } = props ?? {}
      const flat = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      const config = flat === undefined ? rest : { ...rest, children: flat }
      return key === undefined ? jsxRuntime.jsx(type, config) : jsxRuntime.jsx(type, config, key)
    }

    /** 插件命名空间：字典注册名。 */
    const NS = 'ujn-image'
    /** 宿主半边注册的接口前缀。 */
    const API = '/dsh-ujn-image'
    /** 要注入的槽位。 */
    const SLOT = 'settings.section'

    /** 中英文案（本插件面向校内用户，两份都用中文）。 */
    const zh = {
      nav: '济大词元文生图',
      title: '济大词元文生图',
      intro: '填入济南大学大模型公共服务平台的 API Key，DSH 就能调用校内的 Qwen-Image 模型生成图片。',
      apiKey: 'API Key',
      apiKeyHint: '保存在 DSH 的凭据文件里，不会写进插件配置。留空表示保持当前密钥。',
      apiKeySet: '已配置密钥',
      apiKeyUnset: '尚未配置密钥',
      apiKeyReadOnly: '当前密钥由环境变量提供，无法在此修改。',
      getKey: '前往平台申请密钥',
      baseURL: '接口地址',
      baseURLHint: '默认使用学校平台地址；只有自建代理时才需要改。',
      model: '生图模型',
      modelHint: '平台当前提供的图片生成模型。',
      size: '默认画幅',
      sizeHint: '调用工具时未指定画幅时使用。',
      steps: '采样步数',
      stepsHint: '越大越精细也越慢，官方文生图推荐 40。',
      enhance: '默认扩写提示词',
      enhanceHint: '先用 Qwen-Image-PE-T2I 把描述扩写成结构化英文提示词，画面元素多时效果更好，但每次多花约 15 秒。',
      enhanceEdit: '编辑时默认改写指令',
      enhanceEditHint: '先用 Qwen-Image-PE-I2I 改写编辑指令。实测较慢（约 70 秒）且有时不改写，指令本身写得清楚时不必开。',
      tools: '可用工具',
      toolsHint: '配好密钥后，在对话里直接说需求，DSH 会自动选工具。',
      toolGenerate: '文生图',
      toolGenerateDesc: '「画一张……」——从文字描述生成新图片。',
      toolEdit: '图片编辑 / 图生图',
      toolEditDesc: '「让这张图里的角色去……」——给参考图，保住角色特征再改场景。',
      previewEditDefault: '让这个角色坐在电脑桌前玩电脑游戏，保持角色的发型、发饰、服装完全一致',
      previewImage: '参考图路径（填写即切换为图片编辑）',
      previewImageHint: '填相对会话工作目录的路径，或 DSH 附件目录里的只读副本路径。留空则是普通文生图。',
      previewModeGenerate: '本次：文生图',
      previewModeEdit: '本次：图片编辑',
      saveDir: '图片保存目录',
      saveDirHint: '相对路径按会话工作目录解析。',
      credentialRef: '凭据名',
      credentialRefHint: '密钥在凭据文件里的变量名。与「设置 → 模型」里的同一平台共用即可。',
      test: '测试连接',
      testing: '正在测试…',
      testOk: '连接正常',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      preview: '试生成一张',
      previewing: '正在生成…（首次调用需要加载模型，可能较慢）',
      previewPrompt: '试生成的提示词',
      previewPromptDefault: '一只戴着宇航员头盔的橘猫，漂浮在太空中，细腻写实风格',
      previewResult: '生成结果',
      previewPath: '已保存到',
      loadFailed: '读取设置失败',
      retry: '重试',
      sizeSquare: '正方形 1024×1024',
      sizeLandscape: '横版 1664×928',
      sizePortrait: '竖版 928×1664',
      sizeWide: '超宽 2528×1696',
      sizeTall: '超长 1696×2528',
      speedHint: (n) => `约 ${n} 秒`,
      seconds: (n) => `${n} 秒`,
      unconfigured: '配置好密钥后，直接在对话里说「画一张……」就会自动调用这个工具。',
      docs: '平台 API 文档',
    }

    /** 主题令牌：跟随 DSH 明暗主题，不写死颜色。 */
    const theme = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: '12px',
      },
      secondary: { color: 'var(--dsw-alias-label-secondary)' },
      tertiary: { color: 'var(--dsw-alias-label-tertiary)' },
      primary: { color: 'var(--dsw-alias-label-primary)' },
      error: { color: 'var(--dsw-alias-label-error)' },
      success: { color: 'var(--dsw-alias-state-success-primary, #34c77b)' },
    }

    /** 一个受主题约束的按钮。 */
    function Button(props) {
      const { onClick, disabled, children, tone, title, style, type } = props
      const danger = tone === 'danger'
      const primary = tone === 'primary'
      return h('button', {
        type: type ?? 'button',
        title,
        disabled: Boolean(disabled),
        onClick,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1.5',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          padding: '5px 14px',
          borderRadius: '8px',
          border: danger
            ? '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)'
            : '1px solid var(--dsw-alias-border-l2)',
          background: primary
            ? 'var(--dsw-alias-brand-primary)'
            : danger
              ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
              : 'transparent',
          color: primary
            ? 'var(--dsw-alias-label-inverse, #fff)'
            : danger
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
          ...style,
        },
      }, children)
    }

    /** 一个带标签、提示与可选"已配置"徽标的文本框。 */
    function Field(props) {
      const { id, label, hint, value, placeholder, disabled, onChange, badge, badgeTone, type } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('label', {
            htmlFor: id,
            style: { fontSize: '12px', fontWeight: 600, ...theme.primary },
          }, label),
          badge !== undefined && badge !== null
            ? h('span', {
                style: {
                  fontSize: '10px',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  ...(badgeTone === 'warn'
                    ? { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)', ...theme.error }
                    : badgeTone === 'ok'
                      ? { background: 'color-mix(in srgb, #34c77b 15%, transparent)', ...theme.success }
                      : { background: 'var(--dsw-alias-bg-layer-4)', ...theme.tertiary }),
                },
              }, badge)
            : null),
        h('input', {
          id,
          type: type ?? 'text',
          value: value ?? '',
          placeholder,
          disabled: Boolean(disabled),
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => onChange(event.target.value),
          style: {
            appearance: 'none',
            font: 'inherit',
            fontSize: '12px',
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: disabled ? 'var(--dsw-alias-bg-layer-4)' : 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            opacity: disabled ? 0.7 : 1,
          },
        }),
        hint !== undefined && hint !== null && hint !== ''
          ? h('p', { style: { margin: 0, fontSize: '11px', lineHeight: 1.5, ...theme.tertiary } }, hint)
          : null)
    }

    /** 一个布尔开关（用原生 checkbox，避免依赖 ui-primitives）。 */
    function Checkbox(props) {
      const { id, label, hint, checked, disabled, onChange } = props
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        h('label', {
          htmlFor: id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            cursor: disabled ? 'default' : 'pointer',
            ...theme.primary,
          },
        },
        h('input', {
          id,
          type: 'checkbox',
          checked: Boolean(checked),
          disabled: Boolean(disabled),
          onChange: (event) => onChange(event.target.checked),
        }),
        label),
        hint !== undefined && hint !== null && hint !== ''
          ? h('p', { style: { margin: '0 0 0 22px', fontSize: '11px', lineHeight: 1.5, ...theme.tertiary } }, hint)
          : null)
    }

    /** 一行状态提示（成功/失败/进行中）。 */
    function Notice(props) {
      const { text, tone } = props
      if (text === undefined || text === null || text === '') return null
      return h('div', {
        style: {
          fontSize: '11px',
          lineHeight: 1.5,
          padding: '6px 10px',
          borderRadius: '8px',
          background: tone === 'error'
            ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)'
            : tone === 'ok'
              ? 'color-mix(in srgb, #34c77b 10%, transparent)'
              : 'var(--dsw-alias-bg-layer-4)',
          ...(tone === 'error' ? theme.error : tone === 'ok' ? theme.success : theme.secondary),
        },
      }, text)
    }

    /** 设置页主体。 */
    function UjnImageSection(props) {
      const { t } = props

      const [phase, setPhase] = react.useState('loading') // loading | ready | failed
      const [error, setError] = react.useState('')
      const [draft, setDraft] = react.useState(null)
      const [defaults, setDefaults] = react.useState(null)
      const [sizes, setSizes] = react.useState({})
      const [imageModel, setImageModel] = react.useState('')
      const [apiKey, setApiKey] = react.useState({ configured: false, writable: true })
      const [apiKeyDraft, setApiKeyDraft] = react.useState('')
      const [busy, setBusy] = react.useState(null) // null | 'save' | 'test' | 'preview'
      const [notice, setNotice] = react.useState(null) // { text, tone }

      /** 拉取当前设置。 */
      const load = react.useCallback(async () => {
        setPhase('loading')
        setError('')
        try {
          const response = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setDraft({ ...body.settings })
          setDefaults(body.defaults ?? {})
          setSizes(body.sizes ?? {})
          setImageModel(body.imageModel ?? '')
          setApiKey(body.apiKey ?? { configured: false, writable: true })
          setApiKeyDraft('')
          setPhase('ready')
          if (typeof body.warning === 'string' && body.warning !== '') {
            setNotice({ text: body.warning, tone: 'error' })
          }
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setPhase('failed')
        }
      }, [])

      react.useEffect(() => { load() }, [load])

      /** 局部更新一个字段。 */
      const edit = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      /** 保存设置（含密钥，若有填写）。 */
      const save = async () => {
        setBusy('save')
        setNotice(null)
        try {
          const payload = { ...draft }
          if (apiKeyDraft !== '') payload.apiKey = apiKeyDraft
          const response = await fetch(`${API}/save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setDraft({ ...body.settings })
          setApiKey(body.apiKey ?? { configured: false, writable: true })
          setApiKeyDraft('')
          setNotice({ text: t('saved'), tone: 'ok' })
        } catch (cause) {
          setNotice({ text: String(cause?.message ?? cause), tone: 'error' })
        } finally {
          setBusy(null)
        }
      }

      /** 测试连接：用草稿里的地址与（可能未保存的）密钥列一次模型。 */
      const test = async () => {
        setBusy('test')
        setNotice(null)
        try {
          const response = await fetch(`${API}/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              baseURL: draft?.baseURL ?? '',
              ...(apiKeyDraft === '' ? {} : { apiKey: apiKeyDraft }),
            }),
          })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setNotice({ text: body.message ?? t('testOk'), tone: body.supportsImage === false ? 'error' : 'ok' })
        } catch (cause) {
          setNotice({ text: String(cause?.message ?? cause), tone: 'error' })
        } finally {
          setBusy(null)
        }
      }

      /** 试跑一次（文生图；填了参考图就是图片编辑）并预览。 */
      const [previewPrompt, setPreviewPrompt] = react.useState('')
      const [preview, setPreview] = react.useState(null)
      const runPreview = async () => {
        setBusy('preview')
        setNotice(null)
        setPreview(null)
        try {
          const hasRef = previewImage.trim() !== ''
          const response = await fetch(`${API}/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: previewPrompt === '' ? (hasRef ? t('previewEditDefault') : t('previewPromptDefault')) : previewPrompt,
              ...(hasRef ? { image: previewImage.trim(), enhance: draft.enhanceEdit === true } : { enhance: draft.enhance === true }),
            }),
          })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setPreview(body)
        } catch (cause) {
          setNotice({ text: String(cause?.message ?? cause), tone: 'error' })
        } finally {
          setBusy(null)
        }
      }

      const [previewImage, setPreviewImage] = react.useState('')

      if (phase === 'loading') {
        return h('div', { style: { padding: '24px', fontSize: '13px', ...theme.tertiary } }, '正在读取设置…')
      }
      if (phase === 'failed') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '24px' } },
          h('p', { style: { margin: 0, fontSize: '13px', ...theme.error } }, `${t('loadFailed')}：${error}`),
          h(Button, { onClick: load }, t('retry')))
      }

      const sizeOptions = Object.keys(sizes).length > 0 ? Object.keys(sizes) : ['square', 'landscape', 'portrait', 'wide', 'tall']

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' } },

        // 标题
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, t('title')),
          h('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, ...theme.tertiary } }, t('intro'))),

        // API Key
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', ...theme.card } },
          h(Field, {
            id: 'ujn-api-key',
            type: 'password',
            label: t('apiKey'),
            hint: apiKey.writable === false ? t('apiKeyReadOnly') : t('apiKeyHint'),
            value: apiKeyDraft,
            placeholder: apiKey.configured ? '••••••••（留空则保持当前密钥）' : 'ujn-xxxxxxxxxxxxxxxx',
            disabled: apiKey.writable === false,
            onChange: setApiKeyDraft,
            badge: apiKey.configured ? t('apiKeySet') : t('apiKeyUnset'),
            badgeTone: apiKey.configured ? 'ok' : 'warn',
          }),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(Button, {
              onClick: () => window.open('https://llm.ujn.edu.cn/#/docs', '_blank', 'noopener'),
            }, t('getKey')),
            h(Button, { onClick: test, disabled: busy !== null }, busy === 'test' ? t('testing') : t('test'))),
          apiKey.configured !== true
            ? h(Notice, { text: t('unconfigured'), tone: 'info' })
            : null),

        // 接口与模型
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px', ...theme.card } },
          h(Field, {
            id: 'ujn-base-url',
            label: t('baseURL'),
            hint: t('baseURLHint'),
            value: draft.baseURL ?? '',
            placeholder: defaults.baseURL ?? '',
            onChange: (value) => edit('baseURL', value),
          }),
          h(Field, {
            id: 'ujn-model',
            label: t('model'),
            hint: imageModel === '' ? t('modelHint') : `${t('modelHint')}（平台当前为 ${imageModel}）`,
            value: draft.model ?? '',
            placeholder: defaults.model ?? '',
            onChange: (value) => edit('model', value),
          }),
          h(Field, {
            id: 'ujn-credential-ref',
            label: t('credentialRef'),
            hint: t('credentialRefHint'),
            value: draft.credentialRef ?? '',
            placeholder: defaults.credentialRef ?? '',
            onChange: (value) => edit('credentialRef', value),
          })),

        // 生图偏好
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px', ...theme.card } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('label', {
              htmlFor: 'ujn-size',
              style: { fontSize: '12px', fontWeight: 600, ...theme.primary },
            }, t('size')),
            h('select', {
              id: 'ujn-size',
              value: draft.size ?? 'square',
              onChange: (event) => edit('size', event.target.value),
              style: {
                appearance: 'none',
                font: 'inherit',
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, sizeOptions.map((key) => h('option', { key, value: key },
              `${t(`size${key.charAt(0).toUpperCase()}${key.slice(1)}`) || key} · ${sizes[key] ?? ''}`))),
            h('p', { style: { margin: 0, fontSize: '11px', ...theme.tertiary } }, t('sizeHint'))),

          h(Field, {
            id: 'ujn-steps',
            label: t('steps'),
            hint: t('stepsHint'),
            value: String(draft.steps ?? ''),
            onChange: (value) => edit('steps', value),
          }),
          h(Checkbox, {
            id: 'ujn-enhance',
            label: t('enhance'),
            hint: t('enhanceHint'),
            checked: draft.enhance === true,
            onChange: (value) => edit('enhance', value),
          }),
          h(Checkbox, {
            id: 'ujn-enhance-edit',
            label: t('enhanceEdit'),
            hint: t('enhanceEditHint'),
            checked: draft.enhanceEdit === true,
            onChange: (value) => edit('enhanceEdit', value),
          }),
          h(Field, {
            id: 'ujn-save-dir',
            label: t('saveDir'),
            hint: t('saveDirHint'),
            value: draft.saveDir ?? '',
            placeholder: defaults.saveDir ?? '',
            onChange: (value) => edit('saveDir', value),
          })),

        // 试跑（文生图 / 图片编辑）
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', ...theme.card } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, ...theme.primary } }, t('preview')),
          h(Field, {
            id: 'ujn-preview-image',
            label: t('previewImage'),
            hint: t('previewImageHint'),
            value: previewImage,
            placeholder: 'reference.png',
            onChange: setPreviewImage,
          }),
          h(Field, {
            id: 'ujn-preview-prompt',
            label: t('previewPrompt'),
            value: previewPrompt,
            placeholder: previewImage.trim() === '' ? t('previewPromptDefault') : t('previewEditDefault'),
            onChange: setPreviewPrompt,
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h(Button, {
              tone: 'primary',
              onClick: runPreview,
              disabled: busy !== null || apiKey.configured !== true,
            }, busy === 'preview' ? t('previewing') : t('preview')),
            h('span', { style: { fontSize: '11px', ...theme.tertiary } },
              previewImage.trim() === '' ? t('previewModeGenerate') : t('previewModeEdit'))),
          preview !== null
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('p', { style: { margin: 0, fontSize: '11px', ...theme.tertiary } },
                  `${t('previewResult')} · ${preview.width}×${preview.height} · ${t('seconds')(Math.round((preview.elapsedMs ?? 0) / 1000))}`),
                h('img', {
                  src: `${API}/file?name=${encodeURIComponent(preview.fileName)}&t=${Date.now()}`,
                  alt: t('previewResult'),
                  style: {
                    maxWidth: '100%',
                    maxHeight: '360px',
                    borderRadius: '10px',
                    border: '0.5px solid var(--dsw-alias-border-l3)',
                  },
                }),
                h('p', { style: { margin: 0, fontSize: '11px', wordBreak: 'break-all', ...theme.tertiary } },
                  `${t('previewPath')} ${preview.path}`))
            : null),

        // 可用工具说明
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 16px', ...theme.card } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, ...theme.primary } }, t('tools')),
          h('p', { style: { margin: 0, fontSize: '11px', ...theme.tertiary } }, t('toolsHint')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
              h('code', { style: { fontSize: '11px', padding: '1px 6px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-4)', ...theme.secondary } }, 'ujn_generate_image'),
              h('span', { style: { fontSize: '11px', ...theme.tertiary } }, t('toolGenerateDesc'))),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
              h('code', { style: { fontSize: '11px', padding: '1px 6px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-4)', ...theme.secondary } }, 'ujn_edit_image'),
              h('span', { style: { fontSize: '11px', ...theme.tertiary } }, t('toolEditDesc'))))),

        // 动作条
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h(Button, { tone: 'primary', onClick: save, disabled: busy !== null }, busy === 'save' ? t('saving') : t('save')),
          h(Button, {
            onClick: () => window.open('https://llm.ujn.edu.cn/#/docs', '_blank', 'noopener'),
          }, t('docs')),
          busy === 'preview' ? h('span', { style: { fontSize: '11px', ...theme.tertiary } }, t('previewing')) : null),

        h(Notice, { text: notice?.text, tone: notice?.tone }))
    }

    /**
     * 需要 `slots`（注册页面）与 `locale`（提供 t()）。
     * 目标槽位本身由 ui-settings 声明，激活顺序不作约束，
     * 因此用 `slots.inject()` 等声明就位，而不是硬依赖那个插件。
     */
    const inject = ['slots', 'locale']

    /** @param ctx - 客户端根上下文 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en: zh }), 'ujn-image: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'ujn-image',
        order: 42,
        label: () => t('nav'),
        locale: NS,
      }, UjnImageSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.UjnImageSection = UjnImageSection
    return module.exports
  },
})
