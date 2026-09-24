/**
 * Cloudflare Worker 运行时绑定与环境变量类型定义。
 */
export interface Env {
  // ── 运行时变量（wrangler.toml [vars]，可被 secret 覆盖）──
  ENVIRONMENT: string;
  /** Neon 主库（唯一存放业务数据） */
  DATABASE_URL: string;
  /** Neon 副库（备份，写穿透自动同步） */
  DATABASE_URL_BACKUP: string;
  /** Neon 缓存库 1..3（热数据溢出缓存） */
  DATABASE_URL_CACHE_1: string;
  DATABASE_URL_CACHE_2: string;
  DATABASE_URL_CACHE_3: string;
  /** Neon 库数量上限（部署脚本与运行时共同校验，最高 5） */
  MAX_NEON_DATABASES: string;
  /** KV 命名空间数量上限（部署脚本创建时校验，最高 5） */
  MAX_KV_NAMESPACES: string;

  RESEND_API_KEY: string;
  MAIL_FROM_ADDRESS: string;
  MAIL_FROM_NAME: string;
  SESSION_SECRET: string;
  HASHID_SALT: string;
  SITE_URL: string;

  // ── Worker KV：K1 为全量热缓存，其余按职责拆分（最多 5 个）──
  /** K1：热数据全量缓存（设置、用户、文件元数据、目录列表，能缓存的都缓存） */
  K1: KVNamespace;
  /** K2：会话（登录态、CSRF、验证码） */
  K2: KVNamespace;
  /** K3：上传会话（直传凭证、分片状态） */
  K3: KVNamespace;
  /** K4：异步任务进度（压缩/解压/转存/离线下载） */
  K4: KVNamespace;
  /** K5：分布式锁与限流 */
  K5: KVNamespace;

  // ── 兼容旧别名（迁移期间仍可使用）──
  SESSION_KV?: KVNamespace;
  CACHE_KV?: KVNamespace;
  UPLOAD_KV?: KVNamespace;
  TASK_KV?: KVNamespace;
  LOCK_KV?: KVNamespace;

  // ── R2：「本地存储」策略对应的存储桶 ──
  R2_BUCKET: R2Bucket;

  // ── 前端静态资源（SPA）──
  ASSETS?: Fetcher;
}

/** 请求上下文：在中间件与路由间传递的用户与工具 */
export interface Ctx {
  Variables: {
    /** 当前请求用户（未登录为 null） */
    user: import("./db/schema").UserRow | null;
    /** 是否已登录 */
    isLogin: boolean;
    /** 是否为管理员用户组 */
    isAdmin: boolean;
    /** 会话 ID */
    sessionID: string;
    /** CSRF token */
    csrfToken: string;
  };
  Bindings: Env;
}
