-- The tip line's table. api/tips.js also creates it automatically on first use,
-- so you only need to run this by hand if you want to set things up yourself.
create table if not exists tips (
  id          bigint generated always as identity primary key,
  name        text,                              -- optional name or alias
  message     text not null,                     -- the tip itself
  approved    boolean not null default false,    -- only approved tips are shown on the site
  ip_hash     text,                              -- hashed IP, used only for rate limiting
  created_at  timestamptz not null default now()
);
create index if not exists tips_public_idx on tips (approved, created_at desc);
create index if not exists tips_ip_idx on tips (ip_hash, created_at desc);

-- Handy queries for the Neon SQL editor:
--   See tips waiting for review:  select id, name, message, created_at from tips where not approved order by created_at;
--   Approve one:                  update tips set approved = true where id = 42;
--   Delete one:                   delete from tips where id = 42;
