-- Run this in Supabase: Project > SQL Editor > New query

-- Saved poetry/video projects (replaces browser localStorage with real sync)
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  text text not null,
  mood text,
  typography text,
  background text,
  voice text,
  created_at timestamptz default now()
);

alter table projects enable row level security;

create policy "Users can manage their own projects"
  on projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Subscription status, updated by the Stripe webhook
create table if not exists subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',       -- 'free' | 'creator' | 'studio'
  status text not null default 'inactive', -- 'active' | 'inactive' | 'canceled'
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz default now()
);

alter table subscriptions enable row level security;

create policy "Users can read their own subscription"
  on subscriptions for select
  using (auth.uid() = user_id);
