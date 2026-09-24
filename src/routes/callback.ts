import { Hono, type Context } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { files, folders, policies as policyTable, users } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { useUploadSession } from "../middleware";
import { getUploadSession, deleteUploadSession } from "../lib/upload";
import { StorageDriver } from "../storage/driver";
import { toPolicyRuntime } from "../storage/policy";
import { setting } from "../lib/settings";
import { cache } from "../lib/cache";
import { hashID as hashIDE, IDType } from "../lib/hashid";
import { folderFullPath } from "../lib/fs";
import { ConcatStream } from "../lib/streams";
import type { FileRow, UserRow } from "../db/schema";

/**
 * 回调路由：/api/v3/callback/*
 * 对应原版 routers/controllers/* 回调部分。
 *
 * 在 Worker 单体实现中，所有 S3 家族策略（s3/oss/cos/r2/local/remote）
 * 的直传完成回调都由 GET /callback/s3/:sessionID 统一处理：
 * 前端在 CompleteMultipartUpload 成功后通知本接口完成落库。
 */
const callback = new Hono<Ctx>();

/** 完成上传会话：更新文件记录、清理会话、提升缓存 */
async function finishUpload(c: Context<Ctx>, sessionID: string): Promise<Response> {
  const sess = await getUploadSession(c, sessionID);
  if (!sess) {
    return c.json(Err(Code.UploadSessionExpired, "上传会话不存在或已过期"));
  }

  const policy = await db()
    .select()
    .from(policyTable)
    .where(and(eq(policyTable.id, sess.policyId), isNull(policyTable.deletedAt)))
    .limit(1);
  const policyRow = policy[0];
  if (!policyRow) {
    await deleteUploadSession(c, sessionID);
    return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  }

  // 绑定的 R2：若走了中转分片（part_ 文件），合并为最终对象
  const runtime = toPolicyRuntime(c, policyRow);
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const partKeys: string[] = [];
    for (let i = 1; i <= sess.totalChunks; i++) {
      partKeys.push(`${sess.savePath}.part_${i}`);
    }
    if (partKeys.length > 1) {
      const objects = await Promise.all(partKeys.map((k) => c.env.R2_BUCKET.get(k)));
      if (objects.some((o: R2ObjectBody | null) => o === null)) {
        return c.json(Err(Code.UploadFailed, "部分分片缺失，无法合并"));
      }
      const streams = objects.map((o: R2ObjectBody | null) => (o as R2ObjectBody).body);
      const mimeType = sess.mimeType || "application/octet-stream";
      await c.env.R2_BUCKET.put(sess.savePath, new ConcatStream(streams), {
        httpMetadata: { contentType: mimeType },
      });
      await Promise.all(partKeys.map((k) => c.env.R2_BUCKET.delete(k)));
    }
  } else {
    // S3 兼容存储：浏览器已直接完成 CompleteMultipartUpload，服务端无需再合并
    const driver = new StorageDriver(runtime);
    const ordered = Object.keys(sess.parts)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({ partNumber: n, etag: sess.parts[n] as string }));
    if (ordered.length > 0) {
      await driver.completeMultipart(sess.savePath, sess.uploadID, ordered).catch(() => {
        /* 对端可能已完成，忽略 */
      });
    }
  }

  // 更新文件记录：清除会话标记、回填元信息
  const updated = await writeThrough(
    (d) =>
      d
        .update(files)
        .set({
          uploadSessionId: null,
          updatedAt: new Date(),
        })
        .where(eq(files.id, sess.fileID))
        .returning(),
    (rows) => ({
      keys: rows.map((r) => ({ key: `file:${r.id}`, value: JSON.stringify(r), ttl: 3600 })),
    }),
  );
  const fileRow = updated.data[0];
  await deleteUploadSession(c, sessionID);
  await cache.delete(`file:${sess.fileID}`).catch(() => {});

  // 目录列表缓存失效
  await cache.delete(`folder_list:${sess.uid}:${sess.folderID}`).catch(() => {});

  if (!fileRow) return c.json(ok(null));
  const folder = await db()
    .select()
    .from(folders)
    .where(and(eq(folders.id, fileRow.folderId), isNull(folders.deletedAt)))
    .limit(1);
  const position = folder[0] ? await folderFullPath(sess.uid, folder[0]) : "/";
  return c.json(
    ok({
      ...buildFileSummary(fileRow, position),
      sessionID,
    }),
  );
}

function buildFileSummary(f: FileRow, position: string) {
  return {
    id: hashIDE(f.id, IDType.FileID),
    name: f.name,
    path: position,
    thumb: false,
    size: f.size,
    type: "file",
    date: f.updatedAt.toISOString(),
    create_date: f.createdAt.toISOString(),
    source_enabled: false,
  };
}

/** S3 家族直传完成回调 */
callback.get("/s3/:sessionID", useUploadSession("s3"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** COS 策略回调（前端 cosUploadCallback 调用） */
callback.get("/cos/:sessionID", useUploadSession("cos"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** OSS 策略回调 */
callback.post("/oss/:sessionID", useUploadSession("oss"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** 远程（remote/中转）策略回调 */
callback.post("/remote/:sessionID/:key", useUploadSession("remote"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** 七牛策略回调 */
callback.post("/qiniu/:sessionID", useUploadSession("qiniu"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** 又拍云策略回调 */
callback.post("/upyun/:sessionID", useUploadSession("upyun"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** OneDrive 策略完成回调 */
callback.post("/onedrive/finish/:sessionID", useUploadSession("onedrive"), async (c) => {
  return finishUpload(c, c.req.param("sessionID"));
});

/** QQ 互联回调（未启用，保留接口） */
callback.post("/qq", (c) => c.json(Err(Code.FeatureNotEnabled, "QQ 登录未启用")));

/** 支付回调占位 */
callback.post("/payjs", (c) => c.json(ok(null)));
callback.post("/alipay", (c) => c.json(ok(null)));
callback.post("/wechat", (c) => c.json(ok(null)));

export default callback;
