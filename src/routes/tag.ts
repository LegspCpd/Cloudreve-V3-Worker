import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { tags, files } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code } from "../lib/errors";
import { authRequired } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { cache } from "../lib/cache";
import { uuid } from "../lib/utils";
import type { UserRow } from "../db/schema";

/**
 * 用户标签路由：/api/v3/tag
 * 对应原版 routers/controllers/tag.go + service/explorer/tag.go。
 *   POST   /tag/filter —— 创建文件分类标签（type=1）
 *   POST   /tag/link   —— 创建目录快捷方式标签（type=2）
 *   DELETE /tag/:id    —— 删除标签
 */
const tag = new Hono<Ctx>();

tag.use("*", authRequired);

tag.post("/filter", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    name?: string;
    color?: string;
    icon?: string;
    expression?: string;
  };
  if (!body.name) return c.json(Err(Code.ParamErr, "标签名不能为空"));

  const inserted = await writeThrough((d) =>
    d
      .insert(tags)
      .values({
        name: body.name as string,
        icon: body.icon ?? "",
        color: body.color ?? "",
        type: 1,
        expression: body.expression ?? "",
        userId: u.id,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.DBError, "创建标签失败"));
  await cache.delete(`tags:${u.id}`).catch(() => {});
  return c.json(ok(hashIDE(row.id, IDType.TagID)));
});

tag.post("/link", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    name?: string;
    path?: string;
    color?: string;
    icon?: string;
  };
  if (!body.name || !body.path) return c.json(Err(Code.ParamErr, "标签名与目录路径不能为空"));

  const inserted = await writeThrough((d) =>
    d
      .insert(tags)
      .values({
        name: body.name as string,
        icon: body.icon ?? "",
        color: body.color ?? "",
        type: 2,
        expression: body.path as string,
        userId: u.id,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.DBError, "创建标签失败"));
  await cache.delete(`tags:${u.id}`).catch(() => {});
  return c.json(ok(hashIDE(row.id, IDType.TagID)));
});

tag.delete("/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.TagID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析标签 ID"));

  const rows = await db()
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, u.id), isNull(tags.deletedAt)))
    .limit(1);
  if (!rows[0]) return c.json(Err(Code.NotFound, "标签不存在"));

  await writeThrough((d) => d.update(tags).set({ deletedAt: new Date() }).where(eq(tags.id, id)));
  await cache.delete(`tags:${u.id}`).catch(() => {});
  return c.json(ok(null));
});

export default tag;
