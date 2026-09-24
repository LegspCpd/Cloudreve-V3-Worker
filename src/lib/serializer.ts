import { db } from "../db";
import { groups, tags, storagePacks, files } from "../db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import { hashID, IDType } from "./hashid";
import type {
  FileRow,
  FolderRow,
  GroupRow,
  PolicyRow,
  ShareRow,
  TagRow,
  UserRow,
} from "../db/schema";
import { cleanPath, baseName } from "./utils";

/** 用户个性化配置（对应 UserOption） */
export interface UserOption {
  profile_off?: boolean;
  preferred_policy?: number;
  preferred_theme?: string;
}

export function parseUserOptions(raw: string): UserOption {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as UserOption;
  } catch {
    return {};
  }
}

export interface GroupOption {
  archive_download?: boolean;
  archive_task?: boolean;
  compress_size?: number;
  decompress_size?: number;
  one_time_download?: boolean;
  share_download?: boolean;
  share_free?: boolean;
  aria2?: boolean;
  aria2_options?: Record<string, unknown>;
  relocate?: boolean;
  source_batch?: number;
  redirected_source?: boolean;
  aria2_batch?: number;
  available_nodes?: number[];
  select_node?: boolean;
  advance_delete?: boolean;
  webdav_proxy?: boolean;
}

export function parseGroupOptions(raw: string): GroupOption {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as GroupOption;
  } catch {
    return {};
  }
}

export function parsePolicyList(raw: string): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}

export interface PolicyOption {
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

export function parsePolicyOptions(raw: string): PolicyOption {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PolicyOption;
  } catch {
    return {};
  }
}

export function parseFileMetadata(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

// ───────────────────────────────────────────────────────────
// 序列化结构（与 serializer 包逐字段对齐）
// ───────────────────────────────────────────────────────────
export interface UserResponse {
  id: string;
  user_name: string;
  nickname: string;
  status: number;
  avatar: string;
  created_at: string;
  preferred_theme: string;
  score: number;
  anonymous: boolean;
  group: {
    id: number;
    name: string;
    allowShare: boolean;
    allowRemoteDownload: boolean;
    allowArchiveDownload: boolean;
    shareFree: boolean;
    shareDownload: boolean;
    compress: boolean;
    webdav: boolean;
    relocate: boolean;
    sourceBatch: number;
    selectNode: boolean;
    advanceDelete: boolean;
    allowWebDAVProxy: boolean;
  };
  tags: TagResponse[];
}

export interface TagResponse {
  id: string;
  name: string;
  icon: string;
  color: string;
  type: number;
  expression?: string;
}

export interface ObjectResponse {
  id: string;
  name: string;
  path: string;
  thumb: boolean;
  size: number;
  type: string;
  date: string;
  create_date: string;
  key?: string;
  source_enabled: boolean;
}

export interface PolicySummary {
  id: string;
  name: string;
  type: string;
  max_size: number;
  file_type: string[];
}

/** 序列化用户组 */
export function buildGroup(g: GroupRow) {
  const opt = parseGroupOptions(g.options);
  return {
    id: g.id,
    name: g.name,
    allowShare: g.shareEnabled,
    allowRemoteDownload: !!opt.aria2,
    allowArchiveDownload: !!opt.archive_download,
    shareFree: !!opt.share_free,
    shareDownload: !!opt.share_download,
    compress: !!opt.archive_task,
    webdav: g.webdavEnabled,
    relocate: !!opt.relocate,
    sourceBatch: opt.source_batch ?? 0,
    selectNode: !!opt.select_node,
    advanceDelete: !!opt.advance_delete,
    allowWebDAVProxy: !!opt.webdav_proxy,
  };
}

/** 序列化标签 */
export function buildTag(t: TagRow): TagResponse {
  const res: TagResponse = {
    id: hashID(t.id, IDType.TagID),
    name: t.name,
    icon: t.icon,
    color: t.color,
    type: t.type,
  };
  if (t.type !== 0) res.expression = t.expression;
  return res;
}

/** 查询用户标签 */
export async function getTagsByUID(uid: number): Promise<TagResponse[]> {
  const rows = await db().select().from(tags).where(and(eq(tags.userId, uid), isNull(tags.deletedAt)));
  return rows.map(buildTag);
}

/** 序列化用户 */
export async function buildUser(user: UserRow, group?: GroupRow): Promise<UserResponse> {
  const opt = parseUserOptions(user.options);
  if (!group) {
    const rows = await db().select().from(groups).where(eq(groups.id, user.groupId)).limit(1);
    group = rows[0];
  }
  const userTags = await getTagsByUID(user.id);
  return {
    id: hashID(user.id, IDType.UserID),
    user_name: user.email,
    nickname: user.nick,
    status: user.status,
    avatar: user.avatar,
    created_at: user.createdAt.toISOString(),
    preferred_theme: opt.preferred_theme ?? "",
    score: user.score,
    anonymous: false,
    group: buildGroup(group ?? defaultGroupRow(user.groupId)),
    tags: userTags,
  };
}

/** 匿名用户序列化 */
export async function buildAnonymousUser(): Promise<UserResponse> {
  const rows = await db().select().from(groups).where(eq(groups.id, 3)).limit(1);
  const group = rows[0] ?? defaultGroupRow(3);
  const u: UserResponse = {
    id: "0",
    user_name: "",
    nickname: "",
    status: 0,
    avatar: "",
    created_at: new Date(0).toISOString(),
    preferred_theme: "",
    score: 0,
    anonymous: true,
    group: buildGroup(group),
    tags: [],
  };
  return u;
}

function defaultGroupRow(id: number): GroupRow {
  return {
    id,
    name: "",
    policies: "[]",
    maxStorage: 0,
    shareEnabled: false,
    webdavEnabled: false,
    speedLimit: 0,
    options: "{}",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
}

/** 序列化存储概况 */
export async function buildUserStorage(user: UserRow, group: GroupRow): Promise<{
  used: number;
  free: number;
  total: number;
}> {
  const total = group.maxStorage + (await getAvailablePackSize(user.id));
  const free = total > user.storage ? total - user.storage : 0;
  return { used: user.storage, free, total };
}

/** 用户可用容量包总容量 */
export async function getAvailablePackSize(uid: number): Promise<number> {
  const rows = await db()
    .select({ size: storagePacks.size })
    .from(storagePacks)
    .where(and(eq(storagePacks.userId, uid), gt(storagePacks.expiredTime, new Date()), isNull(storagePacks.deletedAt)));
  return rows.reduce((acc, r) => acc + (r.size ?? 0), 0);
}

/**
 * 序列化文件/目录对象。
 * @param position 所属目录的完整虚拟路径（父目录路径 + 父目录名）
 */
export function buildFileObject(file: FileRow, position: string): ObjectResponse {
  const meta = parseFileMetadata(file.metadata);
  const name = file.name;
  return {
    id: hashID(file.id, IDType.FileID),
    name,
    path: position,
    thumb: meta.thumb_status === "exist" || (!meta.thumb_status && isImageLike(name)),
    size: file.size,
    type: "file",
    date: file.updatedAt.toISOString(),
    create_date: file.createdAt.toISOString(),
    source_enabled: false,
  };
}

export function buildFolderObject(folder: FolderRow, position: string): ObjectResponse {
  return {
    id: hashID(folder.id, IDType.FolderID),
    name: folder.name,
    path: position,
    thumb: false,
    size: 0,
    type: "dir",
    date: folder.updatedAt.toISOString(),
    create_date: folder.createdAt.toISOString(),
    source_enabled: false,
  };
}

function isImageLike(name: string): boolean {
  const exts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return exts.includes(ext);
}

export function buildPolicySummary(policy: PolicyRow): PolicySummary {
  const opt = parsePolicyOptions(policy.options);
  return {
    id: hashID(policy.id, IDType.PolicyID),
    name: policy.name,
    type: policy.type,
    max_size: policy.maxSize,
    file_type: opt.file_type ?? [],
  };
}

/**
 * 规范化目录路径，返回 { parent, position }。
 * 前端列表展示依赖每个对象携带正确的 path（父级路径）。
 */
export function folderPosition(parentPath: string, parentName: string): string {
  if (parentPath === "/" || parentPath === "") return parentName === "/" ? "/" : "/" + parentName;
  return cleanPath(parentPath + "/" + parentName);
}

export { cleanPath, baseName };
