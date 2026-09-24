import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { files, folders, webdavs, users, groups, policies as policyTable } from "../db/schema";
import { and, eq, isNull, inArray, ne } from "drizzle-orm";
import { Code, apiError } from "../lib/errors";
import { webdavAuth } from "../middleware";
import { cache } from "../lib/cache";
import { cleanPath, baseName, dirName, isLegalObjectName } from "../lib/utils";
import {
  resolveFolder,
  folderFullPath,
  getChildFiles,
  getChildFolders,
  getRecursiveChildFolders,
  getChildFilesOfFolders,
  generatePath,
} from "../lib/fs";
import { toPolicyRuntime } from "../storage/policy";
import { StorageDriver } from "../storage/driver";
import type { FileRow, FolderRow, UserRow, WebdavRow } from "../db/schema";

/**
 * WebDAV 协议路由：/dav/*
 * 对应原版 routers/controllers/webdav.go。
 *
 * 实现：PROPFIND / GET / PUT / MKCOL / DELETE / MOVE / COPY
 * 不实现 LOCK/UNLOCK（返回 405，前端与主流客户端均可正常工作）。
 *
 * 权限：使用 /api/v3/webdav 管理的应用账号（Basic 认证），
 * 账号的 root 字段决定可见的根目录。
 */
const dav = new Hono<Ctx>();

dav.use("*", webdavAuth);

/** 相对账号 root 的路径 */
function relativePath(root: string, full: string): string {
  const r = cleanPath(root);
  if (r === "/") return cleanPath(full);
  const f = cleanPath(full);
  return f.startsWith(r) ? cleanPath(f.slice(r.length)) : cleanPath(full);
}

/** 把相对路径解析为用户虚拟路径 */
function virtualPath(account: WebdavRow, rel: string): string {
  const r = cleanPath(account.root);
  return r === "/" ? cleanPath(rel) : cleanPath(r + "/" + rel);
}

/** PROPFIND：列目录 / 取文件属性 */
dav.on(["PROPFIND"], ["/*path", "/"], async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  const raw = decodeURIComponent(c.req.param("path") || "/");
  const rel = relativePath(account.root, raw);
  const vpath = virtualPath(account, rel);

  const folder = await resolveFolder(u.id, vpath);
  if (!folder) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);

  const depth = (c.req.header("depth") || "1").toLowerCase();
  const position = await folderFullPath(u.id, folder);

  const entries: { href: string; name: string; isDir: boolean; size: number; updatedAt: Date }[] = [
    { href: rel, name: folder.name, isDir: true, size: 0, updatedAt: folder.updatedAt },
  ];
  if (depth !== "0") {
    const [childFolders, childFiles] = await Promise.all([getChildFolders(folder.id), getChildFiles(folder.id)]);
    for (const f of childFolders) {
      entries.push({
        href: cleanPath(rel + "/" + f.name),
        name: f.name,
        isDir: true,
        size: 0,
        updatedAt: f.updatedAt,
      });
    }
    for (const f of childFiles) {
      entries.push({
        href: cleanPath(rel + "/" + f.name),
        name: f.name,
        isDir: false,
        size: f.size,
        updatedAt: f.updatedAt,
      });
    }
  }

  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<D:multistatus xmlns:D="DAV:">`,
    ...entries.map((e) => {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const href = encodeURI(cleanPath("/dav" + (e.href === "/" ? "/" : e.href)));
      return [
        `<D:response>`,
        `<D:href>${esc(href)}</D:href>`,
        `<D:propstat>`,
        `<D:prop>`,
        `<D:resourcetype>${e.isDir ? "<D:collection/>" : ""}</D:resourcetype>`,
        `<D:getcontentlength>${e.size}</D:getcontentlength>`,
        `<D:getlastmodified>${e.updatedAt.toUTCString()}</D:getlastmodified>`,
        `</D:prop>`,
        `<D:status>HTTP/1.1 200 OK</D:status>`,
        `</D:propstat>`,
        `</D:response>`,
      ].join("");
    }),
    `</D:multistatus>`,
  ].join("");

  c.header("Content-Type", "application/xml; charset=utf-8");
  return c.body(xml, 207);
});

/** GET：下载文件 */
dav.get("/*path", async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  const raw = decodeURIComponent(c.req.param("path") || "/");
  const rel = relativePath(account.root, raw);
  const name = baseName(rel);
  const parent = dirName(rel);

  const folder = await resolveFolder(u.id, virtualPath(account, parent));
  if (!folder) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);

  const rows = await db()
    .select()
    .from(files)
    .where(and(eq(files.name, name), eq(files.folderId, folder.id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  const target = rows[0];
  if (!target) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);

  const policyRow = await db()
    .select()
    .from(policyTable)
    .where(eq(policyTable.id, target.policyId))
    .limit(1);
  if (!policyRow[0]) return c.json({ code: Code.PolicyNotExist, msg: "storage policy not found" });
  const runtime = toPolicyRuntime(c, policyRow[0]);

  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const obj = await c.env.R2_BUCKET.get(target.sourceName);
    if (!obj) return c.json({ code: Code.FileNotFound, msg: "object not found" }, 404);
    return c.newResponse(obj.body, 200, {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
    });
  }
  const driver = new StorageDriver(runtime);
  const resp = await driver.getStream(target.sourceName, c.req.header("range") || undefined);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

/** PUT：上传/覆盖文件 */
dav.put("/*path", async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  if (account.readonly) return c.json({ code: Code.NoPermissionErr, msg: "Read-only account" }, 403);

  const raw = decodeURIComponent(c.req.param("path") || "/");
  const rel = relativePath(account.root, raw);
  const name = baseName(rel);
  const parent = dirName(rel);
  if (!isLegalObjectName(name)) return c.json({ code: Code.IllegalObjectName, msg: "Invalid name" }, 400);

  const folder = await resolveFolder(u.id, virtualPath(account, parent), true);
  if (!folder) return c.json({ code: Code.ParentNotExist, msg: "Parent not found" }, 404);

  const body = await c.req.arrayBuffer().catch(() => null);
  if (!body) return c.json({ code: Code.InvalidContentLength, msg: "Empty body" }, 400);

  const policyRow = await db()
    .select()
    .from(policyTable)
    .where(eq(policyTable.id, folder.policyId || 1))
    .limit(1);
  if (!policyRow[0]) return c.json({ code: Code.PolicyNotExist, msg: "storage policy not found" });
  const runtime = toPolicyRuntime(c, policyRow[0]);

  const dirRule = generatePath(policyRow[0], u.id, parent);
  const saveName = `${u.id}_${Date.now().toString(36)}_${name}`;
  const savePath = dirRule ? `${dirRule}/${saveName}` : saveName;

  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    await c.env.R2_BUCKET.put(savePath, body, {
      httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
    });
  } else {
    await new StorageDriver(runtime).putBuffer(savePath, body, c.req.header("content-type") ?? "application/octet-stream");
  }

  // 覆盖同名记录
  const existed = await db()
    .select()
    .from(files)
    .where(and(eq(files.name, name), eq(files.folderId, folder.id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  if (existed[0]) {
    await writeThrough((d) =>
      d
        .update(files)
        .set({ size: body.byteLength, sourceName: savePath, policyId: policyRow[0].id, updatedAt: new Date() })
        .where(eq(files.id, existed[0].id)),
    );
    if (runtime.isBoundR2 && c.env.R2_BUCKET) {
      await c.env.R2_BUCKET.delete(existed[0].sourceName).catch(() => {});
    } else {
      await new StorageDriver(runtime).delete(existed[0].sourceName).catch(() => {});
    }
    await cache.delete(`file:${existed[0].id}`).catch(() => {});
    return c.body(null, 204);
  }

  const inserted = await writeThrough(
    (d) =>
      d
        .insert(files)
        .values({
          name,
          sourceName: savePath,
          userId: u.id,
          size: body.byteLength,
          picInfo: "",
          folderId: folder.id,
          policyId: policyRow[0].id,
          metadata: "",
        })
        .returning(),
    (rows) => ({ keys: rows.map((r) => ({ key: `file:${r.id}`, value: JSON.stringify(r), ttl: 3600 })) }),
  );
  if (inserted.data[0]) {
    await writeThrough((d) =>
      d.update(users).set({ storage: u.storage + body.byteLength }).where(eq(users.id, u.id)),
    );
  }
  return c.body(null, 201);
});

/** MKCOL：创建目录 */
dav.on(["MKCOL"], ["/*path", "/"], async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  if (account.readonly) return c.json({ code: Code.NoPermissionErr, msg: "Read-only account" }, 403);

  const raw = decodeURIComponent(c.req.param("path") || "/");
  const rel = relativePath(account.root, raw);
  const name = baseName(rel);
  const parent = dirName(rel);
  if (!isLegalObjectName(name)) return c.json({ code: Code.IllegalObjectName, msg: "Invalid name" }, 400);

  const folder = await resolveFolder(u.id, virtualPath(account, parent), true);
  if (!folder) return c.json({ code: Code.ParentNotExist, msg: "Parent not found" }, 404);

  const existed = await db()
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.name, name), eq(folders.parentId, folder.id), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
    .limit(1);
  if (existed.length > 0) return c.json({ code: Code.ObjectExist, msg: "Exists" }, 405);

  await writeThrough((d) =>
    d.insert(folders).values({ name, parentId: folder.id, ownerId: u.id }).returning(),
  );
  return c.body(null, 201);
});

/** DELETE：删除文件或目录 */
dav.delete("/*path", async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  if (account.readonly) return c.json({ code: Code.NoPermissionErr, msg: "Read-only account" }, 403);

  const raw = decodeURIComponent(c.req.param("path") || "/");
  const rel = relativePath(account.root, raw);
  if (rel === "/") return c.json({ code: Code.RootProtected, msg: "Cannot delete root" }, 403);

  const name = baseName(rel);
  const parent = dirName(rel);
  const folder = await resolveFolder(u.id, virtualPath(account, parent));
  if (!folder) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);

  const fileRows = await db()
    .select()
    .from(files)
    .where(and(eq(files.name, name), eq(files.folderId, folder.id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  if (fileRows[0]) {
    const target = fileRows[0];
    const policyRow = await db()
      .select()
      .from(policyTable)
      .where(eq(policyTable.id, target.policyId))
      .limit(1);
    if (policyRow[0]) {
      const runtime = toPolicyRuntime(c, policyRow[0]);
      if (runtime.isBoundR2 && c.env.R2_BUCKET) {
        await c.env.R2_BUCKET.delete(target.sourceName).catch(() => {});
      } else {
        await new StorageDriver(runtime).delete(target.sourceName).catch(() => {});
      }
    }
    await writeThrough((d) => d.update(files).set({ deletedAt: new Date() }).where(eq(files.id, target.id)));
    await writeThrough((d) =>
      d.update(users).set({ storage: Math.max(0, u.storage - target.size) }).where(eq(users.id, u.id)),
    );
    await cache.delete(`file:${target.id}`).catch(() => {});
    return c.body(null, 204);
  }

  const folderRows = await db()
    .select()
    .from(folders)
    .where(and(eq(folders.name, name), eq(folders.parentId, folder.id), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
    .limit(1);
  if (!folderRows[0]) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);

  const targetFolder = folderRows[0];
  const childFolders = await getRecursiveChildFolders(u.id, [targetFolder.id], true);
  const childFiles = await getChildFilesOfFolders(childFolders.map((f) => f.id));
  await writeThrough((d) =>
    d.update(folders).set({ deletedAt: new Date() }).where(inArray(folders.id, childFolders.map((f) => f.id))),
  );
  if (childFiles.length) {
    await writeThrough((d) =>
      d.update(files).set({ deletedAt: new Date() }).where(inArray(files.id, childFiles.map((f) => f.id))),
    );
  }
  return c.body(null, 204);
});

/** MOVE / COPY：移动或复制 */
dav.on(["MOVE", "COPY"], ["/*path", "/"], async (c) => {
  const u = c.get("user") as UserRow;
  const account = c.get("webdav" as never) as WebdavRow;
  if (account.readonly && c.req.method === "MOVE") {
    return c.json({ code: Code.NoPermissionErr, msg: "Read-only account" }, 403);
  }

  const src = relativePath(account.root, decodeURIComponent(c.req.param("path") || "/"));
  const destURL = c.req.header("destination") || "";
  const dst = relativePath(account.root, decodeURIComponent(new URL(destURL).pathname));

  const srcName = baseName(src);
  const srcParent = dirName(src);
  const dstName = baseName(dst);
  const dstParent = dirName(dst);
  if (!isLegalObjectName(dstName)) return c.json({ code: Code.IllegalObjectName, msg: "Invalid name" }, 400);

  const srcFolder = await resolveFolder(u.id, virtualPath(account, srcParent));
  const dstFolder = await resolveFolder(u.id, virtualPath(account, dstParent), true);
  if (!srcFolder || !dstFolder) return c.json({ code: Code.ParentNotExist, msg: "Parent not found" }, 404);

  const fileRows = await db()
    .select()
    .from(files)
    .where(and(eq(files.name, srcName), eq(files.folderId, srcFolder.id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  if (!fileRows[0]) return c.json({ code: Code.FileNotFound, msg: "Not found" }, 404);
  const target = fileRows[0];

  if (c.req.method === "MOVE") {
    const conflict = await db()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.name, dstName), eq(files.folderId, dstFolder.id), ne(files.id, target.id), isNull(files.deletedAt)))
      .limit(1);
    if (conflict[0]) return c.json({ code: Code.ObjectExist, msg: "Exists" }, 409);
    await writeThrough((d) =>
      d
        .update(files)
        .set({ name: dstName, folderId: dstFolder.id, updatedAt: new Date() })
        .where(eq(files.id, target.id)),
    );
    await cache.delete(`file:${target.id}`).catch(() => {});
    return c.body(null, 201);
  }

  // COPY
  await writeThrough((d) =>
    d.insert(files).values({
      name: dstName,
      sourceName: target.sourceName,
      userId: u.id,
      size: target.size,
      picInfo: target.picInfo,
      folderId: dstFolder.id,
      policyId: target.policyId,
      metadata: target.metadata,
    }),
  );
  await writeThrough((d) =>
    d.update(users).set({ storage: u.storage + target.size }).where(eq(users.id, u.id)),
  );
  return c.body(null, 201);
});

/** 未实现的 DAV 方法 */
dav.on(["LOCK", "UNLOCK", "PROPPATCH"], ["/*path", "/"], (c) => c.body(null, 405));

export default dav;
