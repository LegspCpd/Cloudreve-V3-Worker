import { cache } from "./cache";
import { db } from "../db";
import { settings } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { isTrueVal } from "./utils";

/**
 * 系统设置读取层：KV 缓存 + 数据库回源，对齐 models/setting.go。
 */
export class Settings {
  /** 用 Name 获取设置值 */
  async get(name: string): Promise<string> {
    const cached = await cache.get<string>("setting_" + name);
    if (cached !== null) return cached;
    const rows = await db()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.name, name))
      .limit(1);
    const value = rows[0]?.value ?? "";
    await cache.set("setting_" + name, value);
    return value;
  }

  /** 用 Name 获取设置值，取不到时使用缺省值 */
  async getWithDefault(name: string, fallback: string): Promise<string> {
    const res = await this.get(name);
    return res === "" ? fallback : res;
  }

  /** 批量获取 */
  async getMany(names: string[]): Promise<Record<string, string>> {
    const { res, miss } = await cache.getSettings(names, "setting_");
    if (miss.length > 0) {
      const rows = await db().select().from(settings).where(inArray(settings.name, miss));
      for (const r of rows) res[r.name] = r.value;
      await cache.setSettings(
        Object.fromEntries(miss.map((n) => [n, res[n] ?? ""])),
        "setting_",
      );
    }
    return res;
  }

  async isTrue(name: string): Promise<boolean> {
    return isTrueVal(await this.get(name));
  }

  async getInt(key: string, defaultVal: number): Promise<number> {
    const raw = await this.get(key);
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) ? defaultVal : Math.trunc(n);
  }

  /** 获取站点地址 */
  async getSiteURL(): Promise<URL> {
    try {
      const base = await this.get("siteURL");
      return new URL(base || "https://cloudreve.org");
    } catch {
      return new URL("https://cloudreve.org");
    }
  }

  /** 更新设置并刷新缓存 */
  async set(name: string, value: string): Promise<void> {
    await db()
      .insert(settings)
      .values({ name, value, type: "basic" })
      .onConflictDoUpdate({
        target: settings.name,
        set: { value },
      });
    await cache.set("setting_" + name, value);
  }

  /** 批量更新 */
  async setMany(map: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(map)) {
      await this.set(name, value);
    }
  }
}

export const setting = new Settings();
