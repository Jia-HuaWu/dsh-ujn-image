/**
 * dsh-ujn-image — 插件自己的设置存储。
 *
 * 两件事分开存：
 *   · **API Key** 走 DSH 官方凭据域（`$DSH_HOME/.credentials.yaml`），
 *     配置文件里永远不出现明文；这与「网页搜索」「模型」等官方设置页
 *     用的是同一条 seam，因此密钥可以在任意一个入口轮换。
 *   · **其它偏好**（接口地址、默认画幅、步数、保存目录……）落在插件自己的
 *     JSON 里（`$DSH_HOME/dsh-ujn-image/settings.json`）。这里刻意不复用
 *     DSH 的 settings 命名空间：那是按「profile 条目 id + cordis.patch.yml
 *     覆盖」持久化的宿主设施，第三方插件直接读写自己的 JSON 更简单，
 *     也不会和用户手写的 patch 层打架。
 *
 * 读取一律「缺失即默认值」：文件不存在、JSON 损坏、字段类型不对，
 * 都退回默认值而不是抛异常 —— 设置读不出来不应该让整个插件失效。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_BASE_URL, IMAGE_MODEL, SIZE_PRESETS } from './ujn-api.mjs'

/** DSH home：与宿主其它持久化数据放在一起，便于整体备份。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 插件数据目录。 */
export function dataDir() {
  return path.join(dshHome(), 'dsh-ujn-image')
}

/** 设置文件绝对路径。 */
export function settingsFile() {
  return path.join(dataDir(), 'settings.json')
}

/**
 * 设置页「试生成」的图片目录（绝对路径）。
 *
 * 用 DSH home 下的固定位置，而不是 `process.cwd()`：桌面端进程的当前目录是
 * 应用安装目录，用户既找不到、也不该往那里写东西。放在 DSH home 下既一定
 * 可写、又好找（和插件设置文件相邻）。
 * @returns 绝对目录路径。
 */
export function previewDir() {
  return path.join(dataDir(), 'previews')
}

/**
 * 默认凭据引用名。
 *
 * 复用 `UJN_API_KEY` 而不是自造一个新名字：用户很可能已经在
 * 「设置 → 模型」里为同一个平台填过密钥，共用引用意味着**填一次、处处生效**，
 * 不需要在两个地方各存一份可能互相矛盾的密钥。
 */
export const DEFAULT_CREDENTIAL_REF = 'UJN_API_KEY'

/** 设置项默认值（也是 schema 的真源）。 */
export const DEFAULTS = {
  /** 平台根地址；允许用户指向自建代理。 */
  baseURL: DEFAULT_BASE_URL,
  /** 生图模型。 */
  model: IMAGE_MODEL,
  /** 默认画幅预设（键名对应 SIZE_PRESETS）。 */
  size: 'square',
  /** 采样步数：40 是官方文生图推荐值，画质与耗时较平衡。 */
  steps: 40,
  /** 默认是否先用 Qwen-Image-PE-T2I 扩写提示词。 */
  enhance: false,
  /** 图片编辑时是否先用 Qwen-Image-PE-I2I 改写编辑指令（实测较慢，默认关）。 */
  enhanceEdit: false,
  /** 图片保存目录；相对路径按会话工作目录解析。 */
  saveDir: 'ujn-images',
  /** 凭据引用名。 */
  credentialRef: DEFAULT_CREDENTIAL_REF,
}

/** 画幅预设的合法键名。 */
const SIZE_KEYS = new Set(Object.keys(SIZE_PRESETS))

/**
 * 把一个字段收敛到合法值；不合法就用默认值。
 * @param key - 字段名。
 * @param value - 候选值。
 * @returns 可安全使用的值。
 */
function coerce(key, value) {
  const fallback = DEFAULTS[key]
  switch (key) {
    case 'baseURL': {
      const text = typeof value === 'string' ? value.trim() : ''
      return text === '' ? fallback : text
    }
    case 'model': {
      const text = typeof value === 'string' ? value.trim() : ''
      return text === '' ? fallback : text
    }
    case 'saveDir': {
      const text = typeof value === 'string' ? value.trim() : ''
      return text === '' ? fallback : text
    }
    case 'credentialRef': {
      const text = typeof value === 'string' ? value.trim() : ''
      // 凭据引用必须是 POSIX shell 标识符，否则凭据域会拒绝。
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : fallback
    }
    case 'size':
      return SIZE_KEYS.has(value) ? value : fallback
    case 'steps': {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      // 平台能接受很宽的区间，这里只挡住明显无意义的取值。
      return Math.min(100, Math.max(1, Math.trunc(n)))
    }
    case 'enhance':
    case 'enhanceEdit':
      return typeof value === 'boolean' ? value : fallback
    default:
      return fallback
  }
}

/**
 * 读取设置；任何异常都退回默认值。
 * @returns 完整的设置对象。
 */
export function readSettings() {
  let raw
  try {
    raw = fs.readFileSync(settingsFile(), 'utf8')
  } catch {
    return { ...DEFAULTS }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULTS }
  }
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const result = {}
  for (const key of Object.keys(DEFAULTS)) result[key] = coerce(key, source[key])
  return result
}

/**
 * 原子写入设置（先写临时文件再 rename，避免半截文件）。
 * @param patch - 要合并进去的字段（未列出的字段保持当前值）。
 * @returns 写入后的完整设置。
 */
export function writeSettings(patch) {
  const current = readSettings()
  const next = { ...current }
  if (patch !== null && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(patch, key)) next[key] = coerce(key, patch[key])
    }
  }
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = settingsFile()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  return next
}

/**
 * 解析最终生效的设置：显式参数 > 插件设置 > 默认值。
 *
 * 工具调用允许逐个参数覆盖，但「没传」与「传了空」必须区分开：
 * 只有真正提供了值才覆盖，否则沿用设置页里的偏好。
 * @param overrides - 工具调用传入的可选覆盖项。
 * @param stored - 已读取的设置（省略时现场读取）。
 * @returns 合并后的设置。
 */
export function resolveSettings(overrides = {}, stored = readSettings()) {
  const merged = { ...stored }
  if (typeof overrides.baseURL === 'string' && overrides.baseURL.trim() !== '') merged.baseURL = overrides.baseURL.trim()
  if (typeof overrides.model === 'string' && overrides.model.trim() !== '') merged.model = overrides.model.trim()
  if (SIZE_KEYS.has(overrides.size)) merged.size = overrides.size
  if (Number.isFinite(overrides.steps)) merged.steps = Math.min(100, Math.max(1, Math.trunc(overrides.steps)))
  if (typeof overrides.enhance === 'boolean') merged.enhance = overrides.enhance
  if (typeof overrides.enhanceEdit === 'boolean') merged.enhanceEdit = overrides.enhanceEdit
  if (typeof overrides.saveDir === 'string' && overrides.saveDir.trim() !== '') merged.saveDir = overrides.saveDir.trim()
  return merged
}

/**
 * 把画幅预设键名解析成平台接受的 `size` 字面量。
 * @param key - 预设键名（如 `square`），或已经是 `WxH` 的字面量。
 * @returns 形如 `1024x1024` 的字符串。
 */
export function resolveSize(key) {
  if (typeof key === 'string' && /^\d{3,5}x\d{3,5}$/.test(key.trim())) return key.trim()
  return SIZE_PRESETS[key] ?? SIZE_PRESETS[DEFAULTS.size]
}

/**
 * 从凭据域解析 API Key。
 *
 * 解析顺序与官方设置页一致：环境变量 → 凭据文件 → .env 回退，
 * 因此用户把密钥放进 `UJN_API_KEY` 环境变量同样能生效。
 * @param ctx - 宿主上下文（提供可选的 `credentials` 服务）。
 * @param ref - 凭据引用名。
 * @returns 密钥字符串，或 undefined。
 */
export async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) return undefined
  try {
    const hit = await credentials.resolve(ref)
    const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 描述凭据状态（是否已配置 / 能否写入 / 来源），**绝不返回值本身**。
 * @param ctx - 宿主上下文。
 * @param ref - 凭据引用名。
 * @returns `{ configured, writable, source? }`。
 */
export async function describeApiKey(ctx, ref) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) return { configured: false, writable: false }
  try {
    const info = await credentials.describe(ref)
    return {
      configured: info?.configured === true,
      writable: info?.writable !== false,
      ...(typeof info?.source === 'string' ? { source: info.source } : {}),
    }
  } catch {
    return { configured: false, writable: false }
  }
}

/**
 * 写入 API Key。空字符串按「不做任何事」处理（保留现有密钥），
 * 这与官方设置页「留空保存 = 保持当前密钥」的约定一致。
 * @param ctx - 宿主上下文。
 * @param ref - 凭据引用名。
 * @param value - 新密钥明文。
 * @returns 写入后的配置状态。
 */
export async function saveApiKey(ctx, ref, value) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) throw new Error('宿主没有挂载凭据服务，无法保存 API Key')
  const text = typeof value === 'string' ? value.trim() : ''
  if (text !== '') {
    if (text.length < 8) throw new Error('API Key 看起来太短了，请确认复制完整（通常形如 ujn-xxxxxxxx）')
    await credentials.set(ref, text)
  }
  return describeApiKey(ctx, ref)
}
