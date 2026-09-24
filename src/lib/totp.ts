/**
 * TOTP（RFC 6238）实现：HMAC-SHA1 + Base32 密钥，6 位数字，30 秒步长。
 * 用于二步验证（2FA），对齐原版基于 github.com/pquerna/otp/totp 的行为。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_TABLE: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_TABLE[BASE32_ALPHABET[i] as string] = i;
}

/** 生成随机 Base32 密钥（默认 20 字节） */
export function generateTOTPSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_TABLE[ch];
    if (idx === undefined) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

async function hmacSHA1(key: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, data);
}

/** 生成指定时间戳的 TOTP 码 */
export async function generateTOTP(secret: string, timestamp = Date.now(), step = 30, digits = 6): Promise<string> {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / step);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // 高 32 位补 0，低 32 位放计数器（JS 位运算为 32 位有符号，需分两半写入）
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const hash = new Uint8Array(await hmacSHA1(key, new Uint8Array(buf)));
  const offset = (hash[hash.length - 1]! & 0x0f) as number;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** 校验 TOTP 码，允许前后各一个时间窗口的偏差 */
export async function verifyTOTP(secret: string, code: string, skew = 1): Promise<boolean> {
  const step = 30;
  const now = Date.now();
  for (let i = -skew; i <= skew; i++) {
    const expected = await generateTOTP(secret, now + i * step * 1000);
    if (timingSafeEqual(expected, code)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成 otpauth:// URI（供前端渲染二维码） */
export function otpauthURI(issuer: string, account: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
