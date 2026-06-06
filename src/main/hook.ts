import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 自动安装 Claude Code 的 Notification hook —— 让 clipeek 能探到「会话正在等你回应」
// (AskUserQuestion / 权限弹窗 等阻塞态在 transcript 里看不到,只能靠 hook)。
// 设计目标:打包分发后,任何人首次启动 clipeek 即自动装好,无需手配;纯旁路、可随时删。

const CLIPEEK_DIR = join(homedir(), '.clipeek');
export const NOTIFY_DIR = join(CLIPEEK_DIR, 'notify');
export const FOCUS_DIR = join(CLIPEEK_DIR, 'focus'); // <session_id> → 终端聚焦深链(Warp 的 WARP_FOCUS_URL)
export const DONE_DIR = join(CLIPEEK_DIR, 'done'); // <session_id> → 本轮答完标记(Stop hook 落点,mtime=结束时刻)
const HOOK_PATH = join(CLIPEEK_DIR, 'hook.sh');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
// 多事件挂钩:SessionStart/UserPromptSubmit 早早抓到聚焦 URL;Notification 抓「等待」通知;
// Stop 抓「本轮答完」(权威 turn-end 信号,解决尾部停在 tool_result 时误判执行中)。
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop'];

// 钩子脚本:从 stdin 读 Claude Code 的 JSON,记录三件事(sed 解析,不依赖 jq/python):
//   ① 终端聚焦深链 → ~/.clipeek/focus/<session_id>(从环境变量 WARP_FOCUS_URL,Warp 注入;非 Warp 则无)
//   ② 等待通知类型 → ~/.clipeek/notify/<session_id>(仅 Notification 事件带 notification_type;文件 mtime = 通知时刻)
//   ③ 本轮答完标记 → ~/.clipeek/done/<session_id>(Stop 事件写,mtime=结束时刻;UserPromptSubmit 清掉=新轮开始)
const HOOK_SCRIPT = `#!/bin/sh
# clipeek 钩子(由 clipeek 自动安装,可随时删除)。
payload=$(cat)
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
[ -z "$sid" ] && exit 0
mkdir -p "$HOME/.clipeek/notify" "$HOME/.clipeek/focus" "$HOME/.clipeek/done"
# 终端聚焦深链(只在终端注入了 WARP_FOCUS_URL 时才有 → 双击灯跳回该 tab)
[ -n "$WARP_FOCUS_URL" ] && printf '%s' "$WARP_FOCUS_URL" > "$HOME/.clipeek/focus/$sid"
ntype=$(printf '%s' "$payload" | sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
[ -n "$ntype" ] && printf '%s' "$ntype" > "$HOME/.clipeek/notify/$sid"
# 本轮答完 / 新轮开始:Stop 写 done 标记(mtime=结束时刻),UserPromptSubmit 清掉(新轮开始)
event=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
case "$event" in
  Stop) printf 'done' > "$HOME/.clipeek/done/$sid" ;;
  UserPromptSubmit) rm -f "$HOME/.clipeek/done/$sid" ;;
esac
exit 0
`;

function ensureSettingsHook(): void {
  const command = `/bin/sh ${HOOK_PATH}`;
  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    settings = {};
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {}; // 数组也得重置(否则 .hooks 写不进 JSON)
  settings.hooks = settings.hooks || {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // 已装则跳过(按 command 含 .clipeek/hook.sh 识别,不动用户其它 hooks)
    const installed = arr.some(
      (e: any) =>
        Array.isArray(e?.hooks) &&
        e.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('.clipeek/hook.sh')),
    );
    if (installed) continue;
    arr.push({ hooks: [{ type: 'command', command }] }); // 无 matcher = 接该事件全部
    settings.hooks[event] = arr;
    changed = true;
  }
  if (!changed) return;
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  // 原子写:这是用户的 Claude Code 配置,绝不能写一半崩溃就截断写坏。先写 .tmp 再 rename。
  const tmp = `${SETTINGS_PATH}.clipeek.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, SETTINGS_PATH);
  console.log('[clipeek] hooks 已写入', SETTINGS_PATH);
}

/** 清理过期文件:hook 给每个 session 各写一个,从不删,长期会堆积。 */
function reap(dir: string, maxAgeMs: number): void {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 目录不存在等 → 忽略 */
  }
}

/** 启动时调用:幂等地装好钩子脚本 + settings.json 注册。 */
export function installHook(): void {
  try {
    mkdirSync(NOTIFY_DIR, { recursive: true });
    mkdirSync(FOCUS_DIR, { recursive: true });
    mkdirSync(DONE_DIR, { recursive: true });
    reap(NOTIFY_DIR, 24 * 60 * 60 * 1000); // 通知文件 24h 过期
    reap(FOCUS_DIR, 7 * 24 * 60 * 60 * 1000); // 聚焦文件 7d 过期(可能隔几天还想点回去)
    reap(DONE_DIR, 24 * 60 * 60 * 1000); // done 标记 24h 过期
    let needWrite = true;
    try {
      needWrite = readFileSync(HOOK_PATH, 'utf8') !== HOOK_SCRIPT;
    } catch {
      /* 文件不存在 → 需要写 */
    }
    if (needWrite) writeFileSync(HOOK_PATH, HOOK_SCRIPT, 'utf8');
    chmodSync(HOOK_PATH, 0o755);
    ensureSettingsHook();
  } catch (e) {
    console.error('[clipeek] installHook failed (非致命):', e);
  }
}
