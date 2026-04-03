# Booth Hunter

Booth Hunter 是一个面向 VRChat 资产检索场景的聊天式搜索应用。用户可以通过文字描述，或上传参考图片，结合 Booth 检索结果输出更贴近需求的商品推荐。

当前项目由三部分组成：

- 前端：Vite + React + TypeScript
- 服务端：Vercel Serverless Functions
- 数据与鉴权：Supabase Auth + Postgres + Storage

## 当前功能

- 聊天式检索 Booth 商品
- 支持上传参考图进行辅助检索
- 上传图片后先写入 Supabase Storage，再保存公开 URL 到聊天记录
- 服务端在图片场景下优先调用 SerpApi 的 Google Reverse Image Search
- 综合反向搜图线索与用户文本需求，生成更适合 Booth 的搜索关键词
- 支持聊天历史保存与读取
- 支持邮箱注册、登录、邮箱验证
- 支持游客模式与游客使用次数限制
- 支持已登录用户的会话次数与每日次数限制
- 支持管理员查看用户、聊天记录和全局限制配置

## 项目结构

```text
.
├─ index.tsx                  前端主入口，包含主要 UI 和聊天流程
├─ index.css                  全局样式
├─ i18n.ts                    多语言配置
├─ supabaseClient.ts          前端 Supabase 客户端
├─ api/
│  ├─ chat.ts                 聊天主接口，负责限额校验、反向搜图、Booth 搜索、流式回复
│  ├─ upload-image.ts         图片上传接口，负责写入 Supabase Storage 并返回公开 URL
│  └─ admin/
│     ├─ users.ts             管理员用户接口
│     ├─ chats.ts             管理员聊天接口
│     └─ settings.ts          管理员全局设置接口
└─ supabase/
   └─ init.sql                数据库初始化脚本
```

## 工作流程

### 文字检索

1. 用户输入需求并发送消息
2. 前端请求 `/api/chat`
3. 服务端先校验当前用户或游客的可用次数
4. 模型根据上下文决定是否直接回复，或生成 Booth 搜索关键词
5. 服务端抓取 Booth 搜索结果并筛选
6. 以流式方式返回推荐结果和说明

### 图片检索

1. 用户上传图片
2. 前端压缩图片并调用 `/api/upload-image`
3. 服务端将图片写入 Supabase Storage 的公开 bucket
4. 前端把返回的公开 URL 写入聊天消息，而不是保存 base64
5. `/api/chat` 收到图片 URL 后，优先调用 SerpApi 的 Google Reverse Image Search
6. 服务端从反向搜图结果中提炼关键词、标题和来源线索
7. 将这些线索与用户文本需求合并，再进入 Booth 检索流程

## 环境变量

本地开发建议使用 `.env.local`，部署到 Vercel 时配置到项目环境变量。

### 必需

- `GEMINI_API_KEY`
- `GEMINI_API_BASE_URL`
- `GEMINI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### 服务端必需

- `SUPABASE_SERVICE_ROLE_KEY`
- `SERPAPI_API_KEY`

### 可选

- `SUPABASE_IMAGE_BUCKET`

说明：

- `SUPABASE_IMAGE_BUCKET` 默认值为 `chat-images`
- `SUPABASE_SERVICE_ROLE_KEY` 只能放在服务端环境中，不能暴露到前端
- `GEMINI_API_BASE_URL` 使用 OpenAI 兼容接口地址，通常以 `/v1` 结尾

## 本地开发

安装依赖：

```bash
npm install
```

启动本地开发环境：

```bash
vercel dev
```

说明：

- 本项目依赖 `api/` 目录下的 Serverless Functions
- 仅运行 `vite` 无法完整模拟服务端接口

## Supabase 初始化

在 Supabase Dashboard 的 SQL Editor 中执行：

```sql
supabase/init.sql
```

该脚本会完成以下初始化：

- 创建 `public.profiles`
- 创建 `public.app_settings`
- 创建 `public.guest_usage`
- 为 `profiles`、`chats` 等表补齐所需字段
- 创建 `set_updated_at` 触发器函数
- 创建新用户注册后自动同步 `profiles` 的触发器
- 创建以下 RPC：
  - `consume_turn(p_chat_id uuid)`
  - `get_turn_meta()`
  - `consume_guest_turn(p_visitor_id text)`
- 启用并配置 RLS
- 创建公开 Storage bucket：`chat-images`

## Storage Bucket

项目默认使用公开 bucket `chat-images` 保存用户上传的参考图。

当前约定如下：

- bucket 为 public
- 默认允许的图片类型：
  - `image/jpeg`
  - `image/png`
  - `image/webp`
  - `image/gif`
- 默认文件大小限制：8 MB

图片上传由服务端接口 `/api/upload-image` 使用 `service_role` 执行，因此当前不需要额外开放 `storage.objects` 给前端匿名或登录用户直接写入。

## 次数限制规则

### 登录用户

服务端在真正调用模型前，会先执行：

- `consume_turn(chat_id)`

该函数会同时检查：

- 当前会话次数限制
- 当前自然日次数限制

如果超限，`/api/chat` 会返回 `429`。

### 游客

游客模式使用：

- `consume_guest_turn(visitor_id)`

当前默认限制为 3 次，仅用于体验模式。

## 管理员功能

管理员能力通过 `/api/admin/*` 提供，不通过放宽普通 RLS 来实现。

当前提供：

- `GET /api/admin/users`
- `PATCH /api/admin/users?id=<uuid>`
- `DELETE /api/admin/users?id=<uuid>`
- `GET /api/admin/chats`
- `GET /api/admin/chats?user_id=<uuid>`
- `GET /api/admin/chats?id=<uuid>`
- `DELETE /api/admin/chats?id=<uuid>`
- `GET /api/admin/settings`
- `PATCH /api/admin/settings`

这些接口要求：

- 请求头包含 `Authorization: Bearer <Supabase access token>`
- 服务端已配置 `SUPABASE_SERVICE_ROLE_KEY`
- 当前用户在 `profiles.is_admin = true`

## 设置管理员

先让目标账号完成一次注册或登录，使其在 `profiles` 中生成记录，然后执行：

```sql
update public.profiles
set is_admin = true
where email = 'your_admin@email.com';
```
