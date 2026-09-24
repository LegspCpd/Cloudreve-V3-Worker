import { apiError, Code } from "./errors";

/**
 * 与原版 pkg/auth/hmac.go 完全互通的签名实现。
 * 签名格式：`base64url(HMAC_SHA256(body + ":" + expires)) + ":" + expires`
 * 密钥取自设置项 `secret_key`。
 */
export class HMACAuth {
  private key: CryptoKey | null = null;
  constructor(private secretKey: string) {}

  private async getKey(): Promise<CryptoKey> {
    if (!this.key) {
      this.key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.secretKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return this.key;
  }

  /** 对给定 body 生成 expires 后失效的签名；expires=0 表示不限制 */
  async sign(body: string, expires: number): Promise<string> {
    const expireTimeStamp = String(expires);
    const key = await this.getKey();
    const data = new TextEncoder().encode(`${body}:${expireTimeStamp}`);
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return base64UrlEncode(new Uint8Array(sig)) + ":" + expireTimeStamp;
  }

  /** 校验签名并检查有效期 */
  async check(body: string, sign: string): Promise<void> {
    const parts = sign.split(":");
    const expiresRaw = parts[parts.length - 1];
    if (!expiresRaw) {
      throw apiError(Code.NoPermissionErr, "expire timestamp is missing");
    }
    const expires = Number(expiresRaw);
    if (!Number.isFinite(expires)) {
      throw apiError(Code.InvalidSign, "invalid sign");
    }
    if (expires !== 0 && expires < Math.floor(Date.now() / 1000)) {
      throw apiError(Code.SignExpired, "signature expired");
    }
    const expected = await this.sign(body, expires);
    if (expected !== sign) {
      throw apiError(Code.InvalidSign, "invalid sign");
    }
  }
}

/** URL 安全的 Base64 编码（对齐 Go base64.URLEncoding） */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const binary = atob(s + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 对 URI 的 path 部分签名，返回带 sign 查询参数的 URL */
export async function signURI(
  auth: HMACAuth,
  uri: string,
  expires: number,
): Promise<URL> {
  let expiresAt = expires;
  if (expiresAt !== 0) expiresAt += Math.floor(Date.now() / 1000);
  const base = new URL(uri);
  const sign = await auth.sign(base.pathname, expiresAt);
  base.searchParams.set("sign", sign);
  return base;
}

/** 校验 URI 签名（返回去掉 sign 后的 URL） */
export async function checkURI(auth: HMACAuth, url: URL): Promise<void> {
  const sign = url.searchParams.get("sign") ?? "";
  url.searchParams.delete("sign");
  await auth.check(url.pathname, sign);
}
