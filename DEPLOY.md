# Cloudreve-V3-Worker 部署教程

把 Cloudreve Plus（原版 Go/Gin 后端 + React 前端）完整重写为**单个 Cloudflare Worker**。

**Fork 之后不需要装任何本地环境**：在 GitHub 面板填好变量，点一下 Run workflow 就完成构建 + 部署。

---

## 方式一：Fork + 一键部署（推荐，全程不用本地环境）

### 第 1 步：Fork 仓库

在 [Cloudreve-V3-Worker](https://github.com/LegspCpd/Cloudreve-V3-Worker) 页面点右上角 **Fork**，fork 到你自己的账号下。

### 第 2 步：获取 Cloudflare API Token 与账号 ID

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点 **Create Token** → 选择模板 **Edit Cloudflare Workers**
3. 复制生成的 Token（只显示一次）
4. 账号 ID：打开 https://dash.cloudflare.com → 右侧栏 **Account ID**，复制

### 第 3 步：在 GitHub 面板填写变量

进入你 fork 的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，逐个添加：

**必填（部署与邮件）：**

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步生成的 Token | 部署与建库用 |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID | 部署用 |
| `RESEND_API_KEY` | `re_xxxxxxxx` | [Resend](https://resend.com/api-keys) 申请 |
| `SESSION_SECRET` | 32 位以上随机串 | 会话签名 |
| `HASHID_SALT` | 32 位以上随机串 | ID 混淆盐值，**设定后不可改** |

**二选一（数据库）：**

- **A. 自动创建（推荐）**：填下面两个，工作流会自动创建 Neon 库
  - `NEON_API_KEY` — [Neon 控制台](https://console.neon.tech/app/settings/api-keys) 生成
  - `NEON_PROJECT_ID` — Neon 项目页面获取
- **B. 手动指定**：在 [Neon](https://console.neon.tech) 自建库后填连接串
  - `DATABASE_URL` — 主库
  - `DATABASE_URL_BACKUP` — 备份库
  - `DATABASE_URL_CACHE_1` ~ `DATABASE_URL_CACHE_3` — 缓存库（可选）

**可选（管理员账号）：**

| Secret 名称 | 说明 |
|---|---|
| `ADMIN_EMAIL` | 管理员邮箱，默认 `admin@cloudreve.org` |
| `ADMIN_PASSWORD` | 管理员密码，不填则自动生成并打印在日志里 |

生成随机字符串（可在任意在线工具生成，或 Cloudflare 面板的 Workers 命令行里执行）：

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**可选的数量控制**（放在 **Variables** 而不是 Secrets，Settings → Secrets and variables → Actions → **Variables** 标签页）：

| Variable 名称 | 默认 | 说明 |
|---|---|---|
| `MAX_KV_NAMESPACES` | `5` | 自动创建的 KV 数量，**上限 5**，超过自动失败 |
| `MAX_NEON_DATABASES` | `5` | Neon 库数量，**上限 5**（1 主库 + 缓存库 + 1 备份库） |

### 第 4 步：运行工作流

1. 进入仓库 **Actions** 标签页
2. 如果提示 workflows 被禁用（fork 的仓库默认如此），点 **I understand my workflows, go ahead and enable**
3. 左侧选择 **Deploy to Cloudflare Workers**
4. 点 **Run workflow**，按下表勾选：

| 选项 | 何时勾选 |
|---|---|
| `setup` | **首次部署必选**：自动创建 KV 与 Neon 数据库（要求选了方式 A） |
| `build_frontend` | 首次部署、或前端代码有更新时勾选 |
| `apply_secrets` | 首次部署必选；变量已写入过可关掉 |
| `worker_name` | 自定义 Worker 名称，留空用 `cloudreve-v3-worker` |
| `site_url` | 部署后填实际地址，如 `https://xxx.workers.dev` |

5. 点绿色 **Run workflow**，等 3~5 分钟

### 第 5 步：查看结果

- 工作流日志里会打印**管理员账号与密码**（仅在 `setup` 步骤的输出中，注意保存）
- Worker 地址在 [Cloudflare 面板](https://dash.cloudflare.com) → Workers & Pages → 你的 Worker
- 浏览器打开该地址即可使用

> 之后每次想更新部署，重复第 4 步即可（`setup` 关掉、`apply_secrets` 关掉、`build_frontend` 按需）。

---

## 方式二：本地命令行部署

适合想本地调试或自定义流程的用户。

### 0. 前置条件

- Node.js ≥ 20
- 已登录 Cloudflare：`npx wrangler login`

### 1. 一键初始化

```bash
npm install
npm run setup
```

自动完成：创建 KV（上限 5）→ 创建 Neon 库（上限 5，1 主 + 缓存 + 1 备份）→ 建表 → 种子数据。

自动创建 Neon 需要提供 API Key：

**Windows (PowerShell)：**
```powershell
$env:NEON_API_KEY="你的Neon API Key"
$env:NEON_PROJECT_ID="你的Neon Project ID"
npm run setup
```

**Linux / macOS：**
```bash
NEON_API_KEY="..." NEON_PROJECT_ID="..." npm run setup
```

已有数据库则写入 `.env` 后再跑一次 `npm run setup`：

```env
DATABASE_URL=postgres://...
DATABASE_URL_BACKUP=postgres://...
DATABASE_URL_CACHE_1=postgres://...
```

数量控制示例（超过上限会自动失败并提示「请减少一个」）：

```bash
MAX_KV_NAMESPACES=3 npm run setup
MAX_NEON_DATABASES=2 npm run setup
```

### 2. 构建与部署

```bash
npm run build
npm run deploy
```

首次部署前创建 R2 存储桶（用作「本地存储」策略）：

```bash
npx wrangler r2 bucket create cloudreve-storage
```

写入 secret：

```bash
echo "postgres://..." | npx wrangler secret put DATABASE_URL
echo "postgres://..." | npx wrangler secret put DATABASE_URL_BACKUP
echo "re_xxxxxxxx"   | npx wrangler secret put RESEND_API_KEY
echo "随机32位字符串" | npx wrangler secret put SESSION_SECRET
echo "随机盐值"       | npx wrangler secret put HASHID_SALT
```

或一行搞定（读取 `.env` 与环境变量）：

```bash
npm run secrets:apply
```

---

## 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | GitHub Actions 部署用 |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | GitHub Actions 部署用 |
| `DATABASE_URL` | ✅ | Neon 主库连接串（**唯一存放数据的库**） |
| `DATABASE_URL_BACKUP` | ✅ | Neon 备份库（写入主库时自动同步） |
| `DATABASE_URL_CACHE_1`…`3` | 可选 | Neon 缓存库（热数据加速） |
| `MAX_KV_NAMESPACES` | 可选 | KV 数量上限 **5** |
| `MAX_NEON_DATABASES` | 可选 | Neon 库数量上限 **5** |
| `RESEND_API_KEY` | ✅ | Resend 邮件 |
| `SESSION_SECRET` | ✅ | 会话 Cookie 签名密钥 |
| `HASHID_SALT` | ✅ | HashID 盐值，**不可更改** |
| `SITE_URL` | ✅ | 站点对外地址 |
| `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |
| `MAIL_FROM_NAME` | 可选 | 发件人名称 |

---

## 常用命令速查（本地）

```bash
npm run setup          # 一键初始化（KV + Neon + 表结构 + 种子数据）
npm run dev            # 本地开发调试
npm run build          # 构建前端 + 后端
npm run deploy         # 部署到 Cloudflare
npm run secrets:apply  # 把 .env / 环境变量写入 Worker secret
npm run typecheck      # 类型检查
npm run db:push        # 表结构增量更新
npm run db:seed        # 种子数据（幂等）
npm run db:reset       # 清空重建（危险）
npm run tail           # 实时日志
```

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

**K1 缓存说明**：K1 会尽可能多地把热数据缓存进去——系统设置、用户信息、文件元数据、目录列表等，命中时无需查库。

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
| 增值服务（容量包/订单/兑换码） | ✅ 数据结构完整保留，支付回调收敛到 `/callback/*` |
| 离线下载（Aria2） | ✅ 使用**外部 Aria2 节点**：后台「节点管理」配置，本端通过 JSON-RPC 派发任务 |
| 后台管理 | ✅ 用户/用户组/存储策略/文件/分享/订单/任务/举报/节点/兑换码全量管理 |
| 缩略图 | 使用存储策略侧生成的缩略图，图片类直接回源 |
| ffmpeg / 文档转换 | Worker 运行时不可用，需在存储策略侧或外部节点完成 |

---

## 常见问题

**Q: Fork 后 Actions 里看不到工作流 / 无法运行？**
A: Fork 的仓库默认禁用 Actions。进入 **Actions** 标签页，点提示栏里的 **I understand my workflows, go ahead and enable**。

**Q: 工作流跑完，但访问站点报 50005？**
A: 配置的 Neon 数据库数量超过上限。减少到 5 个以内（1 主库 + 缓存库 + 1 备份库）后重新运行。

**Q: `setup` 步骤报错「超过上限 5 个，请减少一个」？**
A: 这是预期行为。把 `MAX_KV_NAMESPACES` / `MAX_NEON_DATABASES` 改小（≤5）后重跑。

**Q: 上传大文件失败？**
A: Worker 单请求体上限 100MB，分片已自动适配（最大 96MB）。使用外部 S3 时请确认存储桶 CORS 允许浏览器 PUT。

**Q: 邮件发不出去？**
A: 检查 `RESEND_API_KEY` 是否设置、`MAIL_FROM_ADDRESS` 的域名是否在 Resend 验证过。

**Q: 想重置管理员密码？**
A: 设置 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 两个 secret，重新跑一次工作流（勾选 `setup`，或不勾 setup 也会自动执行 db:seed，幂等覆盖）。

**Q: HashID 盐值能改吗？**
A: 不能。`HASHID_SALT` 一旦设定就不可更改，否则所有历史分享链接、外链全部失效。

**Q: 免费额度够用吗？**
A: Workers 免费版 10 万请求/天、KV 免费版 10 万读 + 1000 写/天、Neon 免费版 0.5 GB 存储。个人网盘完全够用；流量大时建议 Workers 付费版（$5/月）。
