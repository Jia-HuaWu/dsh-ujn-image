/**
 * dsh-ujn-image — 济大词元（济南大学大模型公共服务平台）API 客户端。
 *
 * 这个文件是纯函数 + 纯网络的一层，不含任何 DSH / Cordis 依赖，
 * 因此可以被 `scripts/selftest.mjs` 直接驱动，也可以在宿主机半边和
 * 自测脚本之间共用同一份协议实现（避免"文档里是 A、代码里是 B"）。
 *
 * 平台是 OpenAI 兼容接口：
 *   POST {base}/v1/images/generations   文生图，返回 data[0].b64_json
 *   POST {base}/v1/images/edits         图生图 / 图片编辑（multipart，最多 4 张输入图）
 *   POST {base}/v1/chat/completions     提示词增强（Qwen-Image-PE-T2I / PE-I2I）
 *   GET  {base}/v1/models               可用模型列表
 *
 * 认证统一走 `Authorization: Bearer ujn-...`。
 */

/** 平台默认地址（不含 /v1 后缀，由 normalizeBaseURL 统一补上）。 */
export const DEFAULT_BASE_URL = 'https://llm.ujn.edu.cn'

/** 生图模型：支持文生图 / 图生图 / 图片编辑。 */
export const IMAGE_MODEL = 'Qwen-Image-2.1'
/** 文生图提示词增强模型：把简短描述扩写成结构化英文提示词并推断画幅。 */
export const PROMPT_ENHANCE_MODEL = 'Qwen-Image-PE-T2I'
/** 图片编辑提示词增强模型：把中文编辑指令改写成结构化英文指令。 */
export const PROMPT_ENHANCE_EDIT_MODEL = 'Qwen-Image-PE-I2I'

/** `/images/edits` 最多接受的输入图数量（平台硬限制）。 */
export const MAX_EDIT_IMAGES = 4

/**
 * 画幅预设：模型名 → 平台接受的 `size` 字面量。
 *
 * 平台按像素总数与长宽比共同约束分辨率，常用档位集中在下面这些值上；
 * 传入未列出的 `size` 时平台会自行校验并返回可读错误，所以这里只做
 * 「给模型一个好用的枚举」，不做白名单拒绝。
 */
export const SIZE_PRESETS = {
  square: '1024x1024',
  landscape: '1664x928',
  portrait: '928x1664',
  wide: '2528x1696',
  tall: '1696x2528',
}

/**
 * 从各种写法的地址里解析出规范的 API 根地址。
 *
 * 用户可能填 `https://llm.ujn.edu.cn`、`https://llm.ujn.edu.cn/`、
 * `https://llm.ujn.edu.cn/v1` 甚至 `.../v1/`；统一折叠成不带尾斜杠的
 * `https://llm.ujn.edu.cn/v1`，后续请求直接拼 `/images/generations`。
 * @param raw - 用户填写的地址；为空时回退到平台默认地址。
 * @returns 形如 `https://host/v1` 的根地址。
 */
export function normalizeBaseURL(raw) {
  const input = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`接口地址不是合法的 URL：${input}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`接口地址必须是 http/https：${input}`)
  }
  // 去掉尾部斜杠，再保证恰好一个 /v1 后缀。
  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/v1$/.test(path)) path = `${path}/v1`
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/**
 * 把平台返回的错误体翻译成一句人话。
 *
 * 平台错误体是 OpenAI 风格 `{error:{message,type,code}}`，但也可能直接
 * 返回 FastAPI 的 `{detail:[...]}`。两者都认，认不出就退回原始文本。
 * @param status - HTTP 状态码。
 * @param text - 响应体原文。
 * @returns 人类可读的错误说明。
 */
export function describeHttpError(status, text) {
  const body = typeof text === 'string' ? text.trim() : ''
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const message =
    parsed?.error?.message ??
    (Array.isArray(parsed?.detail) ? parsed.detail.map((d) => d?.msg ?? JSON.stringify(d)).join('; ') : parsed?.detail) ??
    undefined
  const hint = status === 401
    ? '（API Key 无效或已吊销，请在插件设置里重新填写）'
    : status === 403
      ? '（当前账号无权使用该模型）'
      : status === 429
        ? '（请求过于频繁或额度不足，稍后重试）'
        : ''
  if (typeof message === 'string' && message !== '') return `HTTP ${status}：${message}${hint}`
  return `HTTP ${status}${hint}${body === '' ? '' : `：${body.slice(0, 500)}`}`
}

/**
 * 发一个 JSON 请求并把「非 2xx」变成带可读原因的异常。
 * @param url - 完整请求地址。
 * @param options - fetch 选项（method/headers/body/signal）。
 * @param fetchImpl - 可注入的 fetch 实现，默认用全局 fetch。
 * @returns 解析后的 JSON 体。
 */
async function requestJson(url, options, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行时没有可用的 fetch 实现')
  const response = await doFetch(url, options)
  const text = await response.text()
  if (!response.ok) throw new Error(describeHttpError(response.status, text))
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回的不是合法 JSON：${text.slice(0, 300)}`)
  }
}

/**
 * 组装带 Bearer 认证的请求头。
 * @param apiKey - 平台密钥；为空时抛出可读错误。
 * @param extra - 额外请求头。
 * @returns 请求头对象。
 */
export function authHeaders(apiKey, extra = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key === '') throw new Error('尚未配置济大词元 API Key，请先在「设置 → 济大词元文生图」中填写')
  return { Authorization: `Bearer ${key}`, ...extra }
}

/**
 * 文生图：调用 `/images/generations` 并把 base64 解码成 PNG 字节。
 *
 * @param options - 生图参数。
 * @param options.apiKey - 平台密钥（必需）。
 * @param options.prompt - 提示词（必需，中文可直接用）。
 * @param options.baseURL - 平台根地址，默认 {@link DEFAULT_BASE_URL}。
 * @param options.model - 生图模型，默认 {@link IMAGE_MODEL}。
 * @param options.size - 分辨率字面量，如 `1024x1024`。
 * @param options.steps - 采样步数（`num_inference_steps`）。
 * @param options.cfgScale - `true_cfg_scale` 引导强度。
 * @param options.seed - 随机种子；省略则由平台随机。
 * @param options.count - 一次生成几张（平台通常只回 1 张）。
 * @param options.signal - 取消信号。
 * @param options.fetchImpl - 可注入的 fetch。
 * @returns `{ images: Buffer[], model, size, elapsedMs }`。
 */
export async function generateImage(options) {
  const {
    apiKey,
    prompt,
    baseURL = DEFAULT_BASE_URL,
    model = IMAGE_MODEL,
    size = SIZE_PRESETS.square,
    steps,
    cfgScale,
    seed,
    count,
    signal,
    fetchImpl,
  } = options

  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text === '') throw new Error('提示词不能为空')

  const body = { model, prompt: text, size }
  if (Number.isFinite(steps) && steps > 0) body.num_inference_steps = Math.trunc(steps)
  if (Number.isFinite(cfgScale)) body.true_cfg_scale = cfgScale
  if (Number.isFinite(seed)) body.seed = Math.trunc(seed)
  if (Number.isFinite(count) && count > 1) body.n = Math.trunc(count)

  const started = Date.now()
  const payload = await requestJson(
    `${normalizeBaseURL(baseURL)}/images/generations`,
    {
      method: 'POST',
      headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    },
    fetchImpl,
  )

  const entries = Array.isArray(payload?.data) ? payload.data : []
  if (entries.length === 0) throw new Error('平台没有返回任何图片（data 为空）')

  const images = []
  for (const entry of entries) {
    // 平台约定回 b64_json；个别网关会改回 url，这里只接受 base64，
    // 因为 URL 形式无法满足"图片可被持久引用"的要求。
    if (typeof entry?.b64_json !== 'string' || entry.b64_json === '') {
      throw new Error('平台返回的图片不是 b64_json 形式，无法保存')
    }
    images.push(Buffer.from(entry.b64_json, 'base64'))
  }
  return { images, model, size, elapsedMs: Date.now() - started }
}

/**
 * 图片编辑 / 图生图：调用 `/images/edits`（**multipart 表单**，非 JSON）。
 *
 * 平台明确约定该接口只接受 multipart，最多 4 张输入图。相比纯文生图，
 * 把参考图一起发上去能显著保住角色特征——这也是"根据这张图画……"这类
 * 需求唯一靠谱的做法。
 *
 * @param options - 编辑参数。
 * @param options.apiKey - 平台密钥（必需）。
 * @param options.prompt - 编辑指令（必需，中文可直接用）。
 * @param options.images - 输入图字节数组（1..4 张，必需）。
 * @param options.baseURL - 平台根地址，默认 {@link DEFAULT_BASE_URL}。
 * @param options.model - 编辑模型，默认 {@link IMAGE_MODEL}。
 * @param options.size - 分辨率字面量，如 `1024x1024`。
 * @param options.steps - 采样步数（`num_inference_steps`）。
 * @param options.cfgScale - `true_cfg_scale` 引导强度。
 * @param options.seed - 随机种子；省略则由平台随机。
 * @param options.signal - 取消信号。
 * @param options.fetchImpl - 可注入的 fetch。
 * @param options.formImpl - 可注入的 FormData/Blob 工厂（自测用）。
 * @returns `{ images: Buffer[], model, size, elapsedMs }`。
 */
export async function editImage(options) {
  const {
    apiKey,
    prompt,
    images,
    baseURL = DEFAULT_BASE_URL,
    model = IMAGE_MODEL,
    size = SIZE_PRESETS.square,
    steps,
    cfgScale,
    seed,
    signal,
    fetchImpl,
    formImpl,
  } = options

  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text === '') throw new Error('编辑指令不能为空')

  const inputs = Array.isArray(images) ? images.filter((b) => b !== undefined && b !== null) : []
  if (inputs.length === 0) throw new Error('至少需要一张输入图片')
  if (inputs.length > MAX_EDIT_IMAGES) {
    throw new Error(`最多只能传 ${MAX_EDIT_IMAGES} 张输入图片，收到 ${inputs.length} 张`)
  }

  const factory = formImpl ?? defaultFormFactory()
  const form = factory.createForm()
  for (const [index, bytes] of inputs.entries()) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const name = `image${index === 0 ? '' : index + 1}.png`
    factory.appendFile(form, 'image', data, name)
  }
  form.append('prompt', text)
  form.append('model', model)
  form.append('size', size)
  if (Number.isFinite(steps) && steps > 0) form.append('num_inference_steps', String(Math.trunc(steps)))
  if (Number.isFinite(cfgScale)) form.append('true_cfg_scale', String(cfgScale))
  if (Number.isFinite(seed)) form.append('seed', String(Math.trunc(seed)))

  const started = Date.now()
  // 注意：multipart 的 Content-Type 必须由运行时自己带上 boundary，
  // 所以这里只给 Authorization，绝不手写 Content-Type。
  const payload = await requestJson(
    `${normalizeBaseURL(baseURL)}/images/edits`,
    { method: 'POST', headers: authHeaders(apiKey), body: form, signal },
    fetchImpl,
  )

  const entries = Array.isArray(payload?.data) ? payload.data : []
  if (entries.length === 0) throw new Error('平台没有返回任何图片（data 为空）')
  const out = []
  for (const entry of entries) {
    if (typeof entry?.b64_json !== 'string' || entry.b64_json === '') {
      throw new Error('平台返回的图片不是 b64_json 形式，无法保存')
    }
    out.push(Buffer.from(entry.b64_json, 'base64'))
  }
  return { images: out, model, size, elapsedMs: Date.now() - started }
}

/**
 * 默认的 multipart 工厂：优先用运行时自带的 FormData/Blob（Node 18+ 全局可用）。
 * @returns `{ createForm, appendFile }`。
 */
function defaultFormFactory() {
  return {
    createForm() {
      if (typeof FormData !== 'function') throw new Error('当前运行时没有 FormData，无法上传图片')
      return new FormData()
    },
    appendFile(form, field, bytes, name) {
      if (typeof Blob !== 'function') throw new Error('当前运行时没有 Blob，无法上传图片')
      // 用 Uint8Array 视图而不是 Buffer：某些实现的 Blob 对 Buffer 处理不一致。
      form.append(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name)
    },
  }
}

/**
 * 图片编辑的提示词增强：调用 `Qwen-Image-PE-I2I` 把中文编辑指令改写成
 * 结构化英文指令。
 *
 * 实测该模型较慢（一次约 70 秒），且有时不改写、原样回显中文；调用方应当
 * 把它当"锦上添花"，失败或没改写都要能继续用原始指令。
 * @param options - 增强参数。
 * @param options.apiKey - 平台密钥。
 * @param options.prompt - 原始编辑指令。
 * @param options.image - 参考图字节（可选；带上能让改写更贴合原图）。
 * @param options.baseURL - 平台根地址。
 * @param options.signal - 取消信号。
 * @param options.fetchImpl - 可注入的 fetch。
 * @returns `{ rewrittenPrompt, ratioFollow, raw }`；解析失败时 `rewrittenPrompt` 为 null。
 */
export async function enhanceEditPrompt(options) {
  const { apiKey, prompt, image, baseURL = DEFAULT_BASE_URL, signal, fetchImpl } = options
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text === '') throw new Error('编辑指令不能为空')

  // 官方约定：图片在前（多张依次 <image1> <image2>…），文字指令在最后。
  const content = []
  if (image !== undefined && image !== null) {
    const data = Buffer.isBuffer(image) ? image : Buffer.from(image)
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${data.toString('base64')}` } })
  }
  content.push({ type: 'text', text })

  const payload = await requestJson(
    `${normalizeBaseURL(baseURL)}/chat/completions`,
    {
      method: 'POST',
      headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: PROMPT_ENHANCE_EDIT_MODEL,
        messages: [{ role: 'user', content: content.length === 1 ? text : content }],
        // 官方推荐采样参数：presence_penalty 图片编辑固定 0。
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        presence_penalty: 0,
        max_tokens: 6000,
        seed: 42,
      }),
      signal,
    },
    fetchImpl,
  )

  const raw = payload?.choices?.[0]?.message?.content
  const content2 = typeof raw === 'string' ? raw : ''
  const parsed = parseEnhancedPrompt(content2)
  return {
    rewrittenPrompt: parsed?.rewritten_prompt ?? null,
    ratioFollow: parsed?.ratio_follow ?? null,
    raw: content2,
  }
}

/**
 * 提示词增强：调用 `Qwen-Image-PE-T2I` 把简短描述扩写成结构化英文提示词。
 *
 * 该模型的思考过程内联在 `content` 开头，末尾是单行 JSON；这里取最后一个
 * `{` 到结尾做宽容解析（与官方文档给出的提取方式一致）。
 * @param options - 增强参数。
 * @param options.apiKey - 平台密钥。
 * @param options.prompt - 原始描述。
 * @param options.baseURL - 平台根地址。
 * @param options.signal - 取消信号。
 * @param options.fetchImpl - 可注入的 fetch。
 * @returns `{ rewrittenPrompt, whRatio, raw }`；解析失败时 `rewrittenPrompt` 为 null。
 */
export async function enhancePrompt(options) {
  const { apiKey, prompt, baseURL = DEFAULT_BASE_URL, signal, fetchImpl } = options
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text === '') throw new Error('提示词不能为空')

  const payload = await requestJson(
    `${normalizeBaseURL(baseURL)}/chat/completions`,
    {
      method: 'POST',
      headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: PROMPT_ENHANCE_MODEL,
        messages: [{ role: 'user', content: text }],
        // 官方推荐的采样参数：presence_penalty 文生图固定 1.5。
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        presence_penalty: 1.5,
        max_tokens: 6000,
        seed: 42,
      }),
      signal,
    },
    fetchImpl,
  )

  const content = payload?.choices?.[0]?.message?.content
  const raw = typeof content === 'string' ? content : ''
  const parsed = parseEnhancedPrompt(raw)
  return { rewrittenPrompt: parsed?.rewritten_prompt ?? null, whRatio: parsed?.wh_ratio ?? null, raw }
}

/**
 * 从提示词增强模型的输出里抽出末尾那个 JSON 对象。
 * @param content - 模型回复全文（含思考过程）。
 * @returns 解析出的对象，或 null。
 */
export function parseEnhancedPrompt(content) {
  if (typeof content !== 'string' || content.trim() === '') return null
  const start = content.lastIndexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(content.slice(start))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 列出平台可用模型（用于设置页的「测试连接」）。
 * @param options - `{ apiKey, baseURL, signal, fetchImpl }`。
 * @returns 模型 id 数组。
 */
export async function listModels(options) {
  const { apiKey, baseURL = DEFAULT_BASE_URL, signal, fetchImpl } = options
  const payload = await requestJson(
    `${normalizeBaseURL(baseURL)}/models`,
    { method: 'GET', headers: authHeaders(apiKey), signal },
    fetchImpl,
  )
  const entries = Array.isArray(payload?.data) ? payload.data : []
  return entries.map((entry) => String(entry?.id ?? '')).filter((id) => id !== '')
}

/**
 * 从 PNG 字节里读出宽高（IHDR 固定在第 16..24 字节）。
 *
 * 之所以自己解析而不是引入图像库：DSH 的文件系统 seam 的变更操作只支持
 * 文本，PNG 必须经 `node:fs` 落盘，而这里需要的仅是「喂给附件服务前
 * 拿到准确宽高」这一点元数据，解 IHDR 就够了。
 * @param buffer - PNG 文件字节。
 * @returns `{ width, height }`。
 * @throws 当字节不是合法 PNG（签名或 IHDR 不匹配）时。
 */
export function pngSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) {
    throw new Error('返回的图片不是合法 PNG（缺少 PNG 签名）')
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('返回的图片不是合法 PNG（缺少 IHDR 块）')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 由提示词与分辨率生成一个安全的文件名（不含目录、含扩展名）。
 *
 * 只保留中日韩、字母、数字与少量连接符，其余压成 `-`；过长时截断，
 * 保证在 Windows / Linux 上都能落盘。
 * @param prompt - 原始提示词。
 * @param size - 分辨率字面量，用于附加在文件名里。
 * @param stamp - 时间戳（毫秒）。
 * @param index - 同批次内的序号（从 1 开始）。
 * @param tag - 附加在扩展名前的标记（例如 `edit` 表示这是编辑产物）。
 * @returns 形如 `ujn-20260101-120000-1024x1024-edit-一只猫.png` 的文件名。
 */
export function imageFileName(prompt, size, stamp, index = 1, tag = '') {
  const cleaned = String(prompt ?? '')
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const date = new Date(Number.isFinite(stamp) ? stamp : Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const suffix = index > 1 ? `-${index}` : ''
  const sizePart = typeof size === 'string' && size !== '' ? `-${size}` : ''
  const tagPart = typeof tag === 'string' && tag !== '' ? `-${tag}` : ''
  return `ujn-${time}${sizePart}${tagPart}${cleaned === '' ? '' : `-${cleaned}`}${suffix}.png`
}
