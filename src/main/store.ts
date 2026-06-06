import { app } from 'electron';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Config, DEFAULT_CONFIG, SCALE_MIN, SCALE_MAX } from '../shared/types';

// 极简 JSON 持久化:窗口位置、缩放、名字显隐、自定义会话名。
// 写在 Electron userData 目录,跨启动保留(满足「记住位置」「重命名」)。

const configPath = () => join(app.getPath('userData'), 'config.json');

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const posOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

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
  return {
    x: finiteOrNull(o.x), // 位置可为负(副屏在主屏左侧)
    y: finiteOrNull(o.y),
    scale,
    width: posOrNull(o.width),
    height: posOrNull(o.height),
    listWidth: posOrNull(o.listWidth),
    listHeight: posOrNull(o.listHeight),
    layout: o.layout === 'list' ? 'list' : 'bar',
    showNames: typeof o.showNames === 'boolean' ? o.showNames : DEFAULT_CONFIG.showNames,
    names,
  };
}

export function loadConfig(): Config {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(), 'utf-8')));
  } catch {
    return { ...DEFAULT_CONFIG };
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
