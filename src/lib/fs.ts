import { db } from "../db";
import { folders, files, users, groups, policies } from "../db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import type { FileRow, FolderRow, GroupRow, PolicyRow, UserRow } from "../db/schema";
import { apiError, Code } from "./errors";
import { cleanPath, pathJoin, uuid } from "./utils";
import { parsePolicyList } from "./serializer";

/**
 * 文件系统核心：目录路径解析、用户组与存储策略解析。
 * 目录结构：每个用户拥有一个根目录（name="/"，parent_id 为空）。
 */

/** 获取用户根目录 */
export async function getRootFolder(uid: number): Promise<FolderRow> {
  const rows = await db()
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, uid), isNull(folders.parentId), isNull(folders.deletedAt)))
    .limit(1);
  if (rows.length === 0) {
    // 自动创建根目录
    const created = await db()
      .insert(folders)
      .values({ name: "/", ownerId: uid })
      .returning();
    return created[0]!;
  }
  return rows[0]!;
}

/**
 * 把虚拟路径解析为目录记录；不存在返回 null。
 * @param uid 用户 ID
 * @param path 虚拟路径，如 "/a/b"
 * @param create 中间目录不存在时是否自动创建
 */
export async function resolveFolder(
  uid: number,
  path: string,
  create = false,
): Promise<FolderRow | null> {
  const p = cleanPath(path);
  if (p === "/") return getRootFolder(uid);

  const root = await getRootFolder(uid);
  const parts = p.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    const rows = await db()
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.parentId, current.id),
          eq(folders.ownerId, uid),
          eq(folders.name, part),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      if (!create) return null;
      const created = await db()
        .insert(folders)
        .values({ name: part, parentId: current.id, ownerId: uid })
        .returning();
      current = created[0]!;
    } else {
      current = rows[0]!;
    }
  }
  return current;
}

/** 取目录的完整虚拟路径（向上回溯） */
export async function folderFullPath(uid: number, folder: FolderRow): Promise<string> {
  if (folder.parentId === null) return "/";
  const parts: string[] = [folder.name];
  let current = folder;
  while (current.parentId !== null) {
    const rows = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.id, current.parentId), eq(folders.ownerId, uid), isNull(folders.deletedAt)))
      .limit(1);
    if (rows.length === 0) break;
    current = rows[0]!;
    if (current.parentId !== null) parts.unshift(current.name);
  }
  return "/" + parts.join("/");
}

/** 获取用户所属用户组 */
export async function getGroupByID(groupID: number): Promise<GroupRow | null> {
  const rows = await db().select().from(groups).where(eq(groups.id, groupID)).limit(1);
  return rows[0] ?? null;
}

/** 获取用户（带用户组） */
export async function getUserByID(uid: number): Promise<UserRow | null> {
  const rows = await db()
    .select()
    .from(users)
    .where(and(eq(users.id, uid), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** 获取存储策略 */
export async function getPolicyByID(id: number): Promise<PolicyRow | null> {
  const rows = await db()
    .select()
    .from(policies)
    .where(and(eq(policies.id, id), isNull(policies.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 取用户在指定目录下应使用的存储策略。
 * 优先级：目录挂载策略 > 用户组首选策略 > ID 为 1 的默认策略。
 */
export async function getPolicyForUser(
  user: UserRow,
  group: GroupRow,
  folder?: FolderRow | null,
): Promise<PolicyRow> {
  const policyList = parsePolicyList(group.policies);
  let preferred = policyList[0] ?? 1;

  if (folder) {
    let inherit = folder.policyId;
    if (!inherit) {
      // 向上继承挂载策略
      let current = folder;
      while (current.parentId !== null && !inherit) {
        const rows = await db()
          .select()
          .from(folders)
          .where(and(eq(folders.id, current.parentId), eq(folders.ownerId, user.id)))
          .limit(1);
        if (rows.length === 0) break;
        current = rows[0]!;
        inherit = current.policyId;
      }
    }
    if (inherit && policyList.includes(inherit)) preferred = inherit;
  }

  const p = await getPolicyByID(preferred);
  if (!p) throw apiError(Code.PolicyNotExist, "storage policy not found");
  return p;
}

/** 按用户偏好取存储策略 */
export async function getPolicyByPreference(
  user: UserRow,
  group: GroupRow,
  preference: number,
): Promise<PolicyRow> {
  const policyList = parsePolicyList(group.policies);
  let preferred = policyList[0] ?? 1;
  if (preference && policyList.includes(preference)) preferred = preference;
  const p = await getPolicyByID(preferred);
  if (!p) throw apiError(Code.PolicyNotExist, "storage policy not found");
  return p;
}

// ── 存储路径生成规则（对齐 Policy.GeneratePath / GenerateFileName）──
export function generatePath(policy: PolicyRow, uid: number, origin: string): string {
  let rule = policy.dirNameRule || "{randomkey16}";
  const now = new Date();
  const table: Record<string, string> = {
    "{randomkey16}": randomKey(16),
    "{randomkey8}": randomKey(8),
    "{timestamp}": String(Math.floor(now.getTime() / 1000)),
    "{timestamp_nano}": String(now.getTime() * 1000000),
    "{uid}": String(uid),
    "{datetime}": formatTime(now, "yyyyMMddHHmmss"),
    "{date}": formatTime(now, "yyyyMMdd"),
    "{year}": formatTime(now, "yyyy"),
    "{month}": formatTime(now, "MM"),
    "{day}": formatTime(now, "dd"),
    "{hour}": formatTime(now, "HH"),
    "{minute}": formatTime(now, "mm"),
    "{second}": formatTime(now, "ss"),
    "{path}": origin + "/",
  };
  for (const [k, v] of Object.entries(table)) rule = rule.split(k).join(v);
  return cleanPath(rule);
}

export function generateFileName(policy: PolicyRow, uid: number, origin: string): string {
  if (!policy.autoRename) return origin;
  let rule = policy.fileNameRule || "{originname}";
  const now = new Date();
  const ext = origin.slice(origin.lastIndexOf("."));
  const withoutExt = ext ? origin.slice(0, -ext.length) : origin;
  const table: Record<string, string> = {
    "{randomkey16}": randomKey(16),
    "{randomkey8}": randomKey(8),
    "{timestamp}": String(Math.floor(now.getTime() / 1000)),
    "{timestamp_nano}": String(now.getTime() * 1000000),
    "{uid}": String(uid),
    "{datetime}": formatTime(now, "yyyyMMddHHmmss"),
    "{date}": formatTime(now, "yyyyMMdd"),
    "{year}": formatTime(now, "yyyy"),
    "{month}": formatTime(now, "MM"),
    "{day}": formatTime(now, "dd"),
    "{hour}": formatTime(now, "HH"),
    "{minute}": formatTime(now, "mm"),
    "{second}": formatTime(now, "ss"),
    "{originname}": origin,
    "{originname_without_ext}": withoutExt,
    "{ext}": ext,
    "{uuid}": uuid(),
  };
  for (const [k, v] of Object.entries(table)) rule = rule.split(k).join(v);
  return rule;
}

function randomKey(n: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = new Uint32Array(n);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < n; i++) out += chars[arr[i] % chars.length];
  return out;
}

function formatTime(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return fmt
    .replace("yyyy", String(d.getFullYear()))
    .replace("MM", pad(d.getMonth() + 1))
    .replace("dd", pad(d.getDate()))
    .replace("HH", pad(d.getHours()))
    .replace("mm", pad(d.getMinutes()))
    .replace("ss", pad(d.getSeconds()));
}

/** 批量列出多个目录下的文件 */
export async function getChildFilesOfFolders(folderIDs: number[]): Promise<FileRow[]> {
  if (folderIDs.length === 0) return [];
  return db()
    .select()
    .from(files)
    .where(and(inArray(files.folderId, folderIDs), isNull(files.deletedAt)));
}

/** 列出目录的直接子目录 */
export async function getChildFolders(folderID: number): Promise<FolderRow[]> {
  return db()
    .select()
    .from(folders)
    .where(and(eq(folders.parentId, folderID), isNull(folders.deletedAt)));
}

/** 列出目录的直接子文件 */
export async function getChildFiles(folderID: number): Promise<FileRow[]> {
  return db()
    .select()
    .from(files)
    .where(and(eq(files.folderId, folderID), isNull(files.deletedAt)));
}

/** 递归获取所有子目录（含自身） */
export async function getRecursiveChildFolders(
  uid: number,
  dirIDs: number[],
  includeSelf: boolean,
): Promise<FolderRow[]> {
  const result: FolderRow[] = [];
  const seed = await db()
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, uid), inArray(folders.id, dirIDs), isNull(folders.deletedAt)));
  if (seed.length === 0) return result;
  if (includeSelf) result.push(...seed);
  let parentIDs = seed.map((f) => f.id);
  for (let i = 0; i < 65535; i++) {
    const children = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.ownerId, uid), inArray(folders.parentId, parentIDs), isNull(folders.deletedAt)));
    if (children.length === 0) break;
    result.push(...children);
    parentIDs = children.map((f) => f.id);
  }
  return result;
}

export { pathJoin };
