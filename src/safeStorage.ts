/**
 * safeStorage.ts — Electron safeStorage 文件加解密（qwenwork / qoder 共用）。
 *
 * 文件格式（Electron）：
 * - macOS：Keychain 取密码 → PBKDF2(1003, saltysalt) → AES-128-CBC(IV=0x20)
 * - Windows：v10 + AES-256-GCM（12B nonce + 密文 + 16B tag）
 *   - 密钥：Local State 的 os_crypt.encrypted_key（"DPAPI\0" 前缀 + blob）
 *   - DPAPI 解包（entropy=NULL, CurrentUser）→ 32B AES key
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SafeStorageOptions {
  /** Electron userData 目录（Windows 读 Local State） */
  userDataDir: string;
  /** Keychain service 名（仅 macOS） */
  keychainService: string;
  /** Keychain account 名（仅 macOS） */
  keychainAccount: string;
}

/** safeStorage 解密 key（Keychain password，含尾换行要去掉）— 仅 macOS */
function getKeychainPassword(opts: SafeStorageOptions): string {
  const raw = execFileSync('security', [
    'find-generic-password', '-s', opts.keychainService,
    '-a', opts.keychainAccount, '-w',
  ], { encoding: 'utf8' });
  // security -w 输出末尾带换行；password 本身可能是 base64 字符串（原样使用，不做二次解码）
  return raw.replace(/\n$/, '');
}

/** Windows DPAPI 解密密文（CurrentUser scope；entropy=NULL — 实测 "peanuts" 解不开） */
function dpapiUnprotect(data: Buffer): Buffer {
  const script = `Add-Type -AssemblyName System.Security
$data = [Convert]::FromBase64String('${data.toString('base64')}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::WriteLine([Convert]::ToBase64String($plain))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw new Error(`DPAPI 解密失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`DPAPI 解密失败：powershell 退出码 ${r.status} ${r.stderr?.trim()}`);
  const b64 = r.stdout?.trim();
  if (!b64) throw new Error('DPAPI 解密失败：powershell 无输出');
  return Buffer.from(b64, 'base64');
}

/** Windows：从 Local State 取 DPAPI 保护的 AES key（os_crypt.encrypted_key，DPAPI\0 前缀 + blob） */
function getWindowsAesKey(opts: SafeStorageOptions): Buffer {
  const lsPath = path.join(opts.userDataDir, 'Local State');
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  const ek = ls?.os_crypt?.encrypted_key;
  if (typeof ek !== 'string') {
    throw new Error(`Local State 缺少 os_crypt.encrypted_key（${lsPath}）`);
  }
  const raw = Buffer.from(ek, 'base64');
  if (raw.slice(0, 5).toString() !== 'DPAPI') {
    throw new Error('os_crypt.encrypted_key 不是 DPAPI 格式（App-Bound 加密的 Local State 需要取走 app-bound key）');
  }
  return dpapiUnprotect(raw.slice(5)); // 32B AES key
}

/** 解密 Electron safeStorage 文件 → JSON */
export function decryptSafeStorageJson(filePath: string, opts: SafeStorageOptions): any {
  let enc = fs.readFileSync(filePath);
  // 容错：某些编辑器/工具会在文件头加 UTF-8 BOM，剥掉再识别 v10
  if (enc.length >= 3 && enc[0] === 0xef && enc[1] === 0xbb && enc[2] === 0xbf) enc = enc.slice(3);
  if (enc.slice(0, 3).toString() !== 'v10') {
    throw new Error(`auth 文件头不是 v10（${filePath}），可能不是 safeStorage 格式`);
  }
  let dec: Buffer;
  if (process.platform === 'win32') {
    // v10 + AES-256-GCM：12B nonce + 密文 + 16B tag（Electron ≥ 37 的 os_crypt 格式）
    const nonce = enc.slice(3, 15);
    const data = enc.slice(15);
    if (data.length < 16) throw new Error('auth 密文过短（非 AES-GCM 格式？）');
    const key = getWindowsAesKey(opts);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(data.slice(-16));
    dec = Buffer.concat([d.update(data.slice(0, -16)), d.final()]);
  } else {
    const pw = getKeychainPassword(opts);
    const aesKey = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20); // 16 个空格
    const d = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
    dec = Buffer.concat([d.update(enc.slice(3)), d.final()]);
  }
  return JSON.parse(dec.toString('utf8'));
}

/** 加密 JSON → Electron safeStorage 文件（复用 Local State / Keychain 的同一密钥） */
export function encryptSafeStorageJson(filePath: string, json: any, opts: SafeStorageOptions): void {
  const plaintext = Buffer.from(JSON.stringify(json), 'utf8');
  if (process.platform === 'win32') {
    const key = getWindowsAesKey(opts);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // v10 + 12B nonce + ciphertext + 16B tag
    const out = Buffer.concat([Buffer.from('v10'), nonce, enc, tag]);
    fs.writeFileSync(filePath, out, { mode: 0o600 });
  } else {
    const pw = getKeychainPassword(opts);
    const aesKey = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const out = Buffer.concat([Buffer.from('v10'), enc]);
    fs.writeFileSync(filePath, out, { mode: 0o600 });
  }
}
