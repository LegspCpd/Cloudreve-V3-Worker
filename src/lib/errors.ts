/**
 * 与原版 serializer/error.go 完全对齐的错误码体系。
 * 三位数错误码复用 HTTP 原本含义；五位数为应用自定义错误；
 * 4 开头为客户端错误，5 开头为服务端错误。
 */
export const Code = {
  // 特殊
  NotSet: -1,
  // 三位数：复用 HTTP 含义
  NotFullySuccess: 203,
  CheckLogin: 401,
  NoPermissionErr: 403,
  NotFound: 404,
  Conflict: 409,

  // 五位数：客户端错误
  ParamErr: 40001,
  UploadFailed: 40002,
  CreateFolderFailed: 40003,
  ObjectExist: 40004,
  SignExpired: 40005,
  PolicyNotAllowed: 40006,
  GroupNotAllowed: 40007,
  AdminRequired: 40008,
  MasterNotFound: 40009,
  PhoneRequired: 40010,
  UploadSessionExpired: 40011,
  InvalidChunkIndex: 40012,
  InvalidContentLength: 40013,
  BatchSourceSize: 40014,
  BatchAria2Size: 40015,
  ParentNotExist: 40016,
  UserBaned: 40017,
  UserNotActivated: 40018,
  FeatureNotEnabled: 40019,
  CredentialInvalid: 40020,
  UserNotFound: 40021,
  TwoFACodeErr: 40022,
  LoginSessionNotExist: 40023,
  InitializeAuthn: 40024,
  WebAuthnCredentialError: 40025,
  CaptchaError: 40026,
  CaptchaRefreshNeeded: 40027,
  FailedSendEmail: 40028,
  InvalidTempLink: 40029,
  TempLinkExpired: 40030,
  EmailProviderBaned: 40031,
  EmailExisted: 40032,
  EmailSent: 40033,
  UserCannotActivate: 40034,
  PolicyNotExist: 40035,
  DeleteDefaultPolicy: 40036,
  PolicyUsedByFiles: 40037,
  PolicyUsedByGroups: 40038,
  GroupNotFound: 40039,
  InvalidActionOnSystemGroup: 40040,
  GroupUsedByUser: 40041,
  ChangeGroupForDefaultUser: 40042,
  InvalidActionOnDefaultUser: 40043,
  FileNotFound: 40044,
  ListFilesError: 40045,
  InvalidActionOnSystemNode: 40046,
  CreateFSError: 40047,
  CreateTaskError: 40048,
  FileTooLarge: 40049,
  FileTypeNotAllowed: 40050,
  InsufficientCapacity: 40051,
  IllegalObjectName: 40052,
  RootProtected: 40053,
  ConflictUploadOngoing: 40054,
  MetaMismatch: 40055,
  UnsupportedArchiveType: 40056,
  PolicyChanged: 40057,
  ShareLinkNotFound: 40058,
  SaveOwnShare: 40059,
  SlavePingMaster: 40060,
  VersionMismatch: 40061,
  InsufficientCredit: 40062,
  GroupConflict: 40063,
  GroupInvalid: 40064,
  InvalidGiftCode: 40065,
  QQBindConflict: 40066,
  QQBindOtherAccount: 40067,
  QQNotLinked: 40068,
  IncorrectPassword: 40069,
  DisabledSharePreview: 40070,
  InvalidSign: 40071,
  FulfillAdminGroup: 40072,

  // 五位数：服务端错误
  DBError: 50001,
  EncryptError: 50002,
  IOFailed: 50004,
  InternalSetting: 50005,
  CacheOperation: 50006,
  CallbackError: 50007,
  UpdateSetting: 50008,
  AddCORS: 50009,
  NodeOffline: 50010,
  QueryMetaFailed: 50011,
} as const;

export type CodeValue = (typeof Code)[keyof typeof Code];

/** 应用错误，等价于原版 serializer.AppError */
export class AppError extends Error {
  code: number;
  rawError?: unknown;

  constructor(code: number, msg: string, rawError?: unknown) {
    super(msg);
    this.name = "AppError";
    this.code = code;
    this.rawError = rawError;
  }
}

export const err = (code: number, msg: string, rawError?: unknown): AppError =>
  new AppError(code, msg, rawError);

export const dbErr = (msg = "Database operation failed.", rawError?: unknown): AppError =>
  err(Code.DBError, msg, rawError);

export const paramErr = (msg = "Invalid parameters.", rawError?: unknown): AppError =>
  err(Code.ParamErr, msg, rawError);

/** 兼容路由层惯用写法 */
export const apiError = (code: number, msg: string, rawError?: unknown): AppError =>
  err(code, msg, rawError);
