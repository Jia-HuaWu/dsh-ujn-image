/**
 * dsh-ujn-image 自测。
 *
 * 全部离线：网络调用一律用注入的假 fetch，不碰真实平台，也不写真实的
 * $DSH_HOME（设置文件指向临时目录）。真实网络只在你显式带 `--live` 时跑。
 *
 *   node scripts/selftest.mjs          # 离线（默认）
 *   node scripts/selftest.mjs --live   # 额外跑一次真实生图
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 必须在导入插件之前改掉 DSH_HOME，让设置文件落到临时沙箱里。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ujn-image-test-'))
process.env.DSH_HOME = SANDBOX

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

// Windows 上动态 import 必须用 file:// URL，绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const load = (relative) => import(pathToFileURL(path.join(PKG, relative)).href)

const api = await load('lib/ujn-api.mjs')
const settings = await load('lib/settings.mjs')
const host = await load('lib/index.js')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 粗暴剥掉行注释与块注释，用于「不依赖某包」这类静态检查。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 造一张最小的合法 PNG（仅头部合法，足够用来验证尺寸解析与落盘）。 */
function tinyPng(width = 1, height = 1) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = 6 // color type RGBA
  return Buffer.concat([sig, ihdr])
}

/** 把 PNG 包成平台风格的生图响应。 */
function imageResponse(buffer) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ created: 0, data: [{ b64_json: buffer.toString('base64') }] }),
  }
}

console.log(`sandbox: ${SANDBOX}\n`)

// ───────────────────────── ujn-api.mjs ─────────────────────────
console.log('ujn-api: normalizeBaseURL')
check('裸域名补上 /v1', () => {
  assert.equal(api.normalizeBaseURL('https://llm.ujn.edu.cn'), 'https://llm.ujn.edu.cn/v1')
})
check('尾斜杠被吃掉', () => {
  assert.equal(api.normalizeBaseURL('https://llm.ujn.edu.cn/'), 'https://llm.ujn.edu.cn/v1')
})
check('已带 /v1 不重复', () => {
  assert.equal(api.normalizeBaseURL('https://llm.ujn.edu.cn/v1'), 'https://llm.ujn.edu.cn/v1')
})
check('/v1/ 归一', () => {
  assert.equal(api.normalizeBaseURL('https://llm.ujn.edu.cn/v1/'), 'https://llm.ujn.edu.cn/v1')
})
check('带子路径的代理保留子路径', () => {
  assert.equal(api.normalizeBaseURL('https://proxy.example/u/v1'), 'https://proxy.example/u/v1')
})
check('空值回退默认地址', () => {
  assert.equal(api.normalizeBaseURL(''), api.DEFAULT_BASE_URL + '/v1')
})
check('非法 URL 抛可读错误', () => {
  assert.throws(() => api.normalizeBaseURL('not a url'), /不是合法的 URL/)
})
check('非 http(s) 被拒绝', () => {
  assert.throws(() => api.normalizeBaseURL('ftp://x.example'), /必须是 http\/https/)
})

console.log('\nujn-api: describeHttpError')
check('解析 OpenAI 风格错误', () => {
  assert.match(api.describeHttpError(400, '{"error":{"message":"模型不存在: nope"}}'), /模型不存在: nope/)
})
check('401 附带密钥提示', () => {
  assert.match(api.describeHttpError(401, '{"error":{"message":"API Token 无效"}}'), /重新填写/)
})
check('解析 FastAPI detail 数组', () => {
  assert.match(api.describeHttpError(422, '{"detail":[{"msg":"bad field"}]}'), /bad field/)
})
check('非 JSON 体原样呈现', () => {
  assert.match(api.describeHttpError(500, 'boom'), /HTTP 500/)
})

console.log('\nujn-api: authHeaders')
check('构造 Bearer 头', () => {
  assert.equal(api.authHeaders('ujn-abc').Authorization, 'Bearer ujn-abc')
})
check('空密钥抛可读错误', () => {
  assert.throws(() => api.authHeaders(''), /尚未配置/)
})

console.log('\nujn-api: pngSize')
check('读出 1024x768', () => {
  assert.deepEqual(api.pngSize(tinyPng(1024, 768)), { width: 1024, height: 768 })
})
check('非 PNG 被拒绝', () => {
  assert.throws(() => api.pngSize(Buffer.from('GIF89a....')), /不是合法 PNG/)
})

console.log('\nujn-api: generateImage（假 fetch）')
await checkAsync('happy path 解出 PNG 字节', async () => {
  const png = tinyPng(640, 480)
  let seen = null
  const result = await api.generateImage({
    apiKey: 'ujn-test',
    prompt: '一只猫',
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers }
      return imageResponse(png)
    },
  })
  assert.ok(seen.url.endsWith('/v1/images/generations'), `url=${seen.url}`)
  assert.equal(seen.body.model, api.IMAGE_MODEL)
  assert.equal(seen.body.prompt, '一只猫')
  assert.equal(seen.headers.Authorization, 'Bearer ujn-test')
  assert.equal(result.images.length, 1)
  assert.ok(result.images[0].equals(png))
})
await checkAsync('可选参数只在提供时下发', async () => {
  let body = null
  await api.generateImage({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: 'p',
    steps: 30,
    cfgScale: 1,
    seed: 7,
    count: 2,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return imageResponse(tinyPng()) },
  })
  assert.equal(body.num_inference_steps, 30)
  assert.equal(body.true_cfg_scale, 1)
  assert.equal(body.seed, 7)
  assert.equal(body.n, 2)
})
await checkAsync('省略的参数不出现在请求体里', async () => {
  let body = null
  await api.generateImage({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: 'p',
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return imageResponse(tinyPng()) },
  })
  assert.ok(!('num_inference_steps' in body))
  assert.ok(!('seed' in body))
  assert.ok(!('n' in body))
})
await checkAsync('空提示词被拒绝', async () => {
  await assert.rejects(
    api.generateImage({ apiKey: 'k'.padEnd(8, 'x'), prompt: '   ', fetchImpl: async () => imageResponse(tinyPng()) }),
    /提示词不能为空/,
  )
})
await checkAsync('HTTP 错误转成可读异常', async () => {
  await assert.rejects(
    api.generateImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"API Token 无效或已吊销"}}' }),
    }),
    /API Token 无效或已吊销/,
  )
})
await checkAsync('空 data 被拒绝', async () => {
  await assert.rejects(
    api.generateImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }),
    }),
    /没有返回任何图片/,
  )
})
await checkAsync('非 b64_json 被拒绝', async () => {
  await assert.rejects(
    api.generateImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"data":[{"url":"http://x/y.png"}]}' }),
    }),
    /不是 b64_json 形式/,
  )
})

console.log('\nujn-api: parseEnhancedPrompt / enhancePrompt')
check('从思考过程尾部抽出 JSON', () => {
  const content = '长思考过程……\n{"rewritten_prompt":"a cat","wh_ratio":"3:2"}'
  assert.deepEqual(api.parseEnhancedPrompt(content), { rewritten_prompt: 'a cat', wh_ratio: '3:2' })
})
check('没有 JSON 时返回 null', () => {
  assert.equal(api.parseEnhancedPrompt('只有思考，没有 JSON'), null)
})
check('尾部 JSON 残缺时返回 null', () => {
  assert.equal(api.parseEnhancedPrompt('{"rewritten_prompt": '), null)
})
await checkAsync('enhancePrompt 走 PE 模型并带官方采样参数', async () => {
  let body = null
  const result = await api.enhancePrompt({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: '一只猫',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '思考……{"rewritten_prompt":"A cat.","wh_ratio":"1:1"}' } }] }) }
    },
  })
  assert.equal(body.model, api.PROMPT_ENHANCE_MODEL)
  assert.equal(body.presence_penalty, 1.5)
  assert.equal(result.rewrittenPrompt, 'A cat.')
  assert.equal(result.whRatio, '1:1')
})

console.log('\nujn-api: listModels')
await checkAsync('解出模型 id 列表', async () => {
  const ids = await api.listModels({
    apiKey: 'k'.padEnd(8, 'x'),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"data":[{"id":"a"},{"id":"b"},{"nope":1}]}' }),
  })
  assert.deepEqual(ids, ['a', 'b'])
})

console.log('\nujn-api: imageFileName')
check('包含时间、分辨率与提示词片段', () => {
  const name = api.imageFileName('一只在校园湖边散步的橘猫', '1024x1024', Date.UTC(2026, 0, 2, 3, 4, 5))
  assert.match(name, /^ujn-\d{8}-\d{6}-1024x1024-.*\.png$/)
})
check('危险字符被清理掉', () => {
  const name = api.imageFileName('a/b\\c:d*e?f"g<h>i|j', '1024x1024')
  assert.ok(!/[\\/:*?"<>|]/.test(name), name)
})
check('超长提示词被截断', () => {
  const name = api.imageFileName('猫'.repeat(200), '1024x1024')
  assert.ok(name.length < 100, `len=${name.length}`)
})
check('空提示词仍产出合法名', () => {
  const name = api.imageFileName('', '1024x1024')
  assert.match(name, /\.png$/)
})
check('tag 参数插入到扩展名前', () => {
  const name = api.imageFileName('一只猫', '1024x1024', Date.UTC(2026, 0, 2, 3, 4, 5), 1, 'edit')
  assert.match(name, /-edit-一只猫\.png$/, name)
})

console.log('\nujn-api: editImage（multipart，假 fetch）')
/** 造一个最小的 multipart 工厂桩，记录被 append 的字段。 */
function fakeForm() {
  const entries = []
  return {
    entries,
    factory: {
      createForm() {
        return { append(key, value, name) { entries.push({ key, value, name }) } }
      },
      appendFile(form, field, bytes, name) {
        form.append(field, { bytes }, name)
      },
    },
  }
}

await checkAsync('happy path 解出 PNG 字节', async () => {
  const png = tinyPng(64, 64)
  const form = fakeForm()
  let seen = null
  const result = await api.editImage({
    apiKey: 'ujn-test',
    prompt: '把背景换成雪山',
    images: [png],
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers, body: init.body }
      return imageResponse(png)
    },
    formImpl: form.factory,
  })
  assert.ok(seen.url.endsWith('/v1/images/edits'), `url=${seen.url}`)
  assert.equal(result.images.length, 1)
  assert.ok(result.images[0].equals(png))
})
await checkAsync('字段齐全且用 image 作为文件字段名', async () => {
  const png = tinyPng()
  const form = fakeForm()
  await api.editImage({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: '改一下',
    images: [png],
    steps: 30,
    cfgScale: 1,
    seed: 7,
    fetchImpl: async () => imageResponse(png),
    formImpl: form.factory,
  })
  const keys = form.entries.map((e) => e.key)
  for (const need of ['image', 'prompt', 'model', 'size', 'num_inference_steps', 'true_cfg_scale', 'seed']) {
    assert.ok(keys.includes(need), `缺少字段 ${need}（实际 ${keys.join(',')}）`)
  }
  assert.equal(form.entries.find((e) => e.key === 'prompt').value, '改一下')
})
await checkAsync('不手写 Content-Type（boundary 必须由运行时给）', async () => {
  const png = tinyPng()
  const form = fakeForm()
  let headers = null
  await api.editImage({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: 'p',
    images: [png],
    fetchImpl: async (_url, init) => { headers = init.headers; return imageResponse(png) },
    formImpl: form.factory,
  })
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'), `不该有 Content-Type：${JSON.stringify(headers)}`)
  assert.equal(headers.Authorization, `Bearer ${'k'.padEnd(8, 'x')}`)
})
await checkAsync('多张输入图按 image / image2 / image3 命名', async () => {
  const form = fakeForm()
  await api.editImage({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: 'p',
    images: [tinyPng(), tinyPng(), tinyPng()],
    fetchImpl: async () => imageResponse(tinyPng()),
    formImpl: form.factory,
  })
  const names = form.entries.filter((e) => e.key === 'image').map((e) => e.name)
  assert.deepEqual(names, ['image.png', 'image2.png', 'image3.png'])
})
await checkAsync('超过 4 张被拒绝', async () => {
  await assert.rejects(
    api.editImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      images: [tinyPng(), tinyPng(), tinyPng(), tinyPng(), tinyPng()],
      fetchImpl: async () => imageResponse(tinyPng()),
      formImpl: fakeForm().factory,
    }),
    /最多只能传 4 张/,
  )
})
await checkAsync('没有输入图被拒绝', async () => {
  await assert.rejects(
    api.editImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      images: [],
      fetchImpl: async () => imageResponse(tinyPng()),
      formImpl: fakeForm().factory,
    }),
    /至少需要一张输入图片/,
  )
})
await checkAsync('空指令被拒绝', async () => {
  await assert.rejects(
    api.editImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '  ',
      images: [tinyPng()],
      fetchImpl: async () => imageResponse(tinyPng()),
      formImpl: fakeForm().factory,
    }),
    /编辑指令不能为空/,
  )
})
await checkAsync('HTTP 错误转成可读异常', async () => {
  await assert.rejects(
    api.editImage({
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      images: [tinyPng()],
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"图片尺寸不支持"}}' }),
      formImpl: fakeForm().factory,
    }),
    /图片尺寸不支持/,
  )
})

console.log('\nujn-api: enhanceEditPrompt')
await checkAsync('带图时用数组 content（图在前、文字在后）', async () => {
  let body = null
  const result = await api.enhanceEditPrompt({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: '把背景改成蓝色',
    image: tinyPng(),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '思考……{"rewritten_prompt":"Make the background blue.","ratio_follow":"<image1>"}' } }] }) }
    },
  })
  assert.equal(body.model, api.PROMPT_ENHANCE_EDIT_MODEL)
  assert.equal(body.presence_penalty, 0, '图片编辑的 presence_penalty 官方固定 0')
  assert.ok(Array.isArray(body.messages[0].content), 'content 应当是数组')
  assert.equal(body.messages[0].content[0].type, 'image_url')
  assert.equal(body.messages[0].content[1].type, 'text')
  assert.equal(result.rewrittenPrompt, 'Make the background blue.')
  assert.equal(result.ratioFollow, '<image1>')
})
await checkAsync('不带图时退化为纯文本 content', async () => {
  let body = null
  await api.enhanceEditPrompt({
    apiKey: 'k'.padEnd(8, 'x'),
    prompt: '改一下',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"{}"}}]}' }
    },
  })
  assert.equal(body.messages[0].content, '改一下', '无图时 content 应当是字符串')
})

// ───────────────────────── settings.mjs ─────────────────────────
console.log('\nsettings: 读写与容错')
check('缺失文件返回默认值', () => {
  const s = settings.readSettings()
  assert.deepEqual(s, settings.DEFAULTS)
})
check('非法 JSON 返回默认值', () => {
  fs.mkdirSync(settings.dataDir(), { recursive: true })
  fs.writeFileSync(settings.settingsFile(), '{not json')
  assert.deepEqual(settings.readSettings(), settings.DEFAULTS)
})
check('写入后可读回', () => {
  const next = settings.writeSettings({ baseURL: 'https://proxy.example/v1', steps: 25 })
  assert.equal(next.baseURL, 'https://proxy.example/v1')
  assert.equal(next.steps, 25)
  assert.equal(settings.readSettings().steps, 25)
})
check('未知字段被忽略', () => {
  settings.writeSettings({ evil: 'x' })
  assert.ok(!('evil' in settings.readSettings()))
})
check('steps 被夹到 1..100', () => {
  assert.equal(settings.writeSettings({ steps: 0 }).steps, 1)
  assert.equal(settings.writeSettings({ steps: 9999 }).steps, 100)
  assert.equal(settings.writeSettings({ steps: 'abc' }).steps, settings.DEFAULTS.steps)
})
check('非法画幅回退默认', () => {
  assert.equal(settings.writeSettings({ size: 'nonsense' }).size, settings.DEFAULTS.size)
  assert.equal(settings.writeSettings({ size: 'wide' }).size, 'wide')
})
check('非法凭据名回退默认', () => {
  assert.equal(settings.writeSettings({ credentialRef: '9bad name' }).credentialRef, settings.DEFAULTS.credentialRef)
  assert.equal(settings.writeSettings({ credentialRef: 'MY_KEY' }).credentialRef, 'MY_KEY')
})
check('previewDir 落在插件数据目录下', () => {
  assert.ok(settings.previewDir().startsWith(settings.dataDir()), settings.previewDir())
})
check('profile 目录权限为 0600（非 Windows）', () => {
  if (process.platform === 'win32') return
  const mode = fs.statSync(settings.settingsFile()).mode & 0o777
  assert.equal(mode, 0o600)
})

console.log('\nsettings: resolveSettings / resolveSize')
check('显式覆盖生效', () => {
  const merged = settings.resolveSettings({ size: 'wide', steps: 12, enhance: true }, settings.DEFAULTS)
  assert.equal(merged.size, 'wide')
  assert.equal(merged.steps, 12)
  assert.equal(merged.enhance, true)
})
check('未提供则不覆盖', () => {
  const merged = settings.resolveSettings({ baseURL: '' }, { ...settings.DEFAULTS, baseURL: 'https://x.example/v1' })
  assert.equal(merged.baseURL, 'https://x.example/v1')
})
check('预设键名解析成字面量', () => {
  assert.equal(settings.resolveSize('square'), '1024x1024')
  assert.equal(settings.resolveSize('wide'), '2528x1696')
})
check('已是 WxH 字面量则原样通过', () => {
  assert.equal(settings.resolveSize('640x480'), '640x480')
})
check('未知键名回退默认画幅', () => {
  assert.equal(settings.resolveSize('nope'), api.SIZE_PRESETS[settings.DEFAULTS.size])
})

console.log('\nsettings: 凭据（假 ctx）')
function fakeCtx(store = new Map(), writable = true) {
  return {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined),
        describe: async (ref) => (store.has(ref) ? { configured: true, writable, source: 'file' } : { configured: false, writable }),
        set: async (ref, value) => { store.set(ref, value) },
      }
    },
  }
}
await checkAsync('resolveApiKey 取到值', async () => {
  const key = await settings.resolveApiKey(fakeCtx(new Map([['UJN_API_KEY', 'ujn-abc']])), 'UJN_API_KEY')
  assert.equal(key, 'ujn-abc')
})
await checkAsync('resolveApiKey 未配置返回 undefined', async () => {
  assert.equal(await settings.resolveApiKey(fakeCtx(), 'UJN_API_KEY'), undefined)
})
await checkAsync('describeApiKey 不泄露值', async () => {
  const info = await settings.describeApiKey(fakeCtx(new Map([['K', 'supersecret']])), 'K')
  assert.equal(info.configured, true)
  assert.ok(!JSON.stringify(info).includes('supersecret'))
})
await checkAsync('saveApiKey 写入并回读', async () => {
  const store = new Map()
  const info = await settings.saveApiKey(fakeCtx(store), 'K', 'ujn-newkey1')
  assert.equal(store.get('K'), 'ujn-newkey1')
  assert.equal(info.configured, true)
})
await checkAsync('saveApiKey 空串保持现有密钥', async () => {
  const store = new Map([['K', 'keep-me']])
  await settings.saveApiKey(fakeCtx(store), 'K', '   ')
  assert.equal(store.get('K'), 'keep-me')
})
await checkAsync('saveApiKey 过短被拒绝', async () => {
  await assert.rejects(settings.saveApiKey(fakeCtx(), 'K', 'abc'), /太短/)
})
await checkAsync('缺少凭据服务时抛出可读错误', async () => {
  await assert.rejects(settings.saveApiKey({ get: () => undefined }, 'K', 'ujn-12345678'), /没有挂载凭据服务/)
})

// ───────────────────────── lib/index.js 纯函数 ─────────────────────────
console.log('\nhost: 工具定义')
check('工具名固定', () => {
  assert.equal(host.__test.TOOL_NAME, 'ujn_generate_image')
})
check('参数 schema 是对象根且只含受支持关键字', () => {
  const schema = host.__test.toolParameters()
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['prompt'])
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `不支持的 schema 关键字: ${key}`)
    for (const child of Object.values(node.properties ?? {})) walk(child)
    if (node.items) walk(node.items)
  }
  walk(schema)
})
check('输出 schema 必填字段与 execute 返回一致', () => {
  const schema = host.__test.toolOutputSchema()
  assert.deepEqual(schema.required, ['fileName', 'model', 'size', 'width', 'height', 'bytes'])
})
check('渲染出文本块 + 图片块', () => {
  const blocks = host.__test.renderToolOutput({
    path: 'E:/out/a.png',
    fileName: 'a.png',
    model: 'Qwen-Image-2.1',
    size: '1024x1024',
    width: 1024,
    height: 1024,
    bytes: 1234,
    elapsedMs: 11000,
    prompt: 'p',
    enhanced: false,
    image: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 1234, width: 1024, height: 1024, name: 'a.png' },
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  // Web 端图片卡片按这个信封形状识别，必须严格匹配。
  assert.match(blocks[0].text, /^<path>[^\n]*<\/path>\n<type>image<\/type>\n<content>\n[\s\S]*\n<\/content>$/)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'sha256:abc')
})
check('无附件时只渲染文本块', () => {
  const blocks = host.__test.renderToolOutput({
    fileName: 'a.png', model: 'm', size: '1024x1024', width: 1, height: 1, bytes: 1, elapsedMs: 0, enhanced: false,
  })
  assert.equal(blocks.length, 1)
})

console.log('\nhost: 请求栅栏')
const req = (headers) => ({ headers })
check('回环 Host 放行', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: '127.0.0.1:19387' })), true)
})
check('localhost 放行', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: 'localhost:19387' })), true)
})
check('外部 Host 被拒（DNS 重绑定防护）', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: 'evil.example' })), false)
})
check('相似域名被拒', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: '127.0.0.1.evil.com' })), false)
})
check('跨站标记被拒', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })), false)
})
check('跨域 Origin 被拒', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: '127.0.0.1:1', origin: 'https://evil.example' })), false)
})
check('同源 Origin 放行', () => {
  assert.equal(host.__test.isTrustedRequest(req({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })), true)
})
check('显式声明的额外权威放行', () => {
  process.env.DSH_UJN_IMAGE_TRUSTED_HOSTS = 'dsh.example:8443'
  assert.equal(host.__test.isTrustedRequest(req({ host: 'dsh.example:8443' })), true)
  delete process.env.DSH_UJN_IMAGE_TRUSTED_HOSTS
})

console.log('\nhost: 假 ctx 驱动的端到端（假 fetch，无网络）')
/** 造一个按名字收集工具定义的假 ctx。 */
function collectingCtx() {
  const tools = new Map()
  return {
    tools,
    ctx: {
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      webServer: { register: () => () => {} },
      effect: (fn) => { fn() },
      get: () => undefined,
      logger: { info() {}, warn() {} },
    },
  }
}
await checkAsync('两个工具都注册成功且形状合法', async () => {
  const { tools, ctx } = collectingCtx()
  host.apply(ctx)
  const registered = tools.get(host.__test.TOOL_NAME)
  assert.ok(registered !== undefined, '文生图工具未注册')
  assert.equal(typeof registered.execute, 'function')
  assert.equal(typeof registered.output.render, 'function')
  assert.equal(typeof registered.output.schema, 'object')
  assert.equal(typeof registered.isConcurrencySafe, 'function')
})
await checkAsync('未配置密钥时 execute 给出可读指引', async () => {
  const { tools, ctx } = collectingCtx()
  host.apply(ctx)
  const registered = tools.get(host.__test.TOOL_NAME)
  await assert.rejects(
    registered.execute({ prompt: 'a cat' }, { signal: new AbortController().signal }),
    /设置 → 济大词元文生图/,
  )
})
await checkAsync('produceImage 落盘 + 登记附件', async () => {
  const png = tinyPng(512, 512)
  const original = globalThis.fetch
  globalThis.fetch = async () => imageResponse(png)
  let admitted = null
  const ctx = {
    get: (name) => (name === 'attachments'
      ? { saveImage: async (input) => { admitted = input; return { attachmentId: 'sha256:deadbeef', mediaType: 'image/png', bytes: input.data.length, width: 512, height: 512 } } }
      : undefined),
  }
  try {
    const result = await host.__test.produceImage(ctx, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '测试图',
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'out') },
      size: '1024x1024',
      enhance: false,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.ok(fs.existsSync(result.file), `文件不存在: ${result.file}`)
    assert.deepEqual({ w: result.width, h: result.height }, { w: 512, h: 512 })
    assert.equal(admitted.mediaType, 'image/png')
    assert.equal(result.attachment.attachmentId, 'sha256:deadbeef')
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('produceImage 在附件服务缺失时优雅降级', async () => {
  const png = tinyPng(64, 64)
  const original = globalThis.fetch
  globalThis.fetch = async () => imageResponse(png)
  try {
    const result = await host.__test.produceImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '降级测试',
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'out2') },
      size: '1024x1024',
      enhance: false,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.equal(result.attachment, null)
    assert.ok(fs.existsSync(result.file))
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('同名文件不覆盖，自动加序号', async () => {
  const png = tinyPng(32, 32)
  const original = globalThis.fetch
  globalThis.fetch = async () => imageResponse(png)
  const dir = path.join(SANDBOX, 'dup')
  try {
    const common = {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'dup',
      settings: { ...settings.DEFAULTS, saveDir: dir },
      size: '1024x1024',
      enhance: false,
      cwd: SANDBOX,
      signal: new AbortController().signal,
      save: true,
    }
    const first = await host.__test.produceImage({ get: () => undefined }, { ...common, fileName: 'same.png' })
    const second = await host.__test.produceImage({ get: () => undefined }, { ...common, fileName: 'same.png' })
    assert.equal(path.basename(first.file), 'same.png')
    assert.equal(path.basename(second.file), 'same-2.png')
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('提示词增强失败时回退原始提示词', async () => {
  const png = tinyPng(16, 16)
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    if (String(url).includes('/chat/completions')) return { ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}' }
    return imageResponse(png)
  }
  try {
    const result = await host.__test.produceImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '原始提示词',
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'enh'), enhance: true },
      size: '1024x1024',
      enhance: true,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.equal(calls, 2, '应当先试增强、失败后再生图')
    assert.equal(result.enhanced, false)
    assert.equal(result.prompt, '原始提示词')
    assert.match(String(result.enhancement.error), /boom/)
  } finally {
    globalThis.fetch = original
  }
})

console.log('\nhost: 参考图识别与读取')
check('按 magic bytes 识别 PNG / JPEG / WebP / GIF', () => {
  assert.equal(host.__test.sniffImageMime(tinyPng()), 'image/png')
  assert.equal(host.__test.sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(host.__test.sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp')
  assert.equal(host.__test.sniffImageMime(Buffer.from('GIF89a...')), 'image/gif')
})
check('非图片字节返回 undefined', () => {
  assert.equal(host.__test.sniffImageMime(Buffer.from('这不是图片，只是一段文字')), undefined)
})
check('RIFF 但不是 WEBP 的不算图片', () => {
  assert.equal(host.__test.sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), undefined)
})
check('读取真实 PNG 文件（无扩展名也能识别）', () => {
  const dir = path.join(SANDBOX, 'refs')
  fs.mkdirSync(dir, { recursive: true })
  const noExt = path.join(dir, 'no-extension')
  fs.writeFileSync(noExt, tinyPng(32, 32))
  const got = host.__test.readReferenceImage(noExt, SANDBOX)
  assert.equal(got.mime, 'image/png')
  assert.equal(got.data.length, fs.statSync(noExt).size)
})
check('相对路径按 cwd 解析', () => {
  const rel = 'refs/no-extension'
  const got = host.__test.readReferenceImage(rel, SANDBOX)
  assert.equal(got.mime, 'image/png')
})
check('文件不存在时给出可读错误', () => {
  assert.throws(() => host.__test.readReferenceImage('nope.png', SANDBOX), /找不到参考图/)
})
check('空路径被拒绝', () => {
  assert.throws(() => host.__test.readReferenceImage('  ', SANDBOX), /参考图路径不能为空/)
})
check('不是图片的文件被拒绝', () => {
  const dir = path.join(SANDBOX, 'refs')
  const bogus = path.join(dir, 'bogus.png')
  fs.writeFileSync(bogus, 'not an image')
  assert.throws(() => host.__test.readReferenceImage(bogus, SANDBOX), /不是受支持的图片格式/)
})
check('超过体积上限被拒绝', () => {
  const dir = path.join(SANDBOX, 'refs')
  const big = path.join(dir, 'big.png')
  fs.writeFileSync(big, Buffer.concat([tinyPng(), Buffer.alloc(2048)]))
  assert.throws(() => host.__test.readReferenceImage(big, SANDBOX, 100), /参考图过大/)
})

console.log('\nhost: 编辑工具定义')
check('编辑工具名固定', () => {
  assert.equal(host.__test.EDIT_TOOL_NAME, 'ujn_edit_image')
})
check('编辑参数 required 为 prompt + images', () => {
  assert.deepEqual(host.__test.editToolParameters().required, ['prompt', 'images'])
})
check('images 是字符串数组且受 4 张上限约束', () => {
  const p = host.__test.editToolParameters().properties.images
  assert.equal(p.type, 'array')
  assert.equal(p.items.type, 'string')
  assert.match(p.description, /4 张/)
})
check('编辑参数 schema 只含受支持关键字', () => {
  const schema = host.__test.editToolParameters()
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `不支持的 schema 关键字: ${key}`)
    for (const child of Object.values(node.properties ?? {})) walk(child)
    if (node.items) walk(node.items)
  }
  walk(schema)
})
check('输出 schema 支持 sources / finalPrompt', () => {
  const schema = host.__test.toolOutputSchema()
  assert.ok(schema.properties.sources !== undefined)
  assert.ok(schema.properties.finalPrompt !== undefined)
})
check('render 用"编辑"措辞', () => {
  const blocks = host.__test.renderToolOutput({
    fileName: 'a.png', model: 'm', size: '1024x1024', width: 1, height: 1, bytes: 1, elapsedMs: 0, enhanced: false,
  }, '编辑')
  assert.match(blocks[0].text, /编辑/)
})

console.log('\nhost: 编辑链路（假 fetch）')
await checkAsync('produceEditedImage 走 /images/edits 并落盘（带 edit 标记）', async () => {
  const png = tinyPng(48, 48)
  const original = globalThis.fetch
  let hitUrl = null
  globalThis.fetch = async (url) => { hitUrl = String(url); return imageResponse(png) }
  try {
    const result = await host.__test.produceEditedImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '让角色去玩电脑',
      referenceImages: [tinyPng(16, 16)],
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'edited') },
      size: '1024x1024',
      enhance: false,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.match(hitUrl, /\/v1\/images\/edits$/)
    assert.ok(fs.existsSync(result.file))
    assert.match(path.basename(result.file), /-edit-/, `文件名应当带 edit 标记：${result.file}`)
    assert.equal(result.width, 48)
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('enhanceEdit 关闭时不调用 PE-I2I', async () => {
  const png = tinyPng()
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => { urls.push(String(url)); return imageResponse(png) }
  try {
    await host.__test.produceEditedImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      referenceImages: [tinyPng()],
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'e1') },
      size: '1024x1024',
      enhance: false,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.equal(urls.filter((u) => u.includes('/chat/completions')).length, 0, '不该调用增强模型')
    assert.equal(urls.filter((u) => u.includes('/images/edits')).length, 1)
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('enhanceEdit 开启但模型不改写时仍能出图', async () => {
  const png = tinyPng()
  const original = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    if (String(url).includes('/chat/completions')) {
      // 回显原文（实测该模型有时就是这样）
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"rewritten_prompt":"p","ratio_follow":""}' } }] }) }
    }
    return imageResponse(png)
  }
  try {
    const result = await host.__test.produceEditedImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: 'p',
      referenceImages: [tinyPng()],
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'e2') },
      size: '1024x1024',
      enhance: true,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.equal(urls.filter((u) => u.includes('/chat/completions')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/images/edits')).length, 1)
    assert.equal(result.prompt, 'p')
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('enhanceEdit 失败时回退原始指令继续出图', async () => {
  const png = tinyPng()
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/chat/completions')) return { ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}' }
    return imageResponse(png)
  }
  try {
    const result = await host.__test.produceEditedImage({ get: () => undefined }, {
      apiKey: 'k'.padEnd(8, 'x'),
      prompt: '原始指令',
      referenceImages: [tinyPng()],
      settings: { ...settings.DEFAULTS, saveDir: path.join(SANDBOX, 'e3') },
      size: '1024x1024',
      enhance: true,
      cwd: SANDBOX,
      signal: new AbortController().signal,
    })
    assert.equal(result.prompt, '原始指令')
    assert.match(String(result.enhancement.error), /boom/)
    assert.ok(fs.existsSync(result.file))
  } finally {
    globalThis.fetch = original
  }
})

console.log('\nhost: 编辑工具的 execute（假 ctx）')
await checkAsync('execute 读参考图并返回 sources', async () => {
  // 造一个真实参考图文件，让 execute 真的去读它。
  const refDir = path.join(SANDBOX, 'toolrefs')
  fs.mkdirSync(refDir, { recursive: true })
  const refPath = path.join(refDir, 'character.png')
  fs.writeFileSync(refPath, tinyPng(198, 196))

  const png = tinyPng(64, 64)
  const original = globalThis.fetch
  globalThis.fetch = async () => imageResponse(png)

  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
    get(name) {
      if (name === 'credentials') {
        return { resolve: async () => ({ value: 'ujn-' + 'a'.repeat(20) }), describe: async () => ({ configured: true, writable: true }), set: async () => {} }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
  host.apply(ctx)
  try {
    const editTool = tools.get(host.__test.EDIT_TOOL_NAME)
    assert.ok(editTool !== undefined, '编辑工具未注册')
    const value = await editTool.execute(
      { prompt: '去玩电脑', images: [refPath] },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: SANDBOX } } } },
    )
    assert.equal(value.sources.length, 1)
    assert.equal(value.sources[0], refPath)
    assert.equal(value.width, 64)
    assert.ok(typeof value.fileName === 'string')
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('execute 在参考图缺失时给出可读错误（不发网络请求）', async () => {
  const original = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called += 1; return imageResponse(tinyPng()) }
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
    get: (name) => (name === 'credentials'
      ? { resolve: async () => ({ value: 'ujn-' + 'a'.repeat(20) }), describe: async () => ({ configured: true, writable: true }), set: async () => {} }
      : undefined),
    logger: { info() {}, warn() {} },
  }
  host.apply(ctx)
  try {
    const editTool = tools.get(host.__test.EDIT_TOOL_NAME)
    await assert.rejects(
      editTool.execute({ prompt: 'x', images: ['definitely-missing.png'] }, { signal: new AbortController().signal, agent: { session: { header: { cwd: SANDBOX } } } }),
      /找不到参考图/,
    )
    assert.equal(called, 0, '读不到参考图就不该发网络请求')
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('两个工具都被注册', async () => {
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { info() {}, warn() {} },
  }
  host.apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), [host.__test.EDIT_TOOL_NAME, host.__test.TOOL_NAME].sort())
})

// ───────────────────────── 真实 HTTP 层 ─────────────────────────
// 这一节是必须的：之前只用假 ctx 断言「handler 被注册了」，
// 结果漏掉了 route 包装器在 handler 之前就把 GET 拒掉的问题
// （设置页因此显示「读取设置失败：请使用 POST」）。
// 现在真的起一个 HTTP 服务、真的发请求，方法/路径/鉴权/状态码全走一遍。
console.log('\nHTTP: 真实服务器 + 真实请求')
{
  const http = await import('node:http')

  // 用真实 ctx 形状驱动 apply()，把 webServer.register 收到的路由挂到真服务器上。
  const routes = []
  const toolDefs = new Map()
  const httpCtx = {
    tools: { register: (def) => { toolDefs.set(def.name, def); return () => {} } },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async () => ({ value: 'ujn-abcdefgh', source: 'file' }),
          describe: async () => ({ configured: true, writable: true, source: 'file' }),
          set: async () => {},
        }
      }
      // 附件服务缺席：让 produceImage 走降级分支，避免依赖宿主内部对象。
      return undefined
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {
          const at = routes.indexOf(spec)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
  host.apply(httpCtx)

  // 极简路由器：exact 精确匹配，其余按前缀。
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    for (const r of routes) {
      const hit = r.kind === 'exact' ? pathname === r.path : pathname.startsWith(r.path)
      if (hit) {
        Promise.resolve(r.handler(request, response)).catch(() => {
          if (!response.headersSent) { response.writeHead(500); response.end('{"ok":false}') }
        })
        return
      }
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end('{"ok":false,"error":"not found"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  // 必须用**原始的** fetch 发测试请求：后面的 /preview 用例会替换
  // globalThis.fetch 来桩掉生图接口，否则测试客户端会把自己桩掉。
  const realFetch = globalThis.fetch
  const call = async (method, pathname, { body, headers } = {}) => {
    const response = await realFetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = undefined }
    return { status: response.status, body: parsed, raw: text, contentType: response.headers.get('content-type') }
  }

  check('注册了全部 5 条路由', () => {
    assert.equal(routes.length, 5, `实际 ${routes.length}: ${routes.map((r) => r.path).join(', ')}`)
  })
  check('路由路径都在插件前缀下', () => {
    for (const r of routes) assert.ok(r.path.startsWith(host.__test.ROUTE_PREFIX), r.path)
  })

  await checkAsync('GET /settings 返回 200（这就是之前 405 的那条）', async () => {
    const r = await call('GET', '/dsh-ujn-image/settings')
    assert.equal(r.status, 200, `状态码 ${r.status}：${r.raw.slice(0, 200)}`)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.settings !== undefined, '缺少 settings')
    assert.ok(r.body.defaults !== undefined, '缺少 defaults')
    assert.ok(r.body.sizes !== undefined, '缺少 sizes')
  })
  await checkAsync('GET /settings 不泄露密钥明文', async () => {
    const r = await call('GET', '/dsh-ujn-image/settings')
    assert.ok(!r.raw.includes('ujn-abcdefgh'), '响应里出现了密钥明文')
    assert.equal(r.body.apiKey.configured, true)
  })
  await checkAsync('POST /settings 也放行（回归）', async () => {
    const r = await call('POST', '/dsh-ujn-image/settings')
    assert.equal(r.status, 200, `POST 也应放行，实际 ${r.status}`)
  })

  for (const pathName of ['/save', '/test', '/preview']) {
    await checkAsync(`GET ${pathName} 被拒绝（写接口只收 POST）`, async () => {
      const r = await call('GET', `/dsh-ujn-image${pathName}`)
      assert.equal(r.status, 405, `应当 405，实际 ${r.status}`)
      assert.match(r.body.error, /POST/)
    })
    await checkAsync(`POST ${pathName} 不被方法闸门拒绝`, async () => {
      const r = await call('POST', `/dsh-ujn-image${pathName}`, { body: {} })
      assert.notEqual(r.status, 405, `不该是 405，实际 ${r.status}：${r.raw.slice(0, 160)}`)
    })
  }

  await checkAsync('POST /save 真的保存并回读', async () => {
    const r = await call('POST', '/dsh-ujn-image/save', { body: { saveDir: 'from-http-test', steps: 17 } })
    assert.equal(r.status, 200, r.raw.slice(0, 200))
    assert.equal(r.body.ok, true)
    assert.equal(r.body.settings.saveDir, 'from-http-test')
    assert.equal(r.body.settings.steps, 17)
    const back = await call('GET', '/dsh-ujn-image/settings')
    assert.equal(back.body.settings.steps, 17)
  })
  await checkAsync('POST /save 不接受非法画幅（回退默认）', async () => {
    const r = await call('POST', '/dsh-ujn-image/save', { body: { size: 'bogus' } })
    assert.equal(r.body.settings.size, settings.DEFAULTS.size)
  })

  await checkAsync('伪造 Host 被 403 拒绝', async () => {
    // fetch 不允许改 Host，因此直接用原生 http 发一个自定义 Host 的请求。
    const raw = await new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/dsh-ujn-image/settings', method: 'GET', headers: { host: 'evil.example' } },
        (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => resolve({ status: res.statusCode, data }))
        },
      )
      request.on('error', reject)
      request.end()
    })
    assert.equal(raw.status, 403, `应当 403，实际 ${raw.status}`)
  })
  await checkAsync('未知路径 404', async () => {
    const r = await call('GET', '/dsh-ujn-image/nope')
    assert.equal(r.status, 404)
  })
  await checkAsync('GET /file 缺文件名时 400', async () => {
    const r = await call('GET', '/dsh-ujn-image/file')
    assert.equal(r.status, 400)
  })
  await checkAsync('GET /file 目录穿越被挡住', async () => {
    const r = await call('GET', '/dsh-ujn-image/file?name=../../../etc/passwd')
    assert.ok(r.status === 400 || r.status === 404, `实际 ${r.status}`)
  })
  await checkAsync('GET /file 能读回 previews/ 里的真实 PNG', async () => {
    // /preview 固定写在 DSH home 下的 previews/，这张图就是这个位置。
    const png = tinyPng(8, 8)
    const dir = settings.previewDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'probe.png'), png)

    const response = await realFetch(`${base}/dsh-ujn-image/file?name=probe.png`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.equals(png), '读回的字节与写入的不一致')
  })
  await checkAsync('GET /file 能回退读 saveDir 里的图', async () => {
    const png = tinyPng(4, 4)
    const dir = path.join(SANDBOX, 'fallback-files')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'fallback.png'), png)
    await call('POST', '/dsh-ujn-image/save', { body: { saveDir: dir } })

    const response = await realFetch(`${base}/dsh-ujn-image/file?name=fallback.png`)
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.equals(png))
  })
  await checkAsync('工具与路由共存：两个工具仍已注册', async () => {
    assert.equal(toolDefs.get(host.__test.TOOL_NAME)?.name, host.__test.TOOL_NAME)
    assert.equal(toolDefs.get(host.__test.EDIT_TOOL_NAME)?.name, host.__test.EDIT_TOOL_NAME)
  })

  await checkAsync('POST /preview 把图写进 previews/（不写进程当前目录）', async () => {
    const png = tinyPng(64, 64)
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).includes('/images/generations')) return imageResponse(png)
      return { ok: false, status: 404, text: async () => '{}' }
    }
    try {
      const before = process.cwd()
      const r = await call('POST', '/dsh-ujn-image/preview', { body: { prompt: '预览测试' } })
      assert.equal(r.status, 200, r.raw.slice(0, 300))
      assert.equal(r.body.ok, true)
      // 必须落在 previews/ 下，而不是 process.cwd() 里。
      const inPreviewDir = path.resolve(r.body.path).startsWith(path.resolve(settings.previewDir()))
      assert.ok(inPreviewDir, `落在 ${r.body.path}，不在 ${settings.previewDir()}`)
      assert.ok(fs.existsSync(r.body.path), '文件不存在')
      assert.ok(!path.resolve(r.body.path).startsWith(path.resolve(before)), '不该写进进程当前目录')
    } finally {
      globalThis.fetch = original
    }
  })

  await new Promise((resolve) => server.close(resolve))
  // 恢复被 HTTP 测试改过的设置，避免影响后面的用例。
  settings.writeSettings({ saveDir: '_none_' })
}

// ───────────────────────── 客户端 bundle 静态检查 ─────────────────────────
console.log('\nclient: bundle 形状')
check('client.js 使用 __ModuleLoader__.load 且 id 等于包名', () => {
  const source = fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  const id = /id:\s*'([^']+)'/.exec(source)?.[1]
  assert.equal(id, pkg.name, `bundle id (${id}) 必须等于包名 (${pkg.name})`)
})
check('client.js 不导入任何 @deepseek-ai/* 包', () => {
  const source = stripComments(fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8'))
  assert.ok(!/(?:require\(|from\s+)['"]@deepseek-ai\//.test(source), '客户端 bundle 不应依赖 @deepseek-ai/*')
})
check('宿主半边不导入任何 @deepseek-ai/* 包', () => {
  // 注释里会提到 @deepseek-ai/dsh-tools（解释为什么不用它），
  // 因此这里先剥掉注释，只检查真实的 import/require 语句。
  const source = stripComments(fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8'))
  assert.ok(!/(?:require\(|from\s+|import\s+)['"]@deepseek-ai\//.test(source), '宿主半边不应依赖 @deepseek-ai/*')
})
check('cordis.patch.yml 声明了插件行', () => {
  const yaml = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  assert.match(yaml, /name:\s*dsh-ujn-image/)
})
check('package.json 声明了 bundle patch 与 client', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

// ───────────────────────── 可选：真实网络 ─────────────────────────
if (process.argv.includes('--live')) {
  console.log('\nlive: 真实平台调用')
  const key = process.env.UJN_API_KEY
  if (!key) {
    console.log('  ⊘ 跳过（未设置 UJN_API_KEY）')
  } else {
    await checkAsync('真实列模型', async () => {
      const models = await api.listModels({ apiKey: key })
      assert.ok(models.length > 0, '模型列表为空')
      assert.ok(models.includes(api.IMAGE_MODEL), `缺少 ${api.IMAGE_MODEL}`)
      console.log(`      模型: ${models.join(', ')}`)
    })
    await checkAsync('真实生成一张小图', async () => {
      const result = await api.generateImage({ apiKey: key, prompt: 'a small red circle', size: '1024x1024', steps: 8, seed: 1 })
      assert.equal(result.images.length, 1)
      assert.deepEqual(api.pngSize(result.images[0]), { width: 1024, height: 1024 })
      console.log(`      ${result.elapsedMs} ms, ${result.images[0].length} 字节`)
    })
  }
}

// ───────────────────────── 收尾 ─────────────────────────
console.log(`\n${passed} 通过，${failed} 失败`)
console.log(`sandbox: ${SANDBOX}`)
process.exitCode = failed === 0 ? 0 : 1
