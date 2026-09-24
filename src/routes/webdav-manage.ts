import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { webdavs, folders, groups } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { uuid, cleanPath, randString } from "../lib/utils";
import { resolveFolder } from "../lib/fs";
import type { UserRow } from "../db/schema";

/**
 * WebDAV 管理路由：/api/v3/webdav
 * 对应原版 routers/controllers/webdav.go。
 *
 * WebDAV 协议本体由 /dav/* 提供（见 src/routes/webdav.ts），
 * 此处仅提供应用账号与目录挂载的增删改查。
 */
const webdav = new Hono<Ctx>();

webdav.use("*", authRequired, phoneRequired);

/** 当前用户的 WebDAV 应用账号 */
webdav.get("/accounts", async (c) => {
  const u = c.get("user") as UserRow;
  const rows = await db()
    .select()
    .from(webdavs)
    .where(and(eq(webdavs.userId, u.id), isNull(webdavs.deletedAt)));
  return c.json(
    ok(
      rows.map((r) => ({
        id: hashIDE(r.id, IDType.TagID),
        name: r.name,
        root: r.root,
        readonly: r.readonly,
        use_proxy: r.useProxy,
        // 密码只返回明文一次，列表接口返回空字符串
        password: "",
      })),
    ),
  );
});

/** 新建账号（返回明文密码，仅此一次） */
webdav.post("/accounts", async (c) => {
  const u = c.get("user") as UserRow;
  const group = await db().select().from(groups).where(eq(groups.id, u.groupId)).limit(1);
  if (!group[0] || !group[0].webdavEnabled) {
    return c.json(Err(Code.FeatureNotEnabled, "当前用户组未启用 WebDAV"));
  }
  const body = await c.req.json().catch(() => ({})) as { name?: string };
  const name = body.name || "default";
  const password = randString(12);

  const inserted = await writeThrough((d) =>
    d
      .insert(webdavs)
      .values({
        name,
        password,
        userId: u.id,
        root: "/",
        readonly: false,
        useProxy: false,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.DBError, "创建账号失败"));
  return c.json(ok({ id: hashIDE(row.id, IDType.TagID), name, password }));
});

/** 删除账号 */
webdav.delete("/accounts/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.TagID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析账号 ID"));
  await writeThrough((d) =>
    d
      .update(webdavs)
      .set({ deletedAt: new Date() })
      .where(and(eq(webdavs.id, id), eq(webdavs.userId, u.id))),
  );
  return c.json(ok(null));
});

/** 更新账号属性（只读、是否走代理） */
webdav.patch("/accounts", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    id?: string;
    readonly?: boolean;
    use_proxy?: boolean;
  };
  const id = decodeHashID(body.id ?? "", IDType.TagID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析账号 ID"));
  const patch: Record<string, unknown> = {};
  if (body.readonly !== undefined) patch.readonly = !!body.readonly;
  if (body.use_proxy !== undefined) patch.useProxy = !!body.use_proxy;
  if (Object.keys(patch).length === 0) return c.json(ok(null));
  await writeThrough((d) =>
    d.update(webdavs).set(patch).where(and(eq(webdavs.id, id), eq(webdavs.userId, u.id))),
  );
  return c.json(ok(null));
});

/** 创建目录挂载（指定目录使用指定存储策略） */
webdav.post("/mount", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as { path?: string; policy_id?: number };
  const path = cleanPath(body.path ?? "/");
  const policyID = Number(body.policy_id ?? 0);
  if (!policyID) return c.json(Err(Code.ParamErr, "policy_id 不能为空"));

  const folder = await resolveFolder(u.id, path, true);
  if (!folder) return c.json(Err(Code.ParentNotExist, "目录不存在"));
  await writeThrough((d) => d.update(folders).set({ policyId: policyID }).where(eq(folders.id, folder.id)));
  return c.json(ok(null));
});

/** 删除目录挂载 */
webdav.delete("/mount/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FolderID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析目录 ID"));
  await writeThrough((d) =>
    d
      .update(folders)
      .set({ policyId: 0 })
      .where(and(eq(folders.id, id), eq(folders.ownerId, u.id))),
  );
  return c.json(ok(null));
});

export default webdav;
