-- Topics: user-controlled, extendable via /topic
create table topics (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default '00000000-0000-0000-0000-000000000001',
  slug       text not null,
  label      text not null,
  created_at timestamptz not null default now(),
  unique (user_id, slug)
);

create table articles (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  kind         text not null default 'link' check (kind in ('link', 'pdf')),
  url          text,
  url_key      text,
  domain       text,
  storage_path text,
  title        text,
  description  text,
  fetch_ok     boolean not null default true,
  status       text not null default 'unread'
                 check (status in ('unread', 'read', 'skipped')),
  saved_at     timestamptz not null default now(),
  resolved_at  timestamptz,

  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored,

  constraint articles_link_has_url check (kind <> 'link' or url is not null)
);

-- Partial: PDFs have a null url_key and must not collide
create unique index articles_user_url_key_uniq
  on articles (user_id, url_key) where url_key is not null;

create index articles_search_idx on articles using gin (search_vector);
create index articles_pool_idx on articles (user_id, status, kind, saved_at desc);

create table article_topics (
  article_id  bigint not null references articles(id) on delete cascade,
  topic_id    bigint not null references topics(id) on delete cascade,
  assigned_by text not null default 'llm' check (assigned_by in ('llm', 'user')),
  primary key (article_id, topic_id)
);

create index article_topics_topic_idx on article_topics (topic_id);

create table notes (
  id                  bigint generated always as identity primary key,
  article_id          bigint not null references articles(id) on delete cascade,
  body                text not null,
  telegram_message_id bigint,
  created_at          timestamptz not null default now(),

  search_vector tsvector generated always as (
    to_tsvector('english', body)
  ) stored
);

create index notes_article_idx on notes (article_id);
create index notes_search_idx on notes using gin (search_vector);

create table deliveries (
  id      bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  sent_on date not null,
  sent_at timestamptz not null default now(),
  unique (user_id, sent_on)
);

create table delivery_items (
  delivery_id bigint not null references deliveries(id) on delete cascade,
  article_id  bigint not null references articles(id) on delete cascade,
  position    smallint not null,
  primary key (delivery_id, article_id)
);

-- Maps every outbound bot message back to what it was about.
-- Buttons and replies both resolve through here.
create table sent_messages (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null default '00000000-0000-0000-0000-000000000001',
  chat_id             bigint not null,
  telegram_message_id bigint not null,
  kind                text not null check (kind in ('article', 'topic_list')),
  article_id          bigint references articles(id) on delete cascade,
  payload             jsonb,
  created_at          timestamptz not null default now(),
  unique (chat_id, telegram_message_id)
);

-- Idempotency guard (D3)
create table processed_updates (
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);

insert into topics (slug, label) values
  ('design-systems',    'Design Systems'),
  ('research-methods',  'Research Methods'),
  ('product-design',    'Product Design'),
  ('civic-tech',        'Civic Tech'),
  ('ai-tooling',        'AI Tooling'),
  ('engineering',       'Engineering'),
  ('career',            'Career'),
  ('leadership',        'Leadership'),
  ('writing',           'Writing'),
  ('business-strategy', 'Business & Strategy'),
  ('brand-visual',      'Brand & Visual'),
  ('tools-software',    'Tools & Software'),
  ('health-fitness',    'Health & Fitness'),
  ('personal-finance',  'Personal Finance'),
  ('other',             'Other');

-- New tables are not auto-exposed to the API roles by default. D6 says
-- functions use the service role key with no RLS, so grant it direct access.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- The grants above only cover tables that exist right now. Migrations run as
-- `postgres`, so this makes service_role's access standing for any table a
-- later migration creates (but not one created by hand in the dashboard —
-- repeat the explicit grant block above if that ever happens).
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
