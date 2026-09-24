import type { Env } from "../env";
import { cacheDbGet, cacheDbSet, cacheDbDelete } from "../db/client";

/**
 * 多级缓存层。读取链路：
 *   L1 内存（isolate 级，纳秒）→
 *   L2 K1 / KV（热数据全量缓存，毫秒）→
 *   L3 Neon 缓存库（KV 装不下的溢出部分，十毫秒）
 *
 * 写入时同时写 L1 + L2 + L3，保证后续命中尽可能落在最快的一层。
 * 对齐原版 pkg/cache 的 Get / Set / Deletes / GetSettings / SetSettings 语义。
 */
class Cache {
  private env: Env | null = null;
  private memo = new Map<string, { value: string; expire: number }>();

  /** 注入环境（Worker 启动时调用一次） */
  bind(env: Env): void {
    this.env = env;
  }

  /** K1 命名空间（热数据全量缓存） */
  private kv(): KVNamespace {
    if (!this.env) throw new Error("Cache not bound to env yet");
    return this.env.K1 ?? this.env.CACHE_KV ?? (this.env as unknown as { K1: KVNamespace }).K1;
  }

  private memoGet(key: string): string | null {
    const m = this.memo.get(key);
    if (!m) return null;
    if (m.expire !== 0 && m.expire <= Date.now()) {
      this.memo.delete(key);
      return null;
    }
    return m.value;
  }

  private memoSet(key: string, value: string, ttlSec: number): void {
    this.memo.set(key, { value, expire: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
  }

  /**
   * 读取单个值；ttl <= 0 表示不过期。
   * 逐级回源：内存 → KV → 缓存库，任一层命中都会把值回填到上层。
   */
  async get<T = string>(key: string): Promise<T | null> {
    const m = this.memoGet(key);
    if (m !== null) return m as unknown as T;

    const v2 = await this.kv().get(key);
    if (v2 !== null && v2 !== undefined) {
      this.memoSet(key, v2, 0);
      return v2 as unknown as T;
    }

    const v3 = await cacheDbGet<string>(key).catch(() => null);
    if (v3 !== null && v3 !== undefined) {
      this.memoSet(key, v3, 0);
      await this.kv().put(key, v3).catch(() => {
        /* KV 写失败不致命 */
      });
      return v3 as unknown as T;
    }
    return null;
  }

  /** 写入值；ttl 单位秒，<= 0 表示不过期 */
  async set(key: string, value: unknown, ttl = 0): Promise<void> {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    this.memoSet(key, raw, ttl);
    await Promise.all([
      this.kv().put(key, raw, ttl > 0 ? { expirationTtl: ttl } : undefined).catch(() => {}),
      cacheDbSet(key, raw, ttl).catch(() => {}),
    ]);
  }

  /** 删除（三层全清） */
  async delete(key: string): Promise<void> {
    this.memo.delete(key);
    await Promise.all([this.kv().delete(key).catch(() => {}), cacheDbDelete(key).catch(() => {})]);
  }

  /** 批量删除（带前缀） */
  async deletes(ids: string[], prefix: string): Promise<void> {
    await Promise.all(ids.map((id) => this.delete(prefix + id)));
  }

  /** 批量读取，返回命中与未命中 */
  async getSettings(
    names: string[],
    prefix: string,
  ): Promise<{ res: Record<string, string>; miss: string[] }> {
    const res: Record<string, string> = {};
    const miss: string[] = [];
    await Promise.all(
      names.map(async (n) => {
        const v = await this.get<string>(prefix + n);
        if (v !== null) res[n] = v;
        else miss.push(n);
      }),
    );
    return { res, miss };
  }

  /** 批量写入 */
  async setSettings(values: Record<string, string>, prefix: string): Promise<void> {
    await Promise.all(Object.entries(values).map(([k, v]) => this.set(prefix + k, v)));
  }

  /** 清空内存缓存（设置变更时调用，强制下次回源） */
  flushMemo(): void {
    this.memo.clear();
  }
}

export const cache = new Cache();
