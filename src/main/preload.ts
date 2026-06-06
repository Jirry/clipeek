import { contextBridge, ipcRenderer } from 'electron';
import type { Config, Session } from '../shared/types';

// 横排窗(role=bar)和竖排窗(role=list)共用。窗口操作由主进程按事件来源窗口处理。
// 注意:preload 沙箱,不能 import node 内置模块。
const api = {
  onSessions(cb: (s: Session[]) => void): () => void {
    const h = (_e: unknown, s: Session[]) => cb(s);
    ipcRenderer.on('sessions', h);
    return () => ipcRenderer.removeListener('sessions', h);
  },
  onConfig(cb: (c: Config) => void): () => void {
    const h = (_e: unknown, c: Config) => cb(c);
    ipcRenderer.on('config', h);
    return () => ipcRenderer.removeListener('config', h);
  },
  onDock(cb: (d: { bottom: boolean; right: boolean; dockH: number; home: string }) => void): () => void {
    const h = (_e: unknown, d: { bottom: boolean; right: boolean; dockH: number; home: string }) => cb(d);
    ipcRenderer.on('dock', h);
    return () => ipcRenderer.removeListener('dock', h);
  },
  getConfig(): Promise<Config> {
    return ipcRenderer.invoke('hud:getConfig');
  },
  openMenu(): void {
    ipcRenderer.send('hud:contextmenu');
  },
  rename(id: string, name: string): void {
    ipcRenderer.send('hud:rename', id, name);
  },
  winResize(width: number, height: number): void {
    ipcRenderer.send('win:resize', width, height);
  },
  setMinWidth(width: number): void {
    ipcRenderer.send('win:minWidth', width);
  },
  setMinHeight(height: number): void {
    ipcRenderer.send('win:minHeight', height);
  },
  dragStart(): void {
    ipcRenderer.send('win:dragStart');
  },
  dragEnd(): void {
    ipcRenderer.send('win:dragEnd');
  },
  resizeStart(edge: string): void {
    ipcRenderer.send('win:resizeStart', edge);
  },
  resizeEnd(): void {
    ipcRenderer.send('win:resizeEnd');
  },
  onResizing(cb: (w: number, h: number) => void): () => void {
    const handler = (_e: unknown, w: number, h: number) => cb(w, h);
    ipcRenderer.on('resizing', handler);
    return () => ipcRenderer.removeListener('resizing', handler);
  },
  openSession(id: string): void {
    ipcRenderer.send('session:open', id);
  },
  tipShow(id: string): void {
    ipcRenderer.send('tip:show', id);
  },
  tipLeave(): void {
    ipcRenderer.send('tip:leave');
  },
  tipEnter(): void {
    ipcRenderer.send('tip:enter');
  },
  tipEditStart(): void {
    ipcRenderer.send('tip:editStart');
  },
  tipEditEnd(): void {
    ipcRenderer.send('tip:editEnd');
  },
  onTipSession(cb: (s: Session, width: number, animate: boolean, force: boolean) => void): () => void {
    const h = (_e: unknown, s: Session, width: number, animate: boolean, force: boolean) => cb(s, width, animate, force);
    ipcRenderer.on('tip:session', h);
    return () => ipcRenderer.removeListener('tip:session', h);
  },
  focusForEdit(): void {
    ipcRenderer.send('win:focusForEdit');
  },
  onListWidth(cb: (w: number) => void): () => void {
    const h = (_e: unknown, w: number) => cb(w);
    ipcRenderer.on('list:width', h);
    return () => ipcRenderer.removeListener('list:width', h);
  },
};

contextBridge.exposeInMainWorld('clipeek', api);

export type ClipeekApi = typeof api;
