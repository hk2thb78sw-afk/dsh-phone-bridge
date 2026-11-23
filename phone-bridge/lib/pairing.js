// 配对状态：一次性配对码 + 长期设备 cookie。
// 只依赖 node 内置模块，状态落盘到 $DSH_HOME/phone-bridge/state.json。
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CODE_TTL_MS = 5 * 60 * 1000;
const COOKIE_NAME = 'dsh-phone';

function load(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && raw.version === 1 && typeof raw.secret === 'string' && Array.isArray(raw.devices)) return raw;
  } catch {}
  return null;
}

function save(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function sign(secret, id) {
  return createHmac('sha256', secret).update(id).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Pairing {
  constructor(file) {
    this.file = file;
    const loaded = load(file);
    this.state = loaded ?? {
      version: 1,
      secret: randomBytes(32).toString('base64url'),
      code: null,
      devices: [],
    };
    if (!loaded) save(file, this.state);
    this.failures = new Map(); // ip -> { count, until }
  }

  get cookieName() {
    return COOKIE_NAME;
  }

  persist() {
    save(this.file, this.state);
  }

  /** 当前有效的配对码；过期或不存在时生成新的 6 位数字。 */
  currentCode() {
    const now = Date.now();
    const code = this.state.code;
    if (code && code.expiresAt > now) return { value: code.value, expiresAt: code.expiresAt };
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.state.code = { value, expiresAt: now + CODE_TTL_MS };
    this.persist();
    return { value, expiresAt: this.state.code.expiresAt };
  }

  /** 立刻作废旧码并换一个新的（手机输错/想重置时用）。 */
  rotateCode() {
    this.state.code = null;
    return this.currentCode();
  }

  /** 校验配对码并签发设备 cookie；成功返回设备记录。 */
  pair(code, label) {
    const now = Date.now();
    const current = this.state.code;
    if (!current || current.expiresAt <= now) return { ok: false, reason: 'expired' };
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { ok: false, reason: 'invalid' };
    if (!safeEqual(code.trim(), current.value)) return { ok: false, reason: 'invalid' };
    if (process.env.DSH_PHONE_DEBUG) console.log('[phone-bridge] pair match', code, current.value);

    const device = {
      id: randomBytes(18).toString('base64url'),
      label: String(label ?? '').slice(0, 80) || '未命名设备',
      createdAt: now,
      lastSeenAt: now,
    };
    this.state.devices.push(device);
    this.state.code = null; // 一次性
    this.persist();
    return { ok: true, device, cookie: this.cookieFor(device) };
  }

  cookieFor(device) {
    return { name: COOKIE_NAME, value: `${device.id}.${sign(this.state.secret, device.id)}` };
  }

  /** 从请求的 Cookie 头里解析设备；无效返回 undefined。 */
  deviceFrom(headers) {
    const raw = headers?.cookie;
    if (typeof raw !== 'string') return undefined;
    for (const part of raw.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      if (part.slice(0, index).trim() !== COOKIE_NAME) continue;
      const value = part.slice(index + 1).trim();
      const dot = value.indexOf('.');
      if (dot <= 0) return undefined;
      const id = value.slice(0, dot);
      const signature = value.slice(dot + 1);
      if (!safeEqual(signature, sign(this.state.secret, id))) return undefined;
      const device = this.state.devices.find((item) => item.id === id);
      if (!device) return undefined;
      return device;
    }
    return undefined;
  }

  touch(device) {
    const now = Date.now();
    if (now - (device.lastSeenAt ?? 0) < 60_000) return;
    device.lastSeenAt = now;
    this.persist();
  }

  revoke(id) {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((device) => device.id !== id);
    if (this.state.devices.length !== before) this.persist();
    return before !== this.state.devices.length;
  }

  revokeAll() {
    this.state.devices = [];
    this.persist();
  }

  get devices() {
    return this.state.devices.map((device) => ({
      id: device.id,
      label: device.label,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    }));
  }

  /** 简单的暴力破解防护：同一 IP 连续失败后短暂锁定。 */
  blocked(ip) {
    const entry = this.failures.get(ip);
    return entry !== undefined && entry.until > Date.now();
  }

  recordFailure(ip) {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= 8) entry.until = Date.now() + 5 * 60 * 1000;
    this.failures.set(ip, entry);
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }
}
