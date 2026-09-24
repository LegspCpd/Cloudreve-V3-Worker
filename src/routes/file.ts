import { Hono, type Context } from "hono";
import type { Ctx } from "../env";
import { db, writeThrough } from "../db";
import {
  files,
  folders,
  users,
  sourceLinks,
  policies as policyTable,
  tasks,
} from "../db/schema";
import { and, eq, isNull, like, or, inArray, sql as sqlExpr, isNotNull } from "drizzle-orm";
import { ok, Err, ParamErr } from "../lib/response";
import { Code, apiError } from "../lib/errors";
import { authRequired, phoneRequired } from "../middleware";
import { hashID as hashIDE, IDType, decodeHashID } from "../lib/hashid";
import {
  buildFileObject,
  buildPolicySummary,
  parseUserOptions,
  parsePolicyOptions,
  parseFileMetadata,
} from "../lib/serializer";
import {
  resolveFolder,
  getRootFolder,
  folderFullPath,
  getGroupByID,
  getPolicyByID,
  getPolicyForUser,
  generatePath,
  generateFileName,
} from "../lib/fs";
import {
  UploadSession,
  newSessionID,
  saveUploadSession,
  getUploadSession,
  deleteUploadSession,
  computeChunking,
} from "../lib/upload";
import { StorageDriver } from "../storage/driver";
import { toPolicyRuntime } from "../storage/policy";
import { setting } from "../lib/settings";
import {
  cleanPath,
  baseName,
  dirName,
  extName,
  uuid,
  nowSec,
  isLegalObjectName,
  requireParam,
} from "../lib/utils";
import { cache } from "../lib/cache";
import { HMACAuth, signURI } from "../lib/sign";
import type { FileRow, PolicyRow, UserRow } from "../db/schema";

/**
 * 文件路由：/api/v3/file/*
 * 对应原版 routers/controllers/file.go + service/explorer/upload.go。
 *
 * 上传协议（与原版前端 Uploader 完全对齐）：
 *  1. PUT  file/upload          —— 创建上传会话，返回直传凭证
 *  2. POST file/upload/:id/:idx —— 本地策略（R2 中转）分片上传
 *  3. DELETE file/upload/:id    —— 删除上传会话
 *  4. GET  callback/s3/:id      —— S3 家族直传完成回调
 */
const file = new Hono<Ctx>();

file.use("*", authRequired, phoneRequired);

/** 取当前用户所属用户组的策略清单中，是否包含指定策略 */
function assertPolicyAvailable(groupPolicies: number[], policyID: number): void {
  if (!groupPolicies.includes(policyID)) {
    throw apiError(Code.PolicyNotAllowed, "当前用户组无权使用此存储策略");
  }
}

/** 容量检查 */
async function assertStorageAvailable(user: UserRow, addSize: number): Promise<void> {
  const group = await getGroupByID(user.groupId);
  if (!group) throw apiError(Code.GroupNotFound, "用户组不存在");
  if (group.maxStorage === 0) return; // 0 表示不限
  const used = user.storage + addSize;
  if (used > group.maxStorage) {
    throw apiError(Code.InsufficientCapacity, "容量不足");
  }
}

// ───────────────────────────────────────────────────────────
// 创建上传会话（PUT /file/upload）
// ───────────────────────────────────────────────────────────

file.put("/upload", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    path?: string;
    size?: number;
    name?: string;
    policy_id?: number;
    last_modified?: number;
    mime_type?: string;
  };

  const virtualPath = cleanPath(body.path ?? "/");
  const name = String(body.name ?? "");
  const size = Math.max(0, Number(body.size ?? 0));
  const policyID = Number(body.policy_id ?? 0);
  requireParam(name && isLegalObjectName(name), "文件名不合法");
  requireParam(size >= 0, "文件大小不合法");

  // 解析目标目录
  const folder = await resolveFolder(u.id, virtualPath === "/" ? "/" : virtualPath, true);
  if (!folder) return c.json(Err(Code.ParentNotExist, "父目录不存在"));

  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));

  // 选择存储策略：显式指定 > 目录挂载/用户组首选
  let policy: PolicyRow;
  if (policyID) {
    const picked = await getPolicyByID(policyID);
    if (!picked) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
    policy = picked;
    const list = parsePolicyListSafe(group.policies);
    assertPolicyAvailable(list, policy.id);
  } else {
    policy = await getPolicyForUser(u, group, folder);
  }

  // 大小限制
  if (policy.maxSize > 0 && size > policy.maxSize) {
    return c.json(Err(Code.FileTooLarge, "文件大小超过存储策略限制"));
  }
  // 文件类型限制
  const opts = parsePolicyOptions(policy.options);
  if (opts.file_type && opts.file_type.length > 0) {
    const ext = extName(name).replace(/^\./, "");
    if (ext && !opts.file_type.includes(ext)) {
      return c.json(Err(Code.FileTypeNotAllowed, "文件类型不被允许"));
    }
  }
  // 容量检查
  try {
    await assertStorageAvailable(u, size);
  } catch (e) {
    return c.json(buildErr(e));
  }

  // 生成物理存储路径
  const dirRule = generatePath(policy, u.id, virtualPath === "/" ? "" : virtualPath);
  const saveName = generateFileName(policy, u.id, name);
  const savePath = dirRule ? `${dirRule}/${saveName}` : saveName;

  // 占位文件记录（上传完成后回填）
  const sessionKey = newSessionID();
  const placeholder = await writeThrough(
    (d) =>
      d
        .insert(files)
        .values({
          name,
          sourceName: savePath,
          userId: u.id,
          size,
          picInfo: "",
          folderId: folder.id,
          policyId: policy.id,
          uploadSessionId: sessionKey,
          metadata: "",
        })
        .returning(),
    (rows) => ({
      keys: rows.map((r) => ({
        key: `file:${r.id}`,
        value: JSON.stringify(r),
        ttl: 3600,
      })),
    }),
  );
  const fileRow = placeholder.data[0];
  if (!fileRow) return c.json(Err(Code.CreateFSError, "无法创建文件记录"));

  // 会话有效期
  const sessionTTL = await setting.getInt("upload_session_timeout", 86400);
  const expires = nowSec() + sessionTTL;

  const isS3Like = ["s3", "oss", "cos", "minio", "r2", "local"].includes(policy.type);
  if (!isS3Like) {
    // 其他策略类型在 Worker 单体实现中统一按 S3 兼容协议处理
  }

  const runtime = toPolicyRuntime(c, policy);
  const driver = new StorageDriver(runtime);

  // 生成分片上传
  const { chunkSize, total } = computeChunking(size, runtime.chunkSize);
  const uploadID = await driver.initiateMultipart(savePath);

  // 预签名各分片的上传 URL
  const uploadURLs: string[] = [];
  for (let i = 0; i < total; i++) {
    uploadURLs.push(await driver.presignPart(savePath, uploadID, i + 1, sessionTTL));
  }
  const completeURL = await driver.presignComplete(savePath, uploadID, sessionTTL);
  const callback = `/api/v3/callback/s3/${sessionKey}`;

  const sess: UploadSession = {
    key: sessionKey,
    uid: u.id,
    virtualPath,
    name,
    size,
    savePath,
    policyId: policy.id,
    policyType: policy.type,
    fileID: fileRow.id,
    folderID: folder.id,
    chunkSize,
    totalChunks: total,
    uploadID,
    parts: {},
    callback,
    expires,
    lastModified: body.last_modified,
    mimeType: body.mime_type,
  };
  await saveUploadSession(c, sess);

  return c.json(
    ok({
      sessionID: sessionKey,
      expires,
      chunkSize,
      uploadURLs,
      credential: "",
      uploadID,
      callback,
      policy: "",
      ak: "",
      keyTime: "",
      path: savePath,
      completeURL,
    }),
  );
});

// ───────────────────────────────────────────────────────────
// 本地策略分片上传（POST /file/upload/:sessionID/:index）
// ───────────────────────────────────────────────────────────

file.post("/upload/:sessionID/:index", async (c) => {
  const u = c.get("user") as UserRow;
  const sessionID = c.req.param("sessionID");
  const index = Number(c.req.param("index"));
  if (!sessionID || !Number.isInteger(index) || index < 0) {
    return c.json(Err(Code.InvalidChunkIndex, "分片序号不合法"));
  }

  const sess = await getUploadSession(c, sessionID);
  if (!sess) return c.json(Err(Code.UploadSessionExpired, "上传会话不存在或已过期"));
  if (sess.uid !== u.id) return c.json(Err(Code.NoPermissionErr, "无权操作此上传会话"));

  const body = await c.req.arrayBuffer().catch(() => null);
  if (!body || body.byteLength === 0) {
    return c.json(Err(Code.InvalidContentLength, "分片内容为空"));
  }
  if (body.byteLength > sess.chunkSize + 1024 * 1024) {
    return c.json(Err(Code.InvalidContentLength, "分片大小超过限制"));
  }

  const policy = await getPolicyByID(sess.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));

  const runtime = toPolicyRuntime(c, policy);
  const driver = new StorageDriver(runtime);

  // 绑定的 R2 直接用绑定写入，省一次签名往返
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const partKey = `${sess.savePath}.part_${index + 1}`;
    await c.env.R2_BUCKET.put(partKey, body, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    sess.parts[index + 1] = uuid().replace(/-/g, "");
  } else {
    const etag = await driver.putPart(sess.savePath, sess.uploadID, index + 1, body);
    sess.parts[index + 1] = etag;
  }
  await saveUploadSession(c, sess);

  return c.json(ok({}));
});

// ───────────────────────────────────────────────────────────
// 删除上传会话
// ───────────────────────────────────────────────────────────

file.delete("/upload/:sessionID", async (c) => {
  const u = c.get("user") as UserRow;
  const sessionID = c.req.param("sessionID");
  const sess = await getUploadSession(c, sessionID);
  if (!sess) return c.json(ok(null));
  if (sess.uid !== u.id) return c.json(Err(Code.NoPermissionErr, "无权操作此上传会话"));

  const policy = await getPolicyByID(sess.policyId);
  if (policy) {
    try {
      const driver = new StorageDriver(toPolicyRuntime(c, policy));
      await driver.abortMultipart(sess.savePath, sess.uploadID);
    } catch {
      /* 中止失败不致命 */
    }
  }

  // 删除占位文件记录
  await writeThrough((d) =>
    d.delete(files).where(and(eq(files.id, sess.fileID), eq(files.uploadSessionId, sessionID))),
  );
  await deleteUploadSession(c, sessionID);
  return c.json(ok(null));
});

file.delete("/upload", async (c) => {
  // 前端在页面刷新时按本地记录逐个删除；无全部列表接口则直接返回成功
  return c.json(ok(null));
});

// ───────────────────────────────────────────────────────────
// 更新文件内容（PUT /file/update/:id）
// ───────────────────────────────────────────────────────────

file.put("/update/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const rows = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  const target = rows[0];
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));
  if (target.size > (await setting.getInt("maxEditSize", 52428800))) {
    return c.json(Err(Code.FileTooLarge, "文件过大，无法在线编辑"));
  }

  const body = await c.req.text().catch(() => "");
  const policy = await getPolicyByID(target.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policy);

  // 绑定 R2 直接写
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    await c.env.R2_BUCKET.put(target.sourceName, new TextEncoder().encode(body), {
      httpMetadata: { contentType: "text/plain" },
    });
  } else {
    const { url, headers } = await runtime.signer.signRequest(
      "PUT",
      runtime.bucket,
      target.sourceName,
      new TextEncoder().encode(body),
      { "content-type": "text/plain" },
    );
    const resp = await fetch(url, { method: "PUT", headers, body });
    if (!resp.ok) return c.json(Err(Code.UploadFailed, `写入失败：${resp.status}`));
  }

  await writeThrough((d) =>
    d
      .update(files)
      .set({ size: new TextEncoder().encode(body).byteLength, updatedAt: new Date() })
      .where(eq(files.id, id)),
  );
  await cache.delete(`file:${id}`).catch(() => {});
  return c.json(ok(null));
});

// ───────────────────────────────────────────────────────────
// 创建空白文件（POST /file/create）
// ───────────────────────────────────────────────────────────

file.post("/create", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    path?: string;
    name?: string;
    policy_id?: number;
  };
  const path = cleanPath(body.path ?? "/");
  const name = String(body.name ?? "");
  requireParam(name && isLegalObjectName(name), "文件名不合法");

  const folder = await resolveFolder(u.id, path, true);
  if (!folder) return c.json(Err(Code.ParentNotExist, "父目录不存在"));

  // 同名文件
  const existed = await db()
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.name, name), eq(files.folderId, folder.id), eq(files.userId, u.id), isNull(files.deletedAt)))
    .limit(1);
  if (existed.length > 0) return c.json(Err(Code.ObjectExist, "同名文件已存在"));

  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const policy = body.policy_id
    ? await getPolicyByID(Number(body.policy_id))
    : await getPolicyForUser(u, group, folder);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));

  const saveName = generateFileName(policy, u.id, name);
  const dirRule = generatePath(policy, u.id, path === "/" ? "" : path);
  const savePath = dirRule ? `${dirRule}/${saveName}` : saveName;
  const runtime = toPolicyRuntime(c, policy);

  const empty = new Uint8Array(0);
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    await c.env.R2_BUCKET.put(savePath, empty, {
      httpMetadata: { contentType: "text/plain" },
    });
  } else {
    const { url, headers } = await runtime.signer.signRequest(
      "PUT",
      runtime.bucket,
      savePath,
      empty,
      { "content-type": "text/plain" },
    );
    const resp = await fetch(url, { method: "PUT", headers, body: empty });
    if (!resp.ok) return c.json(Err(Code.UploadFailed, `创建失败：${resp.status}`));
  }

  const inserted = await writeThrough(
    (d) =>
      d
        .insert(files)
        .values({
          name,
          sourceName: savePath,
          userId: u.id,
          size: 0,
          picInfo: "",
          folderId: folder.id,
          policyId: policy.id,
          uploadSessionId: null,
          metadata: "",
        })
        .returning(),
    (rows) => ({ keys: rows.map((r) => ({ key: `file:${r.id}`, value: JSON.stringify(r), ttl: 3600 })) }),
  );
  const row = inserted.data[0];
  if (!row) return c.json(Err(Code.CreateFSError, "无法创建文件记录"));

  const position = await folderFullPath(u.id, folder);
  return c.json(ok(buildFileObject(row, position)));
});

// ───────────────────────────────────────────────────────────
// 文本文件内容预览（GET /file/content/:id）
// ───────────────────────────────────────────────────────────

file.get("/content/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const target = await loadUserFile(u.id, id);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));
  if (target.size > (await setting.getInt("maxEditSize", 52428800))) {
    return c.json(Err(Code.FileTooLarge, "文件过大，无法在线预览"));
  }

  const policy = await getPolicyByID(target.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policy);

  c.header("Content-Security-Policy", "sandbox");
  if (runtime.isBoundR2 && c.env.R2_BUCKET) {
    const obj = await c.env.R2_BUCKET.get(target.sourceName);
    if (!obj) return c.json(Err(Code.FileNotFound, "对象不存在"));
    const text = await obj.text();
    return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }

  const driver = new StorageDriver(runtime);
  const resp = await driver.getStream(target.sourceName);
  const buf = await resp.arrayBuffer();
  return c.body(new TextDecoder("utf-8").decode(buf), 200, {
    "Content-Type": "text/plain; charset=utf-8",
  });
});

// ───────────────────────────────────────────────────────────
// 文件预览（GET /file/preview/:id）—— 重定向到可访问 URL
// ───────────────────────────────────────────────────────────

file.get("/preview/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const target = await loadUserFile(u.id, id);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policy = await getPolicyByID(target.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policy);
  const driver = new StorageDriver(runtime);
  const ttl = await setting.getInt("preview_timeout", 600);
  const { url, redirect } = await driver.sourceURL(target.sourceName, ttl);

  if (redirect) return c.redirect(url, 301);
  return c.redirect(url, 302);
});

// ───────────────────────────────────────────────────────────
// 缩略图（GET /file/thumb/:id）
// ───────────────────────────────────────────────────────────

file.get("/thumb/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const target = await loadUserFile(u.id, id);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policy = await getPolicyByID(target.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policy);
  const opts = parsePolicyOptions(policy.options);
  const suffix = (await setting.getWithDefault("thumb_file_suffix", "._thumb")).replace(/^\./, "");
  const thumbExt = (opts.thumb_exts ?? ["jpg", "jpeg", "png", "gif", "webp"]).map((e) => e.replace(/^\./, ""));
  const baseExt = extName(target.name).replace(/^\./, "").toLowerCase();

  // 1) 策略侧生成的缩略图（与主对象同目录的 .thumb 文件）
  if (thumbExt.length > 0) {
    const thumbKey = `${target.sourceName}.${suffix}`;
    const driver = new StorageDriver(runtime);
    if (runtime.isBoundR2 && c.env.R2_BUCKET) {
      const obj = await c.env.R2_BUCKET.get(thumbKey);
      if (obj) {
        const maxAge = await setting.getInt("public_resource_maxage", 86400);
        c.header("Cache-Control", `public, max-age=${maxAge}`);
        return c.newResponse(obj.body, 200, {
          "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
          "Cache-Control": `public, max-age=${maxAge}`,
        });
      }
    } else {
      const head = await driver.head(thumbKey).catch(() => null);
      if (head) {
        const { url, redirect } = await driver.sourceURL(thumbKey, 3600);
        if (redirect) return c.redirect(url, 301);
        return c.redirect(url, 302);
      }
    }
  }

  // 2) 图片类直接回源（Worker 不做本地图像处理）
  if (baseExt && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(baseExt)) {
    const driver = new StorageDriver(runtime);
    const { url, redirect } = await driver.sourceURL(target.sourceName, 3600);
    if (redirect) return c.redirect(url, 301);
    return c.redirect(url, 302);
  }

  return c.json(Err(Code.NotSet, "此文件没有可用的缩略图"));
});

// ───────────────────────────────────────────────────────────
// Office 文档预览地址（GET /file/doc/:id）
// ───────────────────────────────────────────────────────────

file.get("/doc/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const target = await loadUserFile(u.id, id);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const policy = await getPolicyByID(target.policyId);
  if (!policy) return c.json(Err(Code.PolicyNotExist, "存储策略不存在"));
  const runtime = toPolicyRuntime(c, policy);
  const driver = new StorageDriver(runtime);
  const ttl = await setting.getInt("doc_preview_timeout", 600);
  const { url } = await driver.sourceURL(target.sourceName, ttl);

  const service = await setting.getWithDefault(
    "office_preview_service",
    "https://view.officeapps.live.com/op/view.aspx?src={$src}",
  );
  return c.json(ok(service.replace("{$src}", encodeURIComponent(url))));
});

// ───────────────────────────────────────────────────────────
// 下载会话（PUT /file/download/:id）
// ───────────────────────────────────────────────────────────

file.put("/download/:id", async (c) => {
  const u = c.get("user") as UserRow;
  const id = decodeHashID(c.req.param("id"), IDType.FileID);
  if (!id) return c.json(Err(Code.ParamErr, "无法解析文件 ID"));

  const target = await loadUserFile(u.id, id);
  if (!target) return c.json(Err(Code.FileNotFound, "文件不存在"));

  const secretKey = await setting.get("secret_key");
  if (!secretKey) return c.json(Err(Code.InternalSetting, "系统尚未初始化"));
  const auth = new HMACAuth(secretKey);
  const ttl = await setting.getInt("download_timeout", 600);
  const signed = await signURI(auth, `/api/v3/file/get/${c.req.param("id")}/${target.name}`, ttl);
  return c.json(ok(signed.toString()));
});

// ───────────────────────────────────────────────────────────
// 文件外链（POST /file/source）
// ───────────────────────────────────────────────────────────

file.post("/source", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    items?: string[];
    policy_id?: number;
  };
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return c.json(Err(Code.ParamErr, "items 不能为空"));
  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const groupOpts = parseGroupOptionsSafe(group.options);
  const batchLimit = Number(groupOpts.source_batch ?? 0);
  if (batchLimit > 0 && items.length > batchLimit) {
    return c.json(Err(Code.BatchSourceSize, `单次最多生成 ${batchLimit} 个外链`));
  }

  const results: { url: string; id: string }[] = [];
  for (const raw of items) {
    const fid = decodeHashID(raw, IDType.FileID);
    if (!fid) continue;
    const target = await loadUserFile(u.id, fid);
    if (!target) continue;
    const policy = await getPolicyByID(target.policyId);
    if (!policy || !policy.isOriginLinkEnable) continue;

    // 生成永久直链记录
    const link = await writeThrough((d) =>
      d
        .insert(sourceLinks)
        .values({ fileId: target.id, name: target.name, downloads: 0 })
        .returning(),
    );
    const linkID = link.data[0]?.id;
    if (!linkID) continue;

    const secretKey = await setting.get("secret_key");
    const auth = new HMACAuth(secretKey);
    const signed = await signURI(auth, `/api/v3/file/source/${hashIDE(linkID, IDType.SourceLinkID)}/${target.name}`, 0);
    results.push({ url: signed.toString(), id: raw });
  }

  return c.json(ok(results));
});

// ───────────────────────────────────────────────────────────
// 打包下载（POST /file/archive）
// ───────────────────────────────────────────────────────────

file.post("/archive", async (c) => {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as {
    items?: string[];
    folders?: string[];
    name?: string;
  };
  const items = Array.isArray(body.items) ? body.items : [];
  const folderItems = Array.isArray(body.folders) ? body.folders : [];
  const total = items.length + folderItems.length;
  if (total === 0) return c.json(Err(Code.ParamErr, "请选择至少一个对象"));

  const group = await getGroupByID(u.groupId);
  if (!group) return c.json(Err(Code.GroupNotFound, "用户组不存在"));
  const groupOpts = parseGroupOptionsSafe(group.options);
  if (!groupOpts.archive_download) {
    return c.json(Err(Code.FeatureNotEnabled, "当前用户组无权打包下载"));
  }

  // 统计总大小
  let totalSize = 0;
  const fileIDs: number[] = [];
  for (const raw of items) {
    const fid = decodeHashID(raw, IDType.FileID);
    if (!fid) continue;
    fileIDs.push(fid);
  }
  const fileRows = fileIDs.length
    ? await db().select().from(files).where(and(inArray(files.id, fileIDs), eq(files.userId, u.id), isNull(files.deletedAt)))
    : [];
  totalSize += fileRows.reduce((acc, f) => acc + f.size, 0);

  const folderIDs: number[] = [];
  for (const raw of folderItems) {
    const fid = decodeHashID(raw, IDType.FolderID);
    if (fid) folderIDs.push(fid);
  }
  if (folderIDs.length) {
    const childFiles = await db()
      .select({ size: files.size })
      .from(files)
      .where(and(inArray(files.folderId, folderIDs), eq(files.userId, u.id), isNull(files.deletedAt)));
    totalSize += childFiles.reduce((acc, f) => acc + (f.size ?? 0), 0);
  }

  const maxSize = Number(groupOpts.compress_size ?? 0);
  if (maxSize > 0 && totalSize > maxSize) {
    return c.json(Err(Code.FileTooLarge, `打包总大小超过限制（${maxSize} 字节）`));
  }

  // 生成一次性会话，实际打包在 GET 回调中流式进行
  const sessionID = uuid();
  const payload = JSON.stringify({ items: fileRows.map((f) => f.id), folders: folderIDs, uid: u.id, name: body.name || "archive" });
  const ttl = await setting.getInt("archive_timeout", 600);
  await c.env.K4?.put(`archive:${sessionID}`, payload, { expirationTtl: ttl });

  const secretKey = await setting.get("secret_key");
  const auth = new HMACAuth(secretKey);
  const signed = await signURI(auth, `/api/v3/file/archive/${sessionID}/archive.zip`, ttl);
  return c.json(ok(signed.toString()));
});

// ───────────────────────────────────────────────────────────
// 压缩 / 解压 / 转移任务（POST /file/compress、/decompress、/relocate）
// ───────────────────────────────────────────────────────────

file.post("/compress", async (c) => {
  return createTask(c, "compress");
});
file.post("/decompress", async (c) => {
  return createTask(c, "decompress");
});
file.post("/relocate", async (c) => {
  return createTask(c, "relocate");
});

// ───────────────────────────────────────────────────────────
// 搜索（GET /file/search/:type/:keywords）
// ───────────────────────────────────────────────────────────

file.get("/search/:type/:keywords", async (c) => {
  const u = c.get("user") as UserRow;
  const type = c.req.param("type");
  const keywords = decodeURIComponent(c.req.param("keywords") ?? "");
  if (!keywords) return c.json(ok({ parent: "", objects: [] }));

  const parent = c.req.query("parent") ?? "/";
  const path = cleanPath(parent);
  const folder = await resolveFolder(u.id, path);
  if (!folder) return c.json(Err(Code.ParentNotExist, "父目录不存在"));
  const position = await folderFullPath(u.id, folder);

  const pat = `%${keywords.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const isDir = type === "dir";

  if (isDir) {
    const rows = await db()
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, u.id),
          eq(folders.parentId, folder.id),
          like(folders.name, pat),
          isNull(folders.deletedAt),
        ),
      )
      .limit(100);
    return c.json(
      ok({
        parent: hashIDE(folder.id, IDType.FolderID),
        objects: rows.map((f) => buildFolderObjectSafe(f, position)),
      }),
    );
  }

  if (type === "file") {
    const rows = await db()
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, u.id),
          eq(files.folderId, folder.id),
          like(files.name, pat),
          isNull(files.deletedAt),
        ),
      )
      .limit(100);
    return c.json(
      ok({
        parent: hashIDE(folder.id, IDType.FolderID),
        objects: rows.map((f) => buildFileObject(f, position)),
      }),
    );
  }

  // type === "all" 或其它：同时查文件与目录
  const [fileRows, folderRows] = await Promise.all([
    db()
      .select()
      .from(files)
      .where(
        and(eq(files.userId, u.id), eq(files.folderId, folder.id), like(files.name, pat), isNull(files.deletedAt)),
      )
      .limit(100),
    db()
      .select()
      .from(folders)
      .where(
        and(eq(folders.ownerId, u.id), eq(folders.parentId, folder.id), like(folders.name, pat), isNull(folders.deletedAt)),
      )
      .limit(100),
  ]);
  return c.json(
    ok({
      parent: hashIDE(folder.id, IDType.FolderID),
      objects: [
        ...folderRows.map((f) => buildFolderObjectSafe(f, position)),
        ...fileRows.map((f) => buildFileObject(f, position)),
      ],
    }),
  );
});

// ───────────────────────────────────────────────────────────
// 辅助函数
// ───────────────────────────────────────────────────────────

function parsePolicyListSafe(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}

function parseGroupOptionsSafe(raw: string): Record<string, number | boolean | number[] | unknown> {
  try {
    return JSON.parse(raw) as Record<string, number | boolean | number[] | unknown>;
  } catch {
    return {};
  }
}

function buildFolderObjectSafe(folder: { id: number; name: string; updatedAt: Date; createdAt: Date }, position: string) {
  return {
    id: hashIDE(folder.id, IDType.FolderID),
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

/** 加载用户可访问的文件（带缓存） */
async function loadUserFile(uid: number, fileID: number): Promise<FileRow | null> {
  const cached = await cache.get<string>(`file:${fileID}`).catch(() => null);
  if (cached) {
    try {
      const row = JSON.parse(cached) as FileRow;
      if (row.userId === uid) return row;
      return null;
    } catch {
      /* fallthrough */
    }
  }
  const rows = await db()
    .select()
    .from(files)
    .where(and(eq(files.id, fileID), eq(files.userId, uid), isNull(files.deletedAt)))
    .limit(1);
  const row = rows[0] ?? null;
  if (row) {
    await cache.set(`file:${fileID}`, JSON.stringify(row), 3600).catch(() => {});
  }
  return row;
}

/** 把 Error / AppError 转为标准错误响应 */
function buildErr(e: unknown): { code: number; msg: string } {
  const err = e as { code?: number; message?: string };
  return { code: err.code ?? Code.IOFailed, msg: err.message ?? "操作失败" };
}

/** 异步任务占位创建（压缩/解压/转移在 Worker 中以流式处理或排队） */
async function createTask(c: Context<Ctx>, kind: string) {
  const u = c.get("user") as UserRow;
  const body = await c.req.json().catch(() => ({})) as { items?: string[]; folders?: string[]; dst?: string };
  const items = Array.isArray(body.items) ? body.items : [];
  const folderItems = Array.isArray(body.folders) ? body.folders : [];
  if (items.length === 0 && folderItems.length === 0) {
    return c.json(Err(Code.ParamErr, "请选择至少一个对象"));
  }
  const taskType = kind === "compress" ? 1 : kind === "decompress" ? 2 : 3;
  const inserted = await writeThrough((d) =>
    d
      .insert(tasks)
      .values({
        status: 0,
        type: taskType,
        userId: u.id,
        progress: 0,
        error: "",
        props: JSON.stringify({ items, folders: folderItems, dst: body.dst ?? "" }),
      })
      .returning(),
  );
  const row = inserted.data[0];
  return c.json(ok({ id: row ? hashIDE(row.id, IDType.TagID) : "" }));
}

export default file;
