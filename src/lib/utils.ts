import { apiError, Code } from "./errors";

/** 判断设置值是否为「真」 */
export function isTrueVal(val: string | undefined | null): boolean {
  return val === "1" || val === "true";
}

/** 安全的整数解析 */
export function getIntSetting(val: string | undefined, defaultVal: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : defaultVal;
}

/** 数组包含判断 */
export function containsUint(list: number[], target: number): boolean {
  return list.includes(target);
}
export function containsString(list: string[], target: string): boolean {
  return list.some((v) => v.toLowerCase() === target.toLowerCase());
}

/** 字符串模板替换（等价 util.Replace） */
export function replace(table: Record<string, string>, subject: string): string {
  let out = subject;
  for (const [k, v] of Object.entries(table)) {
    out = out.split(k).join(v);
  }
  return out;
}

/**
 * 规范化路径：统一正斜杠、合并重复斜杠、去除结尾斜杠（根目录保留为 "/"）。
 * 对齐原版 path.Clean 的行为。
 */
export function cleanPath(p: string): string {
  if (!p) return "/";
  let s = p.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  // 压缩重复斜杠
  s = s.replace(/\/+/g, "/");
  // 去除结尾斜杠
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** 路径拼接（对齐 path.Join） */
export function pathJoin(parts: string[]): string {
  return cleanPath(parts.filter(Boolean).join("/"));
}

/** 取父目录路径 */
export function dirName(p: string): string {
  const s = cleanPath(p);
  if (s === "/") return "/";
  const idx = s.lastIndexOf("/");
  if (idx <= 0) return "/";
  return s.slice(0, idx);
}

/** 取文件名 */
export function baseName(p: string): string {
  const s = cleanPath(p);
  if (s === "/") return "/";
  const idx = s.lastIndexOf("/");
  return s.slice(idx + 1);
}

/** 扩展名（含点，小写） */
export function extName(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx).toLowerCase();
}

/** 相对路径解析：以 root 为基准解析 path */
export function resolvePath(root: string, path: string): string {
  if (path.startsWith("/")) return cleanPath(path);
  return pathJoin([root, path]);
}

/** 生成 UUID v4 */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] as number) & 0x0f | 0x40;
  arr[8] = (arr[8] as number) & 0x3f | 0x80;
  const hex = [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 将可能带单位的字节字符串解析为数字 */
export function parseSize(s: string | undefined): number {
  if (!s) return 0;
  const m = /^([\d.]+)\s*(b|k|m|g|t)?b?$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1] as string);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit] ?? 1;
  return Math.floor(n * mult);
}

/** 校验对象名是否合法（非法字符） */
const illegalChars = /[<>:"/\\|?*\x00-\x1f]/;
export function isLegalObjectName(name: string): boolean {
  if (!name || name === "." || name === ".." || name.includes("/")) return false;
  return !illegalChars.test(name);
}

/** 抛出「参数错误」 */
export function requireParam(cond: unknown, msg: string): asserts cond {
  if (!cond) throw apiError(Code.ParamErr, msg);
}

/** 分页参数解析 */
export function parsePagination(page?: string, pageSize?: string): { page: number; pageSize: number } {
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 15));
  return { page: p, pageSize: ps };
}

/** 时间戳（秒） */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** ISO 时间字符串 */
export function isoNow(): string {
  return new Date().toISOString();
}

/** 生成指定长度的随机字符串（大小写字母+数字） */
export function randString(n: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = new Uint32Array(n);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < n; i++) out += chars[arr[i] % chars.length];
  return out;
}
