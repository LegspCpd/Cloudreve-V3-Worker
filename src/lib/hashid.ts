import Hashids from "hashids";

/**
 * 与原版 pkg/hashid 对齐的 ID 混淆实现。
 * 底层算法与 github.com/speps/go-hashids 完全一致（同 salt、同默认字母表与分隔符），
 * 因此与原版数据库中的 HashID 互通。
 */

// ID 类型，与原版常量保持一致
export const IDType = {
  ShareID: 0,
  UserID: 1,
  FileID: 2,
  FolderID: 3,
  TagID: 4,
  PolicyID: 5,
  SourceLinkID: 6,
} as const;
export type IDType = (typeof IDType)[keyof typeof IDType];

const singleton = {
  salt: "",
  h: null as Hashids | null,
};

/** 初始化盐值（Worker 启动时由配置注入） */
export function setHashIDSalt(salt: string): void {
  singleton.salt = salt;
  singleton.h = new Hashids(salt, 0, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
}

function instance(): Hashids {
  if (!singleton.h) {
    setHashIDSalt(singleton.salt || "cloudreve");
  }
  return singleton.h as Hashids;
}

/** 对给定数据计算 HashID */
export function hashEncode(values: number[]): string {
  return instance().encode(values);
}

/** 对给定 HashID 计算原始数据 */
export function hashDecode(raw: string): number[] {
  const v = instance().decode(raw);
  return v.map((n) => Number(n));
}

/** 计算数据库主键对应的 HashID */
export function hashID(id: number, t: IDType): string {
  return hashEncode([id, t]);
}

/** 计算 HashID 对应的数据库 ID；类型不匹配返回 0 */
export function decodeHashID(id: string, t: IDType): number {
  const v = hashDecode(id);
  if (v.length !== 2 || v[1] !== t) {
    return 0;
  }
  return v[0];
}
