import type { Context } from "hono";
import type { Ctx } from "../env";
import { uuid } from "./utils";

/**
 * 上传会话：存于 K3 命名空间，记录直传/中转上传所需的全部上下文。
 * 对齐原版 serializer.UploadSession 的字段与缓存键语义。
 */
export interface UploadSession {
  /** 会话 GUID */
  key: string;
  uid: number;
  /** 用户文件路径（不含文件名） */
  virtualPath: string;
  /** 文件名 */
  name: string;
  /** 文件大小 */
  size: number;
  /** 物理存储路径（含物理文件名） */
  savePath: string;
  /** 存储策略 ID */
  policyId: number;
  /** 策略类型，决定直传还是中转 */
  policyType: string;
  /** 文件记录 ID（files 表占位记录） */
  fileID: number;
  /** 父目录 ID */
  folderID: number;
  /** 分片大小 */
  chunkSize: number;
  /** 总分片数 */
  totalChunks: number;
  /** 分片上传 ID（S3 多段上传） */
  uploadID: string;
  /** 已完成分片：序号 -> ETag */
  parts: Record<number, string>;
  /** 回调地址 */
  callback: string;
  /** 上传凭证过期时间戳（秒） */
  expires: number;
  lastModified?: number;
  mimeType?: string;
}

const PREFIX = "upload_session:";

/** 取上传会话 KV（K3） */
function uploadKV(c: Context<Ctx>): KVNamespace {
  return c.env.K3 ?? c.env.UPLOAD_KV;
}

export function newSessionID(): string {
  return uuid();
}

export async function saveUploadSession(c: Context<Ctx>, s: UploadSession): Promise<void> {
  const ttl = Math.max(60, s.expires - Math.floor(Date.now() / 1000));
  await uploadKV(c).put(PREFIX + s.key, JSON.stringify(s), { expirationTtl: ttl });
}

export async function getUploadSession(c: Context<Ctx>, key: string): Promise<UploadSession | null> {
  const raw = await uploadKV(c).get(PREFIX + key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadSession;
  } catch {
    return null;
  }
}

export async function deleteUploadSession(c: Context<Ctx>, key: string): Promise<void> {
  await uploadKV(c).delete(PREFIX + key);
}

/** 计算分片大小与总数（对齐前端 getChunks 逻辑） */
export function computeChunking(size: number, chunkSize: number): { chunkSize: number; total: number } {
  // Workers 单请求体上限 100MB，分片必须远小于此
  const MAX_CHUNK = 96 * 1024 * 1024;
  let cs = chunkSize > 0 ? chunkSize : 10 * 1024 * 1024;
  if (cs > MAX_CHUNK) cs = MAX_CHUNK;
  const total = size === 0 ? 1 : Math.ceil(size / cs);
  return { chunkSize: cs, total };
}
