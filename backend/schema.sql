-- Copperbelt ILC schema
-- Run this once against your Postgres database (Supabase/Neon/Render all let you
-- paste this into a SQL editor, or run it with psql).

create table if not exists facilities (
  id serial primary key,
  name text not null,
  town text,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id serial primary key,
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('superadmin','facilityadmin','user')),
  facility_id integer references facilities(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists rounds (
  id serial primary key,
  test_id text not null,
  sample_id text not null,
  providing_facility_id integer references facilities(id) on delete cascade,
  deadline date not null,
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id serial primary key,
  round_id integer references rounds(id) on delete cascade,
  facility_id integer references facilities(id) on delete cascade,
  date_received date,
  method_used text,
  sample_condition text,
  result jsonb default '{}',
  personnel_testing text,
  personnel_verifying text,
  status text not null default 'draft' check (status in ('draft','submitted')),
  saved_at timestamptz not null default now(),
  submitted_at timestamptz,
  feedback jsonb,
  unique (round_id, facility_id)
);

create index if not exists idx_users_facility on users(facility_id);
create index if not exists idx_rounds_facility on rounds(providing_facility_id);
create index if not exists idx_submissions_round on submissions(round_id);
