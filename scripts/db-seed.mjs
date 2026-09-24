/**
 * 种子数据：初始化系统设置、用户组、存储策略、主节点、管理员账户。
 * 对齐原版 models/migration.go 的 addDefault* 系列函数。
 *
 * 幂等：已存在的记录会跳过，可安全重复执行。
 * 只写入主库（由 setup.mjs 在初始化阶段调用）。
 *
 * 用法：node scripts/db-seed.mjs
 *   可选环境变量：
 *     ADMIN_EMAIL  管理员邮箱（默认 admin@cloudreve.org）
 *     ADMIN_PASSWORD 管理员密码（默认随机 8 位并打印）
 */
import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✘ DATABASE_URL 未设置，请先运行 npm run setup 或在 .env 中配置");
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const seedData = JSON.parse(readFileSync(resolve(__dirname, "seed-data.json"), "utf8"));

// ───────────────────────────────────────────────────────────
// 工具：与 src/lib/password.ts 完全一致的密码哈希
// ───────────────────────────────────────────────────────────

function randStringRunes(n) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = new Uint32Array(n);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < n; i++) out += chars[arr[i] % chars.length];
  return out;
}

function sha1Hex(input) {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

/** 密码格式：salt:sha1(password+salt) */
function hashPassword(password) {
  const salt = randStringRunes(5);
  return `${salt}:${sha1Hex(password + salt)}`;
}

// ───────────────────────────────────────────────────────────
// 执行
// ───────────────────────────────────────────────────────────

const log = (m) => console.log(m);
const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const skip = (m) => console.log(`\x1b[2m○\x1b[0m ${m}（已存在，跳过）`);

async function exists(table, whereClause, params) {
  const rows = await sql(`SELECT 1 FROM ${table} WHERE ${whereClause} AND deleted_at IS NULL LIMIT 1`, params);
  return rows.length > 0;
}

async function main() {
  log("");
  log("════════════════════════════════════════════");
  log("  Cloudreve-V3-Worker 种子数据初始化");
  log("════════════════════════════════════════════");
  log("");

  // 1. 系统设置
  let inserted = 0;
  for (const s of seedData.settings) {
    const rows = await sql`SELECT 1 FROM settings WHERE name = ${s.name} LIMIT 1`;
    if (rows.length > 0) continue;
    await sql`INSERT INTO settings (type, name, value, created_at, updated_at) VALUES (${s.type}, ${s.name}, ${s.value}, NOW(), NOW())`;
    inserted++;
  }
  if (inserted > 0) ok(`写入 ${inserted} 项系统设置`);
  else skip("系统设置");

  // 2. 存储策略（默认「本地存储」= 绑定的 R2 存储桶）
  if (await exists("policies", "id = 1")) {
    skip("默认存储策略");
  } else {
    const options = JSON.stringify({ chunk_size: 25 * 1024 * 1024, file_type: [], mimetype: "" });
    await sql`
      INSERT INTO policies (id, name, type, server, bucket_name, is_private, base_url,
                            access_key, secret_key, max_size, auto_rename,
                            dir_name_rule, file_name_rule, is_origin_link_enable, options,
                            created_at, updated_at)
      VALUES (1, 'Default storage policy', 'local', '', '', false, '',
              '', '', 0, true,
              'uploads/{uid}/{path}', '{uid}_{randomkey8}_{originname}', false, ${options},
              NOW(), NOW())
    `;
    ok("创建默认存储策略（local = 绑定的 R2 存储桶）");
  }

  // 3. 用户组
  const adminGroupOptions = JSON.stringify({
    archive_download: true,
    archive_task: true,
    share_download: true,
    share_free: true,
    aria2: true,
    relocate: true,
    source_batch: 1000,
    aria2_batch: 50,
    redirected_source: true,
    select_node: true,
    advance_delete: true,
  });
  const userGroupOptions = JSON.stringify({
    share_download: true,
    source_batch: 10,
    aria2_batch: 1,
    redirected_source: true,
  });
  const anonymousGroupOptions = JSON.stringify({ share_download: true });

  if (await exists("groups", "id = 1")) {
    skip("管理员用户组");
  } else {
    await sql`
      INSERT INTO groups (id, name, policies, max_storage, share_enabled, webdav_enabled, speed_limit, options, created_at, updated_at)
      VALUES (1, 'Admin', '[1]', ${1024 * 1024 * 1024}, true, true, 0, ${adminGroupOptions}, NOW(), NOW())
    `;
    ok("创建管理员用户组");
  }
  if (await exists("groups", "id = 2")) {
    skip("注册用户组");
  } else {
    await sql`
      INSERT INTO groups (id, name, policies, max_storage, share_enabled, webdav_enabled, speed_limit, options, created_at, updated_at)
      VALUES (2, 'User', '[1]', ${1024 * 1024 * 1024}, true, true, 0, ${userGroupOptions}, NOW(), NOW())
    `;
    ok("创建注册用户组");
  }
  if (await exists("groups", "id = 3")) {
    skip("游客用户组");
  } else {
    await sql`
      INSERT INTO groups (id, name, policies, max_storage, share_enabled, webdav_enabled, speed_limit, options, created_at, updated_at)
      VALUES (3, 'Anonymous', '[]', 0, false, false, 0, ${anonymousGroupOptions}, NOW(), NOW())
    `;
    ok("创建游客用户组");
  }

  // 4. 主节点
  if (await exists("nodes", "id = 1")) {
    skip("主节点");
  } else {
    const aria2Options = JSON.stringify({ interval: 10, timeout: 10 });
    await sql`
      INSERT INTO nodes (id, status, name, type, server, slave_key, master_key,
                         aria2_enabled, aria2_options, rank, created_at, updated_at)
      VALUES (1, 0, 'Master (Local machine)', 1, '', '', '',
              false, ${aria2Options}, 0, NOW(), NOW())
    `;
    ok("创建主节点");
  }

  // 5. 管理员账户
  const adminEmail = process.env.ADMIN_EMAIL || "admin@cloudreve.org";
  const adminRows = await sql`SELECT 1 FROM users WHERE email = ${adminEmail} AND deleted_at IS NULL LIMIT 1`;
  if (adminRows.length > 0) {
    skip(`管理员账户 ${adminEmail}`);
  } else {
    const password = process.env.ADMIN_PASSWORD || randStringRunes(8);
    const hashed = hashPassword(password);
    await sql`
      INSERT INTO users (email, nick, password, status, group_id, storage, open_id, two_factor,
                         avatar, options, authn, score, previous_group_id, created_at, updated_at)
      VALUES (${adminEmail}, 'admin', ${hashed}, 0, 1, 0, '', '',
              '', '', '', 0, 0, NOW(), NOW())
    `;
    ok(`创建管理员账户：${adminEmail}`);
    console.log("");
    console.log(`  ┌──────────────────────────────────────────────`);
    console.log(`  │ 管理员邮箱：\x1b[36m${adminEmail}\x1b[0m`);
    console.log(`  │ 管理员密码：\x1b[36m${password}\x1b[0m`);
    console.log(`  └──────────────────────────────────────────────`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`  \x1b[33m请妥善保存，此密码仅显示一次。\x1b[0m`);
    }
  }

  // 6. 数据库版本标记
  await sql`
    INSERT INTO settings (type, name, value, created_at, updated_at)
    VALUES ('version', 'db_version_v3', 'installed', NOW(), NOW())
    ON CONFLICT (name) DO NOTHING
  `;

  console.log("");
  ok("种子数据初始化完成");
  console.log("");
}

main().catch((e) => {
  console.error(`\x1b[31m✘\x1b[0m 种子数据初始化失败：${String(e.message || e)}`);
  process.exit(1);
});
