// 挑选「真实局域网」地址：排除 VPN / 虚拟网卡 / WSL / Hyper-V / TAP / 蓝牙 等。
//
// Windows 上 os.networkInterfaces() 只有网卡名，看不到描述，所以优先用一次
// PowerShell 查询拿网卡描述与掩码，缓存到磁盘；失败时退回名称与掩码启发式。
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CACHE_TTL_MS = 10 * 60 * 1000;
const VIRTUAL_PATTERN = /virtual|hyper-?v|vmware|virtualbox|tap|tun\b|vpn|pangp|wireguard|tailscale|zerotier|radmin|bluetooth|loopback|wsl|docker|vethernet/i;

/** 明显不是给手机用的地址：回环、链路本地、/31 与 /32 点对点。 */
function unusable(address, prefix) {
  if (address === '127.0.0.1' || address.startsWith('127.')) return true;
  if (address.startsWith('169.254.')) return true;
  if (prefix !== undefined && (prefix >= 31 || prefix < 8)) return true;
  return false;
}

function fromOs() {
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const prefix = (String(entry.netmask ?? '').split('.').reduce((bits, part) => bits + ((Number(part) || 0).toString(2).match(/1/g) ?? []).length, 0));
      result.push({ name, description: name, address: entry.address, prefix });
    }
  }
  return result;
}

function queryWindows() {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {",
    '  $adapter = $_',
    '  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {',
    '    [pscustomobject]@{ Name = $adapter.Name; Desc = $adapter.InterfaceDescription; IP = $_.IPAddress; Prefix = $_.PrefixLength }',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]');
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            rows
              .filter((row) => typeof row?.IP === 'string')
              .map((row) => ({
                name: String(row.Name ?? ''),
                description: String(row.Desc ?? ''),
                address: row.IP,
                prefix: Number(row.Prefix ?? 0),
              })),
          );
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

/**
 * @param {{ file?: string, log?: (message: string) => void, force?: boolean }} options
 * @returns {Promise<Array<{address: string, prefix: number, name: string}>>}
 */
export async function listAddresses(options = {}) {
  const file = options.file;
  const now = Date.now();

  let cached;
  if (file) {
    try {
      cached = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
  }
  if (!options.force && cached && Array.isArray(cached.rows) && now - Number(cached.at ?? 0) < CACHE_TTL_MS) {
    return cached.rows;
  }

  let rows = process.platform === 'win32' ? await queryWindows() : undefined;
  rows ??= fromOs();

  const usable = rows.filter(
    (row) => !unusable(row.address, row.prefix) && !VIRTUAL_PATTERN.test(`${row.name} ${row.description}`),
  );

  // 全被过滤掉时退回「只按地址过滤」，避免一台机器都看不到。
  const chosen = usable.length > 0 ? usable : rows.filter((row) => !unusable(row.address, row.prefix));
  if (usable.length === 0 && rows.length > 0) {
    options.log?.('没有识别到真实局域网网卡，退回全部可用地址');
  }

  const seen = new Set();
  const result = [];
  for (const row of chosen) {
    if (seen.has(row.address)) continue;
    seen.add(row.address);
    result.push({ address: row.address, prefix: row.prefix, name: row.name });
  }

  if (file && result.length > 0) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ at: now, rows: result }, null, 2));
    } catch {}
  }
  return result;
}
