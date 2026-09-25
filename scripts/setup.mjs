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

/** KV 绑定名与用途（标题统一使用 Cloudreve-v3- 前缀） */
const KV_BINDINGS = [
  { binding: "K1", title: "Cloudreve-v3-cache", desc: "热数据全量缓存" },
  { binding: "K2", title: "Cloudreve-v3-session", desc: "会话" },
  { binding: "K3", title: "Cloudreve-v3-upload", desc: "上传会话" },
  { binding: "K4", title: "Cloudreve-v3-task", desc: "任务进度" },
  { binding: "K5", title: "Cloudreve-v3-lock", desc: "锁与限流" },
];

const createdKV = [];

// wrangler 子进程封装
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
function wrangler(...args) {
  return execFileSync(npxBin, ["wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 拉取当前账号下全部 KV 命名空间（title -> id）
// wrangler 输出可能带版本告警等非 JSON 前缀，需要从输出中切出真正的 JSON 数组
function listKVNamespaces() {
  try {
    const out = wrangler("kv", "namespace", "list");
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      warn("wrangler 未返回命名空间列表（可能账号下暂无命名空间）");
      return new Map();
    }
    const rows = JSON.parse(out.slice(start, end + 1));
    const map = new Map();
    for (const r of rows) {
      if (r && r.title && r.id) map.set(r.title, r.id);
    }
    return map;
  } catch (e) {
    warn(`获取 KV 命名空间列表失败：${String((e && e.stderr) || e.message || e)}`);
    return new Map();
  }
}

if (process.env.SKIP_KV_CREATE === "1") {
  warn("SKIP_KV_CREATE=1，跳过 KV 命名空间创建，直接使用 wrangler.toml 中已有的配置。");
} else {
  // 先查已存在的命名空间，优先复用，避免重复创建导致失败
  const existing = listKVNamespaces();
  if (existing.size > 0) info(`检测到账号下已有 ${existing.size} 个 KV 命名空间，将优先复用。`);

  for (let i = 0; i < kvCount; i++) {
    const cfg = KV_BINDINGS[i];
    const title = cfg.title;
    const desc = `（${cfg.desc}）`;

    // 1) 已存在则直接复用
    const existedId = existing.get(title);
    if (existedId) {
      createdKV.push({ binding: cfg.binding, id: existedId, desc: cfg.desc });
      ok(`KV 命名空间 ${cfg.binding}${desc}复用已存在实例：${existedId}`);
      continue;
    }

    // 2) 不存在才创建
    try {
      const out = wrangler("kv", "namespace", "create", title);
      const idMatch = /id\s*=\s*"([0-9a-fA-F]{32})"/.exec(out);
      let id = idMatch ? idMatch[1] : "";
      if (!id) {
        // 创建可能已成功但输出格式未匹配上，回查列表
        const after = listKVNamespaces();
        id = after.get(title) || "";
      }
      if (!id) throw new Error(`无法从 wrangler 输出中解析命名空间 ID：\n${out}`);
      createdKV.push({ binding: cfg.binding, id, desc: cfg.desc });
      ok(`KV 命名空间 ${cfg.binding}${desc}创建成功：${id}`);
    } catch (e) {
      // 3) 创建失败时最后再尝试一次回查（并发/竞态场景）
      const after = listKVNamespaces();
      const retryId = after.get(title);
      if (retryId) {
        createdKV.push({ binding: cfg.binding, id: retryId, desc: cfg.desc });
        ok(`KV 命名空间 ${cfg.binding}${desc}创建时报告冲突，已复用：${retryId}`);
        continue;
      }
      const msg = e && e.stderr ? String(e.stderr) : String(e);
      fail(`创建 KV 命名空间 ${cfg.binding}${desc}失败（标题 ${title}）：${msg}`);
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
// 第四步：自动创建 / 复用 R2 存储桶（「本地存储」策略用）
// ───────────────────────────────────────────────────────────

// 桶名统一带 cloudreve-v3 前缀，避免与 Cloudreve V4 等其他实例冲突
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || "cloudreve-v3-storage").trim();

// 拉取账号下已有桶名：优先 JSON，其次解析表格里的 name: 行
function listR2Buckets() {
  const names = new Set();
  const attempts = [
    ["r2", "bucket", "list", "--json"],
    ["r2", "bucket", "list"],
  ];
  for (const args of attempts) {
    try {
      const out = wrangler(...args);
      const s = out.indexOf("[");
      const e = out.lastIndexOf("]");
      if (s !== -1 && e > s) {
        try {
          for (const b of JSON.parse(out.slice(s, e + 1))) {
            if (b && b.name) names.add(String(b.name));
          }
          if (names.size) return names;
        } catch {
          /* 不是 JSON，继续按表格解析 */
        }
      }
      for (const m of out.matchAll(/^\s*name:\s*([^\s]+)/gm)) {
        names.add(m[1].replace(/["']/g, ""));
      }
      if (names.size) return names;
    } catch {
      /* 该调用方式不可用，尝试下一种 */
    }
  }
  return names;
}

// 让 wrangler.toml 里的桶名与本次使用的一致
{
  const text = readFileSync(wranglerPath, "utf8");
  const re = /(^\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*)".*"/m;
  if (re.test(text)) {
    const next = text.replace(re, `$1"${R2_BUCKET_NAME}"`);
    if (next !== text) writeFileSync(wranglerPath, next, "utf8");
  }
}

if (process.env.SKIP_R2_CREATE === "1") {
  warn(`SKIP_R2_CREATE=1，跳过 R2 存储桶创建，请确认 ${R2_BUCKET_NAME} 已存在。`);
} else if (listR2Buckets().has(R2_BUCKET_NAME)) {
  ok(`R2 存储桶${R2_BUCKET_NAME}复用已存在实例`);
} else {
  try {
    wrangler("r2", "bucket", "create", R2_BUCKET_NAME);
    ok(`R2 存储桶创建成功：${R2_BUCKET_NAME}`);
  } catch (e) {
    const msg = String(e.stdout || e.stderr || e.message || "").trim();
    if (/already exists|10004|conflict/i.test(msg)) {
      ok(`R2 存储桶${R2_BUCKET_NAME}复用已存在实例`);
    } else {
      fail(`创建 R2 存储桶失败：${msg || e.message}`);
      if (/auth|permission|10000|forbidden|not authorized/i.test(msg)) {
        console.log("  → 当前 API Token 缺少 R2 权限，请在面板给 Build 的 Token 补上 R2 权限后重新部署。");
      } else {
        console.log("  → 若提示 R2 未启用，请先在 Cloudflare 面板 R2 Object Storage 处启用（一次性操作），然后重新部署。");
      }
      process.exit(1);
    }
  }
}
log("");

// ───────────────────────────────────────────────────────────
// 第五步：自动创建 Neon 数据库（分支）
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

// GitHub 面板粘贴的 secret 经常带前后空白或换行，统一清理
const trimS = (v) => (typeof v === "string" ? v.trim().replace(/^["'`]|["'`]$/g, "").trim() : v);
neonApiKey = trimS(neonApiKey);
neonProjectId = trimS(neonProjectId);

if (neonApiKey && neonProjectId) {
  info(`使用 Neon API 自动创建 ${dbCount} 个数据库（项目 ${neonProjectId}）…`);

  // 新版 Neon API 要求 Authorization: Bearer，同时保留 Neon-Api-Key 以兼容旧版
  const neonHeaders = () => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${neonApiKey}`,
    "Neon-Api-Key": neonApiKey,
  });

  const BRANCH_NAMES = { main: "cloudreve-main", backup: "cloudreve-backup" };

  // 先把已存在的分支拉下来，能复用的直接复用，避免重复创建报错
  const existingBranches = new Map(); // name -> branch.id
  try {
    const listResp = await fetch(
      `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches`,
      { headers: neonHeaders() },
    );
    if (listResp.ok) {
      const list = await listResp.json();
      for (const b of list.branches || []) existingBranches.set(b.name, b.id);
      if (existingBranches.size > 0) {
        info(`检测到项目下已有 ${existingBranches.size} 个分支，将优先复用：${[...existingBranches.keys()].join("、")}`);
      }
    }
  } catch {
    /* 拉取失败不阻塞，后面创建时会再报错 */
  }

  // 取指定分支的连接串（复用场景）
  async function connectionUriOf(branchId) {
    const endpoints = await (
      await fetch(
        `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches/${branchId}/endpoints`,
        { headers: neonHeaders() },
      )
    ).json();
    const ep = (endpoints.endpoints || [])[0];
    if (!ep || !ep.connection_uris || !ep.connection_uris.length) return "";
    return ep.connection_uris[0].connection_uri;
  }

  for (let i = 0; i < dbCount; i++) {
    const role = dbRoles[i];
    const name = role === "main" ? BRANCH_NAMES.main : role === "backup" ? BRANCH_NAMES.backup : `cloudreve-cache-${i}`;

    // 1) 已存在则直接复用
    const existedId = existingBranches.get(name);
    if (existedId) {
      try {
        const uri = await connectionUriOf(existedId);
        if (!uri) throw new Error("无法获取连接串");
        dbUrls[role] = uri;
        ok(`Neon 数据库 ${name}（${role}）已存在，复用连接串`);
        continue;
      } catch (e) {
        warn(`复用分支 ${name} 时出错（${String(e.message || e)}），改为尝试创建`);
      }
    }

    // 2) 不存在才创建
    try {
      const resp = await fetch(`https://console.neon.tech/api/v2/projects/${neonProjectId}/branches`, {
        method: "POST",
        headers: neonHeaders(),
        body: JSON.stringify({ branch: { name } }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        if (body && body.message && /already exists|conflict/i.test(body.message)) {
          const uri = await connectionUriOf(existingBranches.get(name) || "");
          if (!uri) throw new Error(`分支 ${name} 已存在但无法获取连接串`);
          dbUrls[role] = uri;
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
      log("");
      warn("常见原因：");
      log("  1. NEON_API_KEY 已过期或权限不足（需要项目的读写权限）");
      log("  2. NEON_API_KEY / NEON_PROJECT_ID 填错或带了多余空白/引号");
      log("  3. NEON_PROJECT_ID 不属于该 API Key 所属账号");
      log("  4. 免费账号的分支数量已达上限");
      log("");
      warn("解决方法：");
      log("  - 到 https://console.neon.tech/app/settings/api-keys 重新生成 API Key");
      log("  - 项目 ID 在 Neon 项目页面的 Settings 中查看");
      log("  - 或跳过自动创建：手动在 Neon 控制台建库后把连接串写入 .env，再重跑");
      log("");
      warn("注意：已创建的 KV 命名空间与数据库分支都会自动复用，修复后重跑不会重复创建。");
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
