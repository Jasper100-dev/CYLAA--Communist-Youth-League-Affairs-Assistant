# 团务助手 · 智慧团建（Microsoft Edge 商店版）

> 本分支只维护 Microsoft Edge 加载项商店版，当前版本 **1.1.0**。另有独立维护的完整版，不在本分支；两版互不影响。

面向共青团基层团务工作的浏览器辅助工具，用于在智慧团建平台（`zhtj.youth.cn`）上减少重复性手工操作。

本工具为第三方辅助工具，与智慧团建官方平台不存在授权或隶属关系。

## 功能

- 团员名单读取、分页读取与 CSV 导出（含性别、团籍是否在本组织、入团年月）。
- 面板可收起成悬浮球拖动，支持「吸附到最近页边」（默认开启）。
- 密码重置验证码的本地记录与导出。
- 教育评议等级批量设置辅助。
- 团员信息批量填写辅助与录入前数据预检。
- 操作日志、操作间隔控制。

批量任务在面板中点击确认后才会开始；确认后工具会逐人填写并提交。评议选择等次后由平台页面即时保存，效果等同提交。请在确认前核对目标人员与数据内容。

## 权限与网络

| 权限 | 用途 |
|---|---|
| `storage` | 本地保存名单变更快照、面板设置和更新时间 |
| `https://zhtj.youth.cn/*` | 内容脚本只在该平台运行，读取页面表格和同源字典接口 |

商店版**不包含自动更新检查**，不请求任何第三方地址，也不上传团务数据。

## 安装

上架后可在 Microsoft Edge 加载项商店搜索「团务助手 - 团员信息管理」安装，后续更新由商店完成。

开发模式本地加载：

1. 解压发布包；
2. 打开 `edge://extensions`，开启开发者模式；
3. 点击「加载解压缩的扩展」，选择解压目录（根目录必须有 `manifest.json`）；
4. 安装后打开智慧团建页面即可看到面板。

## 隐私政策

- 源文件：[docs/index.html](docs/index.html)
- 商店填写地址：`https://jasper100-dev.github.io/CYLAA--Communist-Youth-League-Affairs-Assistant/docs/edge/`

## 发布包

Edge 包只需要以下文件，`manifest.json` 必须在 zip 根目录：

```
manifest.json
content.js
_locales/zh_CN/messages.json
icons/icon16.png
icons/icon32.png
icons/icon48.png
icons/icon128.png
```

本分支不包含 `update.js`、`version.json`，也没有构建脚本；版本号直接写在 `manifest.json`。

## 商店素材

`store-assets/` 内为 300×300 logo、440×280 小宣传图、1400×560 大宣传图、商店长描述文案 `store-description.txt`，以及 `screenshots/` 下 6 张 1280×800 商店截图（示例数据已打码）。

## 使用须知

1. 仅用于合法、合规的团务管理辅助工作。
2. 使用者应确保拥有所操作数据和账号的合法权限。
3. 批量操作前核对目标对象和内容。
4. 不要传播真实团员个人信息、验证码或导出文件。
5. 遵守智慧团建平台规范及个人信息保护相关法律法规。

## 许可

MIT License，见 [LICENSE](LICENSE)。
