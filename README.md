<div align="center">

# dsh-ujn-image

**在 DeepSeek Harness 里用济南大学自己的大模型平台生成和编辑图片**

填一次 API Key，之后在对话里说「画一只戴宇航员头盔的橘猫」，
DSH 就会调用校内的 Qwen-Image 把图做出来、存成 PNG，**并把图回给模型自己看**。

[![License: MIT](https://img.shields.io/badge/License-MIT-3b82f6.svg)](#许可)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-8b5cf6.svg)](#安装)
[![Tests](https://img.shields.io/badge/tests-131%20passing-22c55e.svg)](#自测)
[![Platform](https://img.shields.io/badge/platform-llm.ujn.edu.cn-0ea5e9.svg)](https://llm.ujn.edu.cn)

<img src="docs/demo-edit.webp" alt="用参考图生成：角色在电脑前打游戏" width="820">

<sub>↑ 给一张参考图 + 一句「让她在玩电脑」，角色特征完整保留。（<a href="#️-图片编辑--图生图">怎么做到的</a>）</sub>

</div>

---

## 目录

- [这是什么](#这是什么)
- [功能](#功能)
  - [文生图](#-文生图)
  - [图片编辑 / 图生图](#️-图片编辑--图生图)
  - [设置页](#️-设置页)
- [安装](#安装)
- [拿到 API Key](#拿到-api-key)
- [让模型真的「看见」生成的图](#-让模型真的看见生成的图建议做一步)
- [安全](#安全)
- [工作原理](#工作原理)
- [自测](#自测)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 这是什么

[济大词元](https://llm.ujn.edu.cn)（`llm.ujn.edu.cn`）是济南大学的大模型公共服务平台，
提供 **OpenAI 兼容**接口。接口本身不难调，但 DSH 里没有「画图」这个能力：

| 缺什么 | 这个插件怎么补 |
|---|---|
| DSH 自带的 `read_image` 只能**读**图，不能**生成**图 | 注册 `ujn_generate_image` / `ujn_edit_image` 两个工具 |
| 平台回的是 **base64**，而 DSH 的图片要变成「持久附件」才能进对话、才能被模型看见 | 解码 → 落盘 → `ctx.attachments.saveImage()` → 回传 `ImageBlock` |
| API Key 总得有地方填，而且不该在配置文件里留明文 | 走 DSH 官方凭据域，设置页填写、明文永不回传 |

一句话：**让 DSH 会画画，而且画完自己看得见。**

## 功能

### 🎨 文生图

```
你：画一只戴着宇航员头盔的橘猫，漂浮在太空中，细腻写实风格
```

| 参数 | 必填 | 说明 |
|---|:---:|---|
| `prompt` | ✅ | 画面描述，**中文直接写** |
| `size` | | 画幅：`square` / `landscape` / `portrait` / `wide` / `tall` |
| `enhance` | | 先扩写提示词（见下） |
| `steps` | | 采样步数，默认 40（官方推荐） |
| `fileName` | | 自定义文件名（同名不覆盖，自动加序号） |

<details>
<summary><b>为什么要「扩写提示词」？</b></summary>

平台额外提供了一个 `Qwen-Image-PE-T2I` 模型：把「一只在校园湖边散步的橘猫」这种简短描述，
扩写成结构化的英文绘图提示词，并推断画面宽高比。

画面元素多的时候开启它，出图完整度会明显更好——代价是每次多花约 **15 秒**。

**增强失败不会让生成失败**：会自动回退用原始提示词继续，并把失败原因带在返回里。

</details>

### 🖼️ 图片编辑 / 图生图

```
你：让她在玩电脑            [附上一张角色图]
```

这是**最常用也最容易被做错**的场景：想让某个角色出现在新场景里。
纯文生图（只给文字）根本不知道你的角色长什么样，出来的一定是「另一个蓝发女孩」。

正确的做法是把参考图一起发给平台的 `/v1/images/edits`：

<div align="center">
<img src="docs/ref-character.webp" alt="参考图" width="150">
&nbsp;&nbsp;<b>+</b>&nbsp;&nbsp;
<code>让这个角色坐在电脑桌前玩电脑游戏…保持发型、发饰、服装完全一致</code>
&nbsp;&nbsp;<b>→</b>&nbsp;&nbsp;
<img src="docs/demo-edit.webp" alt="结果" width="330">
</div>

| 参数 | 必填 | 说明 |
|---|:---:|---|
| `prompt` | ✅ | 要改什么 / 要去哪；写清「保持…不变」会明显更稳 |
| `images` | ✅ | 参考图路径，**1–4 张** |
| `size` / `steps` / `enhance` / `fileName` | | 同上 |

**关于 `enhance`（编辑时的 PE-I2I 改写）**：实测这个模型要跑 **约 70 秒**，而且有时
原样回显中文、并不改写。所以**默认关闭**；指令本身写得清楚时没必要开。开启了也会
在「没改写」或「失败」时自动回退。

> **小技巧**：`images` 可以直接填 DSH 附件目录里的只读副本路径——那种路径**没有扩展名**，
> 插件按文件内容（magic bytes）识别格式，不需要你先复制或改名。

### ⚙️ 设置页

**设置 → 济大词元文生图**：

- 🔑 填 **API Key**，保存后只显示「已配置」——**明文永不回传**
- 🔌 **测试连接**：用当前密钥列一次平台模型，确认通不通、有没有生图模型
- 🧪 **试跑**：不用开对话，直接在设置页里验证效果，生成结果当场预览
  （填了参考图路径就自动切成图片编辑模式）
- 🎚️ 接口地址、生图模型、默认画幅、采样步数、保存目录等偏好

---

## 安装

```powershell
# 桌面端（DeepSeek Harness 桌面应用）
dsh plugin --profile desktop add link:E:/DeepseekHarness/dsh-ujn-image

# 网页版（dsh web）
dsh plugin --profile web add link:E:/DeepseekHarness/dsh-ujn-image

# 或从 git 安装
dsh plugin --profile desktop add git+https://github.com/Jia-HuaWu/dsh-ujn-image
```

安装后**重启 DSH**：宿主半边的工具注册与浏览器半边的设置页装配都发生在启动时。

重启后打开设置（侧边栏左下角齿轮）→ 左侧导航里的「济大词元文生图」。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-ujn-image
```

卸载只摘插件，不会删除已生成的图片，也不会动你的凭据文件。

## 拿到 API Key

1. 打开 <https://llm.ujn.edu.cn>，用**统一身份认证**登录（学生用学号）
2. 进「密钥 / Tokens」页，点「创建密钥」
3. 复制 `ujn-` 开头的那串——**它只显示一次**，请当场存好
4. 粘进插件的设置页

> 生图模型与聊天模型是**独立配额**，出图不会挤占你平时对话的额度。

---

## ⚠️ 让模型真的「看见」生成的图（建议做一步）

插件会把生成的图作为**持久图片附件**回给模型。但 DSH 的 pi-ai 适配器有一个保守的默认值：

> `defaultInput` 默认是 `["text"]`。模型在配置里**没显式声明** `input` 时，就被当作纯文本模型。
> 这时图片会被替换成一行占位文本（`[image omitted because this model accepts text only; …]`），
> 模型**收不到真正的像素**，只能读到「已生成 1024x1024 的 PNG」这句话。

**实测结论：你们平台的这些模型其实都支持读图。** 拿一张真实生成的 1024×1024 PNG 直接打
`/v1/chat/completions`，三个模型都能正确描述画面内容：

| 模型 | 实测回应 |
|---|---|
| `deepseek-v41-flash` | 「图中是一只闭着眼睛走在河岸边泥地上的橘猫。」 |
| `Qwen3.8-Flash-Next` | 「一只正在行走的橘猫。」 |
| `GLM-5.3-Flash` | 「一只橘猫。」 |

所以在 profile 的 `cordis.patch.yml` 里，给 `llm-pi-ai` 的 `ujn` 路由补上 `input` 即可：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ujn:
        displayName: 济南大学
        apiKeyEnv: UJN_API_KEY
        api: openai-completions
        baseURL: https://llm.ujn.edu.cn/v1
        # ← 新增：让 ujn 路由下的模型都承认自己能收图
        defaultInput: [text, image]
        models:
          - id: deepseek-v41-flash
            name: deepseek-v41-flash
            contextWindow: 1048576
          # …其余模型不变
```

改完重启 DSH。之后模型不仅能生成图，还能接着对画面追问、批评或要求修改。

<details>
<summary><b>为什么 DSH 默认不这么写？</b></summary>

适配器源码里有一句很实在的注释：

> *"Under-claiming refuses the image before it is attached, naming the model.
> Over-claiming admits one the provider then rejects mid-turn, after the message is durable,
> leaving the session repeating a request that cannot succeed."*

也就是「少声明」只是拒绝一张图，「多声明」会让会话卡死在一条永远发不成功的请求上。
所以这**必须实测确认**平台真的支持才值得打开——上面已经测过了。

**不做这一步也没关系**：插件本身完全正常，图会照常生成、落盘、在对话里显示成图片卡片
（你本人能看到图），只是模型自己「看不见」画面内容而已。

</details>

## 安全

| | |
|---|---|
| 🔐 **API Key 不进配置文件** | 存在 DSH 官方凭据文件（`$DSH_HOME/.credentials.yaml`），与「设置 → 模型」「网页搜索」同一条 seam；所有响应对密钥**只报告是否存在**，无一处回传明文 |
| ♻️ **默认复用 `UJN_API_KEY`** | 若你已在「设置 → 模型」里为同一平台填过密钥，这里直接认到，不用重复填；也可改成别的凭据名 |
| 🛡️ **设置页路由有来源栅栏** | 这些接口能写密钥，因此只接受回环地址的本机请求，并挡住 DNS 重绑定（伪造 `Host`）与跨站请求（`Sec-Fetch-Site: cross-site`、跨域 `Origin`）。通过反代/局域网访问时用 `DSH_UJN_IMAGE_TRUSTED_HOSTS` 显式声明权威 |
| 📁 **只读受限** | 设置页预览接口只从插件自己的 `previews/` 与配置的 `saveDir` 读取，`path.basename()` 挡住目录穿越 |

## 工作原理

```
对话 ──► ujn_generate_image ─┐
                             ├─► 读设置（$DSH_HOME/dsh-ujn-image/settings.json）
对话 ──► ujn_edit_image ─────┘   ├─ 取密钥（凭据域：$DSH_HOME/.credentials.yaml）
        （带 1..4 张参考图）      ├─ 读参考图（按 magic bytes 识别格式）
                                 ├─ [可选] PE-T2I / PE-I2I 改写提示词
                                 ├─ POST /v1/images/generations  或
                                 │  POST /v1/images/edits（multipart）
                                 │       └─► base64 PNG
                                 ├─ 解 IHDR 拿宽高 · 落盘到 ujn-images/
                                 └─ attachments.saveImage(...) ──► 持久图片附件
                                                                    （模型真的能"看见"）
```

### 文件结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：两个工具 + 设置页数据面路由 |
| `lib/ujn-api.mjs` | 平台协议层（纯函数，无 DSH 依赖，可独立测试） |
| `lib/settings.mjs` | 设置读写 + 凭据域封装 |
| `lib/client.js` | 浏览器半边：设置页 UI（手写纯 JS，无构建步骤） |
| `cordis.patch.yml` | bundle patch：把自己插进 profile 的配置树 |

### 数据面路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-ujn-image/settings` | `GET` | 当前设置 + 密钥状态（不含明文） |
| `/dsh-ujn-image/save` | `POST` | 保存设置与密钥 |
| `/dsh-ujn-image/test` | `POST` | 用当前密钥列平台模型 |
| `/dsh-ujn-image/preview` | `POST` | 试跑一次（带 `image` 即编辑模式） |
| `/dsh-ujn-image/file` | `GET` | 读回已生成的图（设置页预览） |

### 三个实现上的坑

<details>
<summary><b>1. 不用 <code>defineTool</code>，手写工具定义</b></summary>

官方文档给的写法是 `import { defineTool } from '@deepseek-ai/dsh-tools'`，但实测
**第三方插件解析不到这个包**（profile 的 `node_modules` 里没有它，ESM 直接
`ERR_MODULE_NOT_FOUND`）。同机的 `dsh-hidden-sessions`、`dsh-pocket` 也都不 import
任何 `@deepseek-ai/*`。

`defineTool` 实际只做「把简写参数表编译成 JSON Schema + 包一层参数校验」，
而注册表接受的就是编译后的原始形状，所以这里直接产出原始形状——等价，
且不引入解析不到的依赖。**已用 DSH 自己的 schema 校验器验证过**（见[自测](#自测)）。
</details>

<details>
<summary><b>2. 二进制落盘走 <code>node:fs</code>，不走 <code>ctx.fs</code></b></summary>

DSH 的文件系统 seam 明确规定**变更操作只支持文本**（二进制写入会被 `FS_NOT_TEXT` 拒绝）。
已安装的插件运行在宿主进程内，因此用 `node:fs` 写 PNG 是正确且必要的选择。
</details>

<details>
<summary><b>3. multipart 不能自己写 <code>Content-Type</code></b></summary>

`/images/edits` 是 multipart 表单。`Content-Type` 必须由运行时自己带上 `boundary`，
手写会把 boundary 写死/写错，导致平台解析失败。所以只传 `Authorization`。
</details>

## 自测

```powershell
cd dsh-ujn-image

# 离线：131 项，全部走假 fetch，不联网、不碰真实 $DSH_HOME
node scripts/selftest.mjs

# 额外跑一次真实平台的列模型 + 生图
$env:UJN_API_KEY = "ujn-..."
node scripts/selftest.mjs --live
```

离线部分覆盖：

- **协议层** — 地址归一化、错误翻译、base64 解码、PNG 尺寸解析、multipart 字段构造
- **编辑层** — 1–4 张输入图命名、超限拒绝、`Content-Type` 不被污染、PE-I2I 回退
- **参考图** — magic bytes 识别（含无扩展名路径）、大小上限、非图片拒绝
- **设置** — 读写容错、越界收敛、凭据域交互（含「明文不泄露」断言）
- **工具** — 两个工具的 schema 合法性、渲染信封格式
- **HTTP** — **起真服务器、发真请求**，逐条验证方法 / 路径 / 鉴权 / 状态码
- **来源栅栏** — 伪造 Host、跨站标记、跨域 Origin 全部拒绝

> **为什么 HTTP 那一节是必须的**：最初只断言「handler 被注册了」，结果漏掉了
> `route()` 包装器在 handler 之前就把 `GET /settings` 拒成 405 的 bug
> （设置页因此显示「读取设置失败：请使用 POST」）。只测函数、不测真实请求，
> 就测不出这类「接线」错误——现在这条路径一旦回归，测试会直接失败。

另外两个独立验证脚本（**用 DSH 自己的实现**验证，而不是「我以为」）：

```powershell
# 用从 app.asar 里取出的 DSH 真实 schema 校验器验证两个工具的 schema
node ../_recon/verify/verify-schema.mjs

# 用真模块加载器语义物化客户端 bundle，验证 slot 注册与元素工厂
node ../_recon/verify/verify-client.mjs
```

## 已知限制

- **单张输出** — 平台接受 `n`，但插件一次只取第一张（DSH 工具一次回一张图最自然）
- **编辑的 `enhance` 很慢** — PE-I2I 实测约 70 秒且有时不改写，默认关闭
- **模型默认「看不见」生成的图** — 直到你按[上文](#-让模型真的看见生成的图建议做一步)补上
  `input: [text, image]`。图本身照常生成与显示
- **图片落盘位置跟会话走** — 默认写在会话工作目录下的 `ujn-images/`；
  设置页「试跑」则写到 `$DSH_HOME/dsh-ujn-image/previews/`
- **生图较慢** — 平台串行推理：1024×1024 / 20 步约 11 秒，2528×1696 约 73 秒，
  步数拉满更久，首次调用还可能撞上模型加载。插件超时给到 10 分钟

## 贡献

欢迎 issue / PR。改动请附上 `node scripts/selftest.mjs` 的输出。

## 许可

[MIT](LICENSE)

---

<div align="center">
<sub>

本项目与济南大学官方无关，是个人为 DSH 编写的第三方插件。
平台地址与服务条款以 <a href="https://llm.ujn.edu.cn">llm.ujn.edu.cn</a> 为准。

</sub>
</div>
