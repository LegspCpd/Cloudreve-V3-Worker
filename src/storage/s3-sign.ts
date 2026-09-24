/**
 * AWS SigV4 签名实现（纯 Web Crypto），同时用于：
 *  - R2（path-style，<account>.r2.cloudflarestorage.com，region = auto）
 *  - 任意 S3 兼容存储（OSS/COS/MinIO 等，按策略 endpoint）
 *
 * 支持两种形态：
 *  - 预签名 URL（查询串携带签名），用于浏览器端直传与下载
 *  - 请求头签名（Authorization: AWS4-HMAC-SHA256），用于服务端 fetch
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", cryptoKey, data);
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? toUtf8(input) : input;
  return hex(await crypto.subtle.digest("SHA-256", data));
}

/** RFC3986 编码 */
function uriEncode(input: string, encodeSlash = true): string {
  let out = "";
  for (const ch of Array.from(input)) {
    if (
      /[A-Za-z0-9\-_.~]/.test(ch) ||
      (!encodeSlash && ch === "/")
    ) {
      out += ch;
    } else {
      const bytes = toUtf8(ch);
      for (const b of bytes) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function amzDate(d: Date): { amzDate: string; dateStamp: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const amz = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return { amzDate: amz, dateStamp: stamp };
}

export interface SignerOptions {
  accessKey: string;
  secretKey: string;
  /** 区域，R2 用 "auto" */
  region: string;
  /** endpoint，如 https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  /** 强制 path-style（R2 与自建 MinIO 为 true） */
  forcePathStyle: boolean;
}

export class S3Signer {
  constructor(private opts: SignerOptions) {}

  private async signingKey(dateStamp: string): Promise<Uint8Array> {
    const kDate = await hmac(toUtf8("AWS4" + this.opts.secretKey), toUtf8(dateStamp));
    const kRegion = await hmac(new Uint8Array(kDate), toUtf8(this.opts.region));
    const kService = await hmac(new Uint8Array(kRegion), toUtf8(SERVICE));
    const kSigning = await hmac(new Uint8Array(kService), toUtf8("aws4_request"));
    return new Uint8Array(kSigning);
  }

  private credentialScope(dateStamp: string): string {
    return `${dateStamp}/${this.opts.region}/${SERVICE}/aws4_request`;
  }

  private bucketHostPrefix(bucket: string): string {
    const ep = this.opts.endpoint.replace(/\/$/, "");
    if (this.opts.forcePathStyle) {
      return `${ep}/${bucket}`;
    }
    // virtual-host style
    const u = new URL(ep);
    return `${u.protocol}//${bucket}.${u.host}`;
  }

  /**
   * 生成预签名 URL（GET 下载 / PUT 上传）。
   * @param method GET | PUT | POST | HEAD
   * @param bucket 存储桶名
   * @param key 对象键（不含桶名）
   * @param expires 有效期秒
   * @param extraQuery 附加查询参数（如 PartNumber、uploadId）
   */
  async presign(
    method: string,
    bucket: string,
    key: string,
    expires: number,
    extraQuery: Record<string, string> = {},
  ): Promise<string> {
    const d = new Date();
    const { amzDate: amz, dateStamp } = amzDate(d);
    const credential = `${this.opts.accessKey}/${this.credentialScope(dateStamp)}`;
    const host = new URL(this.bucketHostPrefix(bucket)).host;

    const signedHeaders = "host";
    const queryParams: Record<string, string> = {
      "X-Amz-Algorithm": ALGORITHM,
      "X-Amz-Credential": credential,
      "X-Amz-Date": amz,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": signedHeaders,
      ...extraQuery,
    };

    // 规范化查询串：键名小写后排序
    const sortedQuery = Object.entries(queryParams)
      .map(([k, v]) => [uriEncode(k.toLowerCase()), uriEncode(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQueryString = sortedQuery.map(([k, v]) => `${k}=${v}`).join("&");

    const canonicalUri = uriEncode("/" + key.replace(/^\/+/, ""), false);
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      `host:${host}\n`,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      ALGORITHM,
      amz,
      this.credentialScope(dateStamp),
      await sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = await this.signingKey(dateStamp);
    const signature = hex(await hmac(signingKey, toUtf8(stringToSign)));

    const finalQuery = canonicalQueryString + "&X-Amz-Signature=" + signature;
    return `${this.bucketHostPrefix(bucket)}${canonicalUri}?${finalQuery}`;
  }

  /**
   * 生成请求头签名（服务端 fetch 调用 S3/R2 API）。
   * @param method HTTP 方法
   * @param bucket 存储桶名
   * @param key 对象键
   * @param body 请求体（可为空）
   * @param headers 附加头
   */
  async signRequest(
    method: string,
    bucket: string,
    key: string,
    body: Uint8Array | string | null,
    headers: Record<string, string> = {},
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const d = new Date();
    const { amzDate: amz, dateStamp } = amzDate(d);
    const host = new URL(this.bucketHostPrefix(bucket)).host;
    const payloadHash = body === null ? await sha256Hex("") : await sha256Hex(body);

    const allHeaders: Record<string, string> = {
      host,
      "x-amz-date": amz,
      "x-amz-content-sha256": payloadHash,
      ...headers,
    };

    const canonicalHeaders = Object.keys(allHeaders)
      .map((k) => k.toLowerCase())
      .sort()
      .map((k) => `${k}:${allHeaders[k]?.trim()}\n`)
      .join("");
    const signedHeaders = Object.keys(allHeaders)
      .map((k) => k.toLowerCase())
      .sort()
      .join(";");

    const canonicalUri = uriEncode("/" + key.replace(/^\/+/, ""), false);
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      ALGORITHM,
      amz,
      this.credentialScope(dateStamp),
      await sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = await this.signingKey(dateStamp);
    const signature = hex(await hmac(signingKey, toUtf8(stringToSign)));
    const credential = `${this.opts.accessKey}/${this.credentialScope(dateStamp)}`;
    const authHeader = `${ALGORITHM} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      url: `${this.bucketHostPrefix(bucket)}${canonicalUri}`,
      headers: {
        ...allHeaders,
        Authorization: authHeader,
      },
    };
  }
}
