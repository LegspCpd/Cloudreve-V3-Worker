import { Hono } from "hono";
import type { Ctx } from "../env";
import { db } from "../db";
import { files, folders, sourceLinks, policies as policyTable } from "../db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { Err } from "../lib/response";
import { Code } from "../lib/errors";
import { signRequired, staticResourceCache, sandbox } from "../middleware";
import { decodeHashID, IDType } from "../lib/hashid";
import { toPolicyRuntime } from "../storage/policy";
import { StorageDriver } from "../storage/driver";
import { setting } from "../lib/settings";
import { cache } from "../lib/cache";
import { folderFullPath, getChildFilesOfFolders, getRecursiveChildFolders } from "../lib/fs";
import type { FileRow, PolicyRow } from "../db/schema";

/**
 * 匿名资源访问路由（需 HMAC 签名）：/api/v3/file/*
 *   GET file/get/:id/:name          —— 直接输出文件内容
 *   GET file/source/:id/:name       —— 永久直链（301 跳转）
 *   GET file/download/:id           —— 下载文件
 *   GET file/archive/:sessionID/archive.zip —— 打包下载
 *
 * 对应原版 routers/router.go 中 sign 组的 file 路由。
 */
const anonymous = new Hono<Ctx>();

/** 校验签名并把解码后的真实 ID 放入上下文 */
anonymous.use("*", signRequired(), async (c, next) => {
  const raw = c.req.param("id") || "";
  const isSourceLink = c.req.path.includes("/file/source/");
  const type = isSourceLink ? IDType.SourceLinkID : IDType.FileID;
  if (raw) {
    const id = decodeHashID(raw, type);
    if (!id) return c.json(Err(Code.ParamErr, "无法解析对象 ID"));
    c.set("object_id" as never, id as never);
  }
  await next();
});

async function loadPolicy(id: number): Promise<PolicyRow | null> {
  const rows = await db()
    .select()
    .from(policyTable)
    .where(and(eq(policyTable.id, id), isNull(policyTable.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadFile(fileID: number): Promise<FileRow | null> {
  const cached = await cache.get<string>(`file:${fileID}`).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as FileRow;
    } catch {
      /* fallthrough */
    }
  }
  const rows = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, fileID), isNull(files.deletedAt)))
    .limit(1);
  const row = rows[0] ?? null;
  if (row) await cache.set(`file:${fileID}`, JSON.stringify(row), 3600).catch(() => {});
  return row;
}

/** 直接输出文件内容（供 img/video/iframe 等内联使用） */
anonymous.get("/get/:id/:name", staticResourceCache, sandbox, async (c) => {
  const fileID = c.get("object_id" as never) as number;
  const target = await loadFile(fileID);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policyRow = await loadPolicy(target.policyId);
  if (!policyRow) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));

  const runtime = toPolicyRuntime(c, policyRow);
  const range = c.req.header("range") || undefined;
  const maxAge = await setting.getInt("public_resource_maxage", 86400);

  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const obj = await c.env.R2_BUCKET.get(target.sourceName, range ? { range } : {});
    if (!obj) return c.json(Err(Code.FileNotFound, "对象不存在"));
    const headers: Record<string, string> = {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": `public, max-age=${maxAge}`,
    };
    return c.newResponse(obj.body, 200, headers);
  }

  const driver = new StorageDriver(runtime);
  const resp = await driver.getStream(target.sourceName, range);
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", `public, max-age=${maxAge}`);
  return new Response(resp.body, { status: resp.status, headers });
});

/** 永久直链（301 跳转到对象存储 URL） */
anonymous.get("/source/:id/:name", staticResourceCache, async (c) => {
  const linkID = c.get("object_id" as never) as number;
  const linkRows = await db()
    .select()
    .from(sourceLinks)
    .where(and(eq(sourceLinks.id, linkID), isNull(sourceLinks.deletedAt)))
    .limit(1);
  const link = linkRows[0];
  if (!link) return c.json(Err(Code.FileNotFound, "外链不存在"));

  const target = await loadFile(link.fileId);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policyRow = await loadPolicy(target.policyId);
  if (!policyRow) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));

  const driver = new StorageDriver(toPolicyRuntime(c, policyRow));
  const { url, redirect } = await driver.sourceURL(target.sourceName, 3600);

  // 异步计数（不阻塞响应）
  db()
    .update(sourceLinks)
    .set({ downloads: (link.downloads ?? 0) + 1 })
    .where(eq(sourceLinks.id, link.id))
    .catch(() => {});

  return c.redirect(url, redirect ? 301 : 302);
});

/** 下载文件（签名 URL 由 PUT /file/download/:id 生成） */
anonymous.get("/download/:id", staticResourceCache, async (c) => {
  const fileID = c.get("object_id" as never) as number;
  const target = await loadFile(fileID);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policyRow = await loadPolicy(target.policyId);
  if (!policyRow) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));

  const driver = new StorageDriver(toPolicyRuntime(c, policyRow));
  const { url, redirect } = await driver.sourceURL(target.sourceName, 3600);
  return c.redirect(url, redirect ? 301 : 302);
});

/** 打包下载（流式输出 zip） */
anonymous.get("/archive/:sessionID/archive.zip", async (c) => {
  const sessionID = c.req.param("sessionID");
  const raw = await c.env.K4?.get(`archive:${sessionID}`);
  if (!raw) return c.json(Err(Code.SignExpired, "打包会话不存在或已过期"));

  let payload: { items: number[]; folders: number[]; uid: number; name: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json(Err(Code.ParamErr, "打包会话数据损坏"));
  }

  // 收集全部文件
  const [directFiles, childFolders] = await Promise.all([
    payload.items.length
      ? db()
          .select()
          .from(files)
          .where(and(inArray(files.id, payload.items), eq(files.userId, payload.uid), isNull(files.deletedAt)))
      : Promise.resolve([]),
    getRecursiveChildFolders(payload.uid, payload.folders, true),
  ]);
  const childFiles = await getChildFilesOfFolders(childFolders.map((f) => f.id));

  // 以文件所属目录名作为 zip 内的子目录前缀
  const folderNames = new Map<number, string>();
  for (const f of childFolders) folderNames.set(f.id, f.name);
  const folderOf = new Map<number, number>();
  for (const f of [...directFiles, ...childFiles]) folderOf.set(f.id, f.folderId);

  const entries: { name: string; source: string; size: number }[] = [];
  const seen = new Set<number>();
  for (const f of [...directFiles, ...childFiles]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const dirBase = folderNames.get(f.folderId) ?? "";
    entries.push({
      name: dirBase ? `${dirBase}/${f.name}` : f.name,
      source: f.sourceName,
      size: f.size,
    });
  }
  if (entries.length === 0) return c.json(Err(Code.FileNotFound, "没有可打包的文件"));

  const firstPolicyId = ([...directFiles, ...childFiles][0] as FileRow).policyId;
  const policyRow = await loadPolicy(firstPolicyId);
  if (!policyRow) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policyRow);
  const zipKey = `archive/${payload.uid}/${sessionID}.zip`;
  const { ZipBuilder } = await import("../lib/zip");
  const driver = new StorageDriver(runtime);

  // 绑定 R2：优先复用已生成的 zip
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const existing = await c.env.R2_BUCKET.head(zipKey);
    if (!existing) {
      const zip = new ZipBuilder();
      let idx = 0;
      for (const e of entries) {
        const obj = await c.env.R2_BUCKET.get(e.source);
        if (!obj) continue;
        const data = new Uint8Array(await obj.arrayBuffer());
        zip.addFile(e.name, data, ++idx);
      }
      await c.env.R2_BUCKET.put(zipKey, zip.finalize(), {
        httpMetadata: { contentType: "application/zip" },
      });
    }
  } else {
    const zip = new ZipBuilder();
    let idx = 0;
    for (const e of entries) {
      const resp = await driver.getStream(e.source);
      const buf = new Uint8Array(await resp.arrayBuffer());
      zip.addFile(e.name, buf, ++idx);
    }
    await driver.putBuffer(zipKey, zip.finalize(), "application/zip");
  }

  const { url, redirect } = await driver.sourceURL(zipKey, 3600);
  return c.redirect(url, redirect ? 301 : 302);
});

export default anonymous;
