import type { Ctx } from "../env";
import { apiError, Code } from "../lib/errors";
import { S3Signer } from "./s3-sign";
import type { PolicyRow } from "../db/schema";
/**
 * 存储策略运行时视图：把数据库 PolicyRow 解析为可直接使用的驱动配置。
 *
 * 支持的类型：
 *  - r2 / local：Cloudflare R2（S3 兼容，path-style，region=auto）
 *  - s3 / oss / cos / minio：任意 S3 兼容对象存储
 */
export interface PolicyRuntime {
  id: number;
  name: string;
  type: string;
  /** 是否为绑定到本 Worker 的 R2（服务端可直接用 R2 绑定操作） */
  isBoundR2: boolean;
  signer: S3Signer;
  bucket: string;
  endpoint: string;
  isPrivate: boolean;
  baseUrl: string;
  maxSize: number;
  autoRename: boolean;
  dirNameRule: string;
  fileNameRule: string;
  isOriginLinkEnable: boolean;
  fileType: string[];
  mimeType: string;
  chunkSize: number;
  region: string;
}

export interface PolicyOptions {
  token?: string;
  file_type?: string[];
  mimetype?: string;
  od_redirect?: string;
  od_proxy?: string;
  od_driver?: string;
  region?: string;
  server_side_endpoint?: string;
  chunk_size?: number;
  placeholder_with_size?: boolean;
  tps_limit?: number;
  tps_limit_burst?: number;
  s3_path_style?: boolean;
  thumb_exts?: string[];
}

export function parsePolicyOptions(raw: string): PolicyOptions {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PolicyOptions;
  } catch {
    return {};
  }
}

/** 把数据库策略行转换为运行时视图 */
export function toPolicyRuntime(c: ContextLike | unknown, p: PolicyRow): PolicyRuntime {
  const opts = parsePolicyOptions(p.options);
  const isBoundR2 = p.type === "r2" || p.type === "local";

  let endpoint = p.server || "";
  let accessKey = p.accessKey;
  let secretKey = p.secretKey;
  let region = opts.region || "auto";
  let forcePathStyle = opts.s3_path_style ?? true;

  if (isBoundR2) {
    // 绑定的 R2：endpoint 与凭证可由环境变量提供（策略行留空时回退）
    const accountId = readEnv(c, "R2_ACCOUNT_ID");
    endpoint = endpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
    accessKey = accessKey || readEnv(c, "R2_ACCESS_KEY_ID") || "";
    secretKey = secretKey || readEnv(c, "R2_SECRET_ACCESS_KEY") || "";
    region = "auto";
    forcePathStyle = true;
  }

  if (!endpoint) {
    throw apiError(Code.InternalSetting, `Storage policy ${p.name} has empty endpoint`);
  }
  if (!accessKey || !secretKey) {
    throw apiError(
      Code.InternalSetting,
      `Storage policy ${p.name} is missing access key / secret key`,
    );
  }

  return {
    id: p.id,
    name: p.name,
    type: p.type,
    isBoundR2,
    signer: new S3Signer({
      accessKey,
      secretKey,
      region,
      endpoint,
      forcePathStyle,
    }),
    bucket: p.bucketName,
    endpoint,
    isPrivate: p.isPrivate,
    baseUrl: p.baseUrl,
    maxSize: p.maxSize,
    autoRename: p.autoRename,
    dirNameRule: p.dirNameRule,
    fileNameRule: p.fileNameRule,
    isOriginLinkEnable: p.isOriginLinkEnable,
    fileType: opts.file_type ?? [],
    mimeType: opts.mimetype ?? "",
    chunkSize: opts.chunk_size || 0,
    region,
  } as PolicyRuntime;
}

interface ContextLike {
  env?: Record<string, unknown>;
}

function readEnv(c: unknown, key: string): string {
  const env = (c as { env?: Record<string, unknown> } | null | undefined)?.env as
    | Record<string, unknown>
    | undefined;
  const fromCtx = env?.[key];
  if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  try {
    if (typeof process !== "undefined" && process.env) {
      const v = process.env[key];
      return v || "";
    }
  } catch {
    /* noop */
  }
  return "";
}

export { S3Signer };
