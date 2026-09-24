import type { Context } from "hono";
import type { Ctx } from "../env";
import { apiError, Code } from "./errors";
import { setting } from "./settings";
import { replace } from "./utils";

/**
 * 邮件发送层：统一使用 Resend（https://resend.com）。
 * 模板取自系统设置项，占位符与原版保持一致：
 * {siteTitle} {siteUrl} {userName} {activationUrl} {resetUrl} {notifyReason}
 */

/** 渲染邮件模板 */
export async function renderTemplate(template: string, vars: Record<string, string>): Promise<string> {
  const siteTitle = await setting.get("siteName");
  const siteUrl = (await setting.getSiteURL()).toString().replace(/\/$/, "");
  const table: Record<string, string> = {
    "{siteTitle}": siteTitle,
    "{siteUrl}": siteUrl,
    ...vars,
  };
  return replace(table, template);
}

function client(c: Context<Ctx>): unknown {
  const apiKey = c.env.RESEND_API_KEY;
  if (!apiKey) {
    throw apiError(Code.FailedSendEmail, "Resend API key is not configured");
  }
  // 轻量化：直接 fetch Resend HTTP API，避免引入 SDK 的 Node 依赖
  return apiKey;
}

/** 发送邮件 */
export async function sendMail(
  c: Context<Ctx>,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const apiKey = client(c) as string;
  const fromAddress = c.env.MAIL_FROM_ADDRESS || "no-reply@example.com";
  const fromName = c.env.MAIL_FROM_NAME || "CloudrevePlus";
  const from = `${fromName} <${fromAddress}>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw apiError(Code.FailedSendEmail, `Failed to send email via Resend: ${resp.status}`, text);
  }
}

/** 发送激活邮件 */
export async function sendActivationEmail(
  c: Context<Ctx>,
  to: string,
  userName: string,
  activationUrl: string,
): Promise<void> {
  const enabled = await setting.isTrue("email_active");
  if (!enabled) return;
  const template = await setting.getWithDefault("mail_activation_template", "");
  const html = await renderTemplate(template, {
    "{userName}": userName,
    "{activationUrl}": activationUrl,
  });
  await sendMail(c, to, "激活账户", html);
}

/** 发送密码重设邮件 */
export async function sendResetEmail(
  c: Context<Ctx>,
  to: string,
  userName: string,
  resetUrl: string,
): Promise<void> {
  const template = await setting.getWithDefault("mail_reset_pwd_template", "");
  const html = await renderTemplate(template, {
    "{userName}": userName,
    "{resetUrl}": resetUrl,
  });
  await sendMail(c, to, "重设密码", html);
}
