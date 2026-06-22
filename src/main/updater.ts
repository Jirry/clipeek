// 自动更新:定时查 GitHub Releases → 发现新版后台下载对应架构的 zip → 就绪后由用户一键「重启更新」。
// app 未签名,用不了 electron-updater(Squirrel.Mac 强制签名),故走「下载 zip + 退出后脚本替换 .app + 重启」的自实现路径。
// 仅在打包后的 macOS 生效;dev / 其它平台只把 supported 置 false,不做任何下载或替换。
import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { UpdateStatus } from '../shared/types';
import { cmpVer, shq } from './updater-util';

const REPO = 'Jirry/clipeek';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 每 6 小时查一次
const FIRST_DELAY = 8000; // 启动 8s 后首检(避开启动繁忙)

function supported(): boolean {
  return process.platform === 'darwin' && app.isPackaged;
}

let status: UpdateStatus = { phase: 'idle', current: app.getVersion(), supported: false };
let readyZip: string | null = null; // 已下载、待安装的 zip 路径
let timer: ReturnType<typeof setInterval> | null = null;
let listener: (s: UpdateStatus) => void = () => {};

/** 订阅状态变化(主进程用来推送设置窗 + 刷新托盘);只保留最后一个监听者。 */
export function onStatus(cb: (s: UpdateStatus) => void): void {
  listener = cb;
}
export function getStatus(): UpdateStatus {
  return status;
}
function set(p: Partial<UpdateStatus>): void {
  status = { ...status, ...p };
  listener(status);
}

// 查最新版本 tag:走 github.com/releases/latest 的 302 重定向(下载/页面通道,不受 api.github.com 的 60次/小时/IP 限流)。
// electron-updater 等主流方案也是走 github.com 资产而非 API,这里思路一致(本 app 未签名故手动实现)。
function fetchLatestTag(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: `https://github.com/${REPO}/releases/latest`, redirect: 'manual' });
    req.setHeader('User-Agent', 'CliPeek-Updater');
    let settled = false;
    req.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
      if (settled) return;
      settled = true;
      req.abort(); // 拿到重定向目标(/releases/tag/vX.Y.Z)即可,不必真去下载那个页面
      const m = redirectUrl.match(/\/releases\/tag\/([^/?#]+)/);
      if (m) resolve(decodeURIComponent(m[1]));
      else reject(new Error(`无法从重定向解析版本: ${redirectUrl}`));
    });
    req.on('response', (res) => {
      // 意外没重定向(直出 200/4xx):读完丢弃并报错
      res.on('data', () => {});
      res.on('end', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`releases/latest 未重定向(HTTP ${res.statusCode ?? 0})`));
        }
      });
    });
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    req.end();
  });
}

/** 查一次更新:有新版且能找到本架构安装包就自动后台下载;过程中的每个阶段都通过 set 推送出去。 */
export async function check(): Promise<void> {
  if (!supported()) {
    set({ phase: 'idle', supported: false });
    return;
  }
  if (status.phase === 'checking' || status.phase === 'downloading') return; // 进行中不重入
  set({ phase: 'checking', supported: true, error: undefined });
  try {
    const tag = await fetchLatestTag(); // 如 "v0.1.8"
    const latest = tag.replace(/^v/i, '');
    if (!latest) throw new Error('未取到版本号');
    if (cmpVer(latest, status.current) <= 0) {
      set({ phase: 'uptodate', latest });
      return;
    }
    // 资产命名固定(package.json build.artifactName = ${productName}-${version}-${arch}.${ext}),直接构造下载 URL,走 github.com 下载通道(不限流)
    const name = `CliPeek-${latest}-${process.arch}.zip`;
    const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
    set({ phase: 'available', latest });
    await download(url, name, latest);
  } catch (e) {
    set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

async function download(url: string, name: string, latest: string): Promise<void> {
  if (!supported()) return; // 纵深守卫(check 已守卫;防日后新增调用点在 dev 误触发真下载)
  // 清掉上一轮残留的下载目录,避免反复 check / 多次发版在 tmp 累积(zip 本体 ~300MB)
  if (readyZip) {
    try {
      rmSync(dirname(readyZip), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    readyZip = null;
  }
  set({ phase: 'downloading', latest, percent: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'clipeek-up-'));
  const file = join(dir, name);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = net.request(url);
      req.setHeader('User-Agent', 'CliPeek-Updater');
      req.on('response', (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 400) {
          reject(new Error(`下载 HTTP ${code}`));
          return;
        }
        const size = Number(res.headers['content-length']) || 0; // 从响应头拿大小算进度(不再依赖 API 的 asset.size)
        const out = createWriteStream(file);
        let got = 0;
        let lastPct = -10;
        res.on('data', (c: Buffer) => {
          out.write(c);
          got += c.length;
          if (size > 0) {
            const p = Math.min(100, Math.round((got / size) * 100));
            // 节流推送:每涨 ≥5% 或刚到 100% 才发一次(加 p!==lastPct 守卫,否则尾部每个 chunk 都满足 p===100 → 刷爆 IPC)。
            if (p !== lastPct && (p - lastPct >= 5 || p === 100)) {
              lastPct = p;
              set({ percent: p });
            }
          }
        });
        res.on('end', () => out.end(() => resolve()));
        res.on('error', reject);
        out.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true }); // 下载失败 → 清掉本次半截 tmp,不残留
    } catch {
      /* 忽略 */
    }
    throw e;
  }
  readyZip = file;
  set({ phase: 'ready', latest, percent: 100 });
}

/** 当前 .app bundle 路径(从 execPath 推导)。dev / 非 bundle 返回 null。 */
function appBundlePath(): string | null {
  const m = process.execPath.match(/^(.*\.app)\/Contents\/MacOS\//);
  return m ? m[1] : null;
}

/** 写一个在本进程退出后才执行的脚本:等本进程消失 → 解压 → 替换 .app → 去隔离 → 重启;随后退出本进程。 */
export function installAndRestart(): boolean {
  if (!supported() || !readyZip || !existsSync(readyZip)) return false;
  const appPath = appBundlePath();
  if (!appPath) return false;
  const dir = dirname(readyZip);
  const extract = join(dir, 'extract');
  const script = join(dir, 'apply-update.sh');
  // 所有路径用 shq 包成 bash 安全字面量;先等本进程(pid)退出,避免覆盖运行中的 bundle。
  // 原子替换 + 可回滚:旧 .app 先 rename 成 .bak,新的就位成功才删 bak;失败则还原 bak —— 绝不让用户落到「没有 app」。
  const sh = [
    '#!/bin/bash',
    `exec >${shq(join(dir, 'update.log'))} 2>&1`, // 留日志便于排障(成功路径末尾会连 dir 一起删)
    'set -e',
    `APP=${shq(appPath)}`,
    `ZIP=${shq(readyZip)}`,
    `EXTRACT=${shq(extract)}`,
    `for i in $(seq 1 150); do /bin/kill -0 ${process.pid} 2>/dev/null || break; sleep 0.2; done`,
    'sleep 0.3',
    'rm -rf "$EXTRACT"',
    '/usr/bin/unzip -q "$ZIP" -d "$EXTRACT"',
    'NEW="$EXTRACT/CliPeek.app"',
    '[ -d "$NEW" ] || { echo "解压未得到 CliPeek.app"; exit 1; }',
    'BAK="$APP.clipeek-bak"',
    'rm -rf "$BAK"',
    '[ -e "$APP" ] && /bin/mv "$APP" "$BAK" || true', // 旧的挪走(同目录 rename,原子)
    'if /bin/mv "$NEW" "$APP"; then', // 新的就位
    '  rm -rf "$BAK" || true',
    '  /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
    '  /usr/bin/open "$APP"',
    'else', // 替换失败 → 还原旧版,绝不让用户没 app
    '  echo "mv 替换失败,还原旧版本"',
    '  [ -e "$BAK" ] && /bin/mv "$BAK" "$APP" || true',
    '  /usr/bin/open "$APP" 2>/dev/null || true',
    `  /usr/bin/osascript -e 'display notification "CliPeek 更新失败,已保留原版本" with title "CliPeek"' 2>/dev/null || true`,
    '  exit 1',
    'fi',
    `rm -rf ${shq(dir)}`,
    '',
  ].join('\n');
  try {
    writeFileSync(script, sh, { mode: 0o755 });
    const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    return false;
  }
  setTimeout(() => app.quit(), 250); // 给脚本一点时间起来,再退出让出 bundle
  return true;
}

/** 启动定时检查(仅打包版 macOS)。 */
export function start(): void {
  if (!supported()) {
    set({ phase: 'idle', supported: false });
    return;
  }
  set({ supported: true });
  setTimeout(() => void check(), FIRST_DELAY);
  timer = setInterval(() => void check(), CHECK_INTERVAL);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
