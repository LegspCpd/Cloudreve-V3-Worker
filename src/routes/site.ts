import { Hono } from "hono";
import type { Ctx } from "../env";
import { ok } from "../lib/response";
import { setting } from "../lib/settings";
import { csrfInit } from "../middleware";
import { generateCaptcha } from "../lib/captcha";
import { buildAnonymousUser, buildUser } from "../lib/serializer";
import { getGroupByID } from "../lib/fs";
import { Code } from "../lib/errors";

/**
 * 站点级路由：/api/v3/site/*
 * 对应原版 routers/controllers/site.go
 */
const site = new Hono<Ctx>();

// 测试用路由
site.get("/ping", (c) => c.json(ok("cloudreve-plus-worker")));

// 验证码
site.get("/captcha", async (c) => {
  const captcha = await generateCaptcha(c);
  return c.json(ok(captcha.dataUri));
});

// 站点全局配置（前端启动时首个请求，同时种下 CSRF 标记）
site.get("/config", csrfInit, async (c) => {
  const values = await setting.getMany([
    "siteName",
    "siteNotice",
    "login_captcha",
    "qq_login",
    "reg_captcha",
    "email_active",
    "forget_captcha",
    "themes",
    "defaultTheme",
    "score_enabled",
    "share_score_rate",
    "home_view_method",
    "share_view_method",
    "authn_enabled",
    "captcha_ReCaptchaKey",
    "captcha_type",
    "captcha_TCaptcha_CaptchaAppId",
    "register_enabled",
    "report_enabled",
    "show_app_promotion",
    "app_forum_link",
    "app_feedback_link",
  ]);

  const check = (k: string) => values[k] === "1" || values[k] === "true";
  const wopiExts: string[] = [];

  const user = c.get("user");
  let userRes;
  if (user) {
    const group = await getGroupByID(user.groupId);
    userRes = await buildUser(user, group ?? undefined);
  } else {
    userRes = await buildAnonymousUser();
  }

  return c.json(
    ok({
      title: values["siteName"] ?? "",
      loginCaptcha: check("login_captcha"),
      regCaptcha: check("reg_captcha"),
      forgetCaptcha: check("forget_captcha"),
      emailActive: check("email_active"),
      QQLogin: check("qq_login"),
      themes: values["themes"] ?? "",
      defaultTheme: values["defaultTheme"] ?? "",
      score_enabled: check("score_enabled"),
      share_score_rate: values["share_score_rate"] ?? "",
      home_view_method: values["home_view_method"] ?? "list",
      share_view_method: values["share_view_method"] ?? "list",
      authn: check("authn_enabled"),
      user: userRes,
      captcha_ReCaptchaKey: values["captcha_ReCaptchaKey"] ?? "",
      site_notice: values["siteNotice"] ?? "",
      captcha_type: values["captcha_type"] ?? "normal",
      tcaptcha_captcha_app_id: values["captcha_TCaptcha_CaptchaAppId"] ?? "",
      registerEnabled: check("register_enabled"),
      report_enabled: check("report_enabled"),
      app_promotion: check("show_app_promotion"),
      wopi_exts: wopiExts,
      app_feedback: values["app_feedback_link"] ?? "",
      app_forum: values["app_forum_link"] ?? "",
    }),
  );
});

// manifest.json
site.get("/manifest.json", async (c) => {
  const values = await setting.getMany([
    "siteName",
    "siteTitle",
    "pwa_small_icon",
    "pwa_medium_icon",
    "pwa_large_icon",
    "pwa_display",
    "pwa_theme_color",
    "pwa_background_color",
  ]);
  return c.json({
    short_name: values["siteName"] ?? "",
    name: values["siteTitle"] ?? "",
    icons: [
      { src: values["pwa_small_icon"] ?? "/static/img/favicon.ico", sizes: "64x64 32x32 24x24 16x16", type: "image/x-icon" },
      { src: values["pwa_medium_icon"] ?? "/static/img/logo192.png", type: "image/png", sizes: "192x192" },
      { src: values["pwa_large_icon"] ?? "/static/img/logo512.png", type: "image/png", sizes: "512x512" },
    ],
    start_url: ".",
    display: values["pwa_display"] ?? "standalone",
    theme_color: values["pwa_theme_color"] ?? "#000000",
    background_color: values["pwa_background_color"] ?? "#ffffff",
  });
});

// VOL 密钥
site.get("/vol", async (c) => {
  const values = await setting.getMany(["vol_content", "vol_signature"]);
  if (!values["vol_signature"]) {
    return c.json({ code: Code.NotFound, msg: "" });
  }
  return c.json(ok({ signature: values["vol_signature"], content: values["vol_content"] ?? "" }));
});

export default site;
