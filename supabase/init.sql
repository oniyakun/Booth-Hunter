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

-- ============ 0) 清理旧函数（必须执行，否则无法修改返回类型） ============
drop function if exists public.consume_turn(uuid);
drop function if exists public.get_turn_meta();

-- ============ 1) profiles 表 ============

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  -- 对话次数统计（今日，按 UTC+8 0 点重置）
  daily_turn_count bigint not null default 0,
  daily_turn_date date not null default (timezone('Asia/Shanghai', now()))::date,
  -- 单独限制（优先级高于全局默认；NULL 表示使用全局默认）
  session_turn_limit_override integer,
  daily_turn_limit_override bigint,
  -- legacy: 历史累计字段（已废弃，不再用于限额）；保留以兼容旧数据/迁移。
  total_turn_count bigint not null default 0,
  total_turn_limit_override bigint,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

-- 兼容旧库：为已存在的 profiles 补齐新列（幂等）
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

-- 兼容旧库：为已存在的 profiles 补齐新列（幂等）
alter table public.profiles add column if not exists total_turn_count bigint not null default 0;
alter table public.profiles add column if not exists session_turn_limit_override integer;
alter table public.profiles add column if not exists total_turn_limit_override bigint;

-- 新版：每日对话次数（UTC+8）
alter table public.profiles add column if not exists daily_turn_count bigint not null default 0;
alter table public.profiles add column if not exists daily_turn_date date not null default (timezone('Asia/Shanghai', now()))::date;
alter table public.profiles add column if not exists daily_turn_limit_override bigint;

-- ============ 2.1) 全局默认限制（管理员可改） ============

create table if not exists public.app_settings (
  key text primary key,
  value_bigint bigint not null,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row
execute function public.set_updated_at();

-- 初始化默认值（可在管理员面板里修改）
insert into public.app_settings (key, value_bigint)
values
  ('default_session_turn_limit', 50),
  -- legacy: 历史累计限制（已废弃）
  ('default_total_turn_limit', 500),
  -- 新版：每日对话次数限制（UTC+8 0 点重置）
  ('default_daily_turn_limit', 200)
on conflict (key) do nothing;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

-- chats 表必须已存在，否则下面 trigger 会失败。
-- 如果你是新项目，请先在 Supabase 建好 chats（或把 chats 的建表也放在这里）。

-- chats: 单会话对话轮数统计（每次用户点发送 +1）
alter table public.chats add column if not exists turn_count integer not null default 0;

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

-- ============ 4.5) consume_turn(): 原子“计数+限额” ============
-- 轮数定义：每次用户点击发送 = 1 轮。
--
-- 用途：
-- - /api/chat 在真正调用模型前先调用该 RPC。
-- - 若超限，直接返回 allowed=false（并由 /api/chat 返回 429）。
--
-- 特点：
-- - SECURITY DEFINER：可在启用 RLS 的前提下更新 chats/profiles。
-- - 使用 auth.uid() 作为最终用户身份（必须由携带用户 JWT 的客户端调用）。

create or replace function public.consume_turn(p_chat_id uuid)
returns table (
  allowed boolean,
  reason text,
  session_turn_count integer,
  daily_turn_count bigint,
  session_limit integer,
  daily_limit bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_session_limit integer;
  v_daily_limit bigint;
  v_profile public.profiles%rowtype;
  v_chat record;
  v_today date;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, 'not_authenticated', 0, 0::bigint, 0, 0::bigint;
    return;
  end if;

  -- 今日日期（UTC+8 / Asia/Shanghai）
  v_today := (timezone('Asia/Shanghai', now()))::date;

  -- 读取全局默认限制
  select value_bigint::integer into v_session_limit
  from public.app_settings
  where key = 'default_session_turn_limit';

  select value_bigint into v_daily_limit
  from public.app_settings
  where key = 'default_daily_turn_limit';

  if v_session_limit is null then v_session_limit := 50; end if;
  if v_daily_limit is null then v_daily_limit := 200; end if;

  -- 锁定/读取 profile
  select * into v_profile
  from public.profiles
  where id = v_uid
  for update;

  if not found then
    -- 极端情况下 profiles 不存在（例如旧数据/触发器没跑），补一条。
    insert into public.profiles (id)
    values (v_uid)
    on conflict (id) do nothing;

    select * into v_profile
    from public.profiles
    where id = v_uid
    for update;
  end if;

  -- 应用用户覆盖限制（NULL 表示用默认）
  v_session_limit := coalesce(v_profile.session_turn_limit_override, v_session_limit);
  v_daily_limit := coalesce(v_profile.daily_turn_limit_override, v_daily_limit);

  -- 若跨日：重置 daily_turn_count
  if v_profile.daily_turn_date is distinct from v_today then
    update public.profiles p
    set daily_turn_count = 0,
        daily_turn_date = v_today,
        updated_at = timezone('utc'::text, now())
    where p.id = v_uid;

    select * into v_profile
    from public.profiles
    where id = v_uid
    for update;
  end if;

  -- 锁定/读取 chat，如果不存在则创建占位行
  select id, user_id, turn_count
  into v_chat
  from public.chats
  where id = p_chat_id
  for update;

  if not found then
    insert into public.chats (id, user_id, title, messages)
    values (p_chat_id, v_uid, null, '[]'::jsonb)
    on conflict (id) do nothing;

    select id, user_id, turn_count
    into v_chat
    from public.chats
    where id = p_chat_id
    for update;
  end if;

  if v_chat.user_id <> v_uid then
    return query select false, 'forbidden', v_chat.turn_count, v_profile.daily_turn_count, v_session_limit, v_daily_limit;
    return;
  end if;

  -- 检查限额（<=0 视为无限制）
  if v_session_limit > 0 and (v_chat.turn_count + 1) > v_session_limit then
    return query select false, 'session_limit', v_chat.turn_count, v_profile.daily_turn_count, v_session_limit, v_daily_limit;
    return;
  end if;

  if v_daily_limit > 0 and (v_profile.daily_turn_count + 1) > v_daily_limit then
    return query select false, 'daily_limit', v_chat.turn_count, v_profile.daily_turn_count, v_session_limit, v_daily_limit;
    return;
  end if;

  update public.chats
  set turn_count = turn_count + 1,
      updated_at = timezone('utc'::text, now())
  where id = p_chat_id;

  update public.profiles p
  set daily_turn_count = p.daily_turn_count + 1,
      total_turn_count = p.total_turn_count + 1,
      daily_turn_date = v_today,
      updated_at = timezone('utc'::text, now())
  where p.id = v_uid;

  -- 返回更新后的值（注意：返回列名与表字段名可能同名，必须加别名避免歧义）
  select c.turn_count into session_turn_count
  from public.chats c
  where c.id = p_chat_id;

  select p.daily_turn_count into daily_turn_count
  from public.profiles p
  where p.id = v_uid;

  allowed := true;
  reason := null;
  session_limit := v_session_limit;
  daily_limit := v_daily_limit;
  return next;
end;
$$;

-- 仅允许已登录用户调用（函数内部也会检查 auth.uid()）
revoke all on function public.consume_turn(uuid) from public;
grant execute on function public.consume_turn(uuid) to authenticated;

-- ============ 4.6) get_turn_meta(): 只读“统计+限额”（不消耗轮数） ============
-- 用途：前端初次加载时展示“总轮数/总上限”。
-- 特点：
-- - SECURITY DEFINER：在 app_settings 开启 RLS（且客户端无权限）时仍可读取默认值。
-- - 不更新 chats / profiles，只返回当前值。

create or replace function public.get_turn_meta()
returns table (
  daily_turn_count bigint,
  session_limit integer,
  daily_limit bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_session_limit integer;
  v_daily_limit bigint;
  v_profile public.profiles%rowtype;
  v_today date;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select 0::bigint, 0, 0::bigint;
    return;
  end if;

  v_today := (timezone('Asia/Shanghai', now()))::date;

  -- 读取全局默认限制
  select value_bigint::integer into v_session_limit
  from public.app_settings
  where key = 'default_session_turn_limit';

  select value_bigint into v_daily_limit
  from public.app_settings
  where key = 'default_daily_turn_limit';

  if v_session_limit is null then v_session_limit := 50; end if;
  if v_daily_limit is null then v_daily_limit := 200; end if;

  select * into v_profile
  from public.profiles
  where id = v_uid;

  if not found then
    insert into public.profiles (id)
    values (v_uid)
    on conflict (id) do nothing;

    select * into v_profile
    from public.profiles
    where id = v_uid;
  end if;

  -- 应用用户覆盖限制（NULL 表示用默认）
  v_session_limit := coalesce(v_profile.session_turn_limit_override, v_session_limit);
  v_daily_limit := coalesce(v_profile.daily_turn_limit_override, v_daily_limit);

  -- 跨日：返回前先把计数视为 0，并顺带落库重置，避免前端看到“昨天的今日次数”。
  if v_profile.daily_turn_date is distinct from v_today then
    update public.profiles p
    set daily_turn_count = 0,
        daily_turn_date = v_today,
        updated_at = timezone('utc'::text, now())
    where p.id = v_uid;
    v_profile.daily_turn_count := 0;
    v_profile.daily_turn_date := v_today;
  end if;

  return query select v_profile.daily_turn_count, v_session_limit, v_daily_limit;
end;
$$;

revoke all on function public.get_turn_meta() from public;
grant execute on function public.get_turn_meta() to authenticated;

-- ============ 5) RLS ============

alter table public.profiles enable row level security;
alter table public.chats enable row level security;

-- app_settings 仅允许服务端（service_role）访问，不开放给客户端。
alter table public.app_settings enable row level security;
drop policy if exists "app_settings: no access" on public.app_settings;
create policy "app_settings: no access"
on public.app_settings
for all
using (false)
with check (false);

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








