import { Hono } from "hono";
import type { Ctx } from "./env";
import { bindEnv } from "./db";
import { cache } from "./lib/cache";
import { setHashIDSalt } from "./lib/hashid";
import { sessionMiddleware, currentUser } from "./middleware";
import { assertDatabaseLimit } from "./db";

import site from "./routes/site";
import user from "./routes/user";
import file from "./routes/file";
import directory from "./routes/directory";
import callback from "./routes/callback";
import anonymous from "./routes/anonymous";
import object from "./routes/object";
import share from "./routes/share";
import tag from "./routes/tag";
import vas from "./routes/vas";
import aria2 from "./routes/aria2";
import webdavManage from "./routes/webdav-manage";
import webdav from "./routes/webdav";
import admin from "./routes/admin";

/**
 * Cloudreve-V3-Worker 应用入口。
 *
 * 架构：单 Worker 承载全部后端能力 + 前端静态资源（[assets] SPA）。
 *   /api/v3/*  —— 后端 API（Hono 路由）
 *   /dav/*     —— WebDAV 协议
 *   其它路径    —— 前端 SPA（由 [assets] 配置托管，未命中时回退 index.html）
 */
const app = new Hono<Ctx>();

/** 全局错误处理：把 AppError 转为标准响应结构 */
app.onError((err, c) => {
  const e = err as { code?: number; message?: string };
  const code = e.code ?? 50001;
  const msg = e.message ?? "Internal Server Error";
  if (code >= 50000) {
    console.error(`[app] ${code} ${msg}`, err);
  }
  return c.json({ code, msg, error: undefined });
});

/** 请求级初始化：注入环境、HashID 盐值、缓存绑定 */
app.use("*", async (c, next) => {
  cache.bind(c.env);
  bindEnv(c.env);
  if (!c.env.HASHID_SALT) {
    // 盐值未设置时使用站点地址兜底（生产环境应通过 secret 设置）
    const fallback = c.env.SITE_URL || "cloudreve-worker";
    setHashIDSalt(fallback);
  } else {
    setHashIDSalt(c.env.HASHID_SALT);
  }
  await next();
});

// 数据库数量上限校验（启动时即失败，提示需要减少一个）
let dbLimitError: string | null = null;
try {
  assertDatabaseLimit();
} catch (e) {
  dbLimitError = String((e as Error).message);
}
if (dbLimitError) {
  app.use("*", async (c) =>
    c.json({ code: 50005, msg: dbLimitError as string }, 503),
  );
}

app.use("*", sessionMiddleware);
app.use("*", currentUser);

// ── API v3 ──
const api = new Hono<Ctx>();

api.route("/site", site);
api.route("/user", user);
api.route("/file", file);
api.route("/directory", directory);
api.route("/object", object);
api.route("/share", share);
api.route("/tag", tag);
api.route("/vas", vas);
api.route("/aria2", aria2);
api.route("/webdav", webdavManage);
api.route("/admin", admin);
api.route("/callback", callback);

// 匿名资源访问（签名校验在路由内部完成）
api.route("/file", anonymous);

app.route("/api/v3", api);

// ── WebDAV ──
app.route("/dav", webdav);

// ── 健康检查（供 Cloudflare 主动健康探测使用）──
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

export default app;
