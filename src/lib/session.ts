import type { Context } from "hono";
import type { Ctx } from "../env";
import { apiError, Code } from "./errors";
import { uuid } from "./utils";

/**
 * 会话层：基于 K2 命名空间实现，Cookie 携带 `会话ID.HMAC签名` 防篡改。
 * 对齐原版 util.SetSession / util.GetSession 的键值读写语义。
 */
const COOKIE_NAME = "cloudreve-session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天

/** 取会话 KV（K2） */
function sessionKV(c: Context<Ctx>): KVNamespace {
  return c.env.K2 ?? c.env.SESSION_KV;
}

export interface SessionData {
  [key: string]: unknown;
}

export class Session {
  id: string;
  data: SessionData;
  private dirty = false;

  constructor(id: string, data: SessionData) {
    this.id = id;
    this.data = data;
  }

  get<T = unknown>(key: string): T | null {
    const v = this.data[key];
    return v === undefined ? null : (v as T);
  }

  set(values: SessionData): void {
    this.data = { ...this.data, ...values };
    this.dirty = true;
  }

  delete(key: string): void {
    delete this.data[key];
    this.dirty = true;
  }

  clear(): void {
    this.data = {};
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** 持久化后重置脏标记 */
  markSaved(): void {
    this.dirty = false;
  }
}

function secret(c: Context<Ctx>): string {
  const s = c.env.SESSION_SECRET || "";
  if (!s) throw apiError(Code.InternalSetting, "SESSION_SECRET is not configured");
  return s;
}

async function hmac(c: Context<Ctx>, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret(c)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sign(c: Context<Ctx>, id: string): Promise<string> {
  return `${id}.${await hmac(c, id)}`;
}

async function verify(c: Context<Ctx>, raw: string): Promise<string | null> {
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const id = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = await hmac(c, id);
  return sig === expected ? id : null;
}

const MEMO_KEY = "__session";

/** 读取（或创建）当前请求的会话对象 */
export async function session(c: Context<Ctx>): Promise<Session> {
  const cached = c.get(MEMO_KEY as never) as Session | undefined;
  if (cached) return cached;

  let id: string | null = null;
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie) {
    id = await verify(c, cookie);
  }
  let data: SessionData = {};
  if (id) {
    const raw = await sessionKV(c).get(`session:${id}`);
    if (raw) {
      try {
        data = JSON.parse(raw) as SessionData;
      } catch {
        data = {};
      }
    } else {
      // KV 中不存在：会话已过期或被清除
      id = null;
    }
  }
  if (!id) id = uuid();
  const s = new Session(id, data);
  c.set(MEMO_KEY as never, s as never);
  return s;
}

/** 持久化会话到 KV 并回写 Cookie */
export async function saveSession(c: Context<Ctx>, s: Session): Promise<void> {
  if (!s.isDirty) return;
  await sessionKV(c).put(`session:${s.id}`, JSON.stringify(s.data), {
    expirationTtl: SESSION_TTL,
  });
  const cookie = await sign(c, s.id);
  setCookie(c, COOKIE_NAME, cookie, SESSION_TTL);
  s.markSaved();
}

/** 销毁会话 */
export async function destroySession(c: Context<Ctx>): Promise<void> {
  const s = c.get(MEMO_KEY as never) as Session | undefined;
  const cookie = getCookie(c, COOKIE_NAME);
  let id: string | undefined = s?.id;
  if (!id && cookie) {
    id = (await verify(c, cookie)) ?? undefined;
  }
  if (id) {
    await sessionKV(c).delete(`session:${id}`);
  }
  if (s) s.clear();
  clearCookie(c, COOKIE_NAME);
}

// ── Cookie 工具 ──
export function getCookie(c: Context<Ctx>, name: string): string | undefined {
  const header = c.req.header("cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function setCookie(c: Context<Ctx>, name: string, value: string, maxAge: number): void {
  const secure = c.req.url.startsWith("https://");
  const flags = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) flags.push("Secure");
  c.header("Set-Cookie", flags.join("; "), { append: true });
}

export function clearCookie(c: Context<Ctx>, name: string): void {
  const secure = c.req.url.startsWith("https://");
  const flags = [`${name}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (secure) flags.push("Secure");
  c.header("Set-Cookie", flags.join("; "), { append: true });
}
