// 局域网扫描：在服务器端探测同网段里其它装了本插件的 DSH 机器。
// 只扫本机网卡所在的子网、只探固定端口，并缓存结果，避免被当成任意端口扫描器。
import net from 'node:net';
import os from 'node:os';

const CACHE_MS = 8000;
const CONNECT_TIMEOUT_MS = 320;
const IDENTITY_TIMEOUT_MS = 1200;
const CONCURRENCY = 64;

let cache = { at: 0, key: '', value: null };

function prefixOf(netmask) {
  const parts = String(netmask).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return 0;
  let bits = 0;
  for (const part of parts) bits += (part.toString(2).match(/1/g) ?? []).length;
  return bits;
}

function ipToInt(address) {
  return address.split('.').reduce((total, part) => (total << 8) + Number(part), 0) >>> 0;
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

/** 本机参与扫描的 IPv4 接口（跳过 /31、/32 这类没有可用网段的接口）。 */
export function localInterfaces() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const prefix = prefixOf(entry.netmask);
      if (prefix < 22 || prefix > 30) continue;
      result.push({ address: entry.address, prefix, netmask: entry.netmask });
    }
  }
  return result;
}

/** 一个子网里可供探测的主机地址（最多 1022 个，跳过网络地址与广播地址）。 */
export function hostsOf({ address, prefix }) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(address) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let value = network + 1; value < broadcast && hosts.length < 1022; value += 1) hosts.push(intToIp(value));
  return hosts;
}

function probe(address, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, address);
  });
}

async function identity(address, port) {
  try {
    const response = await fetch(`http://${address}:${port}/__phone/identity`, {
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    return typeof data?.name === 'string' && data.app === 'dsh-phone-bridge' ? data : undefined;
  } catch {
    return undefined;
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 扫描同网段里其它 DSH 机器。
 * @param {object} options
 * @param {number} options.port 本插件监听的端口
 * @param {boolean} [options.force] 忽略缓存
 * @returns {Promise<{machines: Array<{address: string, port: number, name: string, self: boolean}>, scanned: number, interfaces: string[]}>}
 */
export async function scanLan({ port, force = false, interfaces: provided } = {}) {
  const own = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4') own.add(entry.address);
  }
  const interfaces = Array.isArray(provided) && provided.length > 0
    ? provided.map((row) => ({ address: row.address, prefix: Number(row.prefix ?? 24) }))
    : localInterfaces();
  const key = `${port}:${interfaces.map((item) => item.address).sort().join(',')}`;
  const now = Date.now();
  const usable = cache.value && cache.key === key;
  // 手动刷新也限流：2.5 秒内重复请求直接复用上一次结果。
  const throttledRefresh = force && usable && now - cache.at < 2500;
  if (usable && (throttledRefresh || now - cache.at < CACHE_MS)) return cache.value;

  const seen = new Set();
  const candidates = [];
  for (const item of interfaces) {
    for (const host of hostsOf(item)) {
      if (seen.has(host)) continue;
      seen.add(host);
      candidates.push(host);
    }
  }

  const open = await pool(candidates, CONCURRENCY, async (address) => ((await probe(address, port)) ? address : undefined));
  const reachable = open.filter(Boolean);

  const machines = (
    await pool(reachable, 16, async (address) => {
      const info = await identity(address, port);
      return { address, port, name: info?.name ?? address, self: own.has(address) };
    })
  ).filter(Boolean);

  machines.sort((left, right) => Number(right.self) - Number(left.self) || left.name.localeCompare(right.name));
  const value = { machines, scanned: candidates.length, interfaces: interfaces.map((item) => item.address) };
  cache = { at: Date.now(), key, value };
  return value;
}
