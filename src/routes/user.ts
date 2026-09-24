import { Hono } from "hono";
import type { Context } from "hono";
import type { Ctx } from "../env";
import { db } from "../db";
import { users, groups, shares, settings, storagePacks, tasks, folders, policies } from "../db/schema";
import { and, eq, isNull, desc, gt, inArray } from "drizzle-orm";
import { ok, Err, ParamErr, DBErr, CheckLogin } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { setting } from "../lib/settings";
import { session, destroySession } from "../lib/session";
import { checkPassword, hashPassword, md5Hex } from "../lib/password";
import {
  buildUser,
  buildUserStorage,
  parseUserOptions,
  parsePolicyList,
} from "../lib/serializer";
import { getGroupByID } from "../lib/fs";
import { captchaRequired, authRequired, isFunctionEnabled, hashID } from "../middleware";
import { sendActivationEmail, sendResetEmail } from "../lib/email";
import { HMACAuth } from "../lib/sign";
import { generateTOTPSecret, verifyTOTP } from "../lib/totp";
import { uuid, baseName } from "../lib/utils";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { toPolicyRuntime } from "../storage/policy";
import { putR2Object, proxyR2Object } from "../lib/r2";
import type { UserRow } from "../db/schema";

/**
 * 用户路由：/api/v3/user/*
 * 对应原版 routers/controllers/user.go
 */
const user = new Hono<Ctx>();

/** 登录成功后写入会话并返回用户信息 */
async function afterLoginSuccess(c: Context<Ctx>, userRow: UserRow) {
  const s = await session(c);
  s.set({ user_id: userRow.id });
  const group = await getGroupByID(userRow.groupId);
  return c.json(ok(await buildUser(userRow, group ?? undefined)));
}

/** 检查用户是否可以登录 */
function checkUserLoginable(u: UserRow | null): UserRow {
  if (!u) throw apiError(Code.UserNotFound, "user not found");
  if (u.status === 1) throw apiError(Code.UserNotActivated, "account not activated");
  if (u.status === 2) throw apiError(Code.UserBaned, "account banned");
  if (u.status === 3) throw apiError(Code.UserBaned, "account banned due to overuse");
  return u;
}

// ── 登录 ──
user.post("/session", captchaRequired("login_captcha"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.userName ?? "").trim().toLowerCase();
  const password = String(body.Password ?? "");
  if (!email || !password) return c.json(ParamErr("Email and password are required"));

  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  const u = checkUserLoginable(rows[0] ?? null);

  const valid = await checkPassword(u.password, password);
  if (!valid) return c.json(Err(Code.IncorrectPassword, "Password not correct"));

  // 需要二步验证
  if (u.twoFactor) {
    const s = await session(c);
    s.set({ pending_2fa_uid: u.id });
    return c.json({ code: Code.NotFullySuccess, msg: "2FA required" });
  }

  return afterLoginSuccess(c, u);
});

// ── 二步验证登录 ──
user.post("/2fa", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  if (!code) return c.json(ParamErr("Code is required"));

  const s = await session(c);
  const pendingUID = s.get<number>("pending_2fa_uid");
  if (!pendingUID) return c.json(Err(Code.LoginSessionNotExist, "login session not exist"));

  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, pendingUID), isNull(users.deletedAt)))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json(Err(Code.UserNotFound, "user not found"));
  if (!u.twoFactor) return c.json(Err(Code.ParamErr, "2FA not enabled"));

  const valid = await verifyTOTP(u.twoFactor, code);
  if (!valid) return c.json(Err(Code.TwoFACodeErr, "2FA code error"));

  s.delete("pending_2fa_uid");
  return afterLoginSuccess(c, u);
});

// ── 注册 ──
user.post(
  "/",
  isFunctionEnabled("register_enabled"),
  captchaRequired("reg_captcha"),
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.userName ?? "").trim().toLowerCase();
    const password = String(body.Password ?? "");
    if (!email || !password) return c.json(ParamErr("Email and password are required"));

    // 邮箱后缀白名单
    const filterEnabled = await setting.isTrue("mail_domain_filter");
    if (filterEnabled) {
      const allowList = (await setting.get("mail_domain_filter_list"))
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      const domain = email.split("@")[1] ?? "";
      if (!allowList.includes(domain)) {
        return c.json(Err(Code.EmailProviderBaned, "email provider is not allowed"));
      }
    }

    // 邮箱重复
    const exists = await db()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    if (exists.length > 0) return c.json(Err(Code.EmailExisted, "email already used"));

    const defaultGroupID = await setting.getInt("default_group", 2);
    const hashed = await hashPassword(password);
    const emailActive = await setting.isTrue("email_active");
    const status = emailActive ? 1 : 0;

    const created = await db()
      .insert(users)
      .values({
        email,
        nick: email.split("@")[0] ?? email,
        password: hashed,
        status,
        groupId: defaultGroupID,
        score: 0,
      })
      .returning();
    const u = created[0]!;

    // 创建根目录
    await db().insert(folders).values({
      name: "/",
      ownerId: u.id,
    });

    // 需要邮件激活
    if (emailActive) {
      const authInstance = new HMACAuth(await setting.get("secret_key"));
      const siteURL = (await setting.getSiteURL()).toString().replace(/\/$/, "");
      const expire = 86400;
      const path = `/api/v3/user/activate/${hashIDEncode(u.id)}`;
      const signed = new URL(siteURL + path);
      const sign = await authInstance.sign(signed.pathname, expire + Math.floor(Date.now() / 1000));
      signed.searchParams.set("sign", sign);
      try {
        await sendActivationEmail(c, email, u.nick, signed.toString());
      } catch (e) {
        return c.json(Err(Code.FailedSendEmail, "Failed to send activation email", e));
      }
    }

    if (emailActive) {
      return c.json(ok(null, "Register success, please activate your account via email"));
    }

    // 无需激活：直接登录
    return afterLoginSuccess(c, u);
  },
);

function hashIDEncode(uid: number): string {
  return hashIDE(uid, IDType.UserID);
}

// ── 发送密码重设邮件 ──
user.post("/reset", captchaRequired("forget_captcha"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.userName ?? "").trim().toLowerCase();
  if (!email) return c.json(ParamErr("Email is required"));

  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json(ok(null)); // 不泄漏邮箱是否存在

  const authInstance = new HMACAuth(await setting.get("secret_key"));
  const siteURL = (await setting.getSiteURL()).toString().replace(/\/$/, "");
  const expire = 3600;
  const path = `/reset?id=${hashIDEncode(u.id)}`;
  const signed = new URL(siteURL + path);
  const sign = await authInstance.sign(signed.pathname + signed.search, expire + Math.floor(Date.now() / 1000));
  signed.searchParams.set("sign", sign);

  try {
    await sendResetEmail(c, email, u.nick, signed.toString());
  } catch (e) {
    return c.json(Err(Code.FailedSendEmail, "Failed to send reset email", e));
  }
  return c.json(ok(null));
});

// ── 通过邮件链接重设密码 ──
user.patch("/reset", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const password = String(body.Password ?? "");
  const sign = String(body.sign ?? "");
  if (!id || !password || !sign) return c.json(ParamErr("Invalid reset request"));

  const uid = decodeUserID(id);
  if (!uid) return c.json(Err(Code.UserNotFound, "user not found"));

  const authInstance = new HMACAuth(await setting.get("secret_key"));
  const path = `/reset?id=${id}`;
  try {
    await authInstance.check(path, sign);
  } catch (e) {
    const err = e as { code: number; message: string };
    return c.json(Err(err.code ?? Code.InvalidSign, err.message));
  }

  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, uid), isNull(users.deletedAt)))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json(Err(Code.UserNotFound, "user not found"));

  const hashed = await hashPassword(password);
  await db().update(users).set({ password: hashed }).where(eq(users.id, uid));
  return c.json(ok(null));
});

// ── 邮件激活 ──
user.get("/activate/:id", async (c) => {
  const rawID = c.req.param("id");
  const sign = c.req.query("sign") ?? "";
  const uid = decodeUserID(rawID);
  if (!uid) return c.json(Err(Code.UserNotFound, "user not found"));

  const authInstance = new HMACAuth(await setting.get("secret_key"));
  const path = `/api/v3/user/activate/${rawID}`;
  try {
    await authInstance.check(path, sign);
  } catch (e) {
    const err = e as { code: number; message: string };
    return c.json(Err(err.code ?? Code.InvalidSign, err.message));
  }

  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, uid), isNull(users.deletedAt)))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json(Err(Code.UserNotFound, "user not found"));
  if (u.status !== 1) return c.json(Err(Code.UserCannotActivate, "account cannot be activated"));

  await db().update(users).set({ status: 0 }).where(eq(users.id, uid));
  return c.json(ok(null, "Account activated"));
});

function decodeUserID(raw: string): number {
  return decodeHashID(raw, IDType.UserID);
}

// ── QQ 登录（占位：未启用时返回未开启）──
user.post("/qq", async (c) => {
  const enabled = await setting.isTrue("qq_login");
  if (!enabled) return c.json(Err(Code.FeatureNotEnabled, "QQ login is not enabled"));
  return c.json(Err(Code.FeatureNotEnabled, "QQ login is not configured"));
});

// ── WebAuthn 登录初始化 ──
user.get("/authn/:username", isFunctionEnabled("authn_enabled"), async (c) => {
  return c.json(Err(Code.FeatureNotEnabled, "WebAuthn is not implemented in worker edition"));
});

user.post("/authn/finish/:username", isFunctionEnabled("authn_enabled"), async (c) => {
  return c.json(Err(Code.FeatureNotEnabled, "WebAuthn is not implemented in worker edition"));
});

// ── 用户主页展示用分享 ──
user.get("/profile/:id", hashID(IDType.UserID), async (c) => {
  const uid = c.get("object_id" as never) as number;
  const userRows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, uid), isNull(users.deletedAt)))
    .limit(1);
  const u = userRows[0];
  if (!u) return c.json(Err(Code.UserNotFound, "user not found"));

  const opts = parseUserOptions(u.options);
  if (opts.profile_off) return c.json(Err(Code.NoPermissionErr, "profile is off"));

  const shareRows = await db()
    .select()
    .from(shares)
    .where(and(eq(shares.userId, uid), eq(shares.password, ""), isNull(shares.deletedAt)))
    .orderBy(desc(shares.id))
    .limit(10);
  return c.json(ok({ user: await buildUser(u), shares: shareRows }));
});

// ── 用户头像 ──
user.get("/avatar/:id/:size", hashID(IDType.UserID), async (c) => {
  const uid = c.get("object_id" as never) as number;
  const size = c.req.param("size") || "l";
  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, uid), isNull(users.deletedAt)))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json(Err(Code.UserNotFound, "user not found"));

  // 自定义头像：存储在 R2 的 avatars/ 前缀下
  if (u.avatar && !u.avatar.startsWith("http")) {
    const key = u.avatar.startsWith("avatars/") ? u.avatar : `avatars/${u.avatar}`;
    return proxyR2Object(c, key, `avatar-${uid}-${size}`);
  }
  if (u.avatar && u.avatar.startsWith("http")) {
    return c.redirect(u.avatar);
  }
  // Gravatar
  const gravatarServer = (await setting.get("gravatar_server")).replace(/\/$/, "");
  const digest = await md5Hex(u.email.toLowerCase());
  const sizeMap: Record<string, number> = { s: 50, m: 130, l: 200 };
  return c.redirect(`${gravatarServer}/avatar/${digest}?s=${sizeMap[size] ?? 200}&d=identicon`);
});

// ════════════════════ 以下需要登录 ════════════════════
user.use("*", authRequired);

// 当前登录用户信息
user.get("/me", async (c) => {
  const u = c.get("user")!;
  const group = await getGroupByID(u.groupId);
  return c.json(ok(await buildUser(u, group ?? undefined)));
});

// 存储信息
user.get("/storage", async (c) => {
  const u = c.get("user")!;
  const group = await getGroupByID(u.groupId);
  return c.json(ok(await buildUserStorage(u, group ?? { maxStorage: 0 } as never)));
});

// 退出登录
user.delete("/session", async (c) => {
  await destroySession(c);
  return c.json(ok(null));
});

// 准备复制会话（移动端）
user.get("/session", async (c) => {
  const u = c.get("user")!;
  const s = await session(c);
  const authInstance = new HMACAuth(await setting.get("secret_key"));
  const expire = 300;
  const sign = await authInstance.sign(`session:${s.id}:${u.id}`, expire + Math.floor(Date.now() / 1000));
  const siteURL = (await setting.getSiteURL()).toString().replace(/\/$/, "");
  return c.json(ok({ url: `${siteURL}/api/v3/user/session/copy/${hashIDEncode(u.id)}?sign=${encodeURIComponent(sign)}` }));
});

// WebAuthn 注册
user.put("/authn", isFunctionEnabled("authn_enabled"), async (c) => {
  return c.json(Err(Code.FeatureNotEnabled, "WebAuthn is not implemented in worker edition"));
});

user.put("/authn/finish", isFunctionEnabled("authn_enabled"), async (c) => {
  return c.json(Err(Code.FeatureNotEnabled, "WebAuthn is not implemented in worker edition"));
});

// ── 用户设置 ──
const settingGroup = new Hono<Ctx>();

// 可用存储策略
settingGroup.get("/policies", async (c) => {
  const u = c.get("user")!;
  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, ""));
  const ids = parsePolicyList(group.policies);
  if (ids.length === 0) return c.json(ok([]));
  const rows = await db()
    .select()
    .from(policies)
    .where(and(inArray(policies.id, ids), isNull(policies.deletedAt)));
  return c.json(
    ok(
      rows.map((p) => {
        const rt = toPolicyRuntime(c, p);
        return {
          id: hashIDE(p.id, IDType.PolicyID),
          name: p.name,
          type: p.type,
          max_size: p.maxSize,
          file_type: rt.fileType,
          is_private: p.isPrivate,
        };
      }),
    ),
  );
});

// 可用节点
settingGroup.get("/nodes", async (c) => {
  return c.json(ok([]));
});

// 任务队列
settingGroup.get("/tasks", async (c) => {
  const u = c.get("user")!;
  const rows = await db()
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, u.id), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.id))
    .limit(20);
  return c.json(ok({ total: rows.length, tasks: rows }));
});

// 当前用户设定
settingGroup.get("/", async (c) => {
  const u = c.get("user")!;
  const opts = parseUserOptions(u.options);
  return c.json(
    ok({
      uid: hashIDEncode(u.id),
      nickname: u.nick,
      email: u.email,
      phone: u.phone,
      two_factor: u.twoFactor !== "",
      group_expires: u.groupExpires?.getTime() ?? 0,
      prefer_theme: opts.preferred_theme ?? "",
      qq: u.openId !== "",
      homepage: !opts.profile_off,
      score: u.score,
    }),
  );
});

// 从文件上传头像
settingGroup.post("/avatar", async (c) => {
  const u = c.get("user")!;
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("image/")) {
    return c.json(Err(Code.FileTypeNotAllowed, "avatar must be an image"));
  }
  const maxSize = await setting.getInt("avatar_size", 2097152);
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > maxSize) return c.json(Err(Code.FileTooLarge, "avatar is too large"));

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxSize) return c.json(Err(Code.FileTooLarge, "avatar is too large"));

  const ext = (contentType.split("/")[1] ?? "png").split("+")[0];
  const key = `avatars/${u.id}_${uuid()}.${ext}`;
  const { putR2Object } = await import("../lib/r2");
  await putR2Object(c, key, buf, contentType);

  await db().update(users).set({ avatar: key }).where(eq(users.id, u.id));
  return c.json(ok(null));
});

// 设定为 Gravatar 头像
settingGroup.put("/avatar", async (c) => {
  const u = c.get("user")!;
  await db().update(users).set({ avatar: "" }).where(eq(users.id, u.id));
  return c.json(ok(null));
});

// 2FA 初始化（返回 Base32 密钥，二维码由前端生成）
settingGroup.get("/2fa", async (c) => {
  const u = c.get("user")!;
  if (u.twoFactor) return c.json(ok(""));
  const secret = generateTOTPSecret();
  const s = await session(c);
  s.set({ pending_2fa_secret: secret });
  return c.json(ok(secret));
});

// 启用 / 关闭 2FA
settingGroup.patch("/2fa", async (c) => {
  const u = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? "");
  if (u.twoFactor) {
    // 关闭：校验当前 code
    const valid = await verifyTOTP(u.twoFactor, code);
    if (!valid) return c.json(Err(Code.TwoFACodeErr, "2FA code error"));
    await db().update(users).set({ twoFactor: "" }).where(eq(users.id, u.id));
    return c.json(ok(null));
  }
  const s = await session(c);
  const secret = s.get<string>("pending_2fa_secret");
  if (!secret) return c.json(Err(Code.ParamErr, "please regenerate 2FA secret"));
  const valid = await verifyTOTP(secret, code);
  if (!valid) return c.json(Err(Code.TwoFACodeErr, "2FA code error"));
  await db().update(users).set({ twoFactor: secret }).where(eq(users.id, u.id));
  s.delete("pending_2fa_secret");
  return c.json(ok(null));
});

// 更改用户设定
settingGroup.patch("/:option", async (c) => {
  const u = c.get("user")!;
  const option = c.req.param("option");
  const body = await c.req.json().catch(() => ({}));
  const value = body.value ?? body;

  const allowed = [
    "theme",
    "prefer_theme",
    "homepage",
    "preferred_policy",
    "password",
    "nick",
    "email",
    "score",
  ];
  if (!allowed.includes(option)) return c.json(Err(Code.ParamErr, "invalid option"));

  if (option === "password") {
    const oldPwd = String(body.oldPassword ?? "");
    const newPwd = String(body.Password ?? body.value ?? "");
    if (!newPwd) return c.json(ParamErr("Password is required"));
    const valid = await checkPassword(u.password, oldPwd);
    if (!valid) return c.json(Err(Code.IncorrectPassword, "Password not correct"));
    const hashed = await hashPassword(newPwd);
    await db().update(users).set({ password: hashed }).where(eq(users.id, u.id));
    return c.json(ok(null));
  }

  if (option === "nick") {
    const nick = String(value);
    if (!nick) return c.json(ParamErr("Nickname is required"));
    await db().update(users).set({ nick }).where(eq(users.id, u.id));
    return c.json(ok(null));
  }

  // 其余写入用户 Options
  const opts = parseUserOptions(u.options);
  switch (option) {
    case "theme":
    case "prefer_theme":
      opts.preferred_theme = String(value);
      break;
    case "homepage":
      opts.profile_off = !Boolean(value);
      break;
    case "preferred_policy":
      opts.preferred_policy = Number(value) || 0;
      break;
    default:
      return c.json(Err(Code.ParamErr, "invalid option"));
  }
  await db()
    .update(users)
    .set({ options: JSON.stringify(opts) })
    .where(eq(users.id, u.id));
  return c.json(ok(null));
});

user.route("/setting", settingGroup);

export default user;
