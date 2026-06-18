import { app } from 'electron';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Config, DEFAULT_CONFIG, DEFAULT_SHORTCUTS, SCALE_MIN, SCALE_MAX, SavedPosition, LightColor, LightStateKey, BLINK_MIN_MS, BLINK_MAX_MS } from '../shared/types';

// 极简 JSON 持久化:窗口位置、缩放、名字显隐、自定义会话名。
// 写在 Electron userData 目录,跨启动保留(满足「记住位置」「重命名」)。

const configPath = () => join(app.getPath('userData'), 'config.json');

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const posOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** 校验自定义位置快照数组(防手改/损坏);最多保留 3 个。 */
function sanitizePositions(raw: unknown): SavedPosition[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPosition[] = [];
  for (const item of raw) {
    if (out.length >= 3) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    out.push({
      name: typeof o.name === 'string' && o.name.trim() ? o.name : '未命名',
      layout: o.layout === 'list' ? 'list' : 'bar',
      scale: typeof o.scale === 'number' && Number.isFinite(o.scale) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, o.scale)) : 1,
      showNames: typeof o.showNames === 'boolean' ? o.showNames : true,
      x: finiteOrNull(o.x),
      y: finiteOrNull(o.y),
      width: posOrNull(o.width),
      height: posOrNull(o.height),
      listWidth: posOrNull(o.listWidth),
      listHeight: posOrNull(o.listHeight),
      dockRight: typeof o.dockRight === 'boolean' ? o.dockRight : true,
      dockBottom: typeof o.dockBottom === 'boolean' ? o.dockBottom : true,
      topCenter: typeof o.topCenter === 'boolean' ? o.topCenter : false,
    });
  }
  return out;
}

const LIGHT_KEYS: LightStateKey[] = ['error', 'needsInput', 'working', 'attention', 'done'];
const LIGHT_COLORS = new Set<LightColor>(['red', 'amber', 'green', 'off']);
/** 校验状态→灯效映射(防手改/损坏);缺字段/越界回退到 DEFAULT_CONFIG.lights;周期夹到 [BLINK_MIN,MAX]。 */
export function sanitizeLights(raw: unknown): Config['lights'] {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as Config['lights'];
  for (const k of LIGHT_KEYS) {
    const d = DEFAULT_CONFIG.lights[k];
    const item = o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? (o[k] as Record<string, unknown>) : {};
    out[k] = {
      color: typeof item.color === 'string' && LIGHT_COLORS.has(item.color as LightColor) ? (item.color as LightColor) : d.color,
      blink: typeof item.blink === 'boolean' ? item.blink : d.blink,
      blinkMs:
        typeof item.blinkMs === 'number' && Number.isFinite(item.blinkMs)
          ? Math.min(BLINK_MAX_MS, Math.max(BLINK_MIN_MS, item.blinkMs))
          : d.blinkMs,
    };
  }
  return out;
}

/** 把任意 JSON 强制成合法 Config —— 防止手改/损坏的字段(如 names 非对象、scale 越界)让 poll 每秒崩。 */
function sanitize(raw: unknown): Config {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const names: Record<string, string> = {};
  if (o.names && typeof o.names === 'object' && !Array.isArray(o.names)) {
    for (const [k, v] of Object.entries(o.names as Record<string, unknown>)) {
      if (typeof v === 'string') names[k] = v;
    }
  }
  const scale =
    typeof o.scale === 'number' && Number.isFinite(o.scale)
      ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, o.scale))
      : DEFAULT_CONFIG.scale;
  const sc = (o.shortcuts && typeof o.shortcuts === 'object' && !Array.isArray(o.shortcuts) ? o.shortcuts : {}) as Record<string, unknown>;
  const shortcuts = {
    jump: typeof sc.jump === 'string' && sc.jump ? sc.jump : DEFAULT_SHORTCUTS.jump,
    jumpAll: typeof sc.jumpAll === 'string' && sc.jumpAll ? sc.jumpAll : DEFAULT_SHORTCUTS.jumpAll,
  };
  return {
    x: finiteOrNull(o.x), // 位置可为负(副屏在主屏左侧)
    y: finiteOrNull(o.y),
    dockRight: typeof o.dockRight === 'boolean' ? o.dockRight : DEFAULT_CONFIG.dockRight,
    dockBottom: typeof o.dockBottom === 'boolean' ? o.dockBottom : DEFAULT_CONFIG.dockBottom,
    scale,
    width: posOrNull(o.width),
    height: posOrNull(o.height),
    listWidth: posOrNull(o.listWidth),
    listHeight: posOrNull(o.listHeight),
    layout: o.layout === 'list' ? 'list' : 'bar',
    showNames: typeof o.showNames === 'boolean' ? o.showNames : DEFAULT_CONFIG.showNames,
    names,
    shortcuts,
    launchAtLogin: typeof o.launchAtLogin === 'boolean' ? o.launchAtLogin : DEFAULT_CONFIG.launchAtLogin,
    topCenter: typeof o.topCenter === 'boolean' ? o.topCenter : DEFAULT_CONFIG.topCenter,
    positions: sanitizePositions(o.positions),
    lights: sanitizeLights(o.lights),
  };
}

export function loadConfig(): Config {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(), 'utf-8')));
  } catch {
    return sanitize(undefined); // 走 sanitize 得各字段独立默认值(避免共享 DEFAULT_CONFIG 的嵌套引用被运行时就地写污染)
  }
}

export function saveConfig(cfg: Config): void {
  const p = configPath();
  const tmp = `${p}.tmp`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    // 原子写:先写临时文件再 rename,避免崩溃/强退时截断 config.json 丢掉全部设置与改名
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    renameSync(tmp, p);
  } catch (err) {
    console.error('[clipeek] saveConfig failed:', err);
    try {
      unlinkSync(tmp); // 写一半失败 → 清掉残留 .tmp,避免堆积
    } catch {
      /* tmp 本就不存在 → 忽略 */
    }
  }
}
