import { Hono } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { downloads, nodes, users, groups, files, folders, tasks } from "../db/schema";
import { and, eq, isNull, inArray, gt } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { setting } from "../lib/settings";
import { cache } from "../lib/cache";
import { uuid, cleanPath, nowSec } from "../lib/utils";
import { resolveFolder } from "../lib/fs";
import { parseGroupOptions } from "../lib/serializer";
import type { UserRow, NodeRow, GroupRow } from "../db/schema";

/**
 * 离线下载路由：/api/v3/aria2
 * 对应原版 routers/controllers/aria2.go。
 *
 * 架构说明：Worker 无法内置 Aria2 守护进程，因此 Aria2 一律使用
 * 「外部节点」——在后台 -> 节点管理中配置启用了 aria2 的节点，
 * 节点上运行原版 Cloudreve 从机程序（或任意兼容 RPC 的 Aria2 实例）。
 * 本路由负责把任务派发给可用节点，并接收节点的进度回调。
 */
const aria2 = new Hono<Ctx>();

aria2.use("*", authRequired, phoneRequired);

/** 取用户可用的、启用了 Aria2 的节点 */
async function availableNodes(u: UserRow, group: GroupRow): Promise<NodeRow[]> {
  const groupOpts = parseGroupOptions(group.options);
  const rows = await db()
    .select()
    .from(nodes)
    .where(and(eq(nodes.aria2Enabled, true), eq(nodes.status, 0), isNull(nodes.deletedAt)))
    .orderBy(nodes.rank);
  const allowed = (groupOpts.available_nodes as number[] | undefined) ?? [];
  const list = allowed.length ? rows.filter((n) => allowed.includes(n.id)) : rows;
  const batch = (groupOpts.aria2_batch as number | undefined) ?? 0;
  if (batch > 0 && list.length > batch) return list.slice(0, batch);
  return list;
}

/** Aria2 JSON-RPC 调用 */
async function aria2RPC(node: NodeRow, method: string, params: unknown[]): Promise<unknown> {
  const opts = parseAria2Options(node.aria2Options);
  const rpcURL = node.server.replace(/\/$/, "") + "/jsonrpc";
  const token = opts.secret ? `token:${opts.secret}` : "";
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: uuid(),
    method,
    params: token ? [token, ...params] : params,
  });
  const resp = await fetch(rpcURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const json = (await resp.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw apiError(Code.IOFailed, `Aria2 RPC 错误：${json.error.message ?? "unknown"}`);
  return json.result;
}

function parseAria2Options(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 创建 URL 下载任务 */
aria2.post("/url", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    url?: string;
    dst?: string;
    name?: string;
    node_id?: number;
  };
  const url = String(body.url ?? "").trim();
  if (!url) return c.json(Err(Code.ParamErr, "url 不能为空"));
  if (!/^https?:\/\//i.test(url)) return c.json(Err(Code.ParamErr, "仅支持 http/https 链接"));

  const group = await db().select().from(groups).where(eq(groups.id, u.groupId)).limit(1);
  if (!group[0]) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const groupOpts = parseGroupOptions(group[0].options);
  if (!groupOpts.aria2) return c.json(Err(Code.FeatureNotEnabled, "当前用户组无权使用离线下载"));

  const nodes_ = await availableNodes(u, group[0]);
  if (nodes_.length === 0) return c.json(Err(Code.NodeOffline, "没有可用的离线下载节点，请在后台配置"));

  let node = nodes_[0] as NodeRow;
  if (body.node_id) {
    const picked = nodes_.find((n) => n.id === Number(body.node_id));
    if (!picked) return c.json(Err(Code.NoPermissionErr, "无权使用指定节点"));
    node = picked;
  }

  const dstPath = cleanPath(body.dst ?? "/");
  // 创建异步任务记录
  const taskInserted = await writeThrough((d) =>
    d
      .insert(tasks)
      .values({
        status: 0,
        type: 4,
        userId: u.id,
        progress: 0,
        error: "",
        props: JSON.stringify({ url, dst: dstPath, name: body.name ?? "", nodeId: node.id }),
      })
      .returning(),
  );
  const taskRow = taskInserted.data[0];

  // 向 Aria2 添加任务
  const opts: Record<string, unknown> = { dir: dstPath };
  if (body.name) opts.out = body.name;
  const gid = String(await aria2RPC(node, "aria2.addUri", [[url], opts]));

  // 落库离线下载记录
  const inserted = await writeThrough((d) =>
    d
      .insert(downloads)
      .values({
        status: 0,
        type: 1,
        source: url,
        totalSize: 0,
        downloadedSize: 0,
        gid,
        speed: 0,
        parent: "",
        attrs: "",
        error: "",
        dst: dstPath,
        userId: u.id,
        taskId: taskRow?.id ?? 0,
        nodeId: node.id,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.CreateTaskError, "创建离线下载任务失败"));
  return c.json(ok(hashIDE(row.id, IDType.TagID)));
});

/** 创建种子下载任务（torrent 文件已上传到网盘） */
aria2.post("/torrent/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const fileID = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!fileID) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const group = await db().select().from(groups).where(eq(groups.id, u.groupId)).limit(1);
  if (!group[0]) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const groupOpts = parseGroupOptions(group[0].options);
  if (!groupOpts.aria2) return c.json(Err(Code.FeatureNotEnabled, "当前用户组无权使用离线下载"));

  const fileRows = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, fileID), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  const torrent = fileRows[0];
  if (!torrent) return c.json(Err(Code.FileNotFound, "种子文件不存在"));

  const nodes_ = await availableNodes(u, group[0]);
  if (nodes_.length === 0) return c.json(Err(Code.NodeOffline, "没有可用的离线下载节点"));
  const node = nodes_[0] as NodeRow;

  // 节点需要自行从 Worker 拉取 torrent 内容：返回签名 URL 供节点下载
  const { HMACAuth, signURI } = await import("../lib/sign");
  const secretKey = await setting.get("secret_key");
  const auth = new HMACAuth(secretKey);
  const torrentURL = (
    await signURI(auth, `/api/v3/file/get/${hashIDE(torrent.id, IDType.FileID)}/${torrent.name}`, 3600)
  ).toString();

  const body = await c.req.json().catch(() => ({})) as { dst?: string; node_id?: number };
  const dstPath = cleanPath(body.dst ?? "/");
  const opts: Record<string, unknown> = { dir: dstPath };
  const gid = String(await aria2RPC(node, "aria2.addTorrent", [torrentURL, [], opts]));

  const inserted = await writeThrough((d) =>
    d
      .insert(downloads)
      .values({
        status: 0,
        type: 2,
        source: torrent.name,
        totalSize: 0,
        downloadedSize: 0,
        gid,
        speed: 0,
        parent: "",
        attrs: "",
        error: "",
        dst: dstPath,
        userId: u.id,
        taskId: 0,
        nodeId: node.id,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.CreateTaskError, "创建离线下载任务失败"));
  return c.json(ok(hashIDE(row.id, IDType.TagID)));
});

/** 重新选择种子内要下载的文件 */
aria2.put("/select/:gid", async (c) => {
  const u = c.get("user") as UserRow;
  const gid = c.req.param("gid");
  const rows = await db()
    .select()
    .from(downloads)
    .where(and(eq(downloads.gid, gid), eq(downloads.userId, u.id), isNull(downloads.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json(Err(Code.NotFound, "任务不存在"));
  const nodeRows = await db().select().from(nodes).where(eq(nodes.id, row.nodeId)).limit(1);
  if (!nodeRows[0]) return c.json(Err(Code.NodeOffline, "节点不存在"));
  const indexes = ((await c.req.json().catch(() => ({}))) as { indexes?: number[] }).indexes ?? [];
  await aria2RPC(nodeRows[0], "aria2.changePosition", [gid, 0, "POS_SET"]);
  await aria2RPC(nodeRows[0], "aria2.changeOption", [gid, { select_file: indexes.join(",") }]);
  return c.json(ok(null));
});

/** 取消或删除下载任务 */
aria2.delete("/task/:gid", async (c) => {
  const u = c.get("user") as UserRow;
  const gid = c.req.param("gid");
  const rows = await db()
    .select()
    .from(downloads)
    .where(and(eq(downloads.gid, gid), eq(downloads.userId, u.id), isNull(downloads.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json(Err(Code.NotFound, "任务不存在"));
  const nodeRows = await db().select().from(nodes).where(eq(nodes.id, row.nodeId)).limit(1);
  if (nodeRows[0]) {
    await aria2RPC(nodeRows[0], "aria2.remove", [gid]).catch(() => {});
  }
  await writeThrough((d) =>
    d.update(downloads).set({ status: 3, deletedAt: new Date() }).where(eq(downloads.id, row.id)),
  );
  return c.json(ok(null));
});

/** 获取正在下载中的任务 */
aria2.get("/downloading", async (c) => {
  const u = c.get("user") as UserRow;
  const rows = await db()
    .select()
    .from(downloads)
    .where(and(eq(downloads.userId, u.id), inArray(downloads.status, [0, 1]), isNull(downloads.deletedAt)));
  return c.json(ok(rows.map(buildDownload)));
});

/** 获取已完成的任务 */
aria2.get("/finished", async (c) => {
  const u = c.get("user") as UserRow;
  const rows = await db()
    .select()
    .from(downloads)
    .where(and(eq(downloads.userId, u.id), inArray(downloads.status, [2]), isNull(downloads.deletedAt)));
  return c.json(ok(rows.map(buildDownload)));
});

function buildDownload(d: typeof downloads.$inferSelect) {
  return {
    gid: d.gid,
    name: d.source,
    status: d.status,
    total_size: d.totalSize,
    downloaded_size: d.downloadedSize,
    speed: d.speed,
    dst: d.dst,
    error: d.error,
    node_id: d.nodeId,
  };
}

export default aria2;
