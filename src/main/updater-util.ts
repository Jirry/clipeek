// 自动更新的纯函数(不依赖 electron,便于单测):版本比较 + 按架构选安装包。

/** 比较 x.y.z 版本(忽略前缀 v)。a>b → 1,a<b → -1,相等 → 0。非法段按 0 处理。 */
export function cmpVer(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 从 release assets 里挑当前架构的 zip:CliPeek-<version>-<arch>.zip。挑不到返回 null。 */
export function pickAsset<T extends { name: string }>(assets: T[], version: string, arch: string): T | null {
  const want = `CliPeek-${version}-${arch}.zip`;
  return assets.find((a) => a.name === want) ?? null;
}

/** bash 单引号转义:把内部的 ' 变成 '\'',整体再用单引号包,容忍路径里的空格/特殊字符。 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
