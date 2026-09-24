/**
 * 一键初始化脚本：自动创建 Worker KV 命名空间与 Neon 数据库。
 *
 * 数量由环境变量控制，硬上限均为 5：
 *   MAX_KV_NAMESPACES   需要 KV 的数量（默认 5，>5 直接失败并提示「需要减少一个」）
 *   MAX_NEON_DATABASES  需要 Neon 库的数量（默认 5，>5 直接失败）
 *                       分配规则：1 主库 + 1 备份库 + 其余缓存库
 *
 * 用法：
 *   npx cross-env MAX_KV_NAMESPACES=5 MAX_NEON_DATABASES=5 node scripts/setup.mjs
 *
 * 也可把以上变量写在项目根目录的 .env 文件中，脚本会自动读取。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ───────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`${colors.green}✔${colors.reset} ${msg}`);
const info = (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`);
const warn = (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`);
const fail = (msg) => {
  console.log(`${colors.red}✘${colors.reset} ${msg}`);
  process.exitCode = 1;
};

/** 读取 .env（若存在）并与 process.env 合并，.env 不覆盖已有变量 */
function loadDotEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

function numEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ───────────────────────────────────────────────────────────
// 第一步：数量上限校验
// ───────────────────────────────────────────────────────────

const HARD_MAX_KV = 5;
const HARD_MAX_DB = 5;

const kvWanted = numEnv("MAX_KV_NAMESPACES", 5);
const dbWanted = numEnv("MAX_NEON_DATABASES", 5);

log("");
log(`${colors.cyan}╔════════════════════════════════════════════╗${colors.reset}`);
log(`${colors.cyan}║  Cloudreve-V3-Worker 一键初始化            ║${colors.reset}`);
log(`${colors.cyan}╚════════════════════════════════════════════╝${colors.reset}`);
log("");

// KV 超过上限：立即失败，并明确提示「需要减少一个」
if (kvWanted > HARD_MAX_KV) {
  fail(
    `KV 命名空间数量为 ${kvWanted}，超过上限 ${HARD_MAX_KV} 个，创建自动失败。` +
      `请减少一个（Worker KV 最多 ${HARD_MAX_KV} 个），` +
      `例如把 MAX_KV_NAMESPACES 从 ${kvWanted} 改为 ${kvWanted - 1} 后重试。`,
  );
}
if (dbWanted > HARD_MAX_DB) {
  fail(
    `Neon 数据库数量为 ${dbWanted}，超过上限 ${HARD_MAX_DB} 个，创建自动失败。` +
      `请减少一个（Neon 数据库最多 ${HARD_MAX_DB} 个：1 个主库 + 缓存库 + 1 个备份库），` +
      `例如把 MAX_NEON_DATABASES 从 ${dbWanted} 改为 ${dbWanted - 1} 后重试。`,
  );
}
if (process.exitCode) process.exit(process.exitCode);

const kvCount = Math.max(1, kvWanted);
const dbCount = Math.max(1, dbWanted);

// 库角色分配：第 1 个主库，最后 1 个备份库，中间全部缓存库
const dbRoles = [];
if (dbCount === 1) dbRoles.push("main");
else {
  dbRoles.push("main");
  for (let i = 0; i < dbCount - 2; i++) dbRoles.push("cache");
  dbRoles.push("backup");
}

info(`KV 命名空间：${kvCount} 个（K1 全量热缓存、K2 会话、K3 上传会话、K4 任务进度、K5 锁与限流）`);
info(`Neon 数据库：${dbCount} 个（${dbRoles.map((r, i) => `${r === "main" ? "主库" : r === "backup" ? "备份库" : "缓存库"}#${i + 1}`).join("、")}）`);
log("");

// ───────────────────────────────────────────────────────────
// 第二步：自动创建 Worker KV 命名空间
// ───────────────────────────────────────────────────────────

/** KV 绑定名与用途 */
const KV_BINDINGS = [
  { binding: "K1", desc: "热数据全量缓存" },
  { binding: "K2", desc: "会话" },
  { binding: "K3", desc: "上传会话" },
  { binding: "K4", desc: "任务进度" },
  { binding: "K5", desc: "锁与限流" },
];

const createdKV = [];

if (process.env.SKIP_KV_CREATE === "1") {
  warn("SKIP_KV_CREATE=1，跳过 KV 命名空间创建，直接使用 wrangler.toml 中已有的配置。");
} else {
  for (let i = 0; i < kvCount; i++) {
    const cfg = KV_BINDINGS[i];
    const title = `cloudreve-worker-${cfg.binding}`;
    try {
      const out = execFileSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["wrangler", "kv", "namespace", "create", title],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const idMatch = /id\s*=\s*"([0-9a-fA-F]{32})"/.exec(out);
      const id = idMatch ? idMatch[1] : "";
      if (!id) throw new Error(`无法从 wrangler 输出中解析命名空间 ID：\n${out}`);
      createdKV.push({ binding: cfg.binding, id, desc: cfg.desc });
      ok(`KV 命名空间 ${cfg.binding}（${cfg.desc}）创建成功：${id}`);
    } catch (e) {
      const msg = e && e.stderr ? String(e.stderr) : String(e);
      if (/already exists|title/.test(msg)) {
        // 已存在：尝试从 list 中找回 id
        warn(`KV 命名空间 ${cfg.binding} 已存在，尝试从列表中获取 ID。`);
        try {
          const list = execFileSync(
            process.platform === "win32" ? "npx.cmd" : "npx",
            ["wrangler", "kv", "namespace", "list"],
            { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
          const rows = JSON.parse(list);
          const hit = rows.find((r) => r.title === title);
          if (hit) {
            createdKV.push({ binding: cfg.binding, id: hit.id, desc: cfg.desc });
            ok(`KV 命名空间 ${cfg.binding} 复用已存在实例：${hit.id}`);
            continue;
          }
        } catch {
          /* 继续抛出原错误 */
        }
      }
      fail(`创建 KV 命名空间 ${cfg.binding} 失败：${msg}`);
      process.exit(process.exitCode || 1);
    }
  }
}
log("");

// ───────────────────────────────────────────────────────────
// 第三步：把 KV 配置写回 wrangler.toml
// ───────────────────────────────────────────────────────────

const wranglerPath = resolve(ROOT, "wrangler.toml");
let wranglerText = readFileSync(wranglerPath, "utf8");

// 先删除已有 kv_namespaces 段，再按本次创建的结果重写
wranglerText = wranglerText.replace(/# *──+ KV[\s\S]*?(?=# *──)/, "");
wranglerText = wranglerText.replace(/\[\[kv_namespaces\]\][\s\S]*?(?=\n# *──|\n\[|\n\[\[)/g, "");
wranglerText = wranglerText.replace(/\n{3,}/g, "\n\n");

if (createdKV.length > 0) {
  const block =
    "# ───────────────────────────────────────────────────────────\n" +
    "# Worker KV：由 scripts/setup.mjs 自动创建并写入（上限 5 个）\n" +
    "# K1 = 热数据全量缓存；K2 = 会话；K3 = 上传会话；K4 = 任务进度；K5 = 锁与限流\n" +
    "# ───────────────────────────────────────────────────────────\n" +
    createdKV
      .map((k) => `[[kv_namespaces]]\nbinding = "${k.binding}"\nid = "${k.id}"`)
      .join("\n\n") +
    "\n";
  // 插入到第一个顶级 [section] 之前
  wranglerText = wranglerText.replace(/\n(\[[a-z])/, `\n${block}\n$1`);
}

writeFileSync(wranglerPath, wranglerText.trim() + "\n", "utf8");
ok(`已更新 wrangler.toml（KV 命名空间 × ${createdKV.length}）`);
log("");

// ───────────────────────────────────────────────────────────
// 第四步：自动创建 Neon 数据库（分支）
// ───────────────────────────────────────────────────────────

const neonApiKey = process.env.NEON_API_KEY || "";
const neonProjectId = process.env.NEON_PROJECT_ID || "";
const envUrls = {};
if (process.env.DATABASE_URL) envUrls.main = process.env.DATABASE_URL;
if (process.env.DATABASE_URL_BACKUP) envUrls.backup = process.env.DATABASE_URL_BACKUP;
for (let i = 1; i <= 3; i++) {
  if (process.env[`DATABASE_URL_CACHE_${i}`]) envUrls[`cache${i}`] = process.env[`DATABASE_URL_CACHE_${i}`];
}

const dbUrls = {}; // role -> connection string
const secretsToSet = []; // 待设置的 Worker secret

if (neonApiKey && neonProjectId) {
  info(`使用 Neon API 自动创建 ${dbCount} 个数据库（项目 ${neonProjectId}）…`);
  const BRANCH_NAMES = { main: "cloudreve-main", backup: "cloudreve-backup" };
  for (let i = 0; i < dbCount; i++) {
    const role = dbRoles[i];
    const name = role === "main" ? BRANCH_NAMES.main : role === "backup" ? BRANCH_NAMES.backup : `cloudreve-cache-${i}`;
    try {
      const resp = await fetch(`https://console.neon.tech/api/v2/projects/${neonProjectId}/branches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Neon-Api-Key": neonApiKey,
          Accept: "application/json",
        },
        body: JSON.stringify({ branch: { name } }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        if (body && body.message && /already exists|conflict/i.test(body.message)) {
          // 已存在：走列表接口取连接串
          const listResp = await fetch(
            `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches`,
            { headers: { "Neon-Api-Key": neonApiKey, Accept: "application/json" } },
          );
          const list = await listResp.json();
          const hit = (list.branches || []).find((b) => b.name === name);
          if (!hit) throw new Error(`分支 ${name} 已存在但无法获取连接串`);
          const endpoints = await (
            await fetch(
              `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches/${hit.id}/endpoints`,
              { headers: { "Neon-Api-Key": neonApiKey, Accept: "application/json" } },
            )
          ).json();
          const ep = (endpoints.endpoints || [])[0];
          if (!ep || !ep.connection_uris || !ep.connection_uris.length) {
            throw new Error(`分支 ${name} 没有可用的连接串`);
          }
          dbUrls[role] = ep.connection_uris[0].connection_uri;
          ok(`Neon 数据库 ${name}（${role}）已存在，复用连接串`);
          continue;
        }
        throw new Error(body && body.message ? body.message : `HTTP ${resp.status}`);
      }
      const uris = body.connection_uris || [];
      if (!uris.length) throw new Error("创建成功但响应中没有连接串");
      dbUrls[role] = uris[0].connection_uri;
      ok(`Neon 数据库 ${name}（${role}）创建成功`);
    } catch (e) {
      fail(`创建 Neon 数据库 ${name} 失败：${String(e.message || e)}`);
      warn(`你也可以跳过自动创建，手动在 Neon 控制台创建库后把连接串写入 .env，再重跑本脚本。`);
      process.exit(process.exitCode || 1);
    }
  }
} else {
  warn("未设置 NEON_API_KEY / NEON_PROJECT_ID，跳过 Neon 自动创建。");
  if (Object.keys(envUrls).length === 0) {
    warn("也没有在 .env 中找到 DATABASE_URL。请在 Neon 控制台创建数据库后，把连接串写入 .env：");
    log("  DATABASE_URL=postgres://...            （主库）");
    log("  DATABASE_URL_BACKUP=postgres://...     （备份库）");
    log("  DATABASE_URL_CACHE_1=postgres://...    （缓存库，可选）");
    log("");
    warn("完成后再重跑 `npm run setup`，脚本会继续完成表结构初始化与种子数据。");
    process.exit(1);
  }
  // 用 .env 中已存在的连接串
  for (const [k, v] of Object.entries(envUrls)) dbUrls[k] = v;
  ok(`从 .env 读取到 ${Object.keys(dbUrls).length} 个数据库连接串`);
}
log("");

// ───────────────────────────────────────────────────────────
// 第五步：写 .env 与 .dev.vars（脚本本地使用，不进仓库）
// ───────────────────────────────────────────────────────────

function writeEnvFile(path, entries) {
  const lines = [
    "# 由 scripts/setup.mjs 自动生成，请勿提交到仓库",
    `MAX_KV_NAMESPACES=${kvCount}`,
    `MAX_NEON_DATABASES=${dbCount}`,
  ];
  for (const [k, v] of Object.entries(entries)) lines.push(`${k}=${v}`);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

const envEntries = {};
if (dbUrls.main) envEntries.DATABASE_URL = dbUrls.main;
if (dbUrls.backup) envEntries.DATABASE_URL_BACKUP = dbUrls.backup;
let cacheIdx = 0;
for (const role of dbRoles) {
  if (role === "cache" && dbUrls[role]) {
    cacheIdx++;
    envEntries[`DATABASE_URL_CACHE_${cacheIdx}`] = dbUrls[role];
  }
}

const dotEnvPath = resolve(ROOT, ".env");
if (Object.keys(envEntries).length > 0) {
  writeEnvFile(dotEnvPath, envEntries);
  ok(`已生成 ${ROOT}/.env`);
}
const devVarsPath = resolve(ROOT, ".dev.vars");
if (Object.keys(envEntries).length > 0) {
  writeEnvFile(devVarsPath, envEntries);
  ok(`已生成 ${ROOT}/.dev.vars（本地 wrangler dev 使用）`);
}

// ───────────────────────────────────────────────────────────
// 第六步：输出生产环境需要设置的 secret 命令
// ───────────────────────────────────────────────────────────

log("");
log(`${colors.cyan}──────────── 部署到生产环境前，请执行以下命令设置 secret ────────────${colors.reset}`);
for (const [k, v] of Object.entries(envEntries)) {
  log(`  echo "${v}" | npx wrangler secret put ${k}`);
}
if (process.env.RESEND_API_KEY) log(`  echo "${process.env.RESEND_API_KEY}" | npx wrangler secret put RESEND_API_KEY`);
if (process.env.SESSION_SECRET) log(`  echo "${process.env.SESSION_SECRET}" | npx wrangler secret put SESSION_SECRET`);
if (process.env.HASHID_SALT) log(`  echo "${process.env.HASHID_SALT}" | npx wrangler secret put HASHID_SALT`);
log("");

// ───────────────────────────────────────────────────────────
// 第七步：初始化表结构与种子数据
// ───────────────────────────────────────────────────────────

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

log("");
log(`${colors.cyan}──────────── 初始化表结构（所有配置的数据库）────────────${colors.reset}`);
try {
  execFileSync(npmBin, ["run", "db:push"], { cwd: ROOT, stdio: "inherit" });
  ok("表结构初始化完成");
} catch {
  fail("表结构初始化失败，请手动执行 `npm run db:push`");
}

log("");
log(`${colors.cyan}──────────── 写入种子数据（系统设置 / 用户组 / 管理员账号）────────────${colors.reset}`);
try {
  execFileSync(npmBin, ["run", "db:seed"], { cwd: ROOT, stdio: "inherit" });
  ok("种子数据写入完成");
} catch {
  fail("种子数据写入失败，请手动执行 `npm run db:seed`");
}

log("");
ok("初始化完成。接下来：");
log("  1. 构建前端并部署：npm run build && npm run deploy");
log("  2. 或本地调试：npm run dev");
log("");
