/**
 * dsh-ujn-image — Host half（宿主半边）。
 *
 * 这个半边做三件事：
 *
 *   1. **注册 `ujn_generate_image` 工具**，让模型能调用济大词元（济南大学
 *      大模型公共服务平台）的 Qwen-Image 模型生成图片。
 *   2. **注册设置页的数据面路由**（前缀 `/dsh-ujn-image`），浏览器半边
 *      靠它们读写 API Key 与偏好、测试连接、以及「试生成一张」。
 *   3. 把生成的 PNG 落盘，并**同时**把它登记成 DSH 的持久图片附件，
 *      于是模型能在下一步真的"看见"这张图（走 `ImageBlock` 内容块）。
 *
 * ── 为什么工具定义是手写的、而不是 `defineTool(...)` ─────────────────────
 * 官方文档（`cordis-plugin-development` 技能、各包的 README）给出的写法是
 * `import { defineTool } from '@deepseek-ai/dsh-tools'`。但实测**第三方插件
 * 解析不到这个包**：profile 的 `node_modules` 里只有宿主自己发布的那几个
 * 依赖，`@deepseek-ai/dsh-tools` 并不在其中，Node 的 ESM 解析会直接
 * `ERR_MODULE_NOT_FOUND`。（`dsh-hidden-sessions` / `dsh-pocket` 等同机插件
 * 也都不 import 任何 `@deepseek-ai/*`，只用 `node:*` 与自己的相对导入。）
 *
 * `defineTool` 实际只做两件事：把「简写参数表」编译成标准 JSON Schema，
 * 再在 `execute` 外包一层参数校验。注册表本身（`ctx.tools.register`）
 * 接受的就是**编译后的原始形态**——这一点可以从 `ToolRuntime.register()`
 * 的实现读出来：它只校验 `output.{schema,render}` 的形状、断言 schema 属于
 * 受支持子集，然后原样放进注册表，参数的 schema 会被直接投影给模型。
 * 因此这里直接产出注册表期望的原始形状，等价且不引入解析不到的依赖。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_BASE_URL,
  IMAGE_MODEL,
  MAX_EDIT_IMAGES,
  PROMPT_ENHANCE_EDIT_MODEL,
  PROMPT_ENHANCE_MODEL,
  SIZE_PRESETS,
  editImage,
  enhanceEditPrompt,
  enhancePrompt,
  generateImage,
  listModels,
  normalizeBaseURL,
  imageFileName,
  pngSize,
} from './ujn-api.mjs'
import {
  DEFAULTS,
  describeApiKey,
  previewDir,
  readSettings,
  resolveApiKey,
  resolveSettings,
  resolveSize,
  saveApiKey,
  writeSettings,
} from './settings.mjs'

/** 需要 `tools` 才能注册工具、需要 `webServer` 才能给设置页开数据面。 */
const inject = ['tools', 'webServer']

/** 工具名：与插件同前缀，避免和其它插件撞名。 */
const TOOL_NAME = 'ujn_generate_image'

/** 图片编辑工具名。 */
const EDIT_TOOL_NAME = 'ujn_edit_image'

/** 单张参考图上限：平台的编辑接口是给"照片级"输入设计的，这里给足余量。 */
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024

/** 路由前缀。 */
const ROUTE_PREFIX = '/dsh-ujn-image'

/**
 * 生图超时上限（毫秒）。
 *
 * 平台按分辨率与步数串行推理：实测 1024x1024/20 步约 11 秒，
 * 2528x1696/20 步约 73 秒，步数拉满后会更久。给 10 分钟余量，
 * 超时由 `AbortController` 主动中止，避免请求悬挂。
 */
const GENERATE_TIMEOUT_MS = 600_000

/** 提示词增强超时（实测约 15 秒，给足余量）。 */
const ENHANCE_TIMEOUT_MS = 180_000

/** JSON 响应头。 */
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/**
 * 判断一个请求是不是可信的本机浏览器会话。
 *
 * 这些路由能写入 API Key，因此不能对任意来源开放。DSH 的 Web 端默认只监听
 * 回环地址，但仍要挡住两类常见问题：**DNS 重绑定**（伪造 Host 让浏览器把
 * 请求发到本机）与**跨站请求**（别的网页偷偷 POST 进来）。判定与
 * `dsh-whale-widget` 采用的轻量栅栏同构，但这里是 fail-closed 的：
 * 只认明确的回环权威。
 * @param req - Node 的 IncomingMessage。
 * @returns 是否放行。
 */
function isTrustedRequest(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  // 允许一行显式声明的额外权威（例如通过反代/局域网访问 Web 端）。
  const extra = String(process.env.DSH_UJN_IMAGE_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (host !== '' && extra.includes(host)) return true
  // 逐段校验回环，防 `127.0.0.1.evil.com` 这类相似域名。
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname) &&
      hostname.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  if (!loopback) return false
  // 带 Origin 时必须与 Host 同源；跨站标记一律拒绝。
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 读取并解析请求体（带上限，避免无界缓冲）。
 * @param req - Node 的 IncomingMessage。
 * @param limit - 最大字节数。
 * @returns 解析后的 JSON 对象（空体返回 `{}`）。
 */
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 发一个 JSON 响应。
 * @param res - Node 的 ServerResponse。
 * @param status - HTTP 状态码。
 * @param payload - 要序列化的对象。
 */
function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

/**
 * 解析会话工作目录。
 * @param exec - 工具执行上下文。
 * @returns 绝对目录，取不到时回退到进程当前目录。
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/**
 * 把生成的 PNG 写到磁盘。
 *
 * 用 `node:fs` 而不是 `ctx.fs`：DSH 的文件系统 seam 明确规定**变更操作只支持
 * 文本**（二进制写入被 `FS_NOT_TEXT` 拒绝），因此二进制落盘必须走宿主进程的
 * 原生文件系统 —— 已安装插件运行在宿主进程内，不受工作区沙箱限制。
 * @param dir - 目标目录（绝对或相对会话工作目录）。
 * @param cwd - 会话工作目录。
 * @param name - 文件名。
 * @param data - PNG 字节。
 * @returns 绝对路径。
 */
function writeImageFile(dir, cwd, name, data) {
  const target = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir)
  fs.mkdirSync(target, { recursive: true })
  const file = path.join(target, name)
  fs.writeFileSync(file, data)
  return file
}

/** 支持的输入图格式：magic bytes → MIME 类型。 */
const IMAGE_MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
]

/**
 * 按 magic bytes 识别图片格式。
 *
 * 不信任扩展名：DSH 给模型看的是"规范化副本"的只读路径，那个路径**没有扩展名**，
 * 所以只能靠内容判断格式。
 * @param buffer - 文件字节。
 * @returns MIME 字符串，或 undefined。
 */
export function sniffImageMime(buffer) {
  for (const entry of IMAGE_MAGIC) {
    if (buffer.length < entry.bytes.length) continue
    if (!entry.bytes.every((b, i) => buffer[i] === b)) continue
    if (entry.extra !== undefined) {
      if (buffer.length < entry.extra.at + entry.extra.bytes.length) continue
      if (!entry.extra.bytes.every((b, i) => buffer[entry.extra.at + i] === b)) continue
    }
    return entry.mime
  }
  return undefined
}

/**
 * 读取一张参考图。
 *
 * 支持两种写法：
 *   · 普通路径（相对路径按会话工作目录解析）；
 *   · DSH 附件目录里的**规范化副本**路径——它没有扩展名，因此格式靠 magic bytes 判定。
 *
 * @param referencePath - 用户/模型给出的路径。
 * @param cwd - 会话工作目录。
 * @param maxBytes - 单张上限，超过则拒绝（避免把几百 MB 塞给平台）。
 * @returns `{ data, mime, file }`。
 * @throws 文件不存在、不是图片、或过大时。
 */
export function readReferenceImage(referencePath, cwd, maxBytes = MAX_REFERENCE_BYTES) {
  const raw = typeof referencePath === 'string' ? referencePath.trim() : ''
  if (raw === '') throw new Error('参考图路径不能为空')
  const file = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)

  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error(`找不到参考图：${raw}`)
  }
  if (!stat.isFile()) throw new Error(`参考图不是常规文件：${raw}`)
  if (stat.size > maxBytes) {
    throw new Error(`参考图过大（${(stat.size / 1048576).toFixed(1)} MB），上限 ${(maxBytes / 1048576).toFixed(0)} MB`)
  }

  const data = fs.readFileSync(file)
  const mime = sniffImageMime(data)
  if (mime === undefined) {
    throw new Error(`参考图不是受支持的图片格式（PNG/JPEG/WebP/GIF）：${raw}`)
  }
  return { data, mime, file }
}

/**
 * 落盘一张已生成的 PNG，并（如可用）登记为持久图片附件。
 *
 * 文生图与图片编辑共用这一段：两者的差别只在"字节从哪来"，
 * 之后的命名、写盘、附件登记、返回值组装完全一致。
 *
 * @param ctx - 宿主上下文。
 * @param options - 收尾参数。
 * @param options.data - PNG 字节。
 * @param options.prompt - 原始提示词/编辑指令（用于自动命名与回显）。
 * @param options.finalPrompt - 实际发给平台的提示词（增强后可能是改写版）。
 * @param options.size - 平台分辨率字面量。
 * @param options.model - 实际使用的模型。
 * @param options.elapsedMs - 平台耗时。
 * @param options.enhancement - 增强过程的元信息（或 null）。
 * @param options.settings - 已解析的生效设置。
 * @param options.cwd - 会话工作目录。
 * @param options.signal - 取消信号。
 * @param options.save - 是否落盘。
 * @param options.fileName - 可选自定义文件名。
 * @param options.suffix - 自动命名时附加的标记（编辑图用 `edit` 区分）。
 * @returns 结构化结果。
 */
async function finalizeImage(ctx, options) {
  const {
    data,
    prompt,
    finalPrompt,
    size,
    model,
    elapsedMs,
    enhancement = null,
    settings,
    cwd,
    save = true,
    fileName,
    suffix = '',
  } = options

  const dimensions = pngSize(data)

  // 自定义文件名若已存在，加序号而不是覆盖——用户可能正好在对比两次结果。
  let name = typeof fileName === 'string' && fileName.trim() !== ''
    ? path.basename(fileName.trim())
    : imageFileName(prompt, size, Date.now(), 1, suffix)
  if (!name.toLowerCase().endsWith('.png')) name = `${name}.png`
  const dir = path.isAbsolute(settings.saveDir) ? settings.saveDir : path.resolve(cwd, settings.saveDir)
  if (save) {
    let candidate = name
    for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) {
      candidate = `${name.slice(0, -4)}-${n}.png`
    }
    name = candidate
  }
  const file = save ? writeImageFile(settings.saveDir, cwd, name, data) : null

  // 登记为持久附件：模型下一步就能真的"看见"这张图。
  // 附件服务缺失时优雅降级——仍然返回文件路径与文本说明。
  let attachment = null
  const attachments = ctx.get?.('attachments')
  if (attachments !== undefined && typeof attachments.saveImage === 'function') {
    try {
      const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
      if (ref !== undefined && ref !== null) {
        attachment = {
          attachmentId: String(ref.attachmentId),
          mediaType: String(ref.mediaType ?? 'image/png'),
          bytes: Number(ref.bytes ?? data.length),
          width: Number(ref.width ?? dimensions.width),
          height: Number(ref.height ?? dimensions.height),
          name,
        }
      }
    } catch {
      // 附件登记失败不影响"图片已经生成并落盘"这个事实。
    }
  }

  return {
    file,
    name,
    width: dimensions.width,
    height: dimensions.height,
    bytes: data.length,
    model,
    size,
    elapsedMs,
    prompt: finalPrompt,
    enhanced: finalPrompt !== prompt,
    enhancement,
    attachment,
  }
}

/**
 * 文生图并落盘。
 *
 * @param ctx - 宿主上下文。
 * @param options - 生图参数。
 * @param options.apiKey - 平台密钥。
 * @param options.prompt - 提示词。
 * @param options.settings - 已解析的生效设置。
 * @param options.size - 平台分辨率字面量。
 * @param options.enhance - 是否先做提示词增强。
 * @param options.cwd - 会话工作目录。
 * @param options.signal - 取消信号。
 * @param options.save - 是否落盘。
 * @param options.fileName - 可选的自定义文件名（不含目录）。
 * @returns 结构化结果（含图片元数据与可选附件引用）。
 */
async function produceImage(ctx, options) {
  const { apiKey, prompt, settings, size, enhance, cwd, signal, save = true, fileName } = options

  // 可选的提示词增强：失败不应让整次生成失败，退回原始提示词即可。
  let finalPrompt = prompt
  let enhancement = null
  if (enhance) {
    try {
      const result = await enhancePrompt({
        apiKey,
        prompt,
        baseURL: settings.baseURL,
        signal,
        fetchImpl: globalThis.fetch,
      })
      if (result.rewrittenPrompt !== null) {
        finalPrompt = result.rewrittenPrompt
        enhancement = { model: PROMPT_ENHANCE_MODEL, whRatio: result.whRatio }
      }
    } catch (error) {
      enhancement = { model: PROMPT_ENHANCE_MODEL, error: String(error?.message ?? error) }
    }
  }

  const generated = await generateImage({
    apiKey,
    prompt: finalPrompt,
    baseURL: settings.baseURL,
    model: settings.model,
    size,
    steps: settings.steps,
    signal,
    fetchImpl: globalThis.fetch,
  })

  return finalizeImage(ctx, {
    data: generated.images[0],
    prompt,
    finalPrompt,
    size: generated.size,
    model: generated.model,
    elapsedMs: generated.elapsedMs,
    enhancement,
    settings,
    cwd,
    signal,
    save,
    fileName,
  })
}

/**
 * 图片编辑 / 图生图并落盘。
 *
 * 与文生图共用收尾逻辑，差别只在于：字节来自 `/images/edits`（带参考图），
 * 且自动命名会带 `edit` 标记以免与文生图混淆。
 *
 * @param ctx - 宿主上下文。
 * @param options - 编辑参数。
 * @param options.apiKey - 平台密钥。
 * @param options.prompt - 编辑指令。
 * @param options.referenceImages - 输入图字节数组（1..4 张）。
 * @param options.settings - 已解析的生效设置。
 * @param options.size - 平台分辨率字面量。
 * @param options.enhance - 是否先用 PE-I2I 改写编辑指令。
 * @param options.cwd - 会话工作目录。
 * @param options.signal - 取消信号。
 * @param options.save - 是否落盘。
 * @param options.fileName - 可选的自定义文件名（不含目录）。
 * @returns 结构化结果。
 */
async function produceEditedImage(ctx, options) {
  const { apiKey, prompt, referenceImages, settings, size, enhance, cwd, signal, save = true, fileName } = options

  // PE-I2I 实测很慢（约 70 秒）且有时不改写，因此默认关闭，
  // 且失败/未改写都静默退回原始指令。
  let finalPrompt = prompt
  let enhancement = null
  if (enhance) {
    try {
      const result = await enhanceEditPrompt({
        apiKey,
        prompt,
        image: referenceImages[0],
        baseURL: settings.baseURL,
        signal,
        fetchImpl: globalThis.fetch,
      })
      if (result.rewrittenPrompt !== null && result.rewrittenPrompt !== prompt) {
        finalPrompt = result.rewrittenPrompt
        enhancement = { model: PROMPT_ENHANCE_EDIT_MODEL, ratioFollow: result.ratioFollow }
      } else {
        enhancement = { model: PROMPT_ENHANCE_EDIT_MODEL, skipped: true }
      }
    } catch (error) {
      enhancement = { model: PROMPT_ENHANCE_EDIT_MODEL, error: String(error?.message ?? error) }
    }
  }

  const edited = await editImage({
    apiKey,
    prompt: finalPrompt,
    images: referenceImages,
    baseURL: settings.baseURL,
    model: settings.model,
    size,
    steps: settings.steps,
    signal,
    fetchImpl: globalThis.fetch,
  })

  return finalizeImage(ctx, {
    data: edited.images[0],
    prompt,
    finalPrompt,
    size: edited.size,
    model: edited.model,
    elapsedMs: edited.elapsedMs,
    enhancement,
    settings,
    cwd,
    signal,
    save,
    fileName,
    suffix: 'edit',
  })
}

/**
 * 构造文生图工具的 JSON Schema（参数表）。
 * @returns 原始 JSON Schema 对象。
 */
function toolParameters() {
  return {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '要生成的画面描述。直接用中文写清楚主体、场景、风格即可；平台侧对中文理解良好。',
      },
      size: {
        type: 'string',
        enum: Object.keys(SIZE_PRESETS),
        description: '画幅：square=正方形，landscape=横版，portrait=竖版，wide=超宽，tall=超长。省略则使用设置里的默认画幅。',
      },
      enhance: {
        type: 'boolean',
        description: '是否先调用平台的提示词增强模型把描述扩写成结构化英文提示词。画面元素较多时开启能得到更完整的结果，但会多花约 15 秒。',
      },
      steps: {
        type: 'integer',
        description: '采样步数，越大越精细也越慢（官方文生图推荐 40）。省略则使用设置里的默认值。',
      },
      fileName: {
        type: 'string',
        description: '可选的自定义文件名（不含目录）。省略时按提示词与时间自动命名。',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  }
}

/**
 * 构造图片编辑工具的 JSON Schema（参数表）。
 * @returns 原始 JSON Schema 对象。
 */
function editToolParameters() {
  return {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '要对参考图做什么修改，或想让参考图里的主体处于什么新场景。中文直接写即可；'
          + '若要在新场景里保持角色一致，明确写出「保持发型、发饰、服装不变」会明显更稳。',
      },
      images: {
        type: 'array',
        description: `参考图路径，1 到 ${MAX_EDIT_IMAGES} 张。相对路径按会话工作目录解析；`
          + '也可以直接给 DSH 附件目录里的只读副本路径（那种路径没有扩展名，插件按文件内容识别格式）。',
        items: { type: 'string' },
      },
      size: {
        type: 'string',
        enum: Object.keys(SIZE_PRESETS),
        description: '输出画幅：square=正方形，landscape=横版，portrait=竖版，wide=超宽，tall=超长。省略则使用设置里的默认画幅。',
      },
      enhance: {
        type: 'boolean',
        description: '是否先用平台的 Qwen-Image-PE-I2I 改写编辑指令。实测较慢（约 70 秒）且有时不改写，'
          + '默认关闭；指令本身已经写得清楚时不必开。',
      },
      steps: {
        type: 'integer',
        description: '采样步数，越大越精细也越慢（官方推荐 40）。省略则使用设置里的默认值。',
      },
      fileName: {
        type: 'string',
        description: '可选的自定义文件名（不含目录）。省略时按指令与时间自动命名。',
      },
    },
    required: ['prompt', 'images'],
    additionalProperties: false,
  }
}

/**
 * 构造工具的规范输出 schema。
 * @returns 原始 JSON Schema 对象。
 */
function toolOutputSchema() {
  const imageFields = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string' },
      mediaType: { type: 'string' },
      bytes: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      name: { type: 'string' },
    },
    required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      fileName: { type: 'string' },
      model: { type: 'string' },
      size: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      bytes: { type: 'integer' },
      elapsedMs: { type: 'integer' },
      prompt: { type: 'string' },
      enhanced: { type: 'boolean' },
      /** 实际发给平台的提示词/指令（增强后可能与入参不同）。 */
      finalPrompt: { type: 'string' },
      /** 编辑产物时列出用到的参考图路径，便于模型/用户回溯。 */
      sources: { type: 'array', items: { type: 'string' } },
      image: imageFields,
    },
    required: ['fileName', 'model', 'size', 'width', 'height', 'bytes'],
  }
}

/**
 * 由结构化结果渲染出模型可见的内容块。
 *
 * 与核心 `read_image` 保持同一套约定：先一段说明文本（带 `<path>/<type>/<content>`
 * 信封，Web 端的图片卡片按这个形状识别），再紧跟真正的图片块。图片块让模型
 * 在本轮后续步骤里可以直接"看"到生成结果。
 * @param value - 已校验的工具输出值。
 * @param verb - 动作描述（"生成" / "编辑"）。
 * @returns 内容块数组。
 */
function renderToolOutput(value, verb = '生成') {
  const seconds = Math.round((value.elapsedMs ?? 0) / 1000)
  const sizeNote = value.enhanced === true ? '（提示词已由平台的增强模型改写。）' : ''
  const lines = [
    `<path>${value.path ?? value.fileName}</path>`,
    '<type>image</type>',
    '<content>',
    `已用 ${value.model} ${verb} ${value.width}x${value.height} px 的 PNG（${value.bytes} 字节，耗时 ${seconds} 秒）。${sizeNote}`,
    '</content>',
  ]
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  if (value.image !== undefined && value.image !== null) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(typeof value.image.name === 'string' ? { name: value.image.name } : {}),
      },
    })
  }
  return blocks
}

/**
 * 注册 `ujn_generate_image` 工具。
 * @param ctx - 宿主上下文。
 */
function registerTool(ctx) {
  const definition = {
    name: TOOL_NAME,
    description:
      'Generate an image from a text prompt using the Jinan University (UJN) Qwen-Image model, '
      + 'and save it as a PNG file. Use this when the user asks for a picture, illustration, poster, or concept art. '
      + 'The prompt may be written in Chinese. The generated image is returned to you, so you can inspect it before answering. '
      + 'When the user supplies a reference image and wants that same character or subject in a new scene, '
      + `use ${EDIT_TOOL_NAME} instead — plain text-to-image will not preserve the subject's identity. `
      + 'Requires a UJN API key configured in the plugin settings.',
    parameters: toolParameters(),
    // 声明为 10 分钟：注册表本身不强制截止时间（强制执行由 timeout-policy 包装层负责），
    // 这个值与 produceImage 自己的 AbortController 上限保持一致。
    timeoutMs: GENERATE_TIMEOUT_MS,
    // 生成是外部副作用且耗时较长，并发跑多张不如串行排队可控。
    isConcurrencySafe: () => false,
    output: {
      schema: toolOutputSchema(),
      render: (_args, value) => renderToolOutput(value, '生成'),
    },
    async execute(args, exec) {
      const settings = resolveSettings(
        {
          ...(args.size === undefined ? {} : { size: args.size }),
          ...(args.steps === undefined ? {} : { steps: args.steps }),
          ...(args.enhance === undefined ? {} : { enhance: args.enhance }),
        },
        readSettings(),
      )
      const apiKey = await requireApiKey(ctx, settings)

      return withTimeout(exec, GENERATE_TIMEOUT_MS, '生成图片', async (signal) => {
        const result = await produceImage(ctx, {
          apiKey,
          prompt: args.prompt,
          settings,
          size: resolveSize(args.size ?? settings.size),
          enhance: settings.enhance === true,
          cwd: sessionCwd(exec),
          signal,
          save: true,
          fileName: args.fileName,
        })
        return toToolValue(result)
      })
    },
  }

  // 注册表在 `register()` 时会断言 output 形状并校验 schema 子集，
  // 手写定义与 defineTool 产出的形状一致。
  return ctx.tools.register(definition)
}

/**
 * 注册 `ujn_edit_image` 工具（图生图 / 图片编辑）。
 * @param ctx - 宿主上下文。
 */
function registerEditTool(ctx) {
  const definition = {
    name: EDIT_TOOL_NAME,
    description:
      'Edit an existing image, or place the subject of a reference image into a new scene, using the Jinan University (UJN) '
      + 'Qwen-Image model. Use this whenever the user provides (or you already generated) an image and wants it changed, '
      + 're-styled, or re-composed — for example "put this character at a computer" or "change the background to a snowy mountain". '
      + 'Passing the reference image is what preserves the subject\u2019s identity; do not call the plain text-to-image tool for this. '
      + 'Accepts 1 to 4 reference images. Returns the edited image so you can inspect it before answering. '
      + 'Requires a UJN API key configured in the plugin settings.',
    parameters: editToolParameters(),
    timeoutMs: GENERATE_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    output: {
      schema: toolOutputSchema(),
      render: (_args, value) => renderToolOutput(value, '编辑'),
    },
    async execute(args, exec) {
      const settings = resolveSettings(
        {
          ...(args.size === undefined ? {} : { size: args.size }),
          ...(args.steps === undefined ? {} : { steps: args.steps }),
          ...(args.enhance === undefined ? {} : { enhance: args.enhance }),
        },
        readSettings(),
      )
      const apiKey = await requireApiKey(ctx, settings)
      const cwd = sessionCwd(exec)

      // 先把参考图读进来：读不到就没必要发起网络请求。
      const paths = Array.isArray(args.images) ? args.images : []
      if (paths.length === 0) throw new Error('至少需要一张参考图（images）')
      if (paths.length > MAX_EDIT_IMAGES) {
        throw new Error(`最多 ${MAX_EDIT_IMAGES} 张参考图，收到 ${paths.length} 张`)
      }
      const references = paths.map((p) => readReferenceImage(p, cwd))

      return withTimeout(exec, GENERATE_TIMEOUT_MS, '编辑图片', async (signal) => {
        const result = await produceEditedImage(ctx, {
          apiKey,
          prompt: args.prompt,
          referenceImages: references.map((r) => r.data),
          settings,
          size: resolveSize(args.size ?? settings.size),
          enhance: settings.enhanceEdit === true,
          cwd,
          signal,
          save: true,
          fileName: args.fileName,
        })
        return {
          ...toToolValue(result),
          finalPrompt: result.prompt,
          sources: references.map((r) => r.file),
        }
      })
    },
  }

  return ctx.tools.register(definition)
}

/**
 * 取 API Key，取不到就抛一句能照着做的错误。
 * @param ctx - 宿主上下文。
 * @param settings - 已解析的生效设置。
 * @returns 密钥明文。
 */
async function requireApiKey(ctx, settings) {
  const apiKey = await resolveApiKey(ctx, settings.credentialRef)
  if (apiKey === undefined) {
    throw new Error(
      '尚未配置济大词元 API Key。请打开「设置 → 济大词元文生图」填入密钥后重试'
      + `（也可把密钥写入环境变量 ${settings.credentialRef}）。`,
    )
  }
  return apiKey
}

/**
 * 把内部结果裁剪成工具输出 schema 声明的形状。
 *
 * 只挑 schema 里声明过的字段：多余字段会被宿主的结果快照判为"非声明输出"，
 * 因此这里显式挑选，而不是把整个对象丢出去。
 * @param result - produceImage / produceEditedImage 的返回值。
 * @returns 符合 toolOutputSchema 的对象。
 */
function toToolValue(result) {
  return {
    ...(result.file === null ? {} : { path: result.file }),
    fileName: path.basename(result.file ?? result.name),
    model: result.model,
    size: result.size,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    elapsedMs: result.elapsedMs,
    prompt: result.prompt,
    enhanced: result.enhanced,
    ...(result.attachment === null ? {} : { image: result.attachment }),
  }
}

/**
 * 给一次工具执行套上超时与取消传导，并把超时翻译成可读错误。
 * @param exec - 工具执行上下文。
 * @param ms - 超时毫秒数。
 * @param label - 用于错误文案的动作名（如"生成图片"）。
 * @param body - 实际执行体，收到一个 AbortSignal。
 * @returns 执行体的返回值。
 */
async function withTimeout(exec, ms, label, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  exec.signal?.addEventListener?.('abort', onAbort)
  try {
    return await body(controller.signal)
  } catch (error) {
    if (controller.signal.aborted && exec.signal?.aborted !== true) {
      throw new Error(`${label}超时（超过 ${Math.round(ms / 1000)} 秒），可以降低步数或改用更小的画幅后重试`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    exec.signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 注册设置页需要的 HTTP 路由。
 * @param ctx - 宿主上下文。
 * @returns disposer 数组。
 */
function registerRoutes(ctx) {
  const disposers = []

  /** 统一的入口包装：鉴权、错误转 JSON、防止未捕获异常打崩宿主。 */
  const route = (handler, { allowGet = false } = {}) =>
    async (req, res) => {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: '请求来源不受信任' })
        return
      }
      if (!allowGet && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '请使用 POST' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    }

  // ── 读取当前设置与密钥状态（绝不回传密钥明文）──
  // 只读接口，浏览器半边用 GET 拉取，因此必须放行 GET。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/settings`,
    handler: route(async (_req, res) => {
      const settings = readSettings()
      if (settings.baseURL !== DEFAULT_BASE_URL) {
        try {
          // 提前暴露非法地址，避免用户保存后每次生成才失败。
          normalizeBaseURL(settings.baseURL)
        } catch (error) {
          sendJson(res, 200, {
            ok: true,
            settings,
            defaults: DEFAULTS,
            sizes: SIZE_PRESETS,
            imageModel: IMAGE_MODEL,
            apiKey: await describeApiKey(ctx, settings.credentialRef),
            warning: String(error?.message ?? error),
          })
          return
        }
      }
      sendJson(res, 200, {
        ok: true,
        settings,
        defaults: DEFAULTS,
        sizes: SIZE_PRESETS,
        imageModel: IMAGE_MODEL,
        apiKey: await describeApiKey(ctx, settings.credentialRef),
      })
    }, { allowGet: true }),
  }))

  // ── 保存设置（可同时保存 API Key）──
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/save`,
    handler: route(async (req, res) => {
      const body = await readJsonBody(req)
      const settings = readSettings()
      const ref = typeof body.credentialRef === 'string' && body.credentialRef.trim() !== ''
        ? body.credentialRef.trim()
        : settings.credentialRef

      // 只把明确提供的字段合并进去；未提供的保持原值。
      const patch = {}
      for (const key of ['baseURL', 'model', 'size', 'saveDir']) {
        if (typeof body[key] === 'string') patch[key] = body[key]
      }
      if (body.steps !== undefined) patch.steps = body.steps
      if (body.enhance !== undefined) patch.enhance = body.enhance
      if (body.enhanceEdit !== undefined) patch.enhanceEdit = body.enhanceEdit
      if (Object.hasOwn(body, 'credentialRef')) patch.credentialRef = ref

      const next = writeSettings(patch)

      // 密钥单独走凭据域；空串表示"保持现有密钥"。
      let apiKey = await describeApiKey(ctx, next.credentialRef)
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
        apiKey = await saveApiKey(ctx, next.credentialRef, body.apiKey)
      }

      sendJson(res, 200, {
        ok: true,
        settings: next,
        apiKey,
        message: '已保存',
      })
    }),
  }))

  // ── 测试连接：用当前密钥列一次模型 ──
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/test`,
    handler: route(async (req, res) => {
      const body = await readJsonBody(req)
      const settings = readSettings()
      const ref = settings.credentialRef
      // 允许用"还没保存的"密钥直接测，省得用户先存一个错的。
      const draft = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const apiKey = draft !== '' ? draft : await resolveApiKey(ctx, ref)
      if (apiKey === undefined) {
        sendJson(res, 200, { ok: false, error: '还没有可用的 API Key' })
        return
      }
      const baseURL = typeof body.baseURL === 'string' && body.baseURL.trim() !== ''
        ? body.baseURL.trim()
        : settings.baseURL
      const models = await listModels({ apiKey, baseURL, fetchImpl: globalThis.fetch })
      sendJson(res, 200, {
        ok: true,
        baseURL: normalizeBaseURL(baseURL),
        count: models.length,
        models,
        supportsImage: models.includes(IMAGE_MODEL),
        message: models.includes(IMAGE_MODEL)
          ? `连接成功，平台提供 ${models.length} 个模型（含 ${IMAGE_MODEL}）`
          : `连接成功，但模型列表里没有 ${IMAGE_MODEL}`,
      })
    }),
  }))

  // ── 试跑：设置页里的"试一张"按钮（文生图 / 图片编辑二选一）──
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/preview`,
    handler: route(async (req, res) => {
      const body = await readJsonBody(req)
      const settings = readSettings()
      const apiKey = await resolveApiKey(ctx, settings.credentialRef)
      if (apiKey === undefined) throw new Error('尚未配置 API Key')

      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (prompt === '') throw new Error('请先填写提示词')

      // 带参考图就是编辑；否则是文生图。
      const referencePath = typeof body.image === 'string' ? body.image.trim() : ''
      const mode = referencePath === '' ? 'generate' : 'edit'

      // 试跑固定写到 DSH home 下的 previews/，与用户设置里的 saveDir 解耦：
      // 这里只是"看一眼效果"，不该散落到工作目录里，更不该写进桌面端
      // 进程的当前目录（应用安装目录）。
      const previewSettings = { ...settings, saveDir: previewDir() }
      const size = resolveSize(typeof body.size === 'string' ? body.size : settings.size)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
      try {
        const result = mode === 'edit'
          ? await produceEditedImage(ctx, {
              apiKey,
              prompt,
              referenceImages: [readReferenceImage(referencePath, previewDir()).data],
              settings: previewSettings,
              size,
              enhance: body.enhance === true,
              cwd: previewDir(),
              signal: controller.signal,
              save: true,
            })
          : await produceImage(ctx, {
              apiKey,
              prompt,
              settings: previewSettings,
              size,
              enhance: body.enhance === true,
              cwd: previewDir(),
              signal: controller.signal,
              save: true,
            })
        const fileName = path.basename(result.file ?? result.name)
        sendJson(res, 200, {
          ok: true,
          mode,
          path: result.file,
          fileName,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          elapsedMs: result.elapsedMs,
          prompt: result.prompt,
          enhanced: result.enhanced,
          // 设置页直接用这个 URL 预览（同一进程内的静态读取）。
          url: `${ROUTE_PREFIX}/file?name=${encodeURIComponent(fileName)}`,
        })
      } finally {
        clearTimeout(timer)
      }
    }),
  }))

  // ── 读回一张已生成的图（给设置页预览用）──
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/file`,
    handler: (req, res) => {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: '请求来源不受信任' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const name = path.basename(url.searchParams.get('name') ?? '')
        if (name === '' || !name.endsWith('.png')) {
          sendJson(res, 400, { ok: false, error: '缺少合法的文件名' })
          return
        }
        const settings = readSettings()
        // /preview 固定写在 previews/，因此这里优先从那里读；找不到再回退到
        // 用户配置的 saveDir（容错：早期版本或手工放置的图）。
        const candidates = [
          previewDir(),
          path.isAbsolute(settings.saveDir) ? settings.saveDir : path.resolve(process.cwd(), settings.saveDir),
        ]
        const file = candidates.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate))
        // 只允许读取这两个目录下的文件（path.basename 已挡住目录穿越）。
        if (file === undefined) {
          sendJson(res, 404, { ok: false, error: '文件不存在' })
          return
        }
        const data = fs.readFileSync(file)
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        })
        res.end(data)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }))

  return disposers
}

/**
 * 插件主体。
 * @param ctx - Cordis 根上下文。
 */
function apply(ctx) {
  const disposers = []

  // 工具是插件的核心能力：注册失败应当让插件加载失败（fail loud），
  // 而不是静默地"插件在、但功能没了"。
  disposers.push(registerTool(ctx))
  disposers.push(registerEditTool(ctx))

  // 路由失败不应连累工具；分别 try，只把错误写进日志。
  try {
    disposers.push(...registerRoutes(ctx))
  } catch (error) {
    ctx.logger?.warn?.('dsh-ujn-image: 设置页路由注册失败，工具仍可用')
    ctx.logger?.warn?.(error)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期错误不阻塞其它清理。
      }
    }
  })

  ctx.logger?.info?.('dsh-ujn-image: 已注册工具 %s / %s', TOOL_NAME, EDIT_TOOL_NAME)
}

export { apply, inject }

/**
 * 仅供离线自测使用的内部出口（`scripts/selftest.mjs`）。
 * 生产代码不读这个对象。
 */
export const __test = {
  TOOL_NAME,
  EDIT_TOOL_NAME,
  ROUTE_PREFIX,
  GENERATE_TIMEOUT_MS,
  MAX_REFERENCE_BYTES,
  isTrustedRequest,
  readJsonBody,
  toolParameters,
  editToolParameters,
  toolOutputSchema,
  renderToolOutput,
  produceImage,
  produceEditedImage,
  finalizeImage,
  toToolValue,
  withTimeout,
  requireApiKey,
  sniffImageMime,
  readReferenceImage,
  writeImageFile,
  sessionCwd,
}
