// 托盘图标(纯 Node 手绘,无依赖):两种样式由 config.trayStyle 切换。
//  · 'icon'   单色「一排三盏灯」剪影模板图,随菜单栏明暗自动反色(看不出颜色,状态看 HUD)。
//  · 'lights' 按「第一个灯」状态着色的彩色单点(红/黄/绿/灰),把颜色语义直接搬到菜单栏。
import { nativeImage, type NativeImage } from 'electron';
import type { LightColor } from '../shared/types';
import zlib from 'node:zlib';

type Rgba = { w: number; h: number; buf: Buffer };

// —— 单色三点剪影(模板图:纯黑 + alpha 决定形状)。scale=1 出 @1x(22×14),scale=2 出 @2x。——
function dotsRgba(scale: number): Rgba {
  const w = 22 * scale;
  const h = 14 * scale;
  const r = 2.5 * scale; // 灯半径(直径 5pt)
  const cy = h / 2;
  const cxs = [4 * scale, 11 * scale, 18 * scale]; // 三盏灯水平圆心(间距 7pt > 直径,留间隙;整体水平居中)
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (const cx of cxs) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        a = Math.max(a, Math.min(1, Math.max(0, r + 0.5 - d))); // 圆 + 1px 抗锯齿,三点取并集
      }
      if (a <= 0) continue;
      buf[(y * w + x) * 4 + 3] = Math.round(a * 255); // 纯黑(RGB=0),只填 alpha
    }
  }
  return { w, h, buf };
}

// —— 彩色单点(实心圆 + 一圈深描边,让黄色在亮色菜单栏也有轮廓;off=暗灰小点占位)。——
const DOT_RGB: Record<Exclude<LightColor, 'off'>, [number, number, number]> = {
  red: [0.96, 0.26, 0.21],
  amber: [0.98, 0.74, 0.04],
  green: [0.2, 0.78, 0.35],
};
// 直 alpha 的 src-over 合成(同 tools/make-placeholder-icon.mjs 的 over)。
function over(buf: Buffer, i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const da = buf[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  const dr = buf[i] / 255;
  const dg = buf[i + 1] / 255;
  const db = buf[i + 2] / 255;
  buf[i] = Math.round(((r * a + dr * da * (1 - a)) / oa) * 255);
  buf[i + 1] = Math.round(((g * a + dg * da * (1 - a)) / oa) * 255);
  buf[i + 2] = Math.round(((b * a + db * da * (1 - a)) / oa) * 255);
  buf[i + 3] = Math.round(oa * 255);
}
function lightRgba(scale: number, color: LightColor, dim = false): Rgba {
  const sz = 22 * scale;
  const c = sz / 2;
  const R = 9.5 * scale; // 灯半径(直径 19pt);画布加高到 22pt 以撑满较高的菜单栏,四周留 ~1.5pt 余量不裁
  const buf = Buffer.alloc(sz * sz * 4, 0);
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const i = (y * sz + x) * 4;
      if (color === 'off') {
        const rr = R * 0.62; // 暗点比亮灯小一圈,表示「在但灭」
        const a = Math.min(1, Math.max(0, rr + 0.5 - d)) * 0.5;
        over(buf, i, 0.5, 0.5, 0.5, a);
      } else {
        const [rd, gd, bd] = DOT_RGB[color];
        const stroke = Math.min(1, Math.max(0, R + 0.5 - d)) * 0.5; // 深描边(半径 R)
        over(buf, i, 0.13, 0.13, 0.13, stroke);
        const fill = Math.min(1, Math.max(0, R - 1 * scale + 0.5 - d)); // 填充(半径 R-1)盖住中心,剩外 1px 描边
        over(buf, i, rd, gd, bd, fill);
      }
    }
  }
  if (dim) for (let i = 3; i < buf.length; i += 4) buf[i] = Math.round(buf[i] * 0.3); // 闪烁暗帧:整体透明度降到 30%
  return { w: sz, h: sz, buf };
}

// —— 极简 PNG 编码(RGBA,filter none)—— 同 tools/make-placeholder-icon.mjs。 ——
const crc32 = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng({ w, h, buf }: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    buf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// nativeImage 构建较重(deflate × 2 representation),且图标就那么几种 → memo 缓存。
let dotsCache: NativeImage | null = null;
const lightCache = new Map<string, NativeImage>(); // key = `${color}|${dim}`

/** 单色三盏灯模板图标(含 @1x/@2x);随菜单栏明暗自动反色。 */
export function trayIconDots(): NativeImage {
  if (!dotsCache) {
    const img = nativeImage.createFromBuffer(encodePng(dotsRgba(1)));
    img.addRepresentation({ scaleFactor: 2, buffer: encodePng(dotsRgba(2)) });
    img.setTemplateImage(true); // 让 macOS 按菜单栏明暗自动反色
    dotsCache = img;
  }
  return dotsCache;
}

/** 彩色单点图标(按状态色;非模板,保留红黄绿);dim=闪烁暗帧;含 @1x/@2x。 */
export function trayIconLight(color: LightColor, dim = false): NativeImage {
  const key = `${color}|${dim ? 1 : 0}`;
  let img = lightCache.get(key);
  if (!img) {
    img = nativeImage.createFromBuffer(encodePng(lightRgba(1, color, dim)));
    img.addRepresentation({ scaleFactor: 2, buffer: encodePng(lightRgba(2, color, dim)) });
    lightCache.set(key, img); // 彩色图保持原样,不设 templateImage
  }
  return img;
}
