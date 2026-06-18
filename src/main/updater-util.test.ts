import { describe, it, expect } from 'vitest';
import { cmpVer, pickAsset, shq } from './updater-util';

describe('cmpVer', () => {
  it('比较大小', () => {
    expect(cmpVer('0.1.5', '0.1.4')).toBe(1);
    expect(cmpVer('0.1.4', '0.1.5')).toBe(-1);
    expect(cmpVer('0.2.0', '0.1.9')).toBe(1);
    expect(cmpVer('1.0.0', '0.9.9')).toBe(1);
  });
  it('相等', () => {
    expect(cmpVer('0.1.4', '0.1.4')).toBe(0);
    expect(cmpVer('1.2.3', '1.2.3')).toBe(0);
  });
  it('忽略 v 前缀', () => {
    expect(cmpVer('v0.1.5', '0.1.4')).toBe(1);
    expect(cmpVer('v0.1.4', 'v0.1.4')).toBe(0);
  });
  it('缺省段按 0', () => {
    expect(cmpVer('1', '1.0.0')).toBe(0);
    expect(cmpVer('1.2', '1.2.0')).toBe(0);
    expect(cmpVer('1.2.1', '1.2')).toBe(1);
  });
  it('非法段不炸,按 0 处理', () => {
    expect(cmpVer('', '0.0.0')).toBe(0);
    expect(cmpVer('0.1.x', '0.1.0')).toBe(0);
  });
});

describe('pickAsset', () => {
  const assets = [
    { name: 'CliPeek-0.1.5-arm64.dmg' },
    { name: 'CliPeek-0.1.5-arm64.zip' },
    { name: 'CliPeek-0.1.5-x64.dmg' },
    { name: 'CliPeek-0.1.5-x64.zip' },
  ];
  it('按架构选 zip', () => {
    expect(pickAsset(assets, '0.1.5', 'arm64')?.name).toBe('CliPeek-0.1.5-arm64.zip');
    expect(pickAsset(assets, '0.1.5', 'x64')?.name).toBe('CliPeek-0.1.5-x64.zip');
  });
  it('架构/版本不匹配返回 null', () => {
    expect(pickAsset(assets, '0.1.5', 'ia32')).toBeNull();
    expect(pickAsset(assets, '0.1.6', 'arm64')).toBeNull();
    expect(pickAsset([], '0.1.5', 'arm64')).toBeNull();
  });
});

describe('shq', () => {
  it('包裹普通路径', () => {
    expect(shq('/Applications/CliPeek.app')).toBe(`'/Applications/CliPeek.app'`);
  });
  it('容忍空格', () => {
    expect(shq('/Users/a b/CliPeek.app')).toBe(`'/Users/a b/CliPeek.app'`);
  });
  it('转义内部单引号', () => {
    expect(shq("/x/o'brien")).toBe(`'/x/o'\\''brien'`);
  });
});
