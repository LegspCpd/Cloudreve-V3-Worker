# Cloudreve-V3-Worker 部署教程

把 Cloudreve Plus（原版 Go/Gin 后端 + React 前端）完整重写为**单个 Cloudflare Worker**。

**部署方式：在 Cloudflare 面板的 Workers & Pages 里连接 GitHub 仓库，填构建命令、部署命令和环境变量，面板自动构建部署。GitHub Actions 只负责构建检查，不负责部署。**

---

## 方式一：Cloudflare 面板部署（推荐）

全程在浏览器里完成，不用本地环境。

### 第 1 步：初始化资源（只做一次）

有两种方式创建 KV 命名空间和 Neon 数据库，选一种：

**A. 用 GitHub Actions 自动创建（推荐）**

1. Fork [Cloudreve-V3-Worker](https://github.com/LegspCpd/Cloudreve-V3-Worker) 到你的账号
2. 在 fork 的仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

   | Secret | 说明 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | [创建 Token](https://dash.cloudflare.com/profile/api-tokens)，选 **Edit Cloudflare Workers** 模板 |
   | `CLOUDFLARE_ACCOUNT_ID` | [面板首页](https://dash.cloudflare.com) 右侧 Account ID |
   | `NEON_API_KEY` | [Neon 控制台](https://console.neon.tech/app/settings/api-keys) 生成 |
   | `NEON_PROJECT_ID` | Neon 项目页面 Settings 中查看 |

3. 进 **Actions** 标签页 → 若提示禁用就点 *I understand my workflows, go ahead and enable* → 选 **Build Check** → **Run workflow**，勾选 `setup`
4. 等运行完成，KV 与 Neon 数据库配置会自动写回仓库的 `wrangler.toml` 并提交

> 自动创建的 KV 命名空间标题统一为 `Cloudreve-v3-cache` / `Cloudreve-v3-session` / `Cloudreve-v3-upload` / `Cloudreve-v3-task` / `Cloudreve-v3-lock`。
> 数量受 `MAX_KV_NAMESPACES` 与 `MAX_NEON_DATABASES` 控制，**上限 5 个**，超过会自动失败并提示减少一个。
> 已创建的资源重跑会自动复用，不会重复创建。

**B. 手动创建**

- KV：[Cloudflare 面板](https://dash.cloudflare.com) → Workers & Pages → KV，创建上述 5 个标题的命名空间，把 ID 填进 `wrangler.toml`
- Neon：在 [Neon 控制台](https://console.neon.tech) 创建库，连接串填进 `wrangler.toml` 的 `[vars]` 或 Worker 环境变量

### 第 2 步：在 Cloudflare 面板连接仓库

1. 打开 [Cloudflare 面板](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. 选 **Connect repository**（连接 GitHub 仓库）
3. 授权并选择你 fork 的 `Cloudreve-V3-Worker` 仓库
4. 填写配置：

   | 配置项 | 填写内容 |
   |---|---|
   | **Project name** | `cloudreve-v3`（或任意名） |
   | **Production branch** | `main` |
   | **Framework preset** | `None`（或 Other） |
   | **Build command** | `npm install --legacy-peer-deps && npm run build` |
   | **Deploy command** | `npx wrangler deploy` |
   | **Root directory** | 留空（默认仓库根） |

5. 展开底部的 **Environment variables**，逐个添加：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `DATABASE_URL` | ✅ | Neon 主库连接串（初始化时自动生成，从 `wrangler.toml` 或日志复制） |
   | `DATABASE_URL_BACKUP` | ✅ | Neon 备份库连接串 |
   | `DATABASE_URL_CACHE_1` | 可选 | Neon 缓存库 |
   | `RESEND_API_KEY` | ✅ | [Resend](https://resend.com/api-keys) |
   | `SESSION_SECRET` | ✅ | 会话签名，32 位以上随机串 |
   | `HASHID_SALT` | ✅ | ID 混淆盐值，**设定后不可改** |
   | `SITE_URL` | ✅ | 部署后填实际地址 |
   | `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |
   | `MAIL_FROM_NAME` | 可选 | 发件人名称 |

   > 敏感变量（数据库连接串、API Key、密钥）添加时选 **Encrypt**（加密）类型。

6. 点 **Save and Deploy**，面板会自动构建并部署

### 第 3 步：获取数据库连接串

如果第 1 步用的是 Actions 自动创建，连接串在 Actions 运行日志里（`Setup resources` 步骤），格式如下：

```
DATABASE_URL=postgres://...
DATABASE_URL_BACKUP=postgres://...
```

也可以在 [Neon 控制台](https://console.neon.tech) 的对应分支页面直接复制（分支名：`cloudreve-main` / `cloudreve-backup` / `cloudreve-cache-*`）。

### 第 4 步：创建 R2 存储桶

「本地存储」策略需要一个 R2 存储桶：

[Cloudflare 面板](https://dash.cloudflare.com) → **R2 Object Storage** → **Create bucket** → 名称填 `cloudreve-storage`

> 名称必须与 `wrangler.toml` 中 `[[r2_buckets]]` 的 `bucket_name` 一致。

### 第 5 步：验证

部署成功后，面板会给出 Worker 地址（如 `https://cloudreve-v3.<你的子域>.workers.dev`）。

浏览器打开，用初始化时的管理员账号登录（默认 `admin@cloudreve.org`，密码在 Actions 日志或种子数据脚本输出中）。

之后**每次 push 到 main 分支，面板会自动重新构建部署**，不用再做任何操作。

---

## 方式二：本地命令行部署

适合本地调试。

```bash
# 安装依赖
npm install
cd frontend && npm install --legacy-peer-deps && cd ..

# 一键初始化（自动创建 KV + Neon 库 + 表结构 + 种子数据，可断点续跑）
npm run setup

# 构建前端
npm run build

# 本地调试
npm run dev

# 部署
npm run deploy
```

首次部署前创建 R2 存储桶：

```bash
npx wrangler r2 bucket create cloudreve-storage
```

写入 secret（读取 `.env` 与环境变量，自动批量写入）：

```bash
npm run secrets:apply
```

---

## 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Actions 初始化用 | Edit Cloudflare Workers 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | Actions 初始化用 | 面板首页右侧 |
| `NEON_API_KEY` | 自动建库用 | Neon 控制台生成 |
| `NEON_PROJECT_ID` | 自动建库用 | Neon 项目 Settings |
| `DATABASE_URL` | ✅ | Neon 主库（**唯一存数据的库**） |
| `DATABASE_URL_BACKUP` | ✅ | Neon 备份库（写入主库时自动同步） |
| `DATABASE_URL_CACHE_1`…`3` | 可选 | Neon 缓存库 |
| `MAX_KV_NAMESPACES` | 可选 | KV 数量上限 **5** |
| `MAX_NEON_DATABASES` | 可选 | Neon 库数量上限 **5** |
| `RESEND_API_KEY` | ✅ | 邮件 |
| `SESSION_SECRET` | ✅ | 会话签名 |
| `HASHID_SALT` | ✅ | ID 盐值，**不可改** |
| `SITE_URL` | ✅ | 站点地址 |
| `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |

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
npm run setup          # 一键初始化（KV + Neon + 表结构 + 种子数据，可断点续跑）
npm run dev            # 本地调试
npm run build          # 构建前端
npm run deploy         # 部署
npm run secrets:apply  # 批量写入 Worker secret
npm run typecheck      # 类型检查
npm run db:push        # 表结构增量更新
npm run db:seed        # 种子数据（幂等）
npm run tail           # 实时日志
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

**Q: Fork 后 Actions 里看不到工作流？**
A: Fork 的仓库默认禁用 Actions。进 **Actions** 标签页点提示栏里的 *I understand my workflows, go ahead and enable*。

**Q: Workers Builds 构建失败，提示找不到 wrangler？**
A: Deploy command 用 `npx wrangler deploy` 会自动安装。若网络慢，可改为先 `npm install` 再部署。

**Q: 前端构建报 OpenSSL 错误？**
A: 旧版 Create React App 在 Node 17+ 需要 `NODE_OPTIONS=--openssl-legacy-provider`。Workers Builds 的环境变量里加一个 `NODE_OPTIONS` = `--openssl-legacy-provider` 即可。

**Q: 访问站点报 50005？**
A: Neon 数据库数量超过上限。减少到 5 个以内（1 主库 + 缓存库 + 1 备份库）后重新部署。

**Q: `setup` 报「超过上限 5 个，请减少一个」？**
A: 预期行为。把 `MAX_KV_NAMESPACES` / `MAX_NEON_DATABASES` 改小（≤5）后重跑。

**Q: 重跑 setup 会重复创建资源吗？**
A: 不会。KV 与 Neon 分支都是「先查后建」，已存在的自动复用。

**Q: 上传大文件失败？**
A: Worker 单请求体上限 100MB，分片已自动适配（最大 96MB）。外部 S3 需确认存储桶 CORS 允许浏览器 PUT。

**Q: 邮件发不出去？**
A: 检查 `RESEND_API_KEY` 是否设置、`MAIL_FROM_ADDRESS` 的域名是否在 Resend 验证过。

**Q: 想重置管理员密码？**
A: 设置 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 两个 secret，重跑 Actions（勾选 `setup`），或本地 `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed`。

**Q: HashID 盐值能改吗？**
A: 不能。`HASHID_SALT` 一旦设定不可更改，否则历史分享链接、外链全部失效。

**Q: 免费额度够用吗？**
A: Workers 免费版 10 万请求/天、KV 10 万读 + 1000 写/天、Neon 0.5 GB 存储。个人网盘够用；流量大时建议 Workers 付费版（$5/月）。
