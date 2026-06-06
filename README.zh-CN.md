# clipeek

> 所有 AI agent,角落里一眼看全。

**clipeek**(瞄一眼)是一个常驻屏幕角落、置顶悬浮的 macOS HUD,实时监控你本地的 AI CLI 会话,把每个会话显示成一颗红绿灯——不用在一堆终端标签页里翻找,一眼就知道哪个 agent 在干活、哪个在等你、哪个已经完事。

[English](README.md) · 中文

<!-- TODO: 这里放一张 HUD 的截图 / GIF -->

## 灯语

| 灯 | 含义 |
| --- | --- |
| 🟢 绿 | 完成——空闲,等你 |
| 🟢 绿闪 | 刚结束——该你了 |
| 🟡 黄 | 执行中(思考 / 调工具 / 回复) |
| 🟡 黄闪 | 需要你(权限弹窗 / 提问 / 计划确认) |
| 🔴 红 | 异常(API 报错) |

按紧急程度排序:红 ▸ 黄闪 ▸ 黄 ▸ 绿,同色按最近活动时间排前。

## 功能

- 一排紧凑的灯,每颗对应一个存活会话,灯下可显示名字。
- **悬停**某颗灯 → 弹出该会话的名字(可编辑)和工作目录。
- **双击**某颗灯 → 直接跳到该会话所在的终端标签页(Warp)。
- 拖动手柄移动整条;在灯区拖动可横向滚动;拖边缘可调宽。
- 横排模式(状态条)或竖排模式(列表,停在屏幕角)。
- 常驻菜单栏托盘——无 Dock 图标、无窗口边框。

## 环境要求

- macOS
- [Node.js](https://nodejs.org/)(从源码运行)
- [Claude Code](https://claude.com/claude-code)
- [Warp](https://www.warp.dev/)——仅「双击聚焦终端」功能需要(需 Warp ≥ `2026.05.27`)

## 从源码运行

```bash
git clone https://github.com/Jirry/clipeek.git
cd clipeek
npm install
npm start        # 构建 + 启动
# npm run dev    # 开发时监听重建
```

## 进度

- **Claude Code**——已支持。
- **Codex**——计划中。

## 许可

[MIT](LICENSE) © Jirry
