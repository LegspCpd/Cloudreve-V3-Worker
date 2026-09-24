import type { Context } from "hono";
import type { Ctx } from "../env";
import { session } from "./session";
import { apiError, Code } from "./errors";

/**
 * 验证码层：Workers 无法方便地生成点阵图，这里生成 SVG 矢量验证码。
 * 返回 base64 数据 URI，前端 <img> 可直接渲染；答案存入会话 KV。
 */

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomText(len: number): string {
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < len; i++) out += CHARS[arr[i] % CHARS.length];
  return out;
}

const COLORS = ["#3f51b5", "#2196f3", "#009688", "#e91e63", "#ff5722", "#673ab7"];

function svgCaptcha(text: string, width: number, height: number): string {
  const cells = text.split("");
  const charW = width / cells.length;
  let charsSvg = "";
  cells.forEach((ch, i) => {
    const x = charW * i + charW / 2;
    const y = height / 2 + (Math.sin(i * 1.7) * height) / 8;
    const rot = ((i % 2 === 0 ? 1 : -1) * (8 + (i % 5) * 3)).toFixed(1);
    const color = COLORS[i % COLORS.length];
    charsSvg += `<text x="${x}" y="${y}" font-size="${(height * 0.55).toFixed(0)}" fill="${color}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-weight="bold" transform="rotate(${rot} ${x} ${y})">${escapeXml(ch)}</text>`;
  });

  // 干扰线
  let linesSvg = "";
  const rnd = new Uint32Array(8);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < 4; i++) {
    const x1 = (rnd[i * 2] % width).toFixed(1);
    const y1 = (rnd[i * 2 + 1] % height).toFixed(1);
    const x2 = (rnd[(i * 2 + 2) % 8] % width).toFixed(1);
    const y2 = (rnd[(i * 2 + 3) % 8] % height).toFixed(1);
    linesSvg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS[(i + 2) % COLORS.length]}" stroke-width="1.2" opacity="0.55"/>`;
  }
  // 噪点
  let dotsSvg = "";
  const dots = new Uint32Array(60);
  crypto.getRandomValues(dots);
  for (let i = 0; i < 30; i++) {
    const cx = (dots[i * 2] % width).toFixed(1);
    const cy = (dots[i * 2 + 1] % height).toFixed(1);
    dotsSvg += `<circle cx="${cx}" cy="${cy}" r="1" fill="${COLORS[i % COLORS.length]}" opacity="0.5"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#f5f5f5"/>${linesSvg}${dotsSvg}${charsSvg}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (m) => {
    switch (m) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return m;
    }
  });
}

export interface GeneratedCaptcha {
  id: string;
  dataUri: string;
}

/** 生成验证码并把答案记录到会话 */
export async function generateCaptcha(c: Context<Ctx>): Promise<GeneratedCaptcha> {
  const width = await settingInt("captcha_width", 240);
  const height = await settingInt("captcha_height", 60);
  const len = await settingInt("captcha_CaptchaLen", 6);
  const text = randomText(Math.max(4, Math.min(8, len)));
  const svg = svgCaptcha(text, width, height);
  const dataUri = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));

  const s = await session(c);
  s.set({ captchaID: text.toLowerCase() });

  return { id: s.id, dataUri };
}

async function settingInt(key: string, def: number): Promise<number> {
  const { setting } = await import("./settings");
  return setting.getInt(key, def);
}

/** 校验用户提交的验证码；校验成功后立即失效，防止复用 */
export async function verifyCaptcha(c: Context<Ctx>, input: string): Promise<void> {
  const s = await session(c);
  const expected = s.get<string>("captchaID");
  if (!expected) {
    throw apiError(Code.CaptchaRefreshNeeded, "captcha expired, please refresh");
  }
  if (input.trim().toLowerCase() !== expected) {
    throw apiError(Code.CaptchaError, "captcha code error");
  }
  s.delete("captchaID");
}
