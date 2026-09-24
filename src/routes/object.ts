import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { files, folders, groups, users, policies as policyTable, shares, storagePacks } from "../db/schema";
import { and, eq, isNull, inArray, ne } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import { decodeHashID, IDType } from "../lib/hashid";
import { toPolicyRuntime } from "../storage/policy";
import { StorageDriver } from "../storage/driver";
import { setting } from "../lib/settings";
import { cache } from "../lib/cache";
import { cleanPath, baseName, dirName, isLegalObjectName, requireParam } from "../lib/utils";
import { resolveFolder, getRecursiveChildFolders, getChildFilesOfFolders, folderFullPath } from "../lib/fs";
import type { FileRow, FolderRow, UserRow } from "../db/schema";

/**
 * 对象操作路由：/api/v3/object
 * 对应原版 routers/controllers/object.go + service/explorer/objects.go。
 *   DELETE /object          —— 删除（批量）
 *   PATCH   /object         —— 移动
 *   POST    /object/rename  —— 重命名
 *   POST    /object/copy    —— 复制
 */
const object = new Hono<Ctx>();

object.use("*", authRequired, phoneRequired);

interface ObjectRef {
  type: "file" | "folder";
  id: number;
}

function parseRefs(list: unknown[]): ObjectRef[] {
  const out: ObjectRef[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const fid = decodeHashID(item, IDType.FileID);
    if (fid) {
      out.push({ type: "file", id: fid });
      continue;
    }
    const did = decodeHashID(item, IDType.FolderID);
    if (did) out.push({ type: "folder", id: did });
  }
  return out;
}

async function loadPolicy(id: number) {
  const rows = await db()
    .select()
    .from(policyTable)
    .where(and(eq(policyTable.id, id), isNull(policyTable.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** 删除对象（批量），同时删除存储后端对象 */
object.delete("/", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as { items?: string[] };
  const refs = parseRefs(body.items ?? []);
  if (refs.length === 0) return c.json(Err(Code.ParamErr, "items 不能为空"));

  const group = await db().select().from(groups).where(eq(groups.id, u.groupId)).limit(1);

  const fileRefs = refs.filter((r) => r.type === "file");
  const folderRefs = refs.filter((r) => r.type === "folder");

  // 校验归属并收集待删文件
  const fileIDs = fileRefs.map((r) => r.id);
  const fileRows = fileIDs.length
    ? await db()
        .select()
        .from(files)
        .where(and(inArray(files.id, fileIDs), eq(files.userId, u.id), isNull(files.deletedAt)))
    : [];

  const folderIDs = folderRefs.map((r) => r.id);
  const childFolders = folderIDs.length ? await getRecursiveChildFolders(u.id, folderIDs, true) : [];
  const childFiles = childFolders.length ? await getChildFilesOfFolders(childFolders.map((f) => f.id)) : [];

  const allFiles = [...fileRows, ...childFiles];
  if (allFiles.length === 0 && childFolders.length === 0) {
    return c.json(ok(null));
  }

  // 删除存储后端对象
  const policyCache = new Map<number, StorageDriver>();
  for (const f of allFiles) {
    let driver = policyCache.get(f.policyId);
    if (!driver) {
      const p = await loadPolicy(f.policyId);
      if (!p) continue;
      driver = new StorageDriver(toPolicyRuntime(c, p));
      policyCache.set(f.policyId, driver);
    }
    if (driver.p.isBoundR2 && c.env.R2_BUCKET) {
      await c.env.R2_BUCKET.delete(f.sourceName).catch(() => {});
    } else {
      await driver.delete(f.sourceName).catch(() => {});
    }
  }

  // 软删除数据库记录（写穿透到副库）
  const allFileIDs = allFiles.map((f) => f.id);
  if (allFileIDs.length) {
    await writeThrough((d) =>
      d.update(files).set({ deletedAt: new Date() }).where(inArray(files.id, allFileIDs)),
    );
  }
  if (childFolders.length) {
    await writeThrough((d) =>
      d
        .update(folders)
        .set({ deletedAt: new Date() })
        .where(inArray(folders.id, childFolders.map((f) => f.id))),
    );
  }

  // 回收容量：用户已用容量减去被删文件大小
  const totalSize = allFiles.reduce((acc, f) => acc + f.size, 0);
  if (totalSize > 0) {
    await writeThrough((d) =>
      d
        .update(users)
        .set({ storage: Math.max(0, u.storage - totalSize) })
        .where(eq(users.id, u.id)),
    );
  }

  // 清理缓存
  await Promise.all([
    ...allFileIDs.map((id) => cache.delete(`file:${id}`).catch(() => {})),
    ...childFolders.map((f) => cache.delete(`folder_list:${u.id}:${f.id}`).catch(() => {})),
  ]);

  return c.json(ok(null));
});

/** 移动对象 */
object.patch("/", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    action?: string;
    src?: string[];
    dst?: string;
  };
  if (body.action !== "move") return c.json(Err(Code.ParamErr, "不支持的 action"));
  const refs = parseRefs(body.src ?? []);
  const dstPath = cleanPath(body.dst ?? "/");
  if (refs.length === 0) return c.json(Err(Code.ParamErr, "src 不能为空"));
  if (dstPath === "/") return c.json(Err(Code.RootProtected, "无法移动到根目录"));

  const dstFolder = await resolveFolder(u.id, dstPath, true);
  if (!dstFolder) return c.json(Err(Code.ParentNotExist, "目标目录不存在"));

  // 移动的是目录时，目标不能是自身或自身的子目录
  const movingFolderIDs = refs.filter((r) => r.type === "folder").map((r) => r.id);
  if (movingFolderIDs.length) {
    const ancestors = new Set<number>();
    let cur: FolderRow | null = dstFolder;
    while (cur && cur.parentId !== null) {
      ancestors.add(cur.id);
      const rows = await db()
        .select()
        .from(folders)
        .where(and(eq(folders.id, cur.parentId), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
        .limit(1);
      cur = rows[0] ?? null;
    }
    for (const fid of movingFolderIDs) {
      if (ancestors.has(fid) || dstFolder.id === fid) {
        return c.json(Err(Code.NoPermissionErr, "无法将目录移动到其子目录内"));
      }
    }
  }

  const now = new Date();
  const fileIDs = refs.filter((r) => r.type === "file").map((r) => r.id);
  if (fileIDs.length) {
    const rows = await db()
      .select()
      .from(files)
      .where(and(inArray(files.id, fileIDs), eq(files.userId, u.id), isNull(files.deletedAt)));
    for (const f of rows) {
      const conflict = await db()
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.name, f.name), eq(files.folderId, dstFolder.id), ne(files.id, f.id), isNull(files.deletedAt)))
        .limit(1);
      if (conflict.length > 0) return c.json(Err(Code.ObjectExist, `同名文件已存在：${f.name}`));
    }
    await writeThrough((d) =>
      d.update(files).set({ folderId: dstFolder.id, updatedAt: now }).where(inArray(files.id, rows.map((f) => f.id))),
    );
    await Promise.all(rows.map((f) => cache.delete(`file:${f.id}`).catch(() => {})));
  }

  for (const fid of movingFolderIDs) {
    const rows = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.id, fid), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
      .limit(1);
    const src = rows[0];
    if (!src) continue;
    const conflict = await db()
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.name, src.name), eq(folders.parentId, dstFolder.id), ne(folders.id, src.id), isNull(folders.deletedAt)))
      .limit(1);
    if (conflict.length > 0) return c.json(Err(Code.ObjectExist, `同名目录已存在：${src.name}`));
    await writeThrough((d) =>
      d
        .update(folders)
        .set({ parentId: dstFolder.id, updatedAt: now })
        .where(and(eq(folders.id, src.id), eq(folders.ownerId, u.id))),
    );
    await cache.delete(`folder_list:${u.id}:${src.parentId}`).catch(() => {});
  }
  await cache.delete(`folder_list:${u.id}:${dstFolder.id}`).catch(() => {});

  return c.json(ok(null));
});

/** 重命名对象 */
object.post("/rename", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    id?: string;
    new_name?: string;
  };
  const id = String(body.id ?? "");
  const newName = String(body.new_name ?? "");
  requireParam(isLegalObjectName(newName), "新名称不合法");

  const fid = decodeHashID(id, IDType.FileID);
  if (fid) {
    const rows = await db()
      .select()
      .from(files)
      .where(and(eq(files.id, fid), eq(files.userId, u.id), isNull(files.deletedAt)))
      .limit(1);
    const target = rows[0];
    if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));
    const conflict = await db()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.name, newName), eq(files.folderId, target.folderId), ne(files.id, target.id), isNull(files.deletedAt)))
      .limit(1);
    if (conflict.length > 0) return c.json(Err(Code.ObjectExist, "同名文件已存在"));
    await writeThrough((d) => d.update(files).set({ name: newName, updatedAt: new Date() }).where(eq(files.id, target.id)));
    await cache.delete(`file:${target.id}`).catch(() => {});
    return c.json(ok(null));
  }

  const did = decodeHashID(id, IDType.FolderID);
  if (did) {
    const rows = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.id, did), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
      .limit(1);
    const target = rows[0];
    if (!target) return c.json(Err(Code.FileNotFound, "目录不存在"));
    if (target.parentId === null) return c.json(Err(Code.RootProtected, "无法重命名根目录"));
    const conflict = await db()
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.name, newName), eq(folders.parentId, target.parentId), ne(folders.id, target.id), isNull(folders.deletedAt)))
      .limit(1);
    if (conflict.length > 0) return c.json(Err(Code.ObjectExist, "同名目录已存在"));
    await writeThrough((d) =>
      d.update(folders).set({ name: newName, updatedAt: new Date() }).where(eq(folders.id, target.id)),
    );
    await cache.delete(`folder_list:${u.id}:${target.parentId}`).catch(() => {});
    return c.json(ok(null));
  }

  return c.json(Err(Code.ParamErr, "无法解析对象 ID"));
});

export default object;
