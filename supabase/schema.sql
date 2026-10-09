-- Family Meals — Supabase schema (Phase 9/10).
-- How to apply: Supabase dashboard → SQL Editor → paste this whole file → Run.
-- It creates tables, Row Level Security (one household can never read
-- another's rows), and three helper functions (create/join/revoke).
-- Nothing here needs the secret service_role key in the app.
-- Safe to re-run: every statement uses "if not exists" / "or replace".

create extension if not exists pgcrypto;

-- ============ households / memberships / invites (tables first) ============

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our Home',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

create table if not exists public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (user_id, household_id)
);

-- Only the hash of an invite code is stored. The plain code is shown ONCE
-- at creation — copy it immediately, it cannot be shown again.
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null default now() + interval '7 days',
  max_uses int not null default 1,
  used_count int not null default 0,
  revoked_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;

-- Helpers (created AFTER the tables they reference).
create or replace function public.is_member(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.household_id = hid and m.user_id = auth.uid()
  );
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop policy if exists "members read own household" on public.households;
create policy "members read own household" on public.households
  for select using (public.is_member(id));

drop policy if exists "members update own household" on public.households;
create policy "members update own household" on public.households
  for update using (public.is_member(id));

drop policy if exists "users read own memberships" on public.memberships;
create policy "users read own memberships" on public.memberships
  for select using (user_id = auth.uid());

drop policy if exists "members read household invites" on public.invites;
create policy "members read household invites" on public.invites
  for select using (public.is_member(household_id));

drop policy if exists "members manage household invites" on public.invites;
create policy "members manage household invites" on public.invites
  for all using (public.is_member(household_id));

-- First household: creates "Our Home" + makes you the owner.
create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.households (name, created_by)
  values (coalesce(nullif(p_name, ''), 'Our Home'), auth.uid())
  returning id into hid;
  insert into public.memberships (user_id, household_id, role)
  values (auth.uid(), hid, 'owner');
  return hid;
end;
$$;

-- Join with an invite code (client sends the SHA-256 hex of the code).
create or replace function public.join_household(p_code_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from public.invites
  where code_hash = p_code_hash
    and revoked_at is null
    and expires_at > now()
    and used_count < max_uses
  order by created_at desc limit 1;
  if inv.id is null then raise exception 'Invite invalid, expired, or already used'; end if;
  insert into public.memberships (user_id, household_id, role)
  values (auth.uid(), inv.household_id, 'member')
  on conflict do nothing;
  update public.invites set used_count = used_count + 1 where id = inv.id;
  return inv.household_id;
end;
$$;

create or replace function public.revoke_invite(p_invite_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  select household_id into hid from public.invites where id = p_invite_id;
  if hid is null or not public.is_member(hid) then raise exception 'Not allowed'; end if;
  update public.invites set revoked_at = now() where id = p_invite_id;
end;
$$;

-- ============ household data tables ============
-- Every table: stable uuid id (generated on the phone), household scope,
-- version + updated_at for sync ordering, deleted_at tombstone (never hard-delete remotely).

create table if not exists public.recipes (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null, description text not null default '', notes text not null default '',
  servings_original int not null default 4,
  time_prep_min int, time_cook_min int,
  categories text[] not null default '{}', tags text[] not null default '{}',
  image_path text, source_url text,
  import_source text not null default 'manual', import_status text,
  cost_estimate_cents int, favorite boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid
);

create table if not exists public.recipe_ingredients (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  position int not null default 0,
  name_raw text not null, name_canonical text not null default '',
  qty_amount numeric, qty_min numeric, qty_max numeric,
  unit_raw text, unit_canonical text,
  is_scalable boolean not null default true, scaling_note text, preparation text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1
);

create table if not exists public.recipe_steps (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  position int not null default 0, text text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1
);

create table if not exists public.planned_meals (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  date date not null, meal_type text not null,
  recipe_id uuid references public.recipes (id) on delete set null,
  title_override text, servings_planned int not null default 2,
  is_leftovers boolean not null default false, notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid
);

create table if not exists public.grocery_lists (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  week_start_sun date not null, status text not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid,
  unique (household_id, week_start_sun)
);

create table if not exists public.grocery_items (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  list_id uuid not null references public.grocery_lists (id) on delete cascade,
  stable_key text not null default '', display_name text not null,
  name_canonical text not null default '',
  qty_amount numeric, unit_canonical text,
  is_estimate_uncertain boolean not null default false,
  source_summary text, is_custom boolean not null default false,
  is_checked boolean not null default false, checked_at timestamptz, custom_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid
);

create table if not exists public.pantry_items (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  name_canonical text not null default '', display_name text not null,
  qty_on_hand numeric, unit_canonical text, category text,
  expires_on date, unit_cost_cents int, notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid
);

create table if not exists public.spending_records (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  date date not null, store text, amount_cents int not null,
  kind text not null default 'trip_total', grocery_list_id uuid, memo text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1, updated_by uuid
);

create table if not exists public.price_estimates (
  id uuid primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  name_canonical text not null default '', unit_canonical text,
  price_cents_per_unit int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1
);

create table if not exists public.budget_settings (
  id text primary key, -- "YYYY-MM", matches the phone
  household_id uuid not null references public.households (id) on delete cascade,
  month text not null, amount_cents int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz, version int not null default 1
);

-- One household can never read another's rows. Enforced by the database,
-- not by app code — even a buggy app cannot leak across households.
do $$
declare t text;
begin
  foreach t in array array[
    'recipes','recipe_ingredients','recipe_steps','planned_meals','grocery_lists',
    'grocery_items','pantry_items','spending_records','price_estimates','budget_settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "household isolation" on public.%I', t);
    execute format(
      'create policy "household isolation" on public.%I for all using (public.is_member(household_id)) with check (public.is_member(household_id))',
      t);
    execute format('drop trigger if exists trg_touch on public.%I', t);
    execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
