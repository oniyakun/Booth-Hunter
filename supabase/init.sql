-- Booth Hunter - Supabase Init (Single File)
--
-- 目的：
-- 1) profiles 表（is_admin） + 自动创建 trigger
-- 2) chats 的 updated_at trigger（依赖 chats 表已存在）
-- 3) RLS：
--    - profiles：用户仅可读自己（用于前端判断 is_admin）
--    - chats：用户仅可读写自己的对话
--
-- 说明：
-- - “管理员查看全站用户/对话”不通过 RLS 放开，而是走服务端 /api/admin/*（service_role）
-- - 本脚本可重复执行（尽量幂等）
-- - 文件底部还包含一些【可选】运维/迁移/排错段落（按需执行）
--
-- 执行位置：Supabase Dashboard -> SQL Editor

-- ============ 1) profiles 表 ============

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

-- ============ 2) 通用 updated_at trigger ============

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

-- chats 表必须已存在，否则下面 trigger 会失败。
-- 如果你是新项目，请先在 Supabase 建好 chats（或把 chats 的建表也放在这里）。
drop trigger if exists chats_set_updated_at on public.chats;
create trigger chats_set_updated_at
before update on public.chats
for each row
execute function public.set_updated_at();

-- ============ 3) 新用户自动创建 profile ============

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- ============ 4) Admin 判定函数（避免 RLS policy 递归） ============
-- 仅用于：前端读 profiles.is_admin / 服务端做额外判定。

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

-- ============ 5) RLS ============

alter table public.profiles enable row level security;
alter table public.chats enable row level security;

-- profiles: 仅允许读自己的 profile（用于前端判断 is_admin）
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
on public.profiles
for select
using (auth.uid() = id);

-- chats: 用户仅可读写自己的 chats
drop policy if exists "chats: owner read" on public.chats;
create policy "chats: owner read"
on public.chats
for select
using (auth.uid() = user_id);

drop policy if exists "chats: owner insert" on public.chats;
create policy "chats: owner insert"
on public.chats
for insert
with check (auth.uid() = user_id);

drop policy if exists "chats: owner update" on public.chats;
create policy "chats: owner update"
on public.chats
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "chats: owner delete" on public.chats;
create policy "chats: owner delete"
on public.chats
for delete
using (auth.uid() = user_id);

-- ============ 6) 管理员设置（手动） ============
-- update public.profiles set is_admin = true where email = 'your_admin@email.com';

-- ==========================================================
-- 可选段落（按需执行）
-- ==========================================================

-- ==========================================================
-- A) 回填历史用户到 profiles（幂等）
--    适用：你之前已经有 auth.users / chats，现在新增 profiles/is_admin。
-- ==========================================================

-- insert into public.profiles (id, email, created_at, updated_at)
-- select
--   u.id,
--   u.email,
--   timezone('utc'::text, now()),
--   timezone('utc'::text, now())
-- from auth.users u
-- on conflict (id) do update
--   set email = excluded.email,
--       updated_at = timezone('utc'::text, now());

-- ==========================================================
-- B) 检查 chats 孤儿数据（chats.user_id 不存在于 auth.users）
-- ==========================================================

-- select
--   c.id as chat_id,
--   c.user_id,
--   c.title,
--   c.created_at
-- from public.chats c
-- left join auth.users u on u.id = c.user_id
-- where u.id is null
-- order by c.created_at desc
-- limit 200;

-- （可选）删除孤儿 chats：
-- delete from public.chats c
-- where not exists (select 1 from auth.users u where u.id = c.user_id);

-- ==========================================================
-- C) 收口旧版“admin read all” RLS policy（如果你历史上创建过）
-- ==========================================================

-- drop policy if exists "profiles: admin read all" on public.profiles;
-- drop policy if exists "chats: admin read all" on public.chats;


