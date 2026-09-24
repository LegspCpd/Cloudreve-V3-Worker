import type { MiddlewareHandler } from "hono";
import type { Ctx } from "../env";
import { db } from "../db";
import { users, groups } from "../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { session, saveSession, getCookie } from "../lib/session";
import { cache } from "../lib/cache";
import { Code, apiError } from "../lib/errors";
import { setting } from "../lib/settings";
import { decodeHashID, IDType } from "../lib/hashid";
import { isTrueVal } from "../lib/utils";

/**
 * 会话中间件：为每个请求装载会话对象，并在响应后把变更持久化到 KV。
 * 对应原版 middleware/session.go + sessionstore。
 */
export const sessionMiddleware: MiddlewareHandler<Ctx> = async (c, next) => {
  await next();
  const s = c.get("__session" as never) as { isDirty: boolean; id: string } | undefined;
  if (s && s.isDirty) {
    // 重新获取完整会话对象并保存
    const sess = await session(c);
    await saveSession(c, sess);
  }
};

/** 读取当前用户；未登录时 user 为 null */
export const currentUser: MiddlewareHandler<Ctx> = async (c, next) => {
  const s = await session(c);
  const uid = s.get<number>("user_id");
  if (uid) {
    const rows = await db()
      .select()
      .from(users)
      .where(and(eq(users.id, uid), eq(users.status, 0), isNull(users.deletedAt)))
      .limit(1);
    if (rows.length > 0) {
      const u = rows[0]!;
      c.set("user", u);
      c.set("isLogin", true);
      // 管理员判定：用户组 ID 为 1，或用户 ID 为 1（初始管理员）
      c.set("isAdmin", u.groupId === 1 || u.id === 1);
    }
  }
  await next();
};

/** 需要登录 */
export const authRequired: MiddlewareHandler<Ctx> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ code: Code.CheckLogin, msg: "Login required" });
  }
  await next();
};

/** 需要管理员 */
export const isAdmin: MiddlewareHandler<Ctx> = async (c, next) => {
  if (!c.get("isAdmin")) {
    return c.json({ code: Code.AdminRequired, msg: "" });
  }
  await next();
};

/** 需要绑定手机（仅在设置强制时生效，管理员豁免） */
export const phoneRequired: MiddlewareHandler<Ctx> = async (c, next) => {
  const [phoneRequiredEnabled, phoneEnabled] = await Promise.all([
    setting.isTrue("phone_required"),
    setting.isTrue("phone_enabled"),
  ]);
  if (!phoneRequiredEnabled || !phoneEnabled) {
    await next();
    return;
  }
  const user = c.get("user");
  if (!user || user.phone !== "" || c.get("isAdmin")) {
    await next();
    return;
  }
  return c.json({ code: Code.PhoneRequired, msg: "此功能需要绑定手机后使用" });
};

/** 功能开关：未开启时阻止访问 */
export const isFunctionEnabled = (key: string): MiddlewareHandler<Ctx> => async (c, next) => {
  const enabled = await setting.isTrue(key);
  if (!enabled) {
    return c.json({ code: Code.FeatureNotEnabled, msg: "This feature is not enabled" });
  }
  await next();
};

/** 把路由参数中的 HashID 解码为真实 ID，写入变量 object_id */
export const hashID = (type: IDType): MiddlewareHandler<Ctx> => async (c, next) => {
  const raw = c.req.param("id");
  if (raw) {
    const id = decodeHashID(raw, type);
    if (!id) {
      return c.json({ code: Code.ParamErr, msg: "Failed to parse object ID" });
    }
    c.set("object_id" as never, id as never);
  }
  await next();
};

/** 屏蔽客户端缓存 */
export const cacheControl: MiddlewareHandler<Ctx> = async (c, next) => {
  c.header("Cache-Control", "private, no-cache");
  await next();
};

/** 静态资源缓存策略 */
export const staticResourceCache: MiddlewareHandler<Ctx> = async (c, next) => {
  const maxAge = await setting.getInt("public_resource_maxage", 86400);
  c.header("Cache-Control", `public, max-age=${maxAge}`);
  await next();
};

/** 沙箱：限制页面内脚本能力（外链输出时使用） */
export const sandbox: MiddlewareHandler<Ctx> = async (c, next) => {
  c.header("Content-Security-Policy", "sandbox");
  await next();
};

/** 初始化 CSRF 标记（前端首次加载站点配置时种下） */
export const csrfInit: MiddlewareHandler<Ctx> = async (c, next) => {
  const s = await session(c);
  s.set({ CSRF: true });
  await next();
};

/** 校验 CSRF 标记 */
export const csrfCheck: MiddlewareHandler<Ctx> = async (c, next) => {
  const s = await session(c);
  if (s.get<boolean>("CSRF")) {
    await next();
    return;
  }
  return c.json({ code: Code.NoPermissionErr, msg: "Invalid origin" });
};

/** 按需校验验证码 */
export const captchaRequired = (settingKey: string): MiddlewareHandler<Ctx> => {
  return async (c, next) => {
    const enabled = await setting.isTrue(settingKey);
    if (!enabled) {
      await next();
      return;
    }
    const { verifyCaptcha } = await import("../lib/captcha");
    const code = (await c.req.json().catch(() => ({}))) as { captchaCode?: string };
    if (!code.captchaCode) {
      return c.json({ code: Code.CaptchaError, msg: "captcha code is required" });
    }
    try {
      await verifyCaptcha(c, code.captchaCode);
    } catch (e) {
      const err = e as { code: number; message: string };
      return c.json({ code: err.code ?? Code.CaptchaError, msg: err.message });
    }
    await next();
  };
};

/**
 * 上传会话（回调）验证：从 KV 取出上传会话并校验策略类型。
 * 成功后把会话与用户写入请求上下文。
 */
export const useUploadSession =
  (policyType: string): MiddlewareHandler<Ctx> =>
  async (c, next) => {
    const sessionID = c.req.param("sessionID");
    if (!sessionID) {
      return c.json({ code: Code.ParamErr, msg: "Session ID cannot be empty" });
    }
    const raw = await (c.env.K3 ?? c.env.UPLOAD_KV).get(`upload_session:${sessionID}`);
    if (!raw) {
      return c.json({ code: Code.UploadSessionExpired, msg: "上传会话不存在或已过期" });
    }
    const sess = JSON.parse(raw) as { uid: number; policyType: string; policyId: number };
    if (sess.policyType !== policyType) {
      return c.json({ code: Code.PolicyNotAllowed, msg: "" });
    }
    // 清理回调会话
    await (c.env.K3 ?? c.env.UPLOAD_KV).delete(`upload_session:${sessionID}`);
    const rows = await db()
      .select()
      .from(users)
      .where(and(eq(users.id, sess.uid), eq(users.status, 0), isNull(users.deletedAt)))
      .limit(1);
    if (rows.length === 0) {
      return c.json({ code: Code.UserNotFound, msg: "" });
    }
    c.set("user", rows[0]!);
    c.set("upload_session" as never, sess as never);
    await next();
  };

/** WebDAV Basic 鉴权 */
export const webdavAuth: MiddlewareHandler<Ctx> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }
  const authHeader = c.req.header("authorization") || "";
  if (!authHeader.startsWith("Basic ")) {
    c.header("WWW-Authenticate", `Basic realm="cloudreve"`);
    return c.body(null, 401);
  }
  const decoded = atob(authHeader.slice(6));
  const idx = decoded.indexOf(":");
  if (idx < 0) {
    return c.body(null, 401);
  }
  const email = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);

  const userRows = await db()
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.status, 0), isNull(users.deletedAt)))
    .limit(1);
  if (userRows.length === 0) {
    return c.body(null, 401);
  }
  const user = userRows[0]!;

  const { webdavs } = await import("../db/schema");
  const accountRows = await db()
    .select()
    .from(webdavs)
    .where(and(eq(webdavs.userId, user.id), eq(webdavs.password, password), isNull(webdavs.deletedAt)))
    .limit(1);
  if (accountRows.length === 0) {
    return c.body(null, 401);
  }

  const groupRows = await db().select().from(groups).where(eq(groups.id, user.groupId)).limit(1);
  const group = groupRows[0];
  if (!group || !group.webdavEnabled) {
    return c.body(null, 403);
  }

  c.set("user", user);
  c.set("webdav" as never, accountRows[0] as never);
  await next();
};

/** 校验请求签名（HMACAuth，用于回调/从机通信等） */
export const signRequired = (): MiddlewareHandler<Ctx> => async (c, next) => {
  const { HMACAuth, checkURI } = await import("../lib/sign");
  const secretKey = await setting.get("secret_key");
  const authInstance = new HMACAuth(secretKey);
  const method = c.req.method.toUpperCase();
  try {
    if (method === "PUT" || method === "POST" || method === "PATCH") {
      const authHeader = c.req.header("authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        throw apiError(Code.NoPermissionErr, "authorization header is missing");
      }
      // 请求体签名校验
      const body = await c.req.text();
      const path = new URL(c.req.url).pathname;
      await authInstance.check(path + body, authHeader.slice(7));
    } else {
      const u = new URL(c.req.url);
      await checkURI(authInstance, u);
    }
  } catch (e) {
    const err = e as { code: number; message: string };
    return c.json({ code: err.code ?? Code.CredentialInvalid, msg: err.message });
  }
  await next();
};

export { getCookie, isTrueVal };
