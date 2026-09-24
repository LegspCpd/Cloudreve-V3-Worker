import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import type { Env } from "../env";

/**
 * 数据库客户端：Neon（PostgreSQL）HTTP 驱动 + Drizzle ORM。
 *
 * 库拓扑（受环境变量约束，最多 5 个）：
 *   1. 主库（DATABASE_URL）      —— 唯一存放业务数据的库，所有写入的源头
 *   2. 副库（DATABASE_URL_BACKUP）—— 备份库；每次写入主库都会自动同步（写穿透）
 *      副库写入成功后，会把「热数据」提升到缓存层（KV + 缓存库）以加速访问
 *   3. 缓存库（DATABASE_URL_CACHE_1..3）—— 存放热数据的 KV 装不下的溢出部分
 *
 * 未配置副库/缓存库时自动降级：副库写入跳过、缓存库退化为只使用 KV。
 */

type DB = ReturnType<typeof drizzle>;

const MAX_NEON_DATABASES = 5;

let boundEnv: Env | null = null;

function readEnv(key: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env[key] || undefined;
    }
  } catch {
    /* noop */
  }
  return undefined;
}

function envValue(key: string): string | undefined {
  return (boundEnv as unknown as Record<string, string | undefined> | null)?.[key] || readEnv(key);
}

/** 校验配置的 Neon 库数量上限（超出直接失败，提示需要减少一个） */
export function assertDatabaseLimit(): void {
  const configured: string[] = [];
  const master = envValue("DATABASE_URL");
  if (master) configured.push(master);
  if (envValue("DATABASE_URL_BACKUP")) configured.push(envValue("DATABASE_URL_BACKUP") as string);
  for (let i = 1; i <= 8; i++) {
    const v = envValue(`DATABASE_URL_CACHE_${i}`);
    if (v) configured.push(v);
  }
  const limit = Math.min(
    MAX_NEON_DATABASES,
    Math.max(1, Number(envValue("MAX_NEON_DATABASES")) || MAX_NEON_DATABASES),
  );
  if (configured.length > limit) {
    throw new Error(
      `配置的 Neon 数据库数量为 ${configured.length} 个，超过上限 ${limit} 个。` +
        `请减少一个（Neon 数据库最多 ${MAX_NEON_DATABASES} 个：1 个主库 + 缓存库 + 1 个备份库）。`,
    );
  }
}

function connectionString(): string {
  const url = envValue("DATABASE_URL") || "";
  if (!url) {
    throw new Error("DATABASE_URL 未设置，请执行 npm run setup 自动创建，或用 wrangler secret put DATABASE_URL 手动设置");
  }
  return url;
}

// ── 连接缓存（每个 isolate 懒加载，避免重复建连）──
let _master: DB | null = null;
let _backup: DB | null = null;
const _cachePool: DB[] = [];
let _cacheTotal = 0;

function makeClient(url: string): DB {
  return drizzle({ client: neon(url), schema });
}

/** 主库（唯一数据源） */
export function db(): DB {
  if (!_master) {
    assertDatabaseLimit();
    _master = makeClient(connectionString());
  }
  return _master;
}

/** 副库（备份）。未配置时返回 null。 */
export function backupDb(): DB | null {
  if (_backup === null) {
    const url = envValue("DATABASE_URL_BACKUP");
    _backup = url ? makeClient(url) : null;
  }
  return _backup;
}

/** 缓存库数量（运行时一次解析） */
function cacheDbCount(): number {
  if (!_cacheTotal) {
    let n = 0;
    for (let i = 1; i <= MAX_NEON_DATABASES; i++) {
      if (envValue(`DATABASE_URL_CACHE_${i}`)) n++;
    }
    _cacheTotal = n;
  }
  return _cacheTotal;
}

/** 按 key 哈希选取一个缓存库（未配置缓存库时返回主库做溢出缓存） */
export function cacheDbFor(key: string): DB {
  const total = cacheDbCount();
  if (total === 0) return db();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const idx = h % total;
  if (!_cachePool[idx]) {
    _cachePool[idx] = makeClient(envValue(`DATABASE_URL_CACHE_${idx + 1}`) as string);
  }
  return _cachePool[idx] as DB;
}

/**
 * 缓存库通用 KV 语义读写（cache_store 表）。
 * 读：未过期（expireAt=0 表示永不过期）才算命中。
 */
export async function cacheDbGet<T = string>(key: string): Promise<T | null> {
  const row = await cacheDbFor(key)
    .select({ value: schema.cacheStore.value, expireAt: schema.cacheStore.expireAt })
    .from(schema.cacheStore)
    .where(eq(schema.cacheStore.key, key))
    .limit(1);
  const r = row[0];
  if (!r) return null;
  if (r.expireAt !== 0 && r.expireAt < Math.floor(Date.now() / 1000)) return null;
  return r.value as unknown as T;
}

export async function cacheDbSet(key: string, value: string, ttlSec = 0): Promise<void> {
  const expireAt = ttlSec > 0 ? Math.floor(Date.now() / 1000) + ttlSec : 0;
  await cacheDbFor(key)
    .insert(schema.cacheStore)
    .values({ key, value, expireAt })
    .onConflictDoUpdate({ target: schema.cacheStore.key, set: { value, expireAt, updatedAt: new Date() } });
}

export async function cacheDbDelete(key: string): Promise<void> {
  await cacheDbFor(key).delete(schema.cacheStore).where(eq(schema.cacheStore.key, key));
}

// ── 写穿透：主库写成功 → 副库同步 → 热数据提升到缓存 ──

/** 写操作的回执 */
export interface WriteResult<T> {
  data: T;
  /** 副库同步是否成功 */
  replicated: boolean;
}

/**
 * 双写执行器：同一个写语句（insert/update/delete）在主库执行成功后，
 * 自动在副库执行一次。副库失败不影响主库结果，仅记录错误。
 *
 * 用法：
 *   await writeThrough((d) => d.insert(files).values(row).returning());
 *
 * 副库执行的是「同一份语句构建」，因此参数与 SQL 完全一致。
 */
export async function writeThrough<T>(
  build: (d: DB) => Promise<T>,
  promote?: (data: T) => { keys: Array<{ key: string; value: string; ttl?: number }> },
): Promise<WriteResult<T>> {
  const master = db();
  const data = await build(master);

  const backup = backupDb();
  let replicated = true;
  if (backup && backup !== master) {
    try {
      await build(backup);
    } catch (e) {
      replicated = false;
      console.error("[db] 副库同步失败，将在下个周期由对账任务补偿:", (e as Error).message);
    }
  }

  // 副库写完后，把热数据「移动」到缓存层，加速后续访问
  if (promote) {
    try {
      const { keys } = promote(data);
      await Promise.all(keys.map((k) => cacheDbSet(k.key, k.value, k.ttl ?? 0)));
    } catch (e) {
      console.error("[db] 热数据提升到缓存库失败:", (e as Error).message);
    }
  }
  return { data, replicated };
}

/** Worker 启动时注入环境变量 */
export function bindEnv(env: Env): void {
  boundEnv = env;
}

/** 原始 SQL 执行器（迁移/种子脚本使用，直连主库） */
export async function query<T = unknown>(strings: string, ...values: unknown[]): Promise<T[]> {
  const sql = neon(connectionString());
  return (await sql(strings, values)) as unknown as T[];
}

/** 列出所有已配置的数据库连接串（部署/校验脚本使用） */
export function listConfiguredDatabases(): string[] {
  const out: string[] = [];
  const master = envValue("DATABASE_URL");
  if (master) out.push(master);
  if (envValue("DATABASE_URL_BACKUP")) out.push(envValue("DATABASE_URL_BACKUP") as string);
  for (let i = 1; i <= MAX_NEON_DATABASES; i++) {
    const v = envValue(`DATABASE_URL_CACHE_${i}`);
    if (v) out.push(v);
  }
  return out;
}

export { schema, assertDatabaseLimit as checkDatabaseLimit };
