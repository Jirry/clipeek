# clipeek

> 所有 AI agent,角落里一眼看全。

[![CI](https://github.com/Jirry/clipeek/actions/workflows/ci.yml/badge.svg)](https://github.com/Jirry/clipeek/actions/workflows/ci.yml)

**clipeek**(瞄一眼)是一个常驻屏幕角落、置顶悬浮的 macOS HUD,实时监控你本地的 AI CLI 会话,把每个会话显示成一颗红绿灯——不用在一堆终端标签页里翻找,一眼就知道哪个 agent 在干活、哪个在等你、哪个已经完事,点一下还能直接跳到它的终端。

[English](README.md) · 中文

<!-- TODO: 这里放一张 HUD 的截图 / GIF -->

## 灯语

| 灯 | 含义 |
| --- | --- |
| 🟢 绿·常亮 | 完成——空闲,等你 |
| 🟢 绿·闪烁 | 完成·该你了——刚结束,或 agent 在等你输入 |
| 🟡 黄·常亮 | 执行中——思考 / 跑命令 / 流式回复 |
| 🟡 黄·闪烁 | 需要你——权限弹窗 / 提问 / 计划审批 |
| 🔴 红 | 异常——API 报错 / 崩溃 |

按紧急程度排序(红 ▸ 黄闪 ▸ 黄 ▸ 绿闪 ▸ 绿),同色按最近活动排前。已关闭的会话会自动消失。

## 功能

- **每个存活会话一颗灯**,排成一条;灯下可显示会话名(可开关)。
- **单击**某颗灯(或列表里的一行)→ 直接跳到该会话所在的终端标签页。
- **悬停**某颗灯 → 弹出该会话的名字和工作目录;点 ✏︎ 可改名(仅本地显示名,不动你的真实会话)。
- **两种布局**,托盘菜单一键切换:
  - **横排** —— 一条横向灯带,贴着 Dock。
  - **竖排** —— 屏幕角落的竖向列表,带一行摘要、名字、路径和闲置时长。
- **可移动 / 滚动 / 缩放 / 调大小** —— 拖手柄移动;在灯上拖动可横向滚动;拖边缘调大小;菜单里缩放。位置、大小、改名都跨重启记住。
- **菜单栏托盘** —— 无 Dock 图标、无窗口边框;托盘标题显示聚合灯色 + 存活会话数。

## 环境要求

- macOS
- [Node.js](https://nodejs.org/)(从源码运行)
- [Claude Code](https://claude.com/claude-code)
- [Warp](https://www.warp.dev/)——单击跳转终端标签页需要(需 Warp ≥ `2026.05.27`)。其它终端照样能显示状态,只是暂时还跳不过去。

## 从源码运行

```bash
git clone https://github.com/Jirry/clipeek.git
cd clipeek
npm install
npm start        # 构建 + 启动
# npm run dev    # 开发时监听重建
```

## 打包发版

```bash
npm run dist     # electron-builder → release/clipeek-<版本>-arm64.dmg
```

产出的 dmg **未签名**(没有 Apple 开发者证书),且**仅 Apple 芯片(arm64)**。首次打开会被 macOS Gatekeeper 拦——右键点 app → **打开**,或终端执行 `xattr -dr com.apple.quarantine /Applications/clipeek.app`。

## 说明

首次启动时,clipeek 会装一个小巧、可随时删除的 Claude Code hook(文件在 `~/.clipeek/`,注册进 `~/.claude/settings.json`),用来探测权限弹窗 / 一轮结束、以及打开对应终端标签页。它只添加自己的那一条,绝不动你的其它 hook——删掉那几条即可卸载。

## 进度

- **Claude Code** —— 已支持。
- **Codex** —— 计划中。

## 许可

[MIT](LICENSE) © Jirry
