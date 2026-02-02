# Booth Hunter

AI-powered VRChat 资产搜索助手（Booth.pm）。

本仓库包含：

- 前端：Vite + React
- 后端：Vercel Serverless Functions（`/api`）
- 数据：Supabase（Auth + Postgres）

---

## 功能概览

- 多轮对话搜索：模型会根据结果自动调整关键词
- Booth.pm 抓取：实时抓取商品信息（标题/价格/标签/链接/图片）
- Supabase 登录与云端会话：保存/读取历史对话（chats）

---

## 环境变量

本地请放在 `.env.local`；部署到 Vercel 时配置到 Project Settings → Environment Variables。

### 必需

- `GEMINI_API_KEY`
- `GEMINI_API_BASE_URL`（OpenAI-compatible，通常以 `/v1` 结尾）
- `GEMINI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### 仅管理员功能需要（强烈建议配置）

- `SUPABASE_SERVICE_ROLE_KEY`

> 注意：`SUPABASE_SERVICE_ROLE_KEY` 只能放在服务端（Vercel/本地 vercel dev 环境变量），不要暴露到前端。

---

## 本地开发

安装依赖：

```bash
npm install
```

启动（必须用 Vercel CLI 才能跑 `api/` 目录下的 functions）：

```bash
vercel dev
```

---

## Supabase 初始化（SQL）

仓库提供 1 份 SQL：

### 初始化（必执行）

在 Supabase Dashboard → SQL Editor 执行：

```
supabase/init.sql
```

它会做：

- 创建 `public.profiles`（包含 `is_admin`）
- 新用户自动创建 profile 的 trigger（`auth.users` → `profiles`）
- `public.chats` 的 `updated_at` trigger（要求你的 chats 表已存在）
- 开启 RLS：
  - `profiles`：用户只能读自己的 profile（用于前端判断是否管理员）
  - `chats`：用户只能读写自己的对话

> 设计原则：管理员查看全站数据不通过 RLS 放开，而是只允许走 `/api/admin/*`（service_role）。

### 运维/迁移（按需执行）

`supabase/init.sql` 文件底部包含若干【可选段落】（默认注释掉），你可以按需取消注释并执行：

- 回填历史 `auth.users` → `profiles`（幂等）
- 检查/清理 `chats` 孤儿数据
- 收口旧版的 `admin read all` policies（如果你历史上创建过）

---

## 管理员（Admin）

### 设置管理员

确保目标账号注册/登录过一次（触发 `profiles` 创建），然后在 SQL Editor：

```sql
update public.profiles
set is_admin = true
where email = 'your_admin@email.com';
```

### 管理员面板入口

管理员登录后，顶栏右侧会出现盾牌图标，点击打开管理员面板。

### Admin API

这些接口都要求：

- 你已配置 `SUPABASE_SERVICE_ROLE_KEY`
- 请求头 `Authorization: Bearer <Supabase access_token>`（前端会自动带）

接口：

- `GET /api/admin/users`
- `DELETE /api/admin/users?id=<uuid>`（删除用户：auth.users + profiles + 该用户 chats）
- `GET /api/admin/chats`
- `DELETE /api/admin/chats?id=<uuid>`（删除对话）
- `GET /api/admin/chats?user_id=...`
- `GET /api/admin/chats?id=...`
