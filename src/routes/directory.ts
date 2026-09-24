import { Hono } from "hono";
import type { Ctx } from "../env";
import { db } from "../db";
import { folders, files } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { ok, Err, ParamErr } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import {
  buildFileObject,
  buildFolderObject,
  buildPolicySummary,
} from "../lib/serializer";
import {
  getGroupByID,
  resolveFolder,
  getPolicyForUser,
  folderFullPath,
  getChildFolders,
  getChildFiles,
} from "../lib/fs";
import { hashID as hashIDE, IDType } from "../lib/hashid";
import { cleanPath, dirName, baseName } from "../lib/utils";
import type { UserRow } from "../db/schema";

interface ListObject {
  name: string;
  size: number;
  date: string;
}

/**
 * 目录路由：/api/v3/directory/*
 * 对应原版 routers/controllers/directory.go
 */
const directory = new Hono<Ctx>();

directory.use("*", authRequired, phoneRequired);

/**
 * 列出目录下内容。
 * 前端在客户端完成分页，此接口返回目录下全部对象（对齐原版行为）。
 * 查询参数 order_by（name/size/date）与 order（asc/desc）用于服务端排序。
 */
directory.get("/*path", async (c) => {
  const u = c.get("user") as UserRow;
  const rawPath = c.req.param("path") || "/";
  const path = cleanPath(decodeURIComponent(rawPath));
  const orderBy = (c.req.query("order_by") || "name").toLowerCase();
  const order = (c.req.query("order") || "asc").toLowerCase();

  const folder = await resolveFolder(u.id, path);
  if (!folder) return c.json(Err(Code.ParentNotExist, "parent folder does not exist"));

  const group = (await getGroupByID(u.groupId)) ?? undefined;
  const [childFolders, childFiles, fullPath, policy] = await Promise.all([
    getChildFolders(folder.id),
    getChildFiles(folder.id),
    folderFullPath(u.id, folder),
    getPolicyForUser(u, group as never, folder),
  ]);

  // 对象的 path 字段 = 所属目录的完整路径（根目录为 "/"）
  const position = fullPath;

  const objects: ListObject[] = [
    ...childFolders.map((f) => buildFolderObject(f, position)),
    ...childFiles.map((f) => buildFileObject(f, position)),
  ];

  const sortField = orderBy === "size" ? "size" : orderBy === "date" ? "date" : "name";
  const sortDir = order === "desc" ? -1 : 1;
  objects.sort((a, b) => {
    let r = 0;
    if (sortField === "size") r = a.size - b.size;
    else if (sortField === "date") r = a.date.localeCompare(b.date);
    else r = a.name.localeCompare(b.name, "zh");
    return r * sortDir;
  });

  return c.json(
    ok({
      parent: folder.parentId === null ? "" : hashIDE(folder.id, IDType.FolderID),
      objects,
      policy: buildPolicySummary(policy),
    }),
  );
});

// ── 创建目录 ──
directory.post("/", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({}));
  const path = cleanPath(String(body.path ?? ""));
  if (!path || path === "/") return c.json(Err(Code.RootProtected, "cannot create root folder"));

  const parentPath = dirName(path);
  const name = baseName(path);
  if (!name) return c.json(ParamErr("Invalid folder name"));

  const parent = await resolveFolder(u.id, parentPath);
  if (!parent) return c.json(Err(Code.ParentNotExist, "parent folder does not exist"));

  // 同名目录
  const existed = await db()
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.parentId, parent.id), eq(folders.name, name), isNull(folders.deletedAt)))
    .limit(1);
  if (existed.length > 0) return c.json(Err(Code.ObjectExist, "folder already exists"));

  const created = await db()
    .insert(folders)
    .values({ name, parentId: parent.id, ownerId: u.id })
    .returning();
  return c.json(ok(hashIDE(created[0]!.id, IDType.FolderID)));
});

// ── 目录挂载存储策略（WebDAV 相关）──
directory.post("/mount", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({}));
  const path = cleanPath(String(body.path ?? ""));
  const policyID = Number(body.policy_id ?? 0);
  if (!policyID) return c.json(ParamErr("policy_id is required"));

  const folder = await resolveFolder(u.id, path);
  if (!folder) return c.json(Err(Code.ParentNotExist, "folder does not exist"));

  await db().update(folders).set({ policyId: policyID }).where(eq(folders.id, folder.id));
  return c.json(ok(null));
});

export default directory;
