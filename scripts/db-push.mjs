/**
 * 把 Drizzle schema 推送到所有已配置的 Neon 数据库（主库 + 备份库 + 缓存库）。
 *
 * 用法：
 *   node scripts/db-push.mjs          建表/增量更新
 *   node scripts/db-push.mjs --reset  清空后重建（危险！仅初始化时使用）
 *
 * 连接串来源：.env / 环境变量中的 DATABASE_URL、DATABASE_URL_BACKUP、DATABASE_URL_CACHE_1..3
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const reset = process.argv.slice(2).includes("--reset");

// 读取 .env
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    if (!(key in process.env)) process.env[key] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const targets = [];
if (process.env.DATABASE_URL) targets.push({ name: "主库", url: process.env.DATABASE_URL });
if (process.env.DATABASE_URL_BACKUP) targets.push({ name: "备份库", url: process.env.DATABASE_URL_BACKUP });
for (let i = 1; i <= 3; i++) {
  const u = process.env[`DATABASE_URL_CACHE_${i}`];
  if (u) targets.push({ name: `缓存库#${i}`, url: u });
}

if (targets.length === 0) {
  console.error("✘ 没有找到任何数据库连接串，请先运行 npm run setup 或在 .env 中设置 DATABASE_URL");
  process.exit(1);
}

if (targets.length > 5) {
  console.error(
    `✘ 配置的 Neon 数据库数量为 ${targets.length} 个，超过上限 5 个。请减少一个（最多 5 个：1 主库 + 缓存库 + 1 备份库）。`,
  );
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
let failed = 0;

for (const t of targets) {
  console.log(`\nℹ 正在推送表结构到 ${t.name} …`);
  try {
    execFileSync(
      npx,
      ["drizzle-kit", "push", ...(reset ? ["--force"] : [])],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: t.url },
      },
    );
    console.log(`✔ ${t.name} 表结构${reset ? "已重置" : "已是最新"}`);
  } catch (e) {
    console.error(`✘ ${t.name} 推送失败：${String(e.message || e)}`);
    failed++;
  }
}

console.log("");
if (failed > 0) {
  console.error(`✘ ${failed}/${targets.length} 个数据库推送失败`);
  process.exit(1);
}
console.log(`✔ 全部 ${targets.length} 个数据库表结构初始化完成`);
