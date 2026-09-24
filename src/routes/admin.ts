import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import {
  users,
  groups,
  policies as policyTable,
  files,
  folders,
  shares,
  orders,
  downloads,
  tasks,
  reports,
  nodes,
  redeems,
  settings as settingsTable,
} from "../db/schema";
import { and, eq, isNull, ne, inArray, like, or, desc, sql as sqlExpr, count } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, isAdmin } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { setting } from "../lib/settings";
import { cache } from "../lib/cache";
import { sendMail } from "../lib/email";
import { randString, uuid, cleanPath } from "../lib/utils";
import { toPolicyRuntime } from "../storage/policy";
import { StorageDriver } from "../storage/driver";
import { hashPassword } from "../lib/password";
import { parseUserOptions, parseGroupOptions, parsePolicyOptions } from "../lib/serializer";
import type { UserRow } from "../db/schema";

/**
 * 后台管理路由：/api/v3/admin/*
 * 对应原版 routers/controllers/admin*.go。
 * 全部需要登录且为管理员。
 */
const admin = new Hono<Ctx>();

admin.use("*", authRequired, isAdmin);

// ── 站点概况 ──

admin.get("/summary", async (c) => {
  const [userCount, fileCount, shareCount, storageUsed] = await Promise.all([
    db().select({ c: count() }).from(users).where(isNull(users.deletedAt)),
    db().select({ c: count() }).from(files).where(isNull(files.deletedAt)),
    db().select({ c: count() }).from(shares).where(isNull(shares.deletedAt)),
    db().select({ s: sqlExpr`COALESCE(sum(${files.size}), 0)` }).from(files).where(isNull(files.deletedAt)),
  ]);
  return c.json(
    ok({
      users: userCount[0]?.c ?? 0,
      files: fileCount[0]?.c ?? 0,
      shares: shareCount[0]?.c ?? 0,
      storage: storageUsed[0]?.s ?? 0,
      version: "v3-worker",
      site_id: await setting.get("siteID"),
    }),
  );
});

// ── 设置 ──

admin.post("/setting", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { keys?: string[] };
  const keys = body.keys ?? [];
  const values = await setting.getMany(keys);
  return c.json(ok(values));
});

admin.patch("/setting", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, string>;
  if (Object.keys(body).length === 0) return c.json(Err(Code.ParamErr, "没有需要更新的设置项"));
  await setting.setMany(body);
  cache.flushMemo();
  return c.json(ok(null));
});

// ── 用户组 ──

admin.post("/groups", async (c) => {
  const rows = await db().select().from(groups).where(isNull(groups.deletedAt)).orderBy(groups.id);
  return c.json(ok(rows.map((g) => ({ ...g, policies: parsePolicyListSafe(g.policies), options: parseGroupOptions(g.options) }))));
});

admin.post("/group/list", async (c) => {
  const rows = await db().select().from(groups).where(isNull(groups.deletedAt)).orderBy(groups.id);
  return c.json(ok(rows));
});

admin.get("/group/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await db().select().from(groups).where(and(eq(groups.id, id), isNull(groups.deletedAt))).limit(1);
  if (!rows[0]) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  return c.json(ok(rows[0]));
});

admin.post("/group", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    id?: number;
    name?: string;
    policies?: number[];
    max_storage?: number;
    share_enabled?: boolean;
    webdav_enabled?: boolean;
    speed_limit?: number;
    options?: Record<string, unknown>;
  };
  if (!body.name) return c.json(Err(Code.ParamErr, "用户组名称不能为空"));
  if (body.id === 1 && body.name !== "Admin") {
    return c.json(Err(Code.InvalidActionOnSystemGroup, "不能修改默认管理组名称"));
  }

  const values = {
    name: body.name,
    policies: JSON.stringify(body.policies ?? []),
    maxStorage: Math.max(0, Number(body.max_storage ?? 0)),
    shareEnabled: !!body.share_enabled,
    webdavEnabled: !!body.webdav_enabled,
    speedLimit: Math.max(0, Number(body.speed_limit ?? 0)),
    options: JSON.stringify(body.options ?? {}),
  };

  if (body.id) {
    const gid = body.id;
    await writeThrough((d) => d.update(groups).set(values).where(eq(groups.id, gid)));
    return c.json(ok(body.id));
  }
  const inserted = await writeThrough((d) => d.insert(groups).values(values).returning());
  return c.json(ok(inserted.data[0]?.id));
});

admin.delete("/group/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id <= 3) return c.json(Err(Code.InvalidActionOnSystemGroup, "不能删除系统用户组"));
  const inUse = await db().select({ c: count() }).from(users).where(and(eq(users.groupId, id), isNull(users.deletedAt)));
  if ((inUse[0]?.c ?? 0) > 0) return c.json(Err(Code.GroupUsedByUser, "该用户组下仍有用户"));
  await writeThrough((d) => d.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, id)));
  return c.json(ok(null));
});

// ── 用户 ──

admin.post("/user/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    page?: number;
    page_size?: number;
    keywords?: string;
    group_id?: number;
    status?: number;
  };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const conds = [isNull(users.deletedAt)];
  if (body.keywords) {
    conds.push(or(like(users.email, `%${body.keywords}%`), like(users.nick, `%${body.keywords}%`))!);
  }
  if (body.group_id) conds.push(eq(users.groupId, Number(body.group_id)));
  if (body.status !== undefined) conds.push(eq(users.status, Number(body.status)));

  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(users)
      .where(and(...conds))
      .orderBy(desc(users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(users).where(and(...conds)),
  ]);
  return c.json(
    ok({
      pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize },
      items: rows.map((u) => ({
        ...u,
        password: "",
        options: parseUserOptions(u.options),
      })),
    }),
  );
});

admin.get("/user/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await db().select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1);
  if (!rows[0]) return c.json(Err(Code.UserNotFound, "用户不存在"));
  return c.json(ok({ ...rows[0], password: "" }));
});

admin.post("/user", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    id?: number;
    email?: string;
    nick?: string;
    password?: string;
    status?: number;
    group_id?: number;
    storage?: number;
    score?: number;
  };
  if (!body.email) return c.json(Err(Code.ParamErr, "邮箱不能为空"));
  if (body.group_id === 1 && body.id !== 1) {
    // 允许提升为管理员
  }

  const existed = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, body.email), ne(users.id, body.id ?? 0), isNull(users.deletedAt)))
    .limit(1);
  if (existed[0]) return c.json(Err(Code.EmailExisted, "邮箱已被占用"));

  if (body.id) {
    const patch: Record<string, unknown> = {
      email: body.email,
      nick: body.nick ?? "",
      status: Number(body.status ?? 0),
      groupId: Number(body.group_id ?? 2),
      score: Number(body.score ?? 0),
    };
    if (body.storage !== undefined) patch.storage = Math.max(0, Number(body.storage));
    if (body.password) patch.password = hashPassword(body.password);
    const uid = body.id;
    await writeThrough((d) => d.update(users).set(patch).where(eq(users.id, uid)));
    await cache.delete(`user:${uid}`).catch(() => {});
    return c.json(ok(body.id));
  }

  if (!body.password) return c.json(Err(Code.ParamErr, "新建用户必须设置密码"));
  const email = body.email as string;
  const hashed = await hashPassword(body.password as string);
  const inserted = await writeThrough((d) =>
    d
      .insert(users)
      .values({
        email,
        nick: body.nick ?? email.split("@")[0] ?? "",
        password: hashed,
        status: Number(body.status ?? 0),
        groupId: Number(body.group_id ?? 2),
        storage: 0,
        score: Number(body.score ?? 0),
      })
      .returning(),
  );
  return c.json(ok(inserted.data[0]?.id));
});

admin.post("/user/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  if (ids.includes(1)) return c.json(Err(Code.InvalidActionOnDefaultUser, "不能删除初始管理员账户"));
  await writeThrough((d) => d.update(users).set({ deletedAt: new Date() }).where(inArray(users.id, ids)));
  await Promise.all(ids.map((id) => cache.delete(`user:${id}`).catch(() => {})));
  return c.json(ok(null));
});

admin.patch("/user/ban/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const desired = c.req.param("desired");
  if (id === 1) return c.json(Err(Code.InvalidActionOnDefaultUser, "不能封禁初始管理员账户"));
  const status = desired === "1" ? 2 : 0;
  await writeThrough((d) => d.update(users).set({ status }).where(eq(users.id, id)));
  await cache.delete(`user:${id}`).catch(() => {});
  return c.json(ok(null));
});

// ── 存储策略 ──

admin.post("/policy/list", async (c) => {
  const rows = await db()
    .select()
    .from(policyTable)
    .where(isNull(policyTable.deletedAt))
    .orderBy(policyTable.id);
  return c.json(ok(rows));
});

admin.get("/policy/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await db()
    .select()
    .from(policyTable)
    .where(and(eq(policyTable.id, id), isNull(policyTable.deletedAt)))
    .limit(1);
  if (!rows[0]) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  return c.json(ok(rows[0]));
});

admin.post("/policy", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const id = Number(body.id ?? 0);
  const values = {
    name: String(body.name ?? ""),
    type: String(body.type ?? "s3"),
    server: String(body.server ?? ""),
    bucketName: String(body.bucket_name ?? ""),
    isPrivate: !!body.is_private,
    baseUrl: String(body.base_url ?? ""),
    accessKey: String(body.access_key ?? ""),
    secretKey: String(body.secret_key ?? ""),
    maxSize: Math.max(0, Number(body.max_size ?? 0)),
    autoRename: !!body.auto_rename,
    dirNameRule: String(body.dir_name_rule ?? "uploads/{uid}/{path}"),
    fileNameRule: String(body.file_name_rule ?? "{uid}_{randomkey8}_{originname}"),
    isOriginLinkEnable: !!body.is_origin_link_enable,
    options: typeof body.options === "string" ? body.options : JSON.stringify(body.options ?? {}),
  };
  if (!values.name) return c.json(Err(Code.ParamErr, "策略名称不能为空"));
  if (!values.type) return c.json(Err(Code.ParamErr, "策略类型不能为空"));

  if (id) {
    await writeThrough((d) => d.update(policyTable).set(values).where(eq(policyTable.id, id)));
    await cache.delete(`policy:${id}`).catch(() => {});
    return c.json(ok(id));
  }
  const inserted = await writeThrough((d) => d.insert(policyTable).values(values).returning());
  return c.json(ok(inserted.data[0]?.id));
});

admin.delete("/policy/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 1) return c.json(Err(Code.DeleteDefaultPolicy, "不能删除默认存储策略"));
  const inFiles = await db()
    .select({ c: count() })
    .from(files)
    .where(and(eq(files.policyId, id), isNull(files.deletedAt)));
  if ((inFiles[0]?.c ?? 0) > 0) return c.json(Err(Code.PolicyUsedByFiles, "该策略仍被文件使用"));
  const groupRows = await db().select().from(groups).where(isNull(groups.deletedAt));
  for (const g of groupRows) {
    const list = parsePolicyListSafe(g.policies);
    if (list.includes(id)) {
      return c.json(Err(Code.PolicyUsedByGroups, `用户组「${g.name}」仍在使用该策略`));
    }
  }
  await writeThrough((d) => d.update(policyTable).set({ deletedAt: new Date() }).where(eq(policyTable.id, id)));
  return c.json(ok(null));
});

admin.post("/policy/test/slave", (c) => c.json(ok(null)));
admin.post("/policy/test/path", (c) => c.json(ok(null)));
admin.post("/policy/cors", (c) => c.json(ok(null)));
admin.post("/policy/scf", (c) => c.json(ok(null)));

// ── 文件 ──

admin.post("/file/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    page?: number;
    page_size?: number;
    keywords?: string;
    user_id?: number;
  };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const conds = [isNull(files.deletedAt)];
  if (body.keywords) conds.push(like(files.name, `%${body.keywords}%`));
  if (body.user_id) conds.push(eq(files.userId, Number(body.user_id)));

  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(files)
      .where(and(...conds))
      .orderBy(desc(files.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(files).where(and(...conds)),
  ]);
  return c.json(
    ok({
      pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize },
      items: rows,
    }),
  );
});

admin.post("/file/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) return c.json(Err(Code.ParamErr, "ids 不能为空"));

  const rows = await db().select().from(files).where(inArray(files.id, ids));
  const policyCache = new Map<number, StorageDriver>();
  for (const f of rows) {
    let driver = policyCache.get(f.policyId);
    if (!driver) {
      const p = await db().select().from(policyTable).where(eq(policyTable.id, f.policyId)).limit(1);
      if (!p[0]) continue;
      driver = new StorageDriver(toPolicyRuntime(c, p[0]));
      policyCache.set(f.policyId, driver);
    }
    if (driver.p.isBoundR2 && c.env.R2_BUCKET) {
      await c.env.R2_BUCKET.delete(f.sourceName).catch(() => {});
    } else {
      await driver.delete(f.sourceName).catch(() => {});
    }
  }
  await writeThrough((d) => d.update(files).set({ deletedAt: new Date() }).where(inArray(files.id, ids)));
  await Promise.all(ids.map((id) => cache.delete(`file:${id}`).catch(() => {})));
  return c.json(ok(null));
});

admin.get("/file/preview/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await db().select().from(files).where(and(eq(files.id, id), isNull(files.deletedAt))).limit(1);
  const target = rows[0];
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));
  const policyRow = await db().select().from(policyTable).where(eq(policyTable.id, target.policyId)).limit(1);
  if (!policyRow[0]) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policyRow[0]);
  c.header("Content-Security-Policy", "sandbox");

  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const obj = await c.env.R2_BUCKET.get(target.sourceName);
    if (!obj) return c.json(Err(Code.FileNotFound, "对象不存在"));
    return c.newResponse(obj.body, 200, {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
    });
  }
  const resp = await new StorageDriver(runtime).getStream(target.sourceName);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

admin.get("/file/folders/:type/:id/*path", async (c) => {
  // 列出用户网盘目录（供后台选择挂载目录）
  const uid = Number(c.req.param("id"));
  const raw = decodeURIComponent(c.req.param("path") || "/");
  const path = cleanPath(raw);
  if (uid <= 0) return c.json(ok({ parent: "", objects: [] }));
  const folder = await resolveFolderSafe(uid, path);
  if (!folder) return c.json(Err(Code.ParentNotExist, "目录不存在"));
  const [childFolders, childFiles] = await Promise.all([
    db().select().from(folders).where(and(eq(folders.parentId, folder.id), isNull(folders.deletedAt))),
    db().select().from(files).where(and(eq(files.folderId, folder.id), isNull(files.deletedAt))),
  ]);
  return c.json(
    ok({
      parent: folder.parentId === null ? "" : hashIDE(folder.id, IDType.FolderID),
      objects: [
        ...childFolders.map((f) => ({
          id: hashIDE(f.id, IDType.FolderID),
          name: f.name,
          path,
          type: "dir",
          size: 0,
          date: f.updatedAt.toISOString(),
          create_date: f.createdAt.toISOString(),
          thumb: false,
          source_enabled: false,
        })),
        ...childFiles.map((f) => ({
          id: hashIDE(f.id, IDType.FileID),
          name: f.name,
          path,
          type: "file",
          size: f.size,
          date: f.updatedAt.toISOString(),
          create_date: f.createdAt.toISOString(),
          thumb: false,
          source_enabled: false,
        })),
      ],
    }),
  );
});

// ── 分享 / 订单 / 下载任务 / 异步任务 / 举报 / 节点 / 兑换码 ──

admin.post("/share/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(shares)
      .where(isNull(shares.deletedAt))
      .orderBy(desc(shares.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(shares).where(isNull(shares.deletedAt)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/share/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  await writeThrough((d) => d.update(shares).set({ deletedAt: new Date() }).where(inArray(shares.id, ids)));
  return c.json(ok(null));
});

admin.post("/order/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(orders)
      .where(isNull(orders.deletedAt))
      .orderBy(desc(orders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(orders).where(isNull(orders.deletedAt)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/order/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  await writeThrough((d) => d.update(orders).set({ deletedAt: new Date() }).where(inArray(orders.id, ids)));
  return c.json(ok(null));
});

admin.post("/download/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(downloads)
      .where(isNull(downloads.deletedAt))
      .orderBy(desc(downloads.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(downloads).where(isNull(downloads.deletedAt)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/download/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  await writeThrough((d) => d.update(downloads).set({ deletedAt: new Date() }).where(inArray(downloads.id, ids)));
  return c.json(ok(null));
});

admin.post("/task/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number; type?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const conds = [isNull(tasks.deletedAt)];
  if (body.type !== undefined) conds.push(eq(tasks.type, Number(body.type)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(tasks).where(and(...conds)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/task/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  await writeThrough((d) => d.update(tasks).set({ deletedAt: new Date() }).where(inArray(tasks.id, ids)));
  return c.json(ok(null));
});

admin.post("/task/import", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    policy_id?: number;
    src?: string;
    dst?: string;
    recursive?: boolean;
  };
  const inserted = await writeThrough((d) =>
    d
      .insert(tasks)
      .values({
        status: 0,
        type: 5,
        userId: u.id,
        progress: 0,
        error: "",
        props: JSON.stringify({
          policy_id: Number(body.policy_id ?? 1),
          src: body.src ?? "",
          dst: body.dst ?? "/",
          recursive: !!body.recursive,
        }),
      })
      .returning(),
  );
  return c.json(ok(inserted.data[0]?.id));
});

admin.post("/report/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(reports)
      .where(isNull(reports.deletedAt))
      .orderBy(desc(reports.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(reports).where(isNull(reports.deletedAt)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/report/delete", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return c.json(Err(Code.ParamErr, "ids 不能为空"));
  await writeThrough((d) => d.update(reports).set({ deletedAt: new Date() }).where(inArray(reports.id, ids)));
  return c.json(ok(null));
});

admin.post("/node/list", async (c) => {
  const rows = await db().select().from(nodes).where(isNull(nodes.deletedAt)).orderBy(nodes.rank, nodes.id);
  return c.json(ok(rows));
});

admin.get("/node/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await db().select().from(nodes).where(and(eq(nodes.id, id), isNull(nodes.deletedAt))).limit(1);
  if (!rows[0]) return c.json(Err(Code.MasterNotFound, "节点不存在"));
  return c.json(ok(rows[0]));
});

admin.post("/node", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const id = Number(body.id ?? 0);
  const values = {
    status: Number(body.status ?? 0),
    name: String(body.name ?? ""),
    type: Number(body.type ?? 1),
    server: String(body.server ?? ""),
    slaveKey: String(body.slave_key ?? ""),
    masterKey: String(body.master_key ?? ""),
    aria2Enabled: !!body.aria2_enabled,
    aria2Options:
      typeof body.aria2_options === "string" ? body.aria2_options : JSON.stringify(body.aria2_options ?? {}),
    rank: Number(body.rank ?? 0),
  };
  if (id) {
    if (id === 1) return c.json(Err(Code.InvalidActionOnSystemNode, "不能修改主节点"));
    await writeThrough((d) => d.update(nodes).set(values).where(eq(nodes.id, id)));
    return c.json(ok(id));
  }
  const inserted = await writeThrough((d) => d.insert(nodes).values(values).returning());
  return c.json(ok(inserted.data[0]?.id));
});

admin.patch("/node/enable/:id/:desired", async (c) => {
  const id = Number(c.req.param("id"));
  const desired = c.req.param("desired");
  if (id === 1) return c.json(Err(Code.InvalidActionOnSystemNode, "不能停用主节点"));
  await writeThrough((d) =>
    d
      .update(nodes)
      .set({ status: desired === "1" ? 0 : 1 })
      .where(eq(nodes.id, id)),
  );
  return c.json(ok(null));
});

admin.delete("/node/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 1) return c.json(Err(Code.InvalidActionOnSystemNode, "不能删除主节点"));
  await writeThrough((d) => d.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, id)));
  return c.json(ok(null));
});

admin.post("/node/aria2/test", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { server?: string; secret?: string };
  if (!body.server) return c.json(Err(Code.ParamErr, "Aria2 RPC 地址不能为空"));
  try {
    const resp = await fetch(body.server.replace(/\/$/, "") + "/jsonrpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: uuid(), method: "aria2.getVersion", params: body.secret ? [`token:${body.secret}`] : [] }),
    });
    const json = (await resp.json()) as { result?: { version?: string }; error?: unknown };
    if (json.error) return c.json(Err(Code.NodeOffline, "Aria2 连接失败"));
    return c.json(ok({ version: json.result?.version ?? "unknown" }));
  } catch (e) {
    return c.json(Err(Code.NodeOffline, `Aria2 连接失败：${String((e as Error).message)}`));
  }
});

admin.post("/redeem/list", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { page?: number; page_size?: number };
  const page = Math.max(1, Number(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size ?? 15)));
  const [rows, totalRows] = await Promise.all([
    db()
      .select()
      .from(redeems)
      .where(isNull(redeems.deletedAt))
      .orderBy(desc(redeems.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ c: count() }).from(redeems).where(isNull(redeems.deletedAt)),
  ]);
  return c.json(
    ok({ pagination: { total: totalRows[0]?.c ?? 0, page, page_size: pageSize }, items: rows }),
  );
});

admin.post("/redeem", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    type?: number;
    product_id?: number;
    num?: number;
    count?: number;
  };
  const n = Math.min(200, Math.max(1, Number(body.count ?? 1)));
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = randString(24).toUpperCase();
    codes.push(code);
  }
  await writeThrough((d) =>
    d.insert(redeems).values(
      codes.map((code) => ({
        type: Number(body.type ?? 1),
        productId: Number(body.product_id ?? 0),
        num: Number(body.num ?? 0),
        code,
        used: false,
      })),
    ),
  );
  return c.json(ok(codes));
});

admin.delete("/redeem/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await writeThrough((d) => d.update(redeems).set({ deletedAt: new Date() }).where(eq(redeems.id, id)));
  return c.json(ok(null));
});

// ── 测试 ──

admin.post("/test/mail", async (c) => {
  const u = c.get("user") as UserRow;
  try {
    await sendMail(c, u.email, "Cloudreve 测试邮件", "这是一封来自 Cloudreve-V3-Worker 的测试邮件。");
    return c.json(ok(null));
  } catch (e) {
    return c.json(Err(Code.FailedSendEmail, String((e as Error).message)));
  }
});

admin.post("/test/thumb", (c) => c.json(ok(null)));
admin.post("/aria2/test", (c) => c.json(ok(null)));
admin.get("/vol/sync", (c) => c.json(ok(null)));
admin.get("/reload/:service", (c) => c.json(ok(null)));

// ── 辅助 ──

function parsePolicyListSafe(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}

async function resolveFolderSafe(uid: number, path: string) {
  const p = cleanPath(path);
  const rows = await db()
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, uid), eq(folders.name, baseNameOf(p) || "/"), isNull(folders.deletedAt)))
    .limit(1);
  if (rows[0]) return rows[0];
  if (p === "/") {
    const root = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.ownerId, uid), isNull(folders.parentId), isNull(folders.deletedAt)))
      .limit(1);
    if (root[0]) return root[0];
    const created = await writeThrough((d) =>
      d.insert(folders).values({ name: "/", ownerId: uid }).returning(),
    );
    return created.data[0];
  }
  return null;
}

function baseNameOf(p: string): string {
  const s = cleanPath(p);
  if (s === "/") return "/";
  return s.slice(s.lastIndexOf("/") + 1);
}

export default admin;
