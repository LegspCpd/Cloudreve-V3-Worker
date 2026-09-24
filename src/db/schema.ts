import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/**
 * 数据库 Schema：与原版 GORM 模型逐表逐字段对齐（含软删除 deleted_at）。
 * 主键、唯一索引、普通索引均与原版保持一致，可直接与原数据库迁移互通。
 */

const ts = (name?: string) =>
  name
    ? timestamp(name, { mode: "date", withTimezone: true })
    : timestamp({ mode: "date", withTimezone: true });
const idCol = () => bigserial("id", { mode: "number" }).primaryKey();
const baseCols = {
  id: idCol(),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
  deletedAt: ts("deleted_at"),
};

// ── 用户 ──
export const users = pgTable(
  "users",
  {
    ...baseCols,
    email: text("email").notNull(),
    nick: text("nick").default("").notNull(),
    password: text("password").default("").notNull(),
    status: integer("status").default(0).notNull(),
    groupId: bigint("group_id", { mode: "number" }).default(0).notNull(),
    storage: bigint("storage", { mode: "number" }).default(0).notNull(),
    openId: text("open_id").default("").notNull(),
    twoFactor: text("two_factor").default("").notNull(),
    avatar: text("avatar").default("").notNull(),
    options: text("options").default("").notNull(),
    authn: text("authn").default("").notNull(),
    score: integer("score").default(0).notNull(),
    previousGroupId: bigint("previous_group_id", { mode: "number" }).default(0).notNull(),
    groupExpires: ts("group_expires"),
    notifyDate: ts("notify_date"),
    phone: text("phone").default("").notNull(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

// ── 用户组 ──
export const groups = pgTable("groups", {
  ...baseCols,
  name: text("name").default("").notNull(),
  policies: text("policies").default("").notNull(),
  maxStorage: bigint("max_storage", { mode: "number" }).default(0).notNull(),
  shareEnabled: boolean("share_enabled").default(false).notNull(),
  webdavEnabled: boolean("webdav_enabled").default(false).notNull(),
  speedLimit: integer("speed_limit").default(0).notNull(),
  options: text("options").default("").notNull(),
});

// ── 目录 ──
export const folders = pgTable(
  "folders",
  {
    ...baseCols,
    name: text("name").default("").notNull(),
    parentId: bigint("parent_id", { mode: "number" }),
    ownerId: bigint("owner_id", { mode: "number" }).default(0).notNull(),
    policyId: bigint("policy_id", { mode: "number" }).default(0).notNull(),
  },
  (t) => [
    index("folders_parent_id").on(t.parentId),
    index("folders_owner_id").on(t.ownerId),
    uniqueIndex("idx_only_one_name").on(t.name, t.parentId, t.ownerId),
  ],
);

// ── 文件 ──
export const files = pgTable(
  "files",
  {
    ...baseCols,
    name: text("name").default("").notNull(),
    sourceName: text("source_name").default("").notNull(),
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    size: bigint("size", { mode: "number" }).default(0).notNull(),
    picInfo: text("pic_info").default("").notNull(),
    folderId: bigint("folder_id", { mode: "number" }).default(0).notNull(),
    policyId: bigint("policy_id", { mode: "number" }).default(0).notNull(),
    uploadSessionId: text("upload_session_id"),
    metadata: text("metadata").default("").notNull(),
  },
  (t) => [
    index("files_user_id").on(t.userId),
    index("files_folder_id").on(t.folderId),
    uniqueIndex("idx_only_one").on(t.name, t.userId, t.folderId),
    uniqueIndex("session_only_one").on(t.uploadSessionId),
  ],
);

// ── 存储策略 ──
export const policies = pgTable("policies", {
  ...baseCols,
  name: text("name").default("").notNull(),
  type: text("type").default("").notNull(),
  server: text("server").default("").notNull(),
  bucketName: text("bucket_name").default("").notNull(),
  isPrivate: boolean("is_private").default(false).notNull(),
  baseUrl: text("base_url").default("").notNull(),
  accessKey: text("access_key").default("").notNull(),
  secretKey: text("secret_key").default("").notNull(),
  maxSize: bigint("max_size", { mode: "number" }).default(0).notNull(),
  autoRename: boolean("auto_rename").default(false).notNull(),
  dirNameRule: text("dir_name_rule").default("").notNull(),
  fileNameRule: text("file_name_rule").default("").notNull(),
  isOriginLinkEnable: boolean("is_origin_link_enable").default(false).notNull(),
  options: text("options").default("").notNull(),
});

// ── 分享 ──
export const shares = pgTable(
  "shares",
  {
    ...baseCols,
    password: text("password").default("").notNull(),
    isDir: boolean("is_dir").default(false).notNull(),
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).default(0).notNull(),
    views: integer("views").default(0).notNull(),
    downloads: integer("downloads").default(0).notNull(),
    remainDownloads: integer("remain_downloads").default(-1).notNull(),
    expires: ts("expires"),
    score: integer("score").default(0).notNull(),
    previewEnabled: boolean("preview_enabled").default(false).notNull(),
    sourceName: text("source_name").default("").notNull(),
  },
  (t) => [index("shares_source").on(t.sourceName)],
);

// ── 文件外链 ──
export const sourceLinks = pgTable("source_links", {
  ...baseCols,
  fileId: bigint("file_id", { mode: "number" }).default(0).notNull(),
  name: text("name").default("").notNull(),
  downloads: integer("downloads").default(0).notNull(),
});

// ── 标签 ──
export const tags = pgTable("tags", {
  ...baseCols,
  name: text("name").default("").notNull(),
  icon: text("icon").default("").notNull(),
  color: text("color").default("").notNull(),
  type: integer("type").default(0).notNull(),
  expression: text("expression").default("").notNull(),
  userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
});

// ── 异步任务 ──
export const tasks = pgTable("tasks", {
  ...baseCols,
  status: integer("status").default(0).notNull(),
  type: integer("type").default(0).notNull(),
  userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
  progress: integer("progress").default(0).notNull(),
  error: text("error").default("").notNull(),
  props: text("props").default("").notNull(),
});

// ── 订单 ──
export const orders = pgTable(
  "orders",
  {
    ...baseCols,
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    orderNo: text("order_no").default("").notNull(),
    type: integer("type").default(0).notNull(),
    method: text("method").default("").notNull(),
    productId: bigint("product_id", { mode: "number" }).default(0).notNull(),
    num: integer("num").default(0).notNull(),
    name: text("name").default("").notNull(),
    price: integer("price").default(0).notNull(),
    status: integer("status").default(0).notNull(),
  },
  (t) => [index("orders_order_number").on(t.orderNo)],
);

// ── 兑换码 ──
export const redeems = pgTable(
  "redeems",
  {
    ...baseCols,
    type: integer("type").default(0).notNull(),
    productId: bigint("product_id", { mode: "number" }).default(0).notNull(),
    num: integer("num").default(0).notNull(),
    code: text("code").default("").notNull(),
    used: boolean("used").default(false).notNull(),
  },
  (t) => [index("redeems_redeem_code").on(t.code)],
);

// ── 容量包 ──
export const storagePacks = pgTable(
  "storage_packs",
  {
    ...baseCols,
    name: text("name").default("").notNull(),
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    activeTime: ts("active_time"),
    expiredTime: ts("expired_time"),
    size: bigint("size", { mode: "number" }).default(0).notNull(),
  },
  (t) => [index("storage_packs_expired").on(t.expiredTime)],
);

// ── 离线下载任务 ──
export const downloads = pgTable(
  "downloads",
  {
    ...baseCols,
    status: integer("status").default(0).notNull(),
    type: integer("type").default(0).notNull(),
    source: text("source").default("").notNull(),
    totalSize: bigint("total_size", { mode: "number" }).default(0).notNull(),
    downloadedSize: bigint("downloaded_size", { mode: "number" }).default(0).notNull(),
    gid: text("g_id").default("").notNull(),
    speed: integer("speed").default(0).notNull(),
    parent: text("parent").default("").notNull(),
    attrs: text("attrs").default("").notNull(),
    error: text("error").default("").notNull(),
    dst: text("dst").default("").notNull(),
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    taskId: bigint("task_id", { mode: "number" }).default(0).notNull(),
    nodeId: bigint("node_id", { mode: "number" }).default(0).notNull(),
  },
  (t) => [index("downloads_gid").on(t.gid)],
);

// ── 举报 ──
export const reports = pgTable(
  "reports",
  {
    ...baseCols,
    shareId: bigint("share_id", { mode: "number" }).default(0).notNull(),
    reason: integer("reason").default(0).notNull(),
    description: text("description").default("").notNull(),
  },
  (t) => [index("reports_share_id").on(t.shareId)],
);

// ── 从机节点 ──
export const nodes = pgTable("nodes", {
  ...baseCols,
  status: integer("status").default(0).notNull(),
  name: text("name").default("").notNull(),
  type: integer("type").default(0).notNull(),
  server: text("server").default("").notNull(),
  slaveKey: text("slave_key").default("").notNull(),
  masterKey: text("master_key").default("").notNull(),
  aria2Enabled: boolean("aria2_enabled").default(false).notNull(),
  aria2Options: text("aria2_options").default("").notNull(),
  rank: integer("rank").default(0).notNull(),
});

// ── 系统设置 ──
export const settings = pgTable(
  "settings",
  {
    ...baseCols,
    type: text("type").default("").notNull(),
    name: text("name").notNull(),
    value: text("value").default("").notNull(),
  },
  (t) => [uniqueIndex("settings_setting_key").on(t.name)],
);

// ── WebDAV 应用账号 ──
export const webdavs = pgTable(
  "webdavs",
  {
    ...baseCols,
    name: text("name").default("").notNull(),
    password: text("password").default("").notNull(),
    userId: bigint("user_id", { mode: "number" }).default(0).notNull(),
    root: text("root").default("").notNull(),
    readonly: boolean("readonly").default(false).notNull(),
    useProxy: boolean("use_proxy").default(false).notNull(),
  },
  (t) => [uniqueIndex("webdavs_password_only_on").on(t.password, t.userId)],
);

// ── 通用缓存表（缓存库/溢出缓存；主库也一并创建，作为最近数据的就近缓存）──
export const cacheStore = pgTable(
  "cache_store",
  {
    key: text("key").primaryKey(),
    value: text("value").default("").notNull(),
    expireAt: bigint("expire_at", { mode: "number" }).default(0).notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
);

// ── 行类型导出 ──
export type UserRow = InferSelectModel<typeof users>;
export type UserInsert = InferInsertModel<typeof users>;
export type GroupRow = InferSelectModel<typeof groups>;
export type FolderRow = InferSelectModel<typeof folders>;
export type FileRow = InferSelectModel<typeof files>;
export type PolicyRow = InferSelectModel<typeof policies>;
export type ShareRow = InferSelectModel<typeof shares>;
export type SourceLinkRow = InferSelectModel<typeof sourceLinks>;
export type TagRow = InferSelectModel<typeof tags>;
export type TaskRow = InferSelectModel<typeof tasks>;
export type OrderRow = InferSelectModel<typeof orders>;
export type RedeemRow = InferSelectModel<typeof redeems>;
export type StoragePackRow = InferSelectModel<typeof storagePacks>;
export type DownloadRow = InferSelectModel<typeof downloads>;
export type ReportRow = InferSelectModel<typeof reports>;
export type NodeRow = InferSelectModel<typeof nodes>;
export type SettingRow = InferSelectModel<typeof settings>;
export type WebdavRow = InferSelectModel<typeof webdavs>;

/** 所有表的集合，供迁移脚本遍历 */
export const allTables = [
  users,
  groups,
  folders,
  files,
  policies,
  shares,
  sourceLinks,
  tags,
  tasks,
  orders,
  redeems,
  storagePacks,
  downloads,
  reports,
  nodes,
  settings,
  webdavs,
  cacheStore,
];
