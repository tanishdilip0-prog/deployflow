create extension if not exists pgcrypto;

-- Users (linked to Supabase Auth)
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  github_login text,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Repositories
create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  github_repo_id bigint,
  full_name text not null check (full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text not null default 'main',
  created_at timestamptz not null default now(),
  unique (owner_id, full_name)
);
create index on public.repositories (owner_id);

-- Per-repository deployment configuration
create table public.deployment_configurations (
  repository_id uuid primary key references public.repositories(id) on delete cascade,
  install_command text not null default 'npm ci',
  test_command text not null default 'npm test',
  build_command text not null default 'npm run build',
  output_dir text not null default 'dist',
  s3_bucket text,
  cloudfront_distribution_id text,
  updated_at timestamptz not null default now()
);

-- Deployments
create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.repositories(id) on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{7,40}$'),
  commit_message text,
  branch text not null,
  trigger_source text not null check (trigger_source in ('webhook','manual','retry')),
  status text not null default 'queued' check (status in
    ('queued','cloning','installing','testing','building','deploying','success','failed','cancelled')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  build_duration_ms integer check (build_duration_ms >= 0),
  deployment_url text,
  error_summary text
);
create index on public.deployments (repository_id, created_at desc);
create index on public.deployments (status);

-- Stages
create table public.deployment_stages (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  name text not null check (name in ('checkout','install','test','build','deploy','verify')),
  status text not null default 'pending' check (status in ('pending','running','success','failed','skipped')),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  exit_code integer,
  unique (deployment_id, name)
);

-- Logs
create table public.deployment_logs (
  id bigint generated always as identity primary key,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  stage text,
  level text not null default 'info' check (level in ('info','warn','error')),
  message text not null,
  created_at timestamptz not null default now()
);
create index on public.deployment_logs (deployment_id, id);

-- Webhook delivery ids (stops the same GitHub delivery being processed twice)
create table public.webhook_deliveries (
  delivery_id text primary key,
  event text not null,
  repository_id uuid references public.repositories(id) on delete set null,
  received_at timestamptz not null default now()
);

-- Only allow valid status changes
create function public.check_deployment_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'queued'     and new.status in ('cloning','failed','cancelled')) or
    (old.status = 'cloning'    and new.status in ('installing','failed','cancelled')) or
    (old.status = 'installing' and new.status in ('testing','failed','cancelled')) or
    (old.status = 'testing'    and new.status in ('building','failed','cancelled')) or
    (old.status = 'building'   and new.status in ('deploying','failed','cancelled')) or
    (old.status = 'deploying'  and new.status in ('success','failed','cancelled'))
  ) then
    raise exception 'Invalid deployment status transition: % -> %', old.status, new.status;
  end if;
  return new;
end $$;

create trigger deployments_check_transition
before update of status on public.deployments
for each row execute function public.check_deployment_transition();

-- Row-level security: users can only read their own data.
-- All writes come from the backend using the service-role key.
alter table public.users enable row level security;
alter table public.repositories enable row level security;
alter table public.deployment_configurations enable row level security;
alter table public.deployments enable row level security;
alter table public.deployment_stages enable row level security;
alter table public.deployment_logs enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy "read own profile" on public.users
  for select using (id = (select auth.uid()));

create policy "read own repositories" on public.repositories
  for select using (owner_id = (select auth.uid()));

create policy "read own configuration" on public.deployment_configurations
  for select using (exists (
    select 1 from public.repositories r
    where r.id = deployment_configurations.repository_id and r.owner_id = (select auth.uid())));

create policy "read own deployments" on public.deployments
  for select using (exists (
    select 1 from public.repositories r
    where r.id = deployments.repository_id and r.owner_id = (select auth.uid())));

create policy "read own stages" on public.deployment_stages
  for select using (exists (
    select 1 from public.deployments d join public.repositories r on r.id = d.repository_id
    where d.id = deployment_stages.deployment_id and r.owner_id = (select auth.uid())));

create policy "read own logs" on public.deployment_logs
  for select using (exists (
    select 1 from public.deployments d join public.repositories r on r.id = d.repository_id
    where d.id = deployment_logs.deployment_id and r.owner_id = (select auth.uid())));

-- Live updates for the frontend
alter publication supabase_realtime add table
  public.deployments, public.deployment_stages, public.deployment_logs;