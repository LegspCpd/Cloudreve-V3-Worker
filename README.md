# Cloudreve-V3-Worker

[![Deploy](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Database](https://img.shields.io/badge/Neon-PostgreSQL-00E599?logo=neon&logoColor=black)](https://neon.tech/)
[![Email](https://img.shields.io/badge/Resend-Email-000000?logo=resend&logoColor=white)](https://resend.com/)

把 **Cloudreve Plus**（原版 Go/Gin 后端 + React 前端）完整重写为**单个 Cloudflare Worker**。

所有功能保留、一个项目搞定、两条命令上线。

---

## ✨ 特性

- **单 Worker 全栈**：后端 API + 前端 SPA + WebDAV 协议，全部在一个 Worker 里
- **协议级兼容**：与原版前端完全对齐（响应结构、错误码、HashID、HMAC 签名、S3 直传流程）
- **多级缓存**：内存 → KV → Neon 缓存库 → 主库，热数据尽可能不查库
- **主备双写**：每次写入主库自动同步到备份库，副库再把热数据提升到缓存
- **存储双路**：本地存储 = 绑定的 R2 存储桶；同时支持任意 S3 兼容存储（AWS S3 / MinIO / OSS / COS）
- **数量受控**：KV 与 Neon 库都通过环境变量控制数量，**上限 5 个**，超过自动失败并提示减少一个

## 🚀 快速开始

### 方式一：Fork + 一键部署（推荐，全程不用本地环境）

1. **Fork** 本仓库
2. 在仓库 **Settings → Secrets and variables → Actions** 填入变量：
   `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`RESEND_API_KEY`、`SESSION_SECRET`、`HASHID_SALT`、`NEON_API_KEY`、`NEON_PROJECT_ID`
3. 进入 **Actions** 标签页 → **Deploy to Cloudflare Workers** → **Run workflow**，勾选 `setup` 与 `apply_secrets`
4. 等 3~5 分钟，在日志里拿到管理员账号，打开 Worker 地址即可使用

📄 详细步骤见 [DEPLOY.md](./DEPLOY.md#方式一fork--一键部署推荐全程不用本地环境)

### 方式二：本地命令行

```bash
npm install
npm run setup        # 自动创建 KV + Neon 库 + 表结构 + 种子数据
npm run build        # 构建前端 + 后端
npm run secrets:apply
npm run deploy       # 部署到 Cloudflare
```

## 📁 项目结构

```
cloudreve-worker/
├── src/
│   ├── index.ts              # Hono 入口，装配全部路由与中间件
│   ├── env.ts                # 环境变量与 KV/R2 绑定类型
│   ├── db/
│   │   ├── schema.ts         # Drizzle 表结构（与原版 GORM 模型逐字段对齐）
│   │   └── client.ts         # 主库/副库/缓存库路由 + 写穿透同步
│   ├── lib/
│   │   ├── cache.ts          # 多级缓存（内存 → K1 → Neon 缓存库）
│   │   ├── session.ts        # 会话（K2 KV，HMAC 签名 Cookie）
│   │   ├── upload.ts         # 上传会话（K3 KV）
│   │   ├── zip.ts            # STORE 模式 zip 构建（打包下载）
│   │   ├── password.ts       # 密码哈希（兼容 V2 md5 格式）
│   │   ├── hashid.ts         # ID 混淆（与原版互通）
│   │   ├── sign.ts           # HMAC 签名
│   │   ├── email.ts          # Resend 邮件
│   │   ├── totp.ts           # 2FA（RFC 6238）
│   │   └── ...
│   ├── storage/
│   │   ├── s3-sign.ts        # AWS SigV4 签名（预签名 URL + 请求签名）
│   │   ├── policy.ts         # 存储策略 → 运行时视图
│   │   └── driver.ts         # 存储驱动（multipart / 分片 / 流式读取）
│   ├── middleware/           # 认证 / CSRF / 上传会话 / 限流 / WebDAV 认证
│   └── routes/
│       ├── site.ts           # 站点配置 / 验证码 / PWA
│       ├── user.ts           # 注册 / 登录 / 2FA / 资料设置
│       ├── file.ts           # 上传 / 下载 / 预览 / 搜索 / 压缩
│       ├── directory.ts      # 目录列表 / 创建 / 挂载
│       ├── object.ts         # 删除 / 移动 / 重命名
│       ├── share.ts          # 分享系统
│       ├── tag.ts            # 用户标签
│       ├── vas.ts            # 增值服务（容量包 / 订单 / 兑换码）
│       ├── aria2.ts          # 离线下载（外部 Aria2 节点）
│       ├── webdav.ts         # WebDAV 协议
│       ├── webdav-manage.ts  # WebDAV 账号与挂载管理
│       ├── callback.ts       # 各存储策略上传回调
│       ├── anonymous.ts      # 签名资源访问（下载 / 外链 / 打包）
│       └── admin.ts          # 后台管理
├── scripts/
│   ├── setup.mjs             # 一键初始化（KV + Neon 自动创建，数量上限 5）
│   ├── db-push.mjs           # 表结构推送到所有库
│   ├── db-seed.mjs           # 种子数据
│   └── seed-data.json        # 默认系统设置
├── public/                   # 前端构建产物（由 npm run build 生成）
├── wrangler.toml             # Cloudflare Worker 配置
└── DEPLOY.md                 # 部署教程
```

## 🗄️ 资源分配

| 资源 | 数量上限 | 分配 |
|---|---|---|
| Worker KV | **5** | `K1` 热数据全量缓存 · `K2` 会话 · `K3` 上传会话 · `K4` 任务进度 · `K5` 锁与限流 |
| Neon 数据库 | **5** | **1 主库**（存放数据）+ 缓存库（热数据）+ **1 备份库**（写穿透同步） |
| R2 存储桶 | 1 | 「本地存储」策略 |

超过上限时 `npm run setup` 会自动失败并提示：`请减少一个（Worker KV 最多 5 个）`。

## 📜 常用命令

```bash
npm run setup        # 一键初始化
npm run dev          # 本地调试
npm run build        # 构建
npm run deploy       # 部署
npm run typecheck    # 类型检查
npm run db:push      # 表结构增量更新
npm run db:seed      # 种子数据（幂等）
npm run db:reset     # 清空重建（危险）
npm run tail         # 实时日志
```

## ⚖️ 与原版的差异

| 功能 | 说明 |
|---|---|
| Aria2 离线下载 | 使用**外部节点**（后台「节点管理」配置），Worker 通过 JSON-RPC 派发任务 |
| 本地存储 | 映射到绑定的 R2 存储桶 |
| 缩略图 | 使用存储侧生成的缩略图，图片类直接回源 |
| ffmpeg / 文档转换 | Worker 运行时不可用，需存储侧或外部节点完成 |
| QQ 登录 / WebAuthn | 接口保留，未启用 |

## 📄 License

MIT
