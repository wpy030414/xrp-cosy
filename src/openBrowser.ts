/**
 * openBrowser.ts — 在系统默认浏览器中打开 URL（best-effort，跨通道共用）。
 *
 * 失败不抛错：调用方应同时把 URL 打印到终端，供用户手动打开。
 */

import { spawn } from 'node:child_process';

export function openInBrowser(url: string): boolean {
  try {
    let child;
    if (process.platform === 'win32') {
      // cmd 的 start 中 & 是命令分隔符，URL 必须显式加引号且禁用 Node 的自动转义，
      // 否则 URL 会在第一个 & 处被截断（实测：query 只剩 challenge= 段）
      child = spawn('cmd.exe', ['/c', 'start', '', `"${url}"`], {
        detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}
