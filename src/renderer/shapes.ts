// HUD 灯的图形库(纯几何,居中于 24×24,fill=currentColor 继承状态色)。
// 渲染层(hud.ts)和设置窗(settings.ts 画选择色块)共用同一份,保证一致。
import { ToolShape, DEFAULT_TOOL_SHAPE } from '../shared/types';

const INNER: Record<ToolShape, string> = {
  circle: '<circle cx="12" cy="12" r="10.5"/>',
  square: '<rect x="2.5" y="2.5" width="19" height="19" rx="3.5"/>',
  triangle: '<path d="M12 0L22.39 18L1.61 18Z"/>',
  diamond: '<path d="M12 0.2L23.8 12L12 23.8L0.2 12Z"/>',
  pentagon: '<path d="M12 0.5L22.94 8.45L18.76 21.3L5.24 21.3L1.06 8.45Z"/>',
  hexagon: '<path d="M12 1L21.53 6.5L21.53 17.5L12 23L2.47 17.5L2.47 6.5Z"/>',
  star: '<path d="M12 0.5L14.82 8.12L22.94 8.45L16.57 13.48L18.76 21.3L12 16.8L5.24 21.3L7.43 13.48L1.06 8.45L9.18 8.12Z"/>',
  spark:
    '<path d="M12 1L13.09 7.94L17.5 2.47L14.97 9.03L21.53 6.5L16.06 10.91L23 12L16.06 13.09L21.53 17.5L14.97 14.97L17.5 21.53L13.09 16.06L12 23L10.91 16.06L6.5 21.53L9.03 14.97L2.47 17.5L7.94 13.09L1 12L7.94 10.91L2.47 6.5L9.03 9.03L6.5 2.47L10.91 7.94Z"/>',
};

/** 取某图形的完整 svg 标记(innerHTML 用);非法值兜底到默认图形。 */
export function shapeSvg(shape: ToolShape | undefined): string {
  const inner = INNER[shape as ToolShape] ?? INNER[DEFAULT_TOOL_SHAPE];
  return `<svg viewBox="0 0 24 24">${inner}</svg>`;
}
