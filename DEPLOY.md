# Cloudreve-V3-Worker 部署教程

把 Cloudreve Plus（原版 Go/Gin 后端 + React 前端）完整重写为**单个 Cloudflare Worker**。

**部署方式：Cloudflare 面板连接 GitHub 仓库，填构建命令、部署命令、环境变量，面板自动完成建库、建表、种子数据、构建、部署。GitHub Actions 只做构建检查。**

---

## 一键部署（推荐）

全程在浏览器里完成，不用本地环境。

### 第 1 步：Fork 仓库

Fork [Cloudreve-V3-Worker](https://github.com/LegspCpd/Cloudreve-V3-Worker) 到你的账号。

### 第 2 步：准备外部服务的 Key

| 服务 | 需要什么 | 获取地址 |
|---|---|---|
| Neon | `NEON_API_KEY` + `NEON_PROJECT_ID` | [API Keys](https://console.neon.tech/app/settings/api-keys) / 项目 Settings |
| Resend | `RESEND_API_KEY` | [API Keys](https://resend.com/api-keys) |

随机生成两段 32 位密钥（会话签名 + ID 盐值）：

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 任意能跑 node 的环境都行，或者用在线随机串生成工具。

### 第 3 步：在 Cloudflare 面板连接仓库

1. 打开 [Cloudflare 面板](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. 选 **Connect repository**，授权并选你 fork 的 `Cloudreve-V3-Worker` 仓库
3. 填写：

   | 配置项 | 填写内容 |
   |---|---|
   | Project name | `cloudreve-v3`（任意） |
   | Production branch | `main` |
   | Framework preset | `None` |
   | **Build command** | `npm install --legacy-peer-deps` |
   | **Deploy command** | `npm run deploy` |
   | Root directory | 留空 |

4. 展开 **Environment variables**，逐个添加（敏感的选 **Encrypt**）：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `NEON_API_KEY` | ✅ | 自动创建 Neon 数据库用 |
   | `NEON_PROJECT_ID` | ✅ | 自动创建 Neon 数据库用 |
   | `RESEND_API_KEY` | ✅ | 邮件发送 |
   | `SESSION_SECRET` | ✅ | 会话签名，第 2 步生成的随机串 |
   | `HASHID_SALT` | ✅ | ID 混淆盐值，**设定后不可改** |
   | `MAIL_FROM_ADDRESS` | ✅ | 发件地址，如 `no-reply@你的域名.com` |
   | `SITE_URL` | ✅ | 站点地址，如 `https://cloudreve-v3.xxx.workers.dev` |
   | `ADMIN_EMAIL` | 可选 | 管理员邮箱，默认 `admin@cloudreve.org` |
   | `ADMIN_PASSWORD` | 可选 | 管理员密码，不填自动生成并打印在日志里 |
   | `NODE_VERSION` | 建议 | `22`（wrangler 4 要求 Node ≥ 22） |

   > 旧版 CRA 在 Node 17+ 构建所需的 `--openssl-legacy-provider` 已内置在构建脚本里，不需要你再添加 `NODE_OPTIONS`。

5. 点 **Save and Deploy**

### 第 4 步：验证

部署完成后，面板给出 Worker 地址。浏览器打开，用管理员账号登录。

管理员账号密码在部署日志里：**Workers & Pages → 你的项目 → Deployments → 最新一次的日志**，找到 `db:seed` 步骤的输出。

之后**每次 push 到 main 分支，面板自动重新构建部署**，无需任何操作。

> **R2 存储桶无需手动创建**：部署脚本会自动创建 `cloudreve-v3-storage` 并复用已存在的同名桶。
> 唯一的例外：若你的账号从未启用过 R2，请先在面板 **R2 Object Storage** 处点一下启用（一次性操作），再重新部署。

---

## 一键部署做了什么

`npm run deploy`（即 Deploy command）依次执行：

```
1. 创建/复用 KV 命名空间（上限 5）
   Cloudreve-v3-cache / -session / -upload / -task / -lock
2. 创建/复用 Neon 数据库（上限 5：1 主库 + 缓存库 + 1 备份库）
3. 全部数据库建表
4. 种子数据（系统设置 / 用户组 / 存储策略 / 管理员账号）
5. 数据库连接串回填 wrangler.toml
6. 构建前端
7. 写入 Worker secret
8. wrangler deploy 部署
```

**可断点续跑**：每一步都是「先查后建」，已创建的 KV 与数据库自动复用，失败后重跑不会重复创建、无副作用。

**数量上限**：`MAX_KV_NAMESPACES` 与 `MAX_NEON_DATABASES` 默认都为 5，**最高 5 个**。超过会自动失败并提示「请减少一个」。

---

## 本地部署（可选）

```bash
npm install
cd frontend && npm install --legacy-peer-deps && cd ..

# 一键部署（同面板的 Deploy command）
NEON_API_KEY=... NEON_PROJECT_ID=... \
RESEND_API_KEY=... SESSION_SECRET=... HASHID_SALT=... \
SITE_URL=https://xxx.workers.dev MAIL_FROM_ADDRESS=no-reply@xxx.com \
npm run deploy

# 或分开执行
npm run setup        # 只做资源初始化（KV + Neon + 建表 + 种子数据）
npm run build        # 只构建前端
npm run secrets:apply # 只写入 Worker secret
npx wrangler deploy  # 只部署

npm run dev          # 本地调试（http://localhost:8787）
```

R2 存储桶同样由脚本自动创建/复用，无需手动执行。若想单独建，可用
`npx wrangler r2 bucket create cloudreve-v3-storage`，或设置环境变量 `R2_BUCKET_NAME` 自定义桶名（建议保留 `cloudreve-v3` 前缀）。

---

## 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `NEON_API_KEY` | ✅ | Neon API Key，自动建库 |
| `NEON_PROJECT_ID` | ✅ | Neon 项目 ID |
| `RESEND_API_KEY` | ✅ | Resend 邮件 |
| `SESSION_SECRET` | ✅ | 会话签名 |
| `HASHID_SALT` | ✅ | ID 盐值，**不可改** |
| `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |
| `MAIL_FROM_NAME` | 可选 | 发件人名称 |
| `SITE_URL` | ✅ | 站点地址 |
| `ADMIN_EMAIL` | 可选 | 管理员邮箱 |
| `ADMIN_PASSWORD` | 可选 | 管理员密码 |
| `MAX_KV_NAMESPACES` | 可选 | KV 数量上限 **5** |
| `MAX_NEON_DATABASES` | 可选 | Neon 库数量上限 **5** |
| `R2_BUCKET_NAME` | 可选 | R2 桶名，默认 `cloudreve-v3-storage` |
| `SKIP_R2_CREATE` | 可选 | 设为 `1` 跳过 R2 创建（桶已存在时可用） |
| `NODE_VERSION` | 建议 | `22`（wrangler 4 要求 Node ≥ 22） |

数据库连接串由部署脚本自动生成并写入，**不需要手动填**：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Neon 主库（**唯一存数据的库**） |
| `DATABASE_URL_BACKUP` | Neon 备份库（写入主库时自动同步） |
| `DATABASE_URL_CACHE_1`…`3` | Neon 缓存库（热数据加速） |

---

## 架构与数据流转

```
                    ┌─────────────────────────────────────────────┐
                    │              Cloudflare Worker              │
  请求 ────────────▶│  Hono 路由 (/api/v3/*, /dav/*, 前端 SPA)     │
                    │     │                                       │
                    │     ▼  命中即返回，不查库                    │
                    │  ┌─────────────┐   ┌─────────────┐          │
                    │  │ L1 内存缓存 │──▶│ L2 K1 (KV)  │          │
                    │  └─────────────┘   └─────────────┘          │
                    │         │ 未命中        │ 未命中             │
                    │         ▼              ▼                    │
                    │  ┌──────────────────────────────────────┐   │
                    │  │ L3 Neon 缓存库 ──▶ Neon 主库 (数据)   │   │
                    │  └──────────────────────────────────────┘   │
                    └─────────────────────────────────────────────┘

  写入流程：只写主库 → 同一语句自动在备份库执行（写穿透）
           → 副库写入成功后把热数据提升到 K1 与缓存库
  读取流程：内存 → K1 → 缓存库 → 主库，任一层命中都回填上层

  存储：R2 存储桶（本地策略） / S3 兼容存储（外部策略）
  会话：K2    上传会话：K3    任务进度：K4    锁与限流：K5
```

---

## 常用命令速查（本地）

```bash
npm run deploy        # 一键部署（建库+建表+种子+构建+部署）
npm run setup         # 只做资源初始化（可断点续跑）
npm run build         # 只构建前端
npm run dev           # 本地调试
npm run secrets:apply # 批量写入 Worker secret
npm run typecheck     # 类型检查
npm run db:push       # 表结构增量更新
npm run db:seed       # 种子数据（幂等）
npm run tail          # 实时日志
```

---

## 功能说明（与原版对照）

| 功能 | 实现方式 |
|---|---|
| 用户/注册/登录/2FA/找回密码 | ✅ 完整实现，邮件走 Resend |
| 目录/文件管理 | ✅ 完整实现 |
| 直传上传（S3 家族） | ✅ 浏览器预签名直传，Worker 只做凭证签发与回调 |
| 本地存储策略 | ✅ 映射到绑定的 R2 存储桶 |
| S3 兼容存储 | ✅ AWS SigV4 签名，支持 path-style 与虚拟主机 |
| 分片上传 | ✅ 本地策略走 R2 中转分片；S3 家族走原生 multipart |
| 打包下载 | ✅ Worker 内 STORE 模式 zip 构建 |
| 在线预览/文本编辑/Office 预览 | ✅ |
| 分享系统 | ✅ 含密码保护、预览开关、积分下载、转存 |
| 用户标签 / 快捷方式 | ✅ |
| WebDAV | ✅ PROPFIND/GET/PUT/MKCOL/DELETE/MOVE/COPY |
| 增值服务（容量包/订单/兑换码） | ✅ 数据结构完整保留 |
| 离线下载（Aria2） | ✅ 使用**外部 Aria2 节点**：后台「节点管理」配置，本端通过 JSON-RPC 派发任务 |
| 后台管理 | ✅ 全量管理 |
| 缩略图 | 使用存储策略侧生成的缩略图，图片类直接回源 |
| ffmpeg / 文档转换 | Worker 运行时不可用，需在存储策略侧或外部节点完成 |

---

## 常见问题

**Q: 部署日志报 Neon 认证失败？**
A: 检查 `NEON_API_KEY` 是否有效、`NEON_PROJECT_ID` 是否属于同一账号。重新生成 Key 后在 Workers Builds 的环境变量里更新，然后重新部署。

**Q: 前端构建报 OpenSSL 错误？**
A: 构建脚本已内置 `--openssl-legacy-provider`，正常无需处理。若仍报错，说明构建镜像的 Node 版本过旧或过新，把 `NODE_VERSION` 设为 `22` 后重新部署。

**Q: 部署报 wrangler 要求 Node ≥ 22？**
A: 在 Workers Builds 的环境变量里加 `NODE_VERSION` = `22`，重新部署。

**Q: 部署报「超过上限 5 个，请减少一个」？**
A: 预期行为。把 `MAX_KV_NAMESPACES` / `MAX_NEON_DATABASES` 改小（≤5）后重新部署。

**Q: 重新部署会重复创建资源吗？**
A: 不会。KV 与 Neon 分支都是「先查后建」，已存在的自动复用。

**Q: 访问站点报 50005？**
A: Neon 数据库数量超过上限。减少到 5 个以内（1 主库 + 缓存库 + 1 备份库）后重新部署。

**Q: 上传大文件失败？**
A: Worker 单请求体上限 100MB，分片已自动适配（最大 96MB）。外部 S3 需确认存储桶 CORS 允许浏览器 PUT。

**Q: 邮件发不出去？**
A: 检查 `RESEND_API_KEY` 是否设置、`MAIL_FROM_ADDRESS` 的域名是否在 Resend 验证过。

**Q: 想重置管理员密码？**
A: 环境变量里改 `ADMIN_EMAIL` / `ADMIN_PASSWORD`，重新部署；或本地 `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed`。

**Q: HashID 盐值能改吗？**
A: 不能。`HASHID_SALT` 一旦设定不可更改，否则历史分享链接、外链全部失效。

**Q: 免费额度够用吗？**
A: Workers 免费版 10 万请求/天、KV 10 万读 + 1000 写/天、Neon 0.5 GB 存储。个人网盘够用；流量大时建议 Workers 付费版（$5/月）。
