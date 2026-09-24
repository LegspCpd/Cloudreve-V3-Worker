# Cloudreve-V3-Worker 部署教程

把 Cloudreve Plus（原版 Go/Gin 后端 + React 前端）完整重写为**单个 Cloudflare Worker**。
后端全部能力（用户/文件/目录/分享/标签/网盘增值服务/WebDAV/离线下载/后台管理）都跑在一个 Worker 里，前端使用原版构建产物由同一 Worker 托管。

**全部只需要两条命令：构建 + 部署，再填几个环境变量。**

---

## 0. 前置条件

| 需要什么 | 说明 |
|---|---|
| Node.js ≥ 20 | 本地构建用 |
| Cloudflare 账号 | 免费版即可（Workers 免费额度 10 万次/天） |
| 一个 Neon 账号 | 免费版即可，Postgres 数据库 |
| 一个 Resend 账号 | 免费版即可，邮件发送（每天 100 封） |

安装 Cloudflare CLI 并登录：

```bash
npm install -g wrangler
wrangler login
```

---

## 1. 一键初始化（自动创建 KV 与 Neon 数据库）

```bash
npm run setup
```

这条命令会自动完成：

1. **创建 Worker KV 命名空间**（上限 5 个）
   - `K1` 热数据全量缓存、`K2` 会话、`K3` 上传会话、`K4` 任务进度、`K5` 锁与限流
   - 数量由环境变量 `MAX_KV_NAMESPACES` 控制，**最高 5 个**
   - 超过 5 个会**自动失败**并提示：`请减少一个（Worker KV 最多 5 个）`
   - 创建结果自动写回 `wrangler.toml`

2. **创建 Neon 数据库**（上限 5 个，需要 `NEON_API_KEY` 与 `NEON_PROJECT_ID`）
   - 分配规则：**1 个主库 + 若干缓存库 + 1 个备份库**
   - 主库存放全部业务数据；备份库每次写入主库时自动同步（写穿透）；缓存库存放热数据
   - 数量由 `MAX_NEON_DATABASES` 控制，**最高 5 个**，超过自动失败并提示需要减少一个

3. **初始化全部数据库的表结构** + **写入种子数据**（系统设置、用户组、存储策略、主节点、管理员账号）

### 1.1 自动创建 Neon 数据库（推荐）

在 [Neon 控制台](https://console.neon.tech/app/settings/api-keys) 生成 API Key，并从项目页面拿到 Project ID，然后：

**Windows (PowerShell)：**
```powershell
$env:NEON_API_KEY="你的Neon API Key"
$env:NEON_PROJECT_ID="你的Neon Project ID"
npm run setup
```

**Linux / macOS：**
```bash
NEON_API_KEY="你的Neon API Key" NEON_PROJECT_ID="你的Neon Project ID" npm run setup
```

### 1.2 手动准备数据库（备选）

如果不想用 Neon API，可以在 Neon 控制台手动创建库，把连接串写入项目根目录的 `.env` 文件：

```env
DATABASE_URL=postgres://...            # 主库（存放数据）
DATABASE_URL_BACKUP=postgres://...     # 备份库（自动同步）
DATABASE_URL_CACHE_1=postgres://...    # 缓存库 1（可选）
DATABASE_URL_CACHE_2=postgres://...    # 缓存库 2（可选）
DATABASE_URL_CACHE_3=postgres://...    # 缓存库 3（可选）
```

然后再跑一次 `npm run setup`，脚本会跳过自动创建，直接完成表结构初始化与种子数据。

### 1.3 KV 数量控制示例

```bash
# 只要 3 个 KV（K1 缓存 / K2 会话 / K3 上传会话）
MAX_KV_NAMESPACES=3 npm run setup

# 只要 2 个 Neon 库（1 主库 + 1 备份库，无缓存库）
MAX_NEON_DATABASES=2 npm run setup

# 超过上限会自动失败：
# MAX_KV_NAMESPACES=6 npm run setup
# ✘ KV 命名空间数量为 6，超过上限 5 个，创建自动失败。请减少一个…
```

> **K1 缓存说明**：K1 命名空间会尽可能多地把热数据缓存进去——系统设置、用户信息、文件元数据、目录列表等，全部走「内存 → K1 → Neon 缓存库 → 主库」的多级缓存，命中时无需查库，显著加快访问速度。

---

## 2. 构建前端 + 后端

```bash
npm run build
```

等价于：

```bash
npm run frontend:install   # 首次需要安装前端依赖
npm run frontend:build     # 构建前端并把 dist/ 复制到 public/
```

构建产物输出到 `public/`，由 Worker 的 `[assets]` 配置托管，前端路由自动回退到 `index.html`。

---

## 3. 设置环境变量（Secret）

**这一步必做**，否则 Worker 启动会失败。逐条执行：

```bash
# ── 数据库（由 npm run setup 自动生成，从 .env 复制粘贴）──
echo "postgres://主库连接串"     | wrangler secret put DATABASE_URL
echo "postgres://备份库连接串"   | wrangler secret put DATABASE_URL_BACKUP
echo "postgres://缓存库1连接串"  | wrangler secret put DATABASE_URL_CACHE_1

# ── 邮件（Resend，https://resend.com/api-keys）──
echo "re_xxxxxxxxxxxx"           | wrangler secret put RESEND_API_KEY

# ── 签名密钥（自己生成 32 位以上随机串）──
echo "你的会话签名密钥"           | wrangler secret put SESSION_SECRET
echo "你的HashID盐值"             | wrangler secret put HASHID_SALT
```

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

非敏感配置（站点名、站点地址、发件人）写在 `wrangler.toml` 的 `[vars]` 里直接修改即可：

```toml
[vars]
SITE_URL = "https://你的域名.workers.dev"
MAIL_FROM_ADDRESS = "no-reply@你的域名.com"
MAIL_FROM_NAME = "CloudrevePlus"
```

### 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 主库连接串（**唯一存放数据的库**） |
| `DATABASE_URL_BACKUP` | ✅ | Neon 备份库连接串（写入主库时自动同步） |
| `DATABASE_URL_CACHE_1`…`3` | 可选 | Neon 缓存库（热数据加速） |
| `MAX_KV_NAMESPACES` | 可选 | 自动创建的 KV 数量，上限 **5**，默认 5 |
| `MAX_NEON_DATABASES` | 可选 | Neon 库数量，上限 **5**，默认 5 |
| `RESEND_API_KEY` | ✅ | Resend 邮件 API Key |
| `MAIL_FROM_ADDRESS` | ✅ | 发件地址 |
| `MAIL_FROM_NAME` | 可选 | 发件人名称 |
| `SESSION_SECRET` | ✅ | 会话 Cookie 签名密钥 |
| `HASHID_SALT` | ✅ | HashID 混淆盐值（**一旦设定不可更改**，否则所有历史链接失效） |
| `SITE_URL` | ✅ | 站点对外地址，末尾不带斜杠 |

---

## 4. 部署到 Cloudflare

```bash
npm run deploy
```

等价于 `wrangler deploy`。完成后会输出 Worker 地址：

```
Published cloudreve-v3-worker
  https://cloudreve-v3-worker.你的子域.workers.dev
```

首次部署前需要创建 R2 存储桶（用作「本地存储」策略的实际存储）：

```bash
wrangler r2 bucket create cloudreve-storage
```

> 「本地存储」策略 = 绑定的 R2 存储桶，无需任何额外配置；S3 兼容存储（AWS S3 / MinIO / 阿里云 OSS / 腾讯云 COS 等）在后台「存储策略」中添加即可。

---

## 5. 验证部署

```bash
# 健康检查
curl https://你的Worker地址/health
# {"status":"ok","ts":...}

# 站点配置接口（无需登录）
curl https://你的Worker地址/api/v3/site/config
# {"code":0,"data":{...},"msg":""}
```

浏览器打开 Worker 地址，用初始化时打印的管理员账号登录：

```
管理员邮箱：admin@cloudreve.org
管理员密码：<setup 时打印的随机密码>
```

也可以自定义管理员账号：

```bash
ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="你的密码" npm run db:seed
```

---

## 6. 常用命令速查

```bash
npm run setup          # 一键初始化（KV + Neon + 表结构 + 种子数据）
npm run dev            # 本地开发调试（http://localhost:8787）
npm run build          # 构建前端 + 后端
npm run deploy         # 部署到 Cloudflare
npm run typecheck      # TypeScript 类型检查
npm run db:push        # 表结构推送到所有库（增量更新）
npm run db:seed        # 重新写入种子数据（幂等）
npm run db:reset       # 清空并重建所有库表（危险，仅初始化时用）
npm run tail           # 实时查看 Worker 日志
```

---

## 7. 架构与数据流转

```
                    ┌─────────────────────────────────────────────┐
                    │              Cloudflare Worker              │
                    │                                             │
  请求 ────────────▶│  Hono 路由 (/api/v3/*, /dav/*, 前端 SPA)     │
                    │     │                                       │
                    │     ▼                                       │
                    │  ┌─────────────┐   命中即返回，不查库         │
                    │  │ L1 内存缓存 │◀──────┐                     │
                    │  └─────────────┘       │                     │
                    │         │ 未命中        │                     │
                    │         ▼              │                     │
                    │  ┌─────────────┐       │                     │
                    │  │ L2 K1 (KV) │───────┘                     │
                    │  └─────────────┘                             │
                    │         │ 未命中                              │
                    │         ▼                                    │
                    │  ┌──────────────────┐                        │
                    │  │ L3 Neon 缓存库    │                        │
                    │  └──────────────────┘                        │
                    │         │ 未命中                              │
                    └─────────┼────────────────────────────────────┘
                              ▼
                     ┌──────────────────┐    每次写入 ──▶ ┌──────────────┐
                     │  Neon 主库 (数据) │                  │ Neon 备份库   │
                     └──────────────────┘                  └──────┬───────┘
                                                                  │ 热数据提升
                                                                  ▼
                                                          ┌──────────────┐
                                                          │ KV + 缓存库   │
                                                          └──────────────┘

  存储：R2 存储桶（本地策略） / S3 兼容存储（外部策略）
  会话：K2 KV    上传会话：K3 KV    任务进度：K4 KV    锁与限流：K5 KV
```

**写入流程**：业务写入只落主库 → 同一语句自动在备份库执行一次（写穿透）→ 副库写入成功后把热数据提升到 K1 与缓存库，加速后续访问。

**读取流程**：内存 → K1 → 缓存库 → 主库，任一层命中都会回填上层。

---

## 8. 功能说明（与原版对照）

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
| 网盘增值服务（容量包/订单/兑换码） | ✅ 数据结构完整保留，支付回调收敛到 `/callback/*` |
| 离线下载（Aria2） | ✅ 使用**外部 Aria2 节点**：后台「节点管理」中配置启用了 aria2 的节点，节点上运行 Aria2 实例（或原版从机），本端通过 JSON-RPC 派发任务 |
| 后台管理 | ✅ 用户/用户组/存储策略/文件/分享/订单/任务/举报/节点/兑换码全量管理 |
| 缩略图 | 使用存储策略侧生成的缩略图（R2/S3 原生），图片类直接回源；Worker 内不做图像处理 |
| ffmpeg / 文档转换 | Worker 运行时不可用，需在存储策略侧或外部节点完成 |

---

## 9. 常见问题

**Q: 部署后访问 `/api/v3/site/config` 报 50005？**
A: 配置的 Neon 数据库数量超过上限。检查 `.env` 与已设置的 secret，减少到 5 个以内（1 主库 + 缓存库 + 1 备份库），再重新部署。

**Q: 上传大文件失败？**
A: Worker 单请求体上限 100MB，分片大小已自动适配（最大 96MB）。若使用外部 S3，请确保存储桶的 CORS 配置允许浏览器 PUT。

**Q: 邮件发不出去？**
A: 检查 `RESEND_API_KEY` 是否设置、`MAIL_FROM_ADDRESS` 是否在 Resend 中验证过域名。

**Q: 想重置管理员密码？**
A: `ADMIN_EMAIL="你的邮箱" ADMIN_PASSWORD="新密码" npm run db:seed`

**Q: HashID 盐值能改吗？**
A: 不能。`HASHID_SALT` 一旦设定就不可更改，否则所有历史分享链接、外链全部失效。首次部署时务必设置一个足够随机的值。

**Q: 免费额度够用吗？**
A: Workers 免费版 10 万次请求/天，KV 免费版 10 万次读 + 1000 次写/天，Neon 免费版 0.5 GB 存储。个人网盘完全够用；访问量大时建议升级 Workers 付费版（$5/月，1000 万次请求）。
