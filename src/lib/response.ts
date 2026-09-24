import type { Context } from "hono";
import { AppError, Code, dbErr, err, paramErr } from "./errors";

/**
 * 与原版 serializer.Response 完全对齐的响应结构。
 * 前端拦截器依据 code 判断成功（0 / 203）与失败。
 */
export interface Response {
  code: number;
  data?: unknown;
  msg: string;
  error?: string;
}

const isDev = (c?: Context) => {
  if (!c) return true;
  const env = c.env as { ENVIRONMENT?: string };
  return env?.ENVIRONMENT !== "production";
};

export const ok = (data?: unknown, msg = ""): Response => ({
  code: 0,
  data,
  msg,
});

/** 序列化错误并返回标准响应；开发环境附带底层错误信息 */
export function buildErrorResponse(appErr: AppError, c?: Context): Response {
  const res: Response = {
    code: appErr.code,
    msg: appErr.message,
  };
  if (appErr.rawError !== undefined && isDev(c)) {
    res.error = String(
      appErr.rawError instanceof Error
        ? appErr.rawError.message
        : typeof appErr.rawError === "string"
          ? appErr.rawError
          : JSON.stringify(appErr.rawError),
    );
  }
  return res;
}

/** 通用错误响应（对应 serializer.Err） */
export const Err = (code: number, msg: string, rawError?: unknown, c?: Context): Response =>
  buildErrorResponse(err(code, msg, rawError), c);

/** 参数错误响应 */
export const ParamErr = (msg = "Invalid parameters.", rawError?: unknown, c?: Context): Response =>
  buildErrorResponse(paramErr(msg, rawError), c);

/** 数据库错误响应 */
export const DBErr = (msg = "Database operation failed.", rawError?: unknown, c?: Context): Response =>
  buildErrorResponse(dbErr(msg, rawError), c);

/** 未登录响应 */
export const CheckLogin = (): Response => ({ code: Code.CheckLogin, msg: "Login required" });

/** 需要绑定手机 */
export const PhoneRequired = (): Response => ({
  code: Code.PhoneRequired,
  msg: "此功能需要绑定手机后使用",
});

/**
 * 在路由中抛出，由全局错误处理中间件统一转换为标准响应。
 * 用法：throw apiError(Code.FileNotFound, "文件不存在")
 */
export const apiError = (code: number, msg: string, rawError?: unknown): AppError =>
  err(code, msg, rawError);

export { AppError, Code };
