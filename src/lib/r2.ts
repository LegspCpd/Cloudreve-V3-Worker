import type { Context } from "hono";
import type { Ctx } from "../env";
import { apiError, Code } from "./errors";

/**
 * R2 绑定操作：头像、分享 README 等小文件的直接读写与中转输出。
 * 文件主体（用户文件）由存储策略驱动走 S3 兼容协议；此处仅服务于
 * Worker 内部资源。
 */

export async function putR2Object(
  c: Context<Ctx>,
  key: string,
  data: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
): Promise<void> {
  await c.env.R2_BUCKET.put(key, data, {
    httpMetadata: { contentType },
  });
}

export async function getR2Object(c: Context<Ctx>, key: string): Promise<R2ObjectBody | null> {
  return c.env.R2_BUCKET.get(key);
}

export async function deleteR2Object(c: Context<Ctx>, key: string): Promise<void> {
  await c.env.R2_BUCKET.delete(key);
}

/** 把 R2 对象内容流式输出给客户端（带基本缓存与 Range 支持） */
export async function proxyR2Object(
  c: Context<Ctx>,
  key: string,
  cacheKey: string,
): Promise<Response> {
  const obj = await getR2Object(c, key);
  if (!obj) {
    throw apiError(Code.FileNotFound, "object not found");
  }
  const maxAge = 86400;
  c.header("Cache-Control", `public, max-age=${maxAge}`);
  c.header("ETag", `"${cacheKey}"`);
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return c.newResponse(obj.body, 200, {
    "Content-Type": contentType,
    "Content-Length": String(obj.size),
    "Cache-Control": `public, max-age=${maxAge}`,
  });
}
