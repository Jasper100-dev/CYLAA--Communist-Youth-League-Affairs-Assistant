# Edge 商店填写清单（v1.1.0）

> 复制到 Partner Center 对应字段。所有功能描述必须与商店包实际行为一致。

## 本次更新（v1.1.0，2026-11-23）

发布包：`dist/CYLAA-edge-1.1.0.zip`（54,962 字节，manifest 在 zip 根目录，版本 **1.1.0**）。

Partner Center → Packages 上传新包后，其余字段按下文填写；**没有变化的字段可以不改**。建议在 Release notes / "What's new" 里粘贴：

```
本次更新（v1.1.0）
· 名单 CSV 增加性别、团籍是否在本组织、入团年月，与平台导出的名单字段一致
· 修复抓取名单后，平台自带的「导出团员数据」会下载到空文件的问题
· 面板可收起成悬浮球拖动，设置中新增「吸附到最近页边」（默认开启），卡片自动选择展开方向，不会超出屏幕
· 设置中拆分「清理缓存」与「完全清除」，可选择只清缓存或连本地名单快照、面板设置一起删除
```

本次同步改动的文件（都已提交到 `edge` 分支）：`manifest.json`（1.1.0）、`CHANGELOG.md`、`README.md`、`docs/index.html`（隐私页）、`store-assets/store-description.txt`。

## Extension name

```
团务助手 - 团员信息管理
```

## Short description

```
智慧团建团务辅助：名单导出、验证码记录、评议批量设置与团员信息录入预检。
```

## Manifest description（实际文案在 `_locales/zh_CN/messages.json`，硬上限 132 字符）

`manifest.json` 使用占位符：

```
"description": "__MSG_extensionDescription__"
```

`_locales/zh_CN/messages.json` 中的实际文案：

```
团务助手：智慧团建团务辅助，支持名单读取与 CSV 导出、重置验证码记录、评议批量设置、团员信息录入预检；数据本地处理，批量任务确认后提交。
```

> 实际 70 字符。不要直接写长文案到 manifest，也不要超过 132 字符。

## Store listing Description（Partner Center 长描述，250–10000 字符）

> 填在 Partner Center → Store listings → Details for 中文（简体）→ **Description**，不是 manifest 的 `description` 字段。纯文本粘贴，不要带 Markdown 标记。
>
> 完整文案以 **`store-assets/store-description.txt`** 为准（1,759 字符，满足 250–10000 要求），可直接全选复制。功能分节、列表与隐私说明均已按商店包的实际行为重写。

修改长描述时只改 `store-assets/store-description.txt`，并同步更新这里的字符数，避免多处文案不一致。

## Search terms（最多 7 个，每词 ≤30 字符）

```
团务助手
智慧团建
团员名单
名单导出
教育评议
团员信息录入
验证码记录
```

> `智慧团建` 只用于描述兼容的平台，不代表官方授权或隶属关系；若审核对商标用语有疑问，优先删掉这一条，其余 6 条保留。

## Store listing 语言

包已声明 `default_locale: "zh_CN"` 并提供 `_locales/zh_CN/messages.json`，重新上传后 Store listings 应出现 **中文（简体）** 行。

如果仍显示 **英语（美国）不完整**：

1. 确认上传的是包含 `_locales/zh_CN/messages.json` 的新 zip；
2. 等中文（简体）行出现后，点英语（美国）行的 **Remove**，只保留中文；
3. 不要为了消除“不完整”去填英文描述——那等于声明支持英文，反而引入本地化问题。

## Single purpose

```
为团务工作人员提供智慧团建平台团务数据的本地读取、核对与批量录入辅助，减少重复性手工操作。
```

## 权限理由

| 权限 | 理由 |
|---|---|
| `storage` | 仅在本地保存名单变更快照（姓名 + 手机号）、面板设置与更新时间，用于变更识别和恢复，不上传服务器。 |
| `https://zhtj.youth.cn/*` | 内容脚本只在该平台页面运行，需要读取页面表格与调用同源字典接口，必需。 |

商店版不申请任何其他 host 权限，也不发起外部网络请求。

## 远程代码

选 **No**。包内没有 `eval`、`new Function`、动态脚本注入或远程脚本加载。

## 数据用途勾选

- 个人身份信息（姓名）
- 电话号码（手机号）
- 身份验证信息（密码重置验证码）
- 网页内容（平台表格）

不勾选位置、财务、健康信息。

> 录入预检会读取导入表格中的身份证号，仅在本机内存中做格式与校验位检查，不写入存储、不上传，导出的问题清单也只有行号、姓名和问题描述。如果审核按“处理”口径追问，可把“个人身份信息”理解为包含姓名与身份证号，并在 Notes 中补充这一句。

## 隐私政策 URL

```
https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/edge/
```

> ✅ **1.1.0 已修正隐私页**（`edge` 分支 `docs/index.html` 与 `main` 分支 `docs/edge/index.html`，两者内容一致）：
> - 数据表补上 性别 / 团籍是否在本组织 / 入团年月，来源注明「平台页面表格；导出名单时读取平台自身的导出文件（同源）」；
> - 第 1 节改为「录入预检会在本机内存中读取导入文件里的身份证号，仅用于格式与校验位检查，不写入存储、不上传」；
> - 第 3 节网络通信补上 `/v1/center/exportmembers/…`（同源、当前登录会话）；
> - 存储说明改为「可在设置中用『完全清除』删除，或卸载扩展一并清除；『清理缓存』只清当前名单、验证码与评议缓存」；1.1.0 起「完全清除」会真正删除 `chrome.storage.local` 里的名单快照与面板设置；
> - 第 5 节改为「验证码记录会在您打开密码重置弹窗后自动进行」。
>
> 线上隐私页由 `main` 分支的 GitHub Pages 提供，推送后需等 1–2 分钟构建；**提交商店前请先打开链接确认已是新文案**。

## URL 核验（2026-11-20）

| 用途 | 值 | 核验结果 |
|---|---|---|
| 商店隐私政策（填 Partner Center） | `https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/edge/` | ✅ HTTP 200，可访问 |
| 隐私政策直链（目录 URL 被拒时改用） | `https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/edge/index.html` | ✅ HTTP 200，明确指向 html 文件 |
| 隐私政策目录（不带尾斜杠） | `https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/edge` | ✅ HTTP 200，会跳到带斜杠地址 |
| 项目主页（可作 Website / Support URL） | `https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/` | ✅ HTTP 200，页面内含反馈说明 |
| GitHub 版隐私页（勿填商店） | `https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/` | ✅ HTTP 200 |
| 智慧团建平台 | `https://zhtj.youth.cn/` | ⚠️ 未登录请求返回 403（平台要求登录，属正常）；不要填进 URL 字段 |
| 权限匹配模式 | `https://zhtj.youth.cn/*` | ❌ HTTP 404，不是可访问网址，只是 manifest 匹配串；已从描述和认证备注里删掉 |
| 可选支持链接 | `https://github.com/Jasper100-dev/CYLAA--Communist-Youth-League-Affairs-Assistant/issues` | ⚠️ 当前网络无法访问 GitHub，未能核验；填之前请在浏览器确认能打开 |

填 URL 时注意：只粘 `https://` 开头的纯地址，不要带 Markdown 的 `[文字](地址)`、中文括号、前后空格或句末标点；Partner Center 会把整段当 URL 校验。GitHub Pages 路径**区分大小写**，`CYLAA--Communist-...` 的双连字符和大小写都要保持原样，改成全小写会 404。

> 如果提交时仍报“输入的 URL() 似乎已损坏或无效”，先看是不是把 Support URL / Website 留空了。这两个字段若要求必填，优先填项目主页（已核验 200），不要填 `zhtj.youth.cn`；GitHub Issues 在部分网络下可能打不开，填前先自测。描述/备注里出现 `https://zhtj.youth.cn/*` 时，商店的 URL 校验可能把它当链接去访问，404 同样会报 URL 无效；新版商店描述已完全不出现网址，只写「智慧团建平台」，认证备注保留不带协议的域名供审核测试。

## Notes for certification（含“是否需要账号”回答）

> Partner Center 若问“测试是否需要凭据、帐户或其他信息”，选 **是**。Edge 政策 1.3.1 允许不提供测试账号，但必须在 Notes 里给出清晰、合理的解释。
>
> 英文全文二选一：有录屏用 **`store-assets/certification-notes.txt`**（1,679 字符），没有录屏用 **`store-assets/certification-notes-no-video.txt`**（1,683 字符），都 ≤2,000，直接粘贴到说明框/Notes。两版都会说明：为什么不能提供账号、不登录能验证什么；有录屏版还会给脱敏录屏链接。
>
> 用有录屏版时把 `<VIDEO_URL>` 换成不公开（unlisted）的链接；录屏里不要出现真实姓名、手机号、验证码、身份证号或单位名称。无录屏版被判定“无法测试”的概率明显更高，只建议作为一次尝试。

中文口径（供你核对，正式填写建议用英文）：

- 需要智慧团建账号才能测完整流程；账号绑定真实团组织和实名身份，含真实团员信息。
- 共享账号会违反平台规则和《个人信息保护法》，且平台没有沙箱/演示环境，所以无法提供。
- 不登录也能验证：安装、权限只有 storage + zhtj 主机、登录页面板与六个页签、Network 只请求 zhtj、无远程代码/更新检查。
- 账号相关流程用脱敏录屏展示；可应审核要求补录特定流程。

英文全文开头就是 `YES — ...`，所以它既能回答是/否，也能直接当解释正文用。

## 素材

| 文件 | 规格 | 状态 |
|---|---|---|
| `icons/icon128.png` | 128×128，1:1 | 已在包内 |
| `store-assets/logo-300.png` | 300×300，1:1 | 已生成 |
| `store-assets/small-promotional-tile-440x280.png` | 440×280 | 已生成 |
| `store-assets/large-promotional-tile-1400x560.png` | 1400×560 | 已生成 |
| `store-assets/screenshots/01-roster.png` | 1280×800 | 已生成：名单 |
| `store-assets/screenshots/02-evaluation.png` | 1280×800 | 已生成：评议 |
| `store-assets/screenshots/03-member-info.png` | 1280×800 | 已生成：信息 |
| `store-assets/screenshots/04-import.png` | 1280×800 | 已生成：录入 |
| `store-assets/screenshots/05-codes.png` | 1280×800 | 已生成：取码 |
| `store-assets/screenshots/06-settings.png` | 1280×800 | 已生成：设置 |

截图已用 v1.0.0 真实界面制作，姓名、手机号尾号等已打码；共 6 张，顺序：名单 → 评议 → 信息 → 录入 → 取码 → 设置。面板底部文案与 v1.0.0 一致（“批量任务需确认后自动提交 · 请核对”）。

## 上架前检查

1. 发布包 `dist/CYLAA-edge-1.1.0.zip` 已生成，manifest 在 zip 根目录，`version` 为 `1.1.0`。
2. 权限仅 `storage` + `https://zhtj.youth.cn/*`，只加载 `content.js`。
3. 包内无 `update.js`、`version.json`、第三方更新地址。
4. 隐私页 URL 可访问，内容已更新到 1.1.0 行为（同源导出接口、身份证号说明、存储期限）。
5. 商店描述、面板文案、隐私页三处关于“确认后自动提交”的表述一致。
6. 6 张截图已放入 `store-assets/screenshots/`，均为 1280×800，敏感信息已打码（截图为 1.0.0 界面；1.1.0 只多了一个设置项和悬浮球交互，如需最新界面可重拍 `01-roster`、`06-settings`）。
7. `manifest.json` 的 `description` 已压到 70 字符（≤132），长描述填在 Store listing 的 Description 字段。
8. `store-assets/certification-notes.txt` 里的 `<VIDEO_URL>` 已替换为可访问的脱敏录屏；若“是否需要账号”选「是」，说明框已粘贴全文。
9. 商店要求更新必须提高版本号：已从 1.0.0 升到 **1.1.0**，Partner Center 上传后确认包的版本显示为 1.1.0。
