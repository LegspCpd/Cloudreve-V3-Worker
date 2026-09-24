import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { storagePacks, orders, redeems, users, groups } from "../db/schema";
import { and, eq, isNull, gt, inArray } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { setting } from "../lib/settings";
import { getAvailablePackSize } from "../lib/serializer";
import { getGroupByID } from "../lib/fs";
import { uuid, nowSec } from "../lib/utils";
import type { UserRow } from "../db/schema";

/**
 * 增值服务路由：/api/v3/vas
 * 对应原版 routers/controllers/vas.go。
 *
 * 说明：Worker 环境不内置支付网关对接；商品与订单数据结构完整保留，
 * 支付回调统一收敛到 /callback/*（custom 支付 + 自建支付终端可用）。
 */
const vas = new Hono<Ctx>();

vas.use("*", authRequired, phoneRequired);

/** 容量包及配额信息 */
vas.get("/pack", async (c) => {
  const u = c.get("user") as UserRow;
  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const packSize = await getAvailablePackSize(u.id);
  return c.json(
    ok({
      used: u.storage,
      free: Math.max(0, group.maxStorage + packSize - u.storage),
      total: group.maxStorage + packSize,
      packs: (
        await db()
          .select()
          .from(storagePacks)
          .where(and(eq(storagePacks.userId, u.id), isNull(storagePacks.deletedAt)))
      ).map((p) => ({
        id: hashIDE(p.id, IDType.TagID),
        name: p.name,
        size: p.size,
        active_time: p.activeTime ? p.activeTime.toISOString() : "",
        expired_time: p.expiredTime ? p.expiredTime.toISOString() : "",
      })),
    }),
  );
});

/** 商品信息（从设置项 pack_data 读取） */
vas.get("/product", async (c) => {
  const raw = await setting.getWithDefault("pack_data", "[]");
  let products: unknown[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) products = parsed;
  } catch {
    /* 保持空数组 */
  }
  const groupSellRaw = await setting.getWithDefault("group_sell_data", "[]");
  let groupSell: unknown[] = [];
  try {
    const parsed = JSON.parse(groupSellRaw);
    if (Array.isArray(parsed)) groupSell = parsed;
  } catch {
    /* noop */
  }
  return c.json(ok({ products, group_sell: groupSell }));
});

/** 新建支付订单 */
vas.post("/order", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    product_id?: number;
    method?: string;
    num?: number;
    price?: number;
    name?: string;
  };
  const num = Math.max(1, Number(body.num ?? 1));
  const price = Math.max(0, Number(body.price ?? 0));
  const orderNo = nowSec().toString(36).toUpperCase() + uuid().replace(/-/g, "").slice(0, 12).toUpperCase();

  const inserted = await writeThrough((d) =>
    d
      .insert(orders)
      .values({
        userId: u.id,
        orderNo,
        type: Number(body.product_id ?? 0),
        method: String(body.method ?? "custom"),
        productId: Number(body.product_id ?? 0),
        num,
        name: String(body.name ?? ""),
        price,
        status: 0,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.DBError, "创建订单失败"));
  return c.json(ok({ id: orderNo, order_no: orderNo, price, name: row.name }));
});

/** 查询订单状态 */
vas.get("/order/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const orderNo = c.req.param("id");
  const rows = await db()
    .select()
    .from(orders)
    .where(and(eq(orders.orderNo, orderNo), eq(orders.userId, u.id), isNull(orders.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json(Err(Code.NotFound, "订单不存在"));
  return c.json(ok({ id: row.orderNo, status: row.status, price: row.price, name: row.name }));
});

/** 获取兑换码信息 */
vas.get("/redeem/:code", async (c) => {
  const code = c.req.param("code");
  const rows = await db()
    .select()
    .from(redeems)
    .where(and(eq(redeems.code, code), eq(redeems.used, false), isNull(redeems.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json(Err(Code.InvalidGiftCode, "兑换码无效"));
  return c.json(ok({ type: row.type, num: row.num, product_id: row.productId }));
});

/** 执行兑换 */
vas.post("/redeem/:code", async (c) => {
  const u = c.get("user") as UserRow;
  const code = c.req.param("code");
  const rows = await db()
    .select()
    .from(redeems)
    .where(and(eq(redeems.code, code), eq(redeems.used, false), isNull(redeems.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json(Err(Code.InvalidGiftCode, "兑换码无效"));

  await writeThrough((d) => d.update(redeems).set({ used: true }).where(eq(redeems.id, row.id)));

  // type=1 为容量包
  if (row.type === 1) {
    const size = row.num;
    await writeThrough((d) =>
      d
        .insert(storagePacks)
        .values({
          name: "兑换码容量包",
          userId: u.id,
          activeTime: new Date(),
          expiredTime: new Date(Date.now() + 365 * 24 * 3600 * 1000),
          size,
        })
        .returning(),
    );
  } else {
    // 其余类型记为积分
    await writeThrough((d) =>
      d.update(users).set({ score: u.score + row.num }).where(eq(users.id, u.id)),
    );
  }
  return c.json(ok(null));
});

export default vas;
