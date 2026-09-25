/**
 * 把数据库连接串与密钥写入 Cloudflare Worker 的 secret。
 *
 * 值来源优先级：进程环境变量 > .env 文件。空值跳过。
 *
 * 用法（本地或 CI）：
 *   node scripts/apply-secrets.mjs
 *   值在环境变量中：DATABASE_URL=... RESEND_API_KEY=... node scripts/apply-secrets.mjs
 *   值在 .env 中（npm run setup 自动生成）：node scripts/apply-secrets.mjs
 *
 * 需要 CLOUDFLARE_API_TOKEN（与可选的 CLOUDFLARE_ACCOUNT_ID）。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const COLORS = { green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok = (m) => console.log(`${COLORS.green}✔${COLORS.reset} ${m}`);
const info = (m) => console.log(`${COLORS.cyan}ℹ${COLORS.reset} ${m}`);
const warn = (m) => console.log(`${COLORS.yellow}⚠${COLORS.reset} ${m}`);
const fail = (m) => console.log(`${COLORS.red}✘${COLORS.reset} ${m}`);

// 需要写入 Worker secret 的键。
// 注意：DATABASE_URL* 不在这里 —— 它们由 deploy.mjs 在构建时注入 wrangler.toml 的 [vars]，
// MAX_KV_NAMESPACES / MAX_NEON_DATABASES 已在 wrangler.toml [vars] 声明；
// 同名同时作为 var 与 secret 会造成绑定冲突。
const SECRET_KEYS = [
  "RESEND_API_KEY",
  "SESSION_SECRET",
  "HASHID_SALT",
  "MAIL_FROM_ADDRESS",
  "MAIL_FROM_NAME",
  "SITE_URL",
];

// 读取 .env（不覆盖已有环境变量）
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    if (!SECRET_KEYS.includes(key)) continue;
    if (!process.env[key]) {
      process.env[key] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  info("已加载 .env");
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  fail("CLOUDFLARE_API_TOKEN 未设置，无法写入 secret");
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
let applied = 0;
let skipped = 0;

async function putSecret(key, value) {
  return new Promise((resolveFn) => {
    const child = spawn(npx, ["wrangler", "secret", "put", key], {
      cwd: ROOT,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.stdin.write(value + "\n");
    child.stdin.end();
    child.on("close", (code) => resolveFn(code === 0));
    child.on("error", () => resolveFn(false));
  });
}

for (const key of SECRET_KEYS) {
  const value = process.env[key];
  if (!value) {
    skipped++;
    continue;
  }
  const success = await putSecret(key, value);
  if (success) {
    applied++;
    ok(`secret ${key} 已写入`);
  } else {
    fail(`secret ${key} 写入失败`);
  }
}

console.log("");
if (applied > 0) ok(`共写入 ${applied} 个 secret`);
if (skipped > 0) warn(`跳过 ${skipped} 个空值（未提供的变量不会写入）`);
