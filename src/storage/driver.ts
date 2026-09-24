import { apiError, Code } from "../lib/errors";
import type { PolicyRuntime } from "./policy";

/**
 * S3 家族存储操作：覆盖 R2 与任意 S3 兼容存储。
 * 分片上传流程对齐前端 Uploader 的 s3-like 协议：
 *   initiate -> presign part PUT -> presign complete POST -> 回调通知本服务
 */

function extractXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = re.exec(xml);
  return m ? (m[1] as string).trim() : null;
}

export class StorageDriver {
  constructor(private policy: PolicyRuntime) {}

  get p(): PolicyRuntime {
    return this.policy;
  }

  /** 发起分片上传，返回 uploadId */
  async initiateMultipart(key: string): Promise<string> {
    const { url, headers } = await this.policy.signer.signRequest(
      "POST",
      this.policy.bucket,
      `${key}?uploads`,
      null,
      {},
    );
    const resp = await fetch(url, { method: "POST", headers });
    const text = await resp.text();
    if (!resp.ok) {
      throw apiError(Code.UploadFailed, `Failed to initiate multipart upload: ${resp.status}`, text);
    }
    const uploadId = extractXmlTag(text, "UploadId");
    if (!uploadId) {
      throw apiError(Code.UploadFailed, "Multipart upload ID missing in response", text);
    }
    return uploadId;
  }

  /** 为指定分片生成预签名 PUT URL（浏览器直传） */
  async presignPart(key: string, uploadId: string, partNumber: number, expires: number): Promise<string> {
    const cleanKey = key.split("?")[0] ?? key;
    return this.policy.signer.presign("PUT", this.policy.bucket, cleanKey, expires, {
      partNumber: String(partNumber),
      uploadId,
    });
  }

  /** 为 CompleteMultipartUpload 生成预签名 POST URL */
  async presignComplete(key: string, uploadId: string, expires: number): Promise<string> {
    const cleanKey = key.split("?")[0] ?? key;
    return this.policy.signer.presign("POST", this.policy.bucket, cleanKey, expires, {
      uploadId,
    });
  }

  /** 服务端直接上传一个分片（用于经 Worker 中转的本地策略） */
  async putPart(key: string, uploadId: string, partNumber: number, body: ArrayBuffer | Uint8Array): Promise<string> {
    const cleanKey = key.split("?")[0] ?? key;
    const data = body instanceof Uint8Array ? body : new Uint8Array(body);
    const { url, headers } = await this.policy.signer.signRequest(
      "PUT",
      this.policy.bucket,
      `${cleanKey}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
      data,
      {},
    );
    const resp = await fetch(url, { method: "PUT", headers, body: data });
    if (!resp.ok) {
      const text = await resp.text();
      throw apiError(Code.UploadFailed, `Failed to upload part ${partNumber}: ${resp.status}`, text);
    }
    const etag = resp.headers.get("etag") || "";
    if (!etag) {
      throw apiError(Code.UploadFailed, `Part ${partNumber} response missing ETag`);
    }
    return etag.replace(/"/g, "");
  }

  /** 完成分片上传 */
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const cleanKey = key.split("?")[0] ?? key;
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>` +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
        .join("") +
      `</CompleteMultipartUpload>`;
    const { url, headers } = await this.policy.signer.signRequest(
      "POST",
      this.policy.bucket,
      `${cleanKey}?uploadId=${encodeURIComponent(uploadId)}`,
      body,
      { "content-type": "application/xhtml+xml" },
    );
    const resp = await fetch(url, { method: "POST", headers, body });
    if (!resp.ok) {
      const text = await resp.text();
      throw apiError(Code.UploadFailed, `Failed to complete multipart upload: ${resp.status}`, text);
    }
  }

  /** 中止分片上传 */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const cleanKey = key.split("?")[0] ?? key;
    const { url, headers } = await this.policy.signer.signRequest(
      "DELETE",
      this.policy.bucket,
      `${cleanKey}?uploadId=${encodeURIComponent(uploadId)}`,
      null,
    );
    const resp = await fetch(url, { method: "DELETE", headers });
    // 中止失败不致命，忽略错误
    if (!resp.ok) {
      void await resp.text().catch(() => "");
    }
  }

  /** 生成预签名下载 URL */
  async presignGet(key: string, expires: number): Promise<string> {
    const cleanKey = key.split("?")[0] ?? key;
    return this.policy.signer.presign("GET", this.policy.bucket, cleanKey, expires);
  }

  /**
   * 取得文件的可访问 URL：
   *  - 公有桶且配置了 base_url：直接拼接（301 跳转）
   *  - 私有桶：预签名（302 跳转）
   */
  async sourceURL(key: string, expires: number): Promise<{ url: string; redirect: boolean }> {
    if (!this.policy.isPrivate && this.policy.baseUrl) {
      const base = this.policy.baseUrl.replace(/\/$/, "");
      return { url: `${base}/${key}`, redirect: true };
    }
    return { url: await this.presignGet(key, expires), redirect: false };
  }

  /** 删除对象 */
  async delete(key: string): Promise<void> {
    const cleanKey = key.split("?")[0] ?? key;
    const { url, headers } = await this.policy.signer.signRequest("DELETE", this.policy.bucket, cleanKey, null);
    const resp = await fetch(url, { method: "DELETE", headers });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      throw apiError(Code.IOFailed, `Failed to delete object: ${resp.status}`, text);
    }
  }

  /** 批量删除 */
  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.delete(k).catch(() => {})));
  }

  /** 获取对象元信息 */
  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const cleanKey = key.split("?")[0] ?? key;
    const { url, headers } = await this.policy.signer.signRequest("HEAD", this.policy.bucket, cleanKey, null);
    const resp = await fetch(url, { method: "HEAD", headers });
    if (!resp.ok) return null;
    const size = Number(resp.headers.get("content-length") || 0);
    const etag = (resp.headers.get("etag") || "").replace(/"/g, "");
    return { size, etag };
  }

  /** 流式读取对象内容（供 Worker 中转输出） */
  async getStream(key: string, range?: string): Promise<Response> {
    const cleanKey = key.split("?")[0] ?? key;
    const headers: Record<string, string> = {};
    if (range) headers.range = range;
    const signed = await this.policy.signer.signRequest("GET", this.policy.bucket, cleanKey, null, headers);
    const resp = await fetch(signed.url, { method: "GET", headers: signed.headers });
    if (!resp.ok) {
      throw apiError(Code.IOFailed, `Failed to fetch object: ${resp.status}`);
    }
    return resp;
  }

  /** 直接上传一段字节（打包归档等场景使用） */
  async putBuffer(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<void> {
    const cleanKey = key.split("?")[0] ?? key;
    const body = data instanceof Uint8Array ? data : new Uint8Array(data);
    const { url, headers } = await this.policy.signer.signRequest(
      "PUT",
      this.policy.bucket,
      cleanKey,
      body,
      { "content-type": contentType },
    );
    const resp = await fetch(url, { method: "PUT", headers, body });
    if (!resp.ok) {
      const text = await resp.text();
      throw apiError(Code.UploadFailed, `Failed to put object: ${resp.status}`, text);
    }
  }
}
