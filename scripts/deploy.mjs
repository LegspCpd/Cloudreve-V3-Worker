/**
 * 一键部署脚本（供 Cloudflare Workers Builds 的 Deploy command 调用）。
 *
 * 一次执行完成全部事情：
 *   1. 创建/复用 KV 命名空间（标题前缀 Cloudreve-v3-，上限 5）
 *   2. 创建/复用 Neon 数据库（上限 5：主库 + 缓存库 + 备份库）
 *   3. 初始化全部数据库表结构
 *   4. 写入种子数据（系统设置 / 用户组 / 存储策略 / 管理员账号）
 *   5. 把生成的数据库连接串写入 wrangler.toml
 *   6. 调用 wrangler deploy 部署 Worker
 *
 * 需要的环境变量（在 Workers Builds 的 Environment variables 里配置）：
 *   NEON_API_KEY / NEON_PROJECT_ID   自动创建 Neon 数据库
 *   ADMIN_EMAIL / ADMIN_PASSWORD     可选，自定义管理员账号
 *   MAX_KV_NAMESPACES / MAX_NEON_DATABASES  可选，数量上限，默认 5
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  Workers Builds 自动提供
 *
 * 本地也可直接运行：node scripts/deploy.mjs
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WRANGLER_TOML = resolve(ROOT, "wrangler.toml");

const C = { green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok = (m) => console.log(`${C.green}✔${C.reset} ${m}`);
const info = (m) => console.log(`${C.cyan}ℹ${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}⚠${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✘${C.reset} ${m}`);

const shell = process.platform === "win32";
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

function run(cmd, args, label) {
  return new Promise((resolveFn, rejectFn) => {
    console.log(`\n${C.cyan}▶ ${label}${C.reset}`);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", shell });
    child.on("close", (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`${label} 失败（退出码 ${code}）`));
    });
    child.on("error", rejectFn);
  });
}

// 加载 setup 生成的 .env（子进程写入，父进程需要自己读）
function loadDotEnv() {
  const dotEnvPath = resolve(ROOT, ".env");
  try {
    const text = readFileSync(dotEnvPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const idx = t.indexOf("=");
      if (idx < 0) continue;
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  } catch {
    /* .env 不存在时忽略 */
  }
}

// 把 setup 生成的连接串回填到 wrangler.toml 的 [vars]
function applyDbUrlsToWrangler() {
  loadDotEnv();
  let text = readFileSync(WRANGLER_TOML, "utf8");
  const keys = ["DATABASE_URL", "DATABASE_URL_BACKUP", "DATABASE_URL_CACHE_1", "DATABASE_URL_CACHE_2", "DATABASE_URL_CACHE_3"];
  let changed = 0;
  for (const key of keys) {
    const value = process.env[key];
    if (!value) continue;
    const re = new RegExp(`^${key}\\s*=\\s*".*"`, "m");
    if (re.test(text)) {
      text = text.replace(re, `${key} = "${value}"`);
      changed++;
    }
  }
  if (changed > 0) {
    writeFileSync(WRANGLER_TOML, text, "utf8");
    ok(`已把 ${changed} 个数据库连接串写入 wrangler.toml`);
  } else {
    warn("未检测到数据库连接串，wrangler.toml 保持不变");
  }
}

async function main() {
  console.log(`${C.cyan}╔════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.cyan}║  Cloudreve-V3-Worker 一键部署              ║${C.reset}`);
  console.log(`${C.cyan}╚════════════════════════════════════════════╝${C.reset}\n`);

  // 1) 资源初始化（KV + Neon + 表结构 + 种子数据），可断点续跑
  await run(npmBin, ["run", "setup"], "第 1/4 步：初始化资源（KV 命名空间 + Neon 数据库 + 表结构 + 种子数据）");

  // 2) 把连接串回填到 wrangler.toml
  applyDbUrlsToWrangler();

  // 3) 前端构建
  await run(npmBin, ["run", "build"], "第 2/4 步：构建前端");

  // 4) 写入 secret（RESEND_API_KEY / SESSION_SECRET / HASHID_SALT 等）
  try {
    await run(npmBin, ["run", "secrets:apply"], "第 3/4 步：写入 Worker secret");
  } catch (e) {
    warn(`secret 写入被跳过：${String(e.message || e)}`);
    warn("若是首次部署，请在 Workers Builds 的环境变量中确认已配置 RESEND_API_KEY / SESSION_SECRET / HASHID_SALT");
  }

  // 5) 部署
  await run(npxBin, ["wrangler", "deploy"], "第 4/4 步：部署 Worker 到 Cloudflare");

  console.log(`\n${C.green}══════════════════════════════════════════════${C.reset}`);
  ok("一键部署完成");
  console.log(`${C.green}══════════════════════════════════════════════${C.reset}`);
}

main().catch((e) => {
  fail(`部署中断：${String(e.message || e)}`);
  process.exit(1);
});
