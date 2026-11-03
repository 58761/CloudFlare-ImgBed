# 批量图片文件夹 / Batch image folders

## 使用方式

- 在首页一次选择、拖入或粘贴两张及以上本地图片，自动创建一个文件夹，图片使用 R2 上传。同一批次压缩、分块上传和失败重试均保留该文件夹。
- 混合选择时，仅图片归入批次；单张图片、非图片文件、粘贴外链仍使用原来的上传流程。目录选择中不同子目录的图片会归入同一个批次目录，原始文件名保留在元数据中。
- 分享链接中的 `xn--` 域名标签会自动解码为 Unicode，例如 `https://xn--fsqu00a.xn--0zwm56d/album/…` 输出为 `https://例子.测试/album/…`。复制链接与 API 返回值均使用中文域名，端口和文件夹路径不变。
- 上传页的「最近的图片文件夹」可复制链接、打开、重命名、关闭/开启分享及更换链接。重命名只修改显示名称，不移动 R2 对象。
- `/album/<文件夹ID>.<随机分享密钥>` 无需登录即可浏览该文件夹的可访问图片。支持放大、原图和「加载更多」。计数为已加载图片数；每次最多读取 60 条文件记录，屏蔽、过期和非图片记录不会展示。
- 分享无需开启站点全局「公开浏览」。原有图片屏蔽、白名单、有效期及防盗链规则继续生效；如开启防盗链，请允许本网站域名。
- 关闭或更换分享链接不撤销已经获得的图片直链。最近 100 个文件夹及管理凭据保存在当前浏览器；清除浏览器数据会失去该浏览器的快捷管理入口。不要将管理凭据当作分享链接发送。
- 文件夹内容按固定路径查询，上传、删除图片后刷新可见；通过原有文件管理页移动整个目录不会自动更新分享记录。优先使用文件夹面板修改显示名称。

## Worker + R2 + D1 部署（推荐）

本改动保留项目现有运行方式。前端与公共后端依赖 `punycode@2.3.1`，用于将分享链接中的 `xn--` 域名标签解码成中文等 Unicode 域名；不依赖 Node.js 专用 API，支持 Worker。前端源码位于本地 `frontend-src/`（独立的 Sanyue-ImgHub Git 仓库），`frontend-dist/` 已由该源码构建。Worker、Pages 使用同一份 Functions 业务代码。

1. 在 Cloudflare 创建一个 R2 Bucket 和一个 D1 数据库。
2. 在 `deploy/worker/wrangler.toml` 中启用并填写绑定：

```toml
[[r2_buckets]]
binding = "img_r2"
bucket_name = "你的存储桶名称"

[[d1_databases]]
binding = "img_d1"
database_name = "你的数据库名称"
database_id = "你的数据库ID"
```

3. 新建实例首次初始化数据库，已有实例使用已有数据库，不要重建：

```sh
npm ci
npx wrangler d1 execute img_d1 --remote --config deploy/worker/wrangler.toml --file database/init.sql
```

4. 如修改了前端源码，重新构建（该命令会替换生成目录 `frontend-dist/`）：

```sh
cd frontend-src
npm ci
npm run build -- --dest ../frontend-dist
cd ..
```

5. 检查构建并部署：

```sh
node deploy/worker/generate-routes.js
npx wrangler deploy --dry-run --config deploy/worker/wrangler.toml
npm run deploy:worker
```

6. 在站点管理界面配置管理员与上传认证，并确认 R2 渠道启用且未超过设置的容量限制。图片通过 Worker 的 `/file/…` 接口读取，R2 Bucket 可以保持私有；本功能本身不要求 R2 公共域名。

文件夹记录使用现有数据库适配器的 `manage@album@<id>` 键；D1 对应现有 `settings` 表，**本功能不需要额外建表或迁移历史图片**。文件仍使用项目现有 `files` 元数据与 R2 对象。

使用 GitHub Actions 时，沿用 `.github/workflows/deploy-worker.yml`，配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`R2_BUCKET_NAME`，并确保提交本次构建的 `frontend-dist/`。本地 `frontend-src/` 是独立仓库；提交前端源代码时应在该仓库中单独提交，不要误将其作为未配置的 Git 子模块提交。

## KV 替代方案

将 D1 绑定替换为：

```toml
[[kv_namespaces]]
binding = "img_url"
id = "你的KV命名空间ID"
```

KV 无需 SQL 初始化。不要同时配置 `img_url` 与 `img_d1`；现有适配器优先使用 KV。KV 为最终一致性，跨地区读取新文件夹、图片列表及关闭/更换分享状态可能有延迟，严格要求及时撤销分享时优先使用 D1。本功能不在应用层缓存分享响应。

## API 约定

| 请求 | 用途 |
| --- | --- |
| `POST /api/albums`，JSON `{ "name": "可选名称" }` | 创建文件夹；返回 `id`、`directory`、`shareUrl`、`manageKey` |
| `GET /api/albums` | 读取该文件夹管理信息 |
| `PATCH /api/albums`，JSON `{ "name": "新名称", "enabled": false, "rotate": true }` | 按需更新名称、分享开关或随机分享密钥，各字段可独立使用 |
| `POST /upload`，multipart `file` | 向批次上传图片；沿用既有普通/分块协议 |
| `GET /api/album-share?share=<id>.<key>&cursor=<cursor>` | 匿名分页读取分享图片，返回 `name`、`createdAt`、`files`、`cursor`；`cursor=null` 表示完成 |

创建、管理和上传均需要原有上传认证（站点会话或具有 `upload` 权限的 API Token）。GET/PATCH 管理接口和批次上传额外携带 `X-Album-Id` 与 `X-Album-Key` 请求头；`manageKey` 仅创建时返回，数据库只存 SHA-256 摘要。API 使用同源前端；服务端脚本可直接调用。

批次上传由服务器固定目录并指定 `cfr2`，关闭跨渠道自动回退。重试仍上传 R2。普通单图上传及原有多渠道 API 行为不变。分享密钥与管理密钥相互独立，公开接口不会返回上传 IP、渠道凭据或管理密钥。文件夹日期路径使用 UTC；显示名称可随时修改。

## 验证

```sh
npm test
npm run test:server
npx wrangler pages functions build functions --outdir data/ci-pages-build
node deploy/worker/generate-routes.js
node --import ./deploy/server/register.mjs test/smoke/workerEntry.mjs
npx wrangler deploy --dry-run --config deploy/worker/wrangler.toml
cd frontend-src
npm test
npm run build -- --dest ../frontend-dist
```

`test/smoke/albumsLocal.mjs` 针对**隔离的本地 Wrangler 实例**验证真实 Worker 路由与本地 D1/R2：并发同名上传、分块上传合并后的字节、分享列表、错误管理凭据、重命名、关闭与更换链接。先使用绑定了测试 D1/R2 的 Wrangler 配置启动 `wrangler dev --local` 并初始化本地 D1，再运行：

```sh
node test/smoke/albumsLocal.mjs http://127.0.0.1:8787
```

该脚本会留下测试文件夹和图片，只允许 localhost 目标。单元测试中的 D1 使用 SQLite 适配器；本地 Wrangler smoke 覆盖 D1 的实际 SQL 限制。线上 Cloudflare 账户、真实额度、跨地区 KV 一致性及自定义域名需部署后验收。

本次验证（2026-11-03）：后端 270 项、前端 251 项回归通过（含中文域名输出增补）；前端生产构建、Pages Functions 编译、Worker dry-run、20 个服务端路由导入、Worker 入口测试和本地 D1/R2 文件夹 smoke 均通过。浏览器曾实测两张图片自动分组上传及分享页读取；中断恢复后浏览器连接不可用，最后的布局调整已编译但未再次截图检查。验证日志保存在本地 `data/`，未部署到真实 Cloudflare 账户。

## English summary

Selecting, dropping or pasting two or more local images creates a unique R2 folder. Single images, non-images and URL imports retain their previous behavior. The upload screen provides folder links, rename, sharing controls and link rotation. Public galleries support previews, original files and cursor pagination; existing file access policies still apply.

Deploy with a Worker, private R2 binding `img_r2`, and either D1 `img_d1` (recommended) or KV `img_url`. Existing database tables are reused, with no album migration required. Rebuild `frontend-src/` into `frontend-dist/` before deploying changes. KV share revocation is eventually consistent. Disabling a gallery does not revoke original file links. Management credentials and up to 100 recent folders are retained in the current browser only.
