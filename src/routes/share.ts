import { Hono, type Context } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import { shares, files, folders, users, groups, reports, policies as policyTable } from "../db/schema";
import { and, eq, isNull, inArray, gt, lt, or, ne, like, sql as sqlExpr } from "drizzle-orm";
import { ok, Err } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, phoneRequired, csrfCheck } from "../middleware";
import { hashID as hashIDE, decodeHashID, IDType } from "../lib/hashid";
import { cache } from "../lib/cache";
import { setting } from "../lib/settings";
import { HMACAuth, signURI } from "../lib/sign";
import { session } from "../lib/session";
import { uuid, cleanPath, nowSec } from "../lib/utils";
import { buildFileObject, buildFolderObject, parseGroupOptions } from "../lib/serializer";
import {
  resolveFolder,
  folderFullPath,
  getChildFiles,
  getChildFolders,
  getRecursiveChildFolders,
  getChildFilesOfFolders,
  getGroupByID,
} from "../lib/fs";
import { toPolicyRuntime } from "../storage/policy";
import { StorageDriver } from "../storage/driver";
import type { FileRow, FolderRow, ShareRow, UserRow } from "../db/schema";

/**
 * 分享路由：/api/v3/share
 * 对应原版 routers/controllers/share.go + service/explorer/share.go。
 *
 * 已登录用户的接口（POST/PATCH/DELETE/GET 列表）走 authRequired；
 * 匿名访问接口（info/preview/list/download 等）单独放行。
 */
const share = new Hono<Ctx>();

// ── 公共分享序列化 ──

interface ShareResponse {
  created_at: string;
  remain_downloads: number;
  is_dir: boolean;
  views: number;
  expires: string;
  score: number;
  preview_enabled: boolean;
  creator: { id: string; name: string };
  source: { id: string; name: string; size: number };
  is_private: boolean;
  password: boolean;
}

async function buildShare(s: ShareRow): Promise<ShareResponse> {
  const creator = await db()
    .select({ id: users.id, nick: users.nick, email: users.email })
    .from(users)
    .where(and(eq(users.id, s.userId), isNull(users.deletedAt)))
    .limit(1);
  const creatorRow = creator[0];

  let sourceName = s.sourceName;
  let sourceSize = 0;
  if (s.isDir) {
    const rows = await db()
      .select()
      .from(folders)
      .where(and(eq(folders.id, s.sourceId), isNull(folders.deletedAt)))
      .limit(1);
    if (rows[0]) sourceName = rows[0].name;
  } else {
    const rows = await db()
      .select()
      .from(files)
      .where(and(eq(files.id, s.sourceId), isNull(files.deletedAt)))
      .limit(1);
    if (rows[0]) {
      sourceName = rows[0].name;
      sourceSize = rows[0].size;
    }
  }

  return {
    created_at: s.createdAt.toISOString(),
    remain_downloads: s.remainDownloads,
    is_dir: s.isDir,
    views: s.views,
    expires: s.expires ? s.expires.toISOString() : "",
    score: s.score,
    preview_enabled: s.previewEnabled,
    creator: {
      id: hashIDE(s.userId, IDType.UserID),
      name: creatorRow?.nick || creatorRow?.email || "",
    },
    source: {
      id: hashIDE(s.sourceId, s.isDir ? IDType.FolderID : IDType.FileID),
      name: sourceName,
      size: sourceSize,
    },
    is_private: s.password !== "",
    password: s.password !== "",
  };
}

/** 取分享记录；不存在或源对象已删则返回 null */
async function loadShare(rawID: string): Promise<ShareRow | null> {
  const id = decodeHashID(rawID, IDType.ShareID);
  if (!id) return null;
  const rows = await db()
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** 校验分享是否可用（未过期、下载次数未耗尽、源对象存在） */
async function assertShareAvailable(s: ShareRow | null): Promise<ShareRow> {
  if (!s) throw apiError(Code.ShareLinkNotFound, "分享不存在");
  if (s.expires && s.expires.getTime() < Date.now()) {
    throw apiError(Code.SignExpired, "分享已过期");
  }
  if (s.remainDownloads === 0) {
    throw apiError(Code.NoPermissionErr, "下载次数已用尽");
  }
  const sourceExists = s.isDir
    ? (await db()
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, s.sourceId), isNull(folders.deletedAt)))
        .limit(1)).length > 0
    : (await db()
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.id, s.sourceId), isNull(files.deletedAt)))
        .limit(1)).length > 0;
  if (!sourceExists) throw apiError(Code.FileNotFound, "分享源不存在");
  return s;
}

/** 分享解锁状态保存在会话中，key 形如 share_unlock:<shareID> */
async function isShareUnlocked(c: Context<Ctx>, s: ShareRow): Promise<boolean> {
  if (!s.password) return true;
  const sess = await session(c);
  const key = `share_unlock:${s.id}`;
  return sess.get<boolean>(key) === true;
}

async function markShareUnlocked(c: Context<Ctx>, s: ShareRow): Promise<void> {
  const sess = await session(c);
  sess.set({ [`share_unlock:${s.id}`]: true });
}

// ── 匿名可访问接口 ──

/** 获取分享信息 */
share.get("/info/:id", async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  // 浏览数 +1（异步）
  writeThrough((d) => d.update(shares).set({ views: (s as ShareRow).views + 1 }).where(eq(shares.id, s!.id))).catch(
    () => {},
  );
  return c.json(ok(await buildShare(s as ShareRow)));
});

/** 分享密码解锁 */
share.post("/info/:id", async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!s!.password) return c.json(ok(null));
  const body = await c.req.json().catch(() => ({})) as { password?: string };
  if (body.password !== s!.password) {
    return c.json(Err(Code.CredentialInvalid, "密码错误"));
  }
  await markShareUnlocked(c, s as ShareRow);
  return c.json(ok(null));
});

/** 分享目录列文件 */
share.get("/list/:id/*path", async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!(await isShareUnlocked(c, s as ShareRow))) {
    return c.json(Err(Code.CredentialInvalid, "请先输入分享密码"));
  }
  if (!s!.isDir) return c.json(Err(Code.ParamErr, "该分享不是目录分享"));

  const rootPath = (await folderFullPath(s!.userId, (await db()
    .select()
    .from(folders)
    .where(eq(folders.id, s!.sourceId))
    .limit(1))[0] as FolderRow)) as string;
  const sub = cleanPath(decodeURIComponent(c.req.param("path") || "/"));
  const targetPath = sub === "/" ? rootPath : `${rootPath}${sub}`;

  const folder = await resolveFolder(s!.userId, targetPath);
  if (!folder) return c.json(Err(Code.ParentNotExist, "目录不存在"));

  const [childFolders, childFiles] = await Promise.all([getChildFolders(folder.id), getChildFiles(folder.id)]);
  const position = await folderFullPath(s!.userId, folder);
  return c.json(
    ok({
      parent: folder.parentId === null ? "" : hashIDE(folder.id, IDType.FolderID),
      objects: [
        ...childFolders.map((f) => buildFolderObject(f, position)),
        ...childFiles.map((f) => buildFileObject(f, position)),
      ],
    }),
  );
});

/** 生成分享下载 URL（需解锁） */
share.put("/download/:id", async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!(await isShareUnlocked(c, s as ShareRow))) {
    return c.json(Err(Code.CredentialInvalid, "请先输入分享密码"));
  }

  // 积分下载校验
  const groupOpts = await loadCreatorGroupOptions(s as ShareRow);
  if (s!.score > 0 && !groupOpts.share_free) {
    const u = c.get("user") as UserRow | null;
    if (!u) return c.json(Err(Code.CheckLogin, "需要登录后下载此分享"));
    if (u.score < s!.score) return c.json(Err(Code.InsufficientCredit, "积分不足"));
    await writeThrough((d) =>
      d.update(users).set({ score: Math.max(0, u.score - s!.score) }).where(eq(users.id, u.id)),
    );
  }

  // 下载次数 -1
  await writeThrough((d) =>
    d
      .update(shares)
      .set({ downloads: (s as ShareRow).downloads + 1, remainDownloads: Math.max(-1, (s as ShareRow).remainDownloads - 1) })
      .where(eq(shares.id, s!.id)),
  );

  const secretKey = await setting.get("secret_key");
  if (!secretKey) return c.json(Err(Code.InternalSetting, "系统尚未初始化"));
  const auth = new HMACAuth(secretKey);
  const ttl = await setting.getInt("download_timeout", 600);

  if (s!.isDir) {
    const sessionID = uuid();
    const payload = JSON.stringify({
      items: [],
      folders: [s!.sourceId],
      uid: s!.userId,
      name: "share",
      shareId: s!.id,
    });
    await c.env.K4?.put(`archive:${sessionID}`, payload, { expirationTtl: ttl });
    const signed = await signURI(auth, `/api/v3/file/archive/${sessionID}/archive.zip`, ttl);
    return c.json(ok(signed.toString()));
  }

  const fileRows = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, s!.sourceId), isNull(files.deletedAt)))
    .limit(1);
  if (!fileRows[0]) return c.json(Err(Code.FileNotFound, "文件不存在"));
  const signed = await signURI(
    auth,
    `/api/v3/file/get/${hashIDE(fileRows[0].id, IDType.FileID)}/${fileRows[0].name}`,
    ttl,
  );
  return c.json(ok(signed.toString()));
});

/** 预览分享文件 */
share.get("/preview/:id", csrfCheck, async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!(await isShareUnlocked(c, s as ShareRow))) {
    return c.json(Err(Code.CredentialInvalid, "请先输入分享密码"));
  }
  if (!s!.previewEnabled) return c.json(Err(Code.DisabledSharePreview, "该分享未启用预览"));

  const secretKey = await setting.get("secret_key");
  const auth = new HMACAuth(secretKey);
  const ttl = await setting.getInt("preview_timeout", 600);
  const target = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, s!.sourceId), isNull(files.deletedAt)))
    .limit(1);
  if (!target[0]) return c.json(Err(Code.FileNotFound, "文件不存在"));
  const signed = await signURI(
    auth,
    `/api/v3/file/get/${hashIDE(target[0].id, IDType.FileID)}/${target[0].name}`,
    ttl,
  );
  return c.redirect(signed.toString(), 302);
});

/** 分享内文本文件内容 */
share.get("/content/:id", async (c) => {
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!(await isShareUnlocked(c, s as ShareRow))) {
    return c.json(Err(Code.CredentialInvalid, "请先输入分享密码"));
  }
  const target = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, s!.sourceId), isNull(files.deletedAt)))
    .limit(1);
  if (!target[0]) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policyRow = await db()
    .select()
    .from(policyTable)
    .where(eq(policyTable.id, target[0].policyId))
    .limit(1);
  if (!policyRow[0]) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policyRow[0]);

  c.header("Content-Security-Policy", "sandbox");
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const obj = await c.env.R2_BUCKET.get(target[0].sourceName);
    if (!obj) return c.json(Err(Code.FileNotFound, "对象不存在"));
    return c.body(await obj.text(), 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  const resp = await new StorageDriver(runtime).getStream(target[0].sourceName);
  return c.body(new TextDecoder("utf-8").decode(await resp.arrayBuffer()), 200, {
    "Content-Type": "text/plain; charset=utf-8",
  });
});

/** 转存他人分享到自己的网盘 */
share.post("/save/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const s = await loadShare(c.req.param("id"));
  try {
    await assertShareAvailable(s);
  } catch (e) {
    return c.json(buildErr(e));
  }
  if (!(await isShareUnlocked(c, s as ShareRow))) {
    return c.json(Err(Code.CredentialInvalid, "请先输入分享密码"));
  }
  if (s!.userId === u.id) return c.json(Err(Code.SaveOwnShare, "不能转存自己的分享"));

  const src = s!.isDir
    ? (await db().select().from(folders).where(eq(folders.id, s!.sourceId)).limit(1))[0]
    : (await db().select().from(files).where(eq(files.id, s!.sourceId)).limit(1))[0];
  if (!src) return c.json(Err(Code.FileNotFound, "源对象不存在"));

  const dstPath = cleanPath((await c.req.json().catch(() => ({})))?.path || "/");
  const dstFolder = await resolveFolder(u.id, dstPath === "/" ? "/" : dstPath, true);

  if (s!.isDir) {
    // 递归复制目录
    const childFolders = await getRecursiveChildFolders(s!.userId, [s!.sourceId], true);
    const childFiles = await getChildFilesOfFolders(childFolders.map((f) => f.id));
    const idMap = new Map<number, number>();
    for (const f of childFolders) {
      const parentID = f.parentId === null ? null : (idMap.get(f.parentId as number) ?? dstFolder!.id);
      const inserted = await writeThrough((d) =>
        d
          .insert(folders)
          .values({
            name: f.name,
            parentId: parentID,
            ownerId: u.id,
            policyId: f.policyId,
          })
          .returning(),
      );
      idMap.set(f.id, inserted.data[0]!.id);
    }
    for (const f of childFiles) {
      await writeThrough((d) =>
        d.insert(files).values({
          name: f.name,
          sourceName: f.sourceName,
          userId: u.id,
          size: f.size,
          picInfo: f.picInfo,
          folderId: idMap.get(f.folderId) ?? dstFolder!.id,
          policyId: f.policyId,
          metadata: f.metadata,
        }),
      );
    }
  } else {
    const existed = await db()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.name, (src as FileRow).name), eq(files.folderId, dstFolder!.id), eq(files.userId, u.id), isNull(files.deletedAt)))
      .limit(1);
    if (existed.length > 0) return c.json(Err(Code.ObjectExist, "同名文件已存在"));
    await writeThrough((d) =>
      d.insert(files).values({
        name: (src as FileRow).name,
        sourceName: (src as FileRow).sourceName,
        userId: u.id,
        size: (src as FileRow).size,
        picInfo: (src as FileRow).picInfo,
        folderId: dstFolder!.id,
        policyId: (src as FileRow).policyId,
        metadata: (src as FileRow).metadata,
      }),
    );
    await writeThrough((d) =>
      d.update(users).set({ storage: u.storage + (src as FileRow).size }).where(eq(users.id, u.id)),
    );
  }

  return c.json(ok(null));
});

// ── 需要登录的接口 ──

share.use("*", async (c, next) => {
  // info / list / preview / content / download / save 走匿名；其余需要登录
  const p = c.req.path;
  const anonymousPaths = ["/info", "/list", "/preview", "/content", "/download"];
  if (anonymousPaths.some((prefix) => p.startsWith(prefix))) {
    return next();
  }
  const m = authRequired;
  return m(c, next);
});

/** 创建分享 */
share.post("/", phoneRequired, async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    id?: string;
    is_dir?: boolean;
    password?: string;
    expires?: string;
    preview_enabled?: boolean;
    score?: number;
    share_type?: number;
  };

  const sourceID = decodeHashID(body.id ?? "", body.is_dir ? IDType.FolderID : IDType.FileID);
  if (!sourceID) return c.json(Err(Code.ParamErr, "无法解析源对象 ID"));

  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  if (!group.shareEnabled) return c.json(Err(Code.FeatureNotEnabled, "当前用户组无权创建分享"));

  // 源对象必须属于当前用户
  const owns = body.is_dir
    ? (await db()
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, sourceID), eq(folders.ownerId, u.id), isNull(folders.deletedAt)))
        .limit(1)).length > 0
    : (await db()
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.id, sourceID), eq(files.userId, u.id), isNull(files.deletedAt)))
        .limit(1)).length > 0;
  if (!owns) return c.json(Err(Code.NoPermissionErr, "无权分享此对象"));

  let expiresAt: Date | null = null;
  if (body.expires) {
    const n = Number(body.expires);
    if (Number.isFinite(n) && n > 0) expiresAt = new Date(Date.now() + n * 1000);
  }

  const sourceName = body.is_dir
    ? (await db().select({ name: folders.name }).from(folders).where(eq(folders.id, sourceID)).limit(1))[0]?.name ?? ""
    : (await db().select({ name: files.name }).from(files).where(eq(files.id, sourceID)).limit(1))[0]?.name ?? "";

  const inserted = await writeThrough((d) =>
    d
      .insert(shares)
      .values({
        password: body.password ?? "",
        isDir: !!body.is_dir,
        userId: u.id,
        sourceId: sourceID,
        views: 0,
        downloads: 0,
        remainDownloads: -1,
        expires: expiresAt,
        score: Math.max(0, Number(body.score ?? 0)),
        previewEnabled: !!body.preview_enabled,
        sourceName,
      })
      .returning(),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.DBError, "创建分享失败"));
  return c.json(ok(hashIDE(row.id, IDType.ShareID)));
});

/** 列出我的分享 */
share.get("/", async (c) => {
  const u = c.get("user") as UserRow;
  const rows = await db()
    .select()
    .from(shares)
    .where(and(eq(shares.userId, u.id), isNull(shares.deletedAt)))
    .orderBy(sqlExpr`${shares.createdAt} DESC`);
  const items = await Promise.all(rows.map(buildShare));
  return c.json(ok(items));
});

/** 更新分享属性 */
share.patch("/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const s = await loadShare(c.req.param("id"));
  if (!s) return c.json(Err(Code.ShareLinkNotFound, "分享不存在"));
  if (s.userId !== u.id) return c.json(Err(Code.NoPermissionErr, "无权操作此分享"));

  const body = await c.req.json().catch(() => ({})) as {
    password?: string;
    preview_enabled?: boolean;
    expires?: string;
    score?: number;
    remain_downloads?: number;
  };
  const patch: Record<string, unknown> = {};
  if (body.password !== undefined) patch.password = body.password;
  if (body.preview_enabled !== undefined) patch.previewEnabled = !!body.preview_enabled;
  if (body.remain_downloads !== undefined) patch.remainDownloads = Number(body.remain_downloads);
  if (body.score !== undefined) patch.score = Math.max(0, Number(body.score));
  if (body.expires !== undefined) {
    const n = Number(body.expires);
    patch.expires = Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000) : null;
  }
  if (Object.keys(patch).length === 0) return c.json(ok(null));
  await writeThrough((d) => d.update(shares).set(patch).where(eq(shares.id, s.id)));
  return c.json(ok(null));
});

/** 删除分享 */
share.delete("/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const s = await loadShare(c.req.param("id"));
  if (!s) return c.json(Err(Code.ShareLinkNotFound, "分享不存在"));
  if (s.userId !== u.id) return c.json(Err(Code.NoPermissionErr, "无权操作此分享"));
  await writeThrough((d) => d.update(shares).set({ deletedAt: new Date() }).where(eq(shares.id, s.id)));
  return c.json(ok(null));
});

/** 搜索公共分享 */
share.get("/search", async (c) => {
  const u = c.get("user") as UserRow;
  const keywords = (c.req.query("keywords") || "").trim();
  const page = Number(c.req.query("page") || 1);
  const pageSize = Number(c.req.query("page_size") || 15);
  if (!keywords) return c.json(ok({ pagination: { total: 0, page, pageSize }, items: [] }));

  const pat = `%${keywords.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const rows = await db()
    .select()
    .from(shares)
    .where(and(eq(shares.userId, u.id), like(shares.sourceName, pat), isNull(shares.deletedAt)))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = await Promise.all(rows.map(buildShare));
  return c.json(ok({ pagination: { total: items.length, page, pageSize }, items }));
});

/** 举报分享 */
share.post("/report/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const s = await loadShare(c.req.param("id"));
  if (!s) return c.json(Err(Code.ShareLinkNotFound, "分享不存在"));
  const body = await c.req.json().catch(() => ({})) as { reason?: number; description?: string };
  await writeThrough((d) =>
    d.insert(reports).values({
      shareId: s.id,
      reason: Number(body.reason ?? 0),
      description: String(body.description ?? ""),
    }),
  );
  return c.json(ok(null));
});

// ── 辅助 ──

async function loadCreatorGroupOptions(s: ShareRow): Promise<Record<string, unknown>> {
  const userRows = await db()
    .select({ groupId: users.groupId })
    .from(users)
    .where(and(eq(users.id, s.userId), isNull(users.deletedAt)))
    .limit(1);
  const gid = userRows[0]?.groupId;
  if (!gid) return {};
  const rows = await db().select({ options: groups.options }).from(groups).where(eq(groups.id, gid)).limit(1);
  return JSON.parse(rows[0]?.options ?? "{}") as Record<string, unknown>;
}

function buildErr(e: unknown): { code: number; msg: string } {
  const err = e as { code?: number; message?: string };
  return { code: err.code ?? Code.IOFailed, msg: err.message ?? "操作失败" };
}

export default share;
