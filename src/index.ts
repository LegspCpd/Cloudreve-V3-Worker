import { Hono } from "hono";
import type { Context } from "hono";
import type { Ctx } from "./env";
import { bindEnv } from "./db";
import { cache } from "./lib/cache";
import { setHashIDSalt } from "./lib/hashid";
import { setting } from "./lib/settings";
import { sessionMiddleware, currentUser } from "./middleware";
import { assertDatabaseLimit } from "./db";

import site, { buildManifest } from "./routes/site";
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

// 会话与用户信息只对后端路由生效：静态资源与 index.html 不需要查询 KV / 数据库，
// 否则每加载一个 js / css 都会额外产生一次 KV 读与用户查询。
app.use("/api/*", sessionMiddleware);
app.use("/api/*", currentUser);
app.use("/dav/*", sessionMiddleware);
app.use("/dav/*", currentUser);

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

// ── 前端根路径资源 ──
// index.html 里引用的是 /manifest.json（原版由 Gin 在根路径处理），补上根路径。
app.get("/manifest.json", async (c) => c.json(await buildManifest()));

// 浏览器默认请求的站点图标；index.html 的占位符可能指向其它路径，这里兜底
app.get("/favicon.ico", async (c) => {
  const res = await fetchAsset(c, "/static/img/favicon.ico");
  return res ?? notFound(c);
});

/** 后端路由前缀：这些路径由 API / WebDAV 处理，未命中时不做 SPA 回退 */
const BACKEND_PREFIX = /^\/(api|custom|dav|f)(\/|$)/;
/** 带扩展名的路径视为静态资源（/static/js/x.js、/locales/x.json 等） */
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;

function notFound(c: Context<Ctx>): Response {
  return c.text("404 Not Found", 404);
}

/** 读取静态资源；ASSETS 未绑定（前端产物未部署）时返回 null */
async function fetchAsset(c: Context<Ctx>, path: string): Promise<Response | null> {
  if (!c.env.ASSETS) return null;
  return c.env.ASSETS.fetch(new URL(path, c.req.url).toString());
}

/**
 * 渲染 index.html，并把站点设置占位符替换成真实值。
 * 对齐原版 middleware/frontend.go 的 {siteName} / {siteKeywords} / {siteDes} /
 * {siteScript} / {pwa_small_icon} 替换。设置读取失败时保留占位符，避免首页直接 500。
 */
async function renderIndex(c: Context<Ctx>): Promise<Response> {
  // 资源层会在根路径返回 index.html（SPA 回退同样指向 index.html）
  const assetRes = await fetchAsset(c, "/");
  if (!assetRes || !assetRes.ok) return notFound(c);
  const template = await assetRes.text();

  let values: Record<string, string> = {};
  try {
    values = await setting.getMany([
      "siteName",
      "siteKeywords",
      "siteDes",
      "siteScript",
      "pwa_small_icon",
    ]);
  } catch {
    // 站点设置暂不可用（KV / 数据库未就绪）时保持原样
  }
  const replacements: Record<string, string> = {
    "{siteName}": values["siteName"] || "CloudrevePlus",
    "{siteKeywords}": values["siteKeywords"] ?? "",
    "{siteDes}": values["siteDes"] ?? "",
    "{siteScript}": values["siteScript"] ?? "",
    "{pwa_small_icon}": values["pwa_small_icon"] || "/static/img/favicon.ico",
  };
  const html = template.replace(
    /\{siteName\}|\{siteKeywords\}|\{siteDes\}|\{siteScript\}|\{pwa_small_icon\}/g,
    (token) => replacements[token] ?? token,
  );

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-cache",
    },
  });
}

/**
 * 前端资源与路由兜底。[assets] 配了 run_worker_first = true，除 API / WebDAV 之外的
 * 请求都会走到这里：
 *   - 带扩展名的路径 → 返回真实静态资源，缺失或拿到 HTML 时返回 404
 *     （避免把 index.html 当成 JS / JSON 返回，触发浏览器 MIME 类型错误）；
 *   - 其余路径（/、/index.html、/login 等前端路由）→ 返回渲染后的 index.html。
 */
async function serveFrontend(c: Context<Ctx>): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  if (BACKEND_PREFIX.test(path)) return notFound(c);

  if (path !== "/" && path !== "/index.html" && HAS_EXTENSION.test(path)) {
    const res = await fetchAsset(c, path);
    const type = res?.headers.get("content-type") ?? "";
    if (res?.ok && !type.includes("text/html")) return res;
    return notFound(c);
  }
  return renderIndex(c);
}

app.get("/", serveFrontend);
app.get("*", serveFrontend);

export default app;
