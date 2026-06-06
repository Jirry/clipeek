// 生成占位 app 图标 → build/icon.png(1024×1024,无依赖,纯 Node)。
// 深色圆角方块 + 红/黄/绿三盏灯(带柔光),贴合 clipeek「一排状态灯」的样子。
// 这只是占位图;有正式图标时,直接用 1024×1024 PNG 覆盖 build/icon.png 即可(无需再跑本脚本)。
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 1024;
const buf = Buffer.alloc(S * S * 4, 0); // RGBA,默认全透明

function over(i, r, g, b, a) {
  // 直 alpha 的 src-over 合成
  if (a <= 0) return;
  const da = buf[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  const dr = buf[i] / 255,
    dg = buf[i + 1] / 255,
    db = buf[i + 2] / 255;
  buf[i] = Math.round(((r * a + dr * da * (1 - a)) / oa) * 255);
  buf[i + 1] = Math.round(((g * a + dg * da * (1 - a)) / oa) * 255);
  buf[i + 2] = Math.round(((b * a + db * da * (1 - a)) / oa) * 255);
  buf[i + 3] = Math.round(oa * 255);
}

// 圆角矩形 SDF(macOS 风格的小边距 + 大圆角)
const margin = 84;
const R = 205;
const cx0 = S / 2,
  cy0 = S / 2;
const halfW = (S - 2 * margin) / 2,
  halfH = (S - 2 * margin) / 2;
function rrCoverage(x, y) {
  const qx = Math.abs(x + 0.5 - cx0) - (halfW - R);
  const qy = Math.abs(y + 0.5 - cy0) - (halfH - R);
  const ax = Math.max(qx, 0),
    ay = Math.max(qy, 0);
  const sd = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R; // <0 在内
  return Math.min(1, Math.max(0, 0.5 - sd)); // 1px 抗锯齿
}

const BG = [0.11, 0.11, 0.12];
const dots = [
  { dx: -232, col: [1.0, 0.27, 0.23] }, // 红
  { dx: 0, col: [1.0, 0.84, 0.04] }, // 黄
  { dx: 232, col: [0.19, 0.82, 0.35] }, // 绿
];
const rd = 96; // 灯半径
const sigma = rd * 0.95; // 柔光范围
const glowA = 0.5;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cov = rrCoverage(x, y);
    if (cov <= 0) continue;
    const i = (y * S + x) * 4;
    over(i, BG[0], BG[1], BG[2], cov); // 深色底
    for (const d of dots) {
      const ddx = x + 0.5 - (cx0 + d.dx);
      const ddy = y + 0.5 - cy0;
      const dd = Math.hypot(ddx, ddy);
      const ga = glowA * Math.exp(-(dd * dd) / (2 * sigma * sigma)) * cov; // 柔光
      over(i, d.col[0], d.col[1], d.col[2], ga);
      const ca = Math.min(1, Math.max(0, 0.5 - (dd - rd))) * cov; // 实心灯
      over(i, d.col[0], d.col[1], d.col[2], ca);
    }
  }
}

// ---- 极简 PNG 编码(RGBA,filter 0) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log('[clipeek] 占位图标已生成 → build/icon.png', png.length, 'bytes');
