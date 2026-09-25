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

## 🚀 一键部署

**在 Cloudflare 面板连仓库，填 3 样东西就完事：构建命令、部署命令、环境变量。**
部署时自动完成：创建 KV 命名空间 → 创建 Neon 数据库 → 建表 → 种子数据 → 构建前端 → 部署 Worker。之后每次 push 到 main 自动重新部署。

### 操作步骤

1. **Fork** 本仓库

2. 打开 [Cloudflare 面板](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Connect repository**，选你 fork 的仓库

3. 填写配置：

   | 配置项 | 填写内容 |
   |---|---|
   | Project name | `cloudreve-v3`（任意） |
   | Production branch | `main` |
   | Framework preset | `None` |
   | **Build command** | `npm install --legacy-peer-deps` |
   | **Deploy command** | `npm run deploy` |
   | Root directory | 留空 |

4. 展开底部的 **Environment variables**，逐个添加（敏感的选 **Encrypt**）：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `NEON_API_KEY` | ✅ | [Neon 控制台](https://console.neon.tech/app/settings/api-keys) 生成，用于自动建库 |
   | `NEON_PROJECT_ID` | ✅ | Neon 项目 Settings 中查看 |
   | `RESEND_API_KEY` | ✅ | [Resend](https://resend.com/api-keys)，邮件发送 |
   | `SESSION_SECRET` | ✅ | 会话签名，32 位随机串 |
   | `HASHID_SALT` | ✅ | ID 混淆盐值，**设定后不可改** |
   | `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |
   | `SITE_URL` | ✅ | 站点地址，如 `https://cloudreve-v3.xxx.workers.dev` |
   | `ADMIN_EMAIL` | 可选 | 管理员邮箱，默认 `admin@cloudreve.org` |
   | `ADMIN_PASSWORD` | 可选 | 管理员密码，不填自动生成 |
   | `NODE_VERSION` | 建议 | `22`（wrangler 4 要求 Node ≥ 22；构建镜像默认通常已满足） |

   > `--openssl-legacy-provider`（旧版 CRA 在 Node 17+ 构建时需要）已内置在构建脚本中，无需再手工添加 `NODE_OPTIONS`。

5. 点 **Save and Deploy**，等 3~5 分钟

6. 完成。管理员账号密码在部署日志的 `db:seed` 步骤里

> KV 命名空间与 R2 存储桶都由部署脚本自动创建，已存在的自动复用，无需手工操作。
> 唯一需要一次性手动启用的：若账号从未用过 R2，请先在面板 **R2 Object Storage** 处点一下启用。

> 随机串可用在线工具生成，或任意能跑 node 的地方执行：
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 一键部署做了什么

```
npm run deploy
  ├─ 1. 创建/复用 5 个 KV 命名空间（Cloudreve-v3-cache/session/upload/task/lock）
  ├─ 2. 创建/复用 R2 存储桶（cloudreve-v3-storage，「本地存储」策略用）
  ├─ 3. 创建/复用 5 个 Neon 数据库（1 主库 + 3 缓存库 + 1 备份库）
  ├─ 4. 全库建表
  ├─ 5. 种子数据（系统设置 / 用户组 / 存储策略 / 管理员账号）
  ├─ 6. 连接串回填 wrangler.toml
  ├─ 7. 构建前端
  ├─ 8. 写入 Worker secret
  └─ 9. wrangler deploy 部署
```

全部步骤**可断点续跑**：已创建的 KV、R2 桶与数据库都会自动复用，不会重复创建，失败后重跑无副作用。

> GitHub Actions 只做构建检查（类型检查 + 前端构建 + wrangler 配置校验），不部署、不建任何资源。

### 数量上限

KV 与 Neon 库都通过环境变量控制数量，**上限 5 个**，超过自动失败并提示「请减少一个」：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_KV_NAMESPACES` | `5` | KV 命名空间数量 |
| `MAX_NEON_DATABASES` | `5` | Neon 库数量（1 主库 + 缓存库 + 1 备份库） |

### 本地部署（可选）

```bash
npm install
cd frontend && npm install --legacy-peer-deps && cd ..
NEON_API_KEY=... NEON_PROJECT_ID=... npm run deploy
```

`npm run deploy` 一条命令完成上面全部 8 步；`npm run dev` 可本地调试。

📄 更多细节与常见问题见 [DEPLOY.md](./DEPLOY.md)

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
