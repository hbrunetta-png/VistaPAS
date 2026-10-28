-- =====================================================================
-- VistaPAS · Base de datos para Supabase
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar todo → Run.
-- Se puede volver a ejecutar sin romper nada (usa "if not exists" / "or replace").
-- =====================================================================

-- 1) Cuenta de cada productor: un registro por usuario.
--    doc = "documento de la cuenta" del CRM (tus datos, grupos familiares, configuración, avisos resueltos).
--    plan y trial_until los cambia solo el administrador (el usuario no tiene permiso).
create table if not exists public.accounts (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text,
  nombre      text not null default '',
  doc         jsonb not null default '{}'::jsonb,
  plan        text not null default 'prueba',          -- prueba | activo | suspendido
  trial_until date not null default (current_date + 30),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2) Datos del CRM: una fila por registro de cada colección
--    (clientes, pólizas, siniestros, oportunidades, cobranzas, etc.). El contenido va en "data".
--    Las bajas son lógicas (deleted = true) para que los otros dispositivos se enteren.
create table if not exists public.records (
  user_id    uuid not null references auth.users (id) on delete cascade,
  coll       text not null check (coll in ('clients','policies','claims','opps','tasks','acts','cias','prods',
                                           'cobros','liqs','docs','tpls','wtpls','charts','trash','_files')),
  id         text not null,
  data       jsonb not null,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, coll, id)
);
create index if not exists records_sync_idx on public.records (user_id, updated_at);

-- Fecha de último cambio automática (la usa la sincronización entre dispositivos)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.touch_updated_at();

drop trigger if exists accounts_touch on public.accounts;
create trigger accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();

-- 3) Seguridad: cada productor ve y modifica solo sus propios datos (Row Level Security)
alter table public.accounts enable row level security;
alter table public.records  enable row level security;

drop policy if exists "cuenta propia: ver" on public.accounts;
create policy "cuenta propia: ver" on public.accounts
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "cuenta propia: editar" on public.accounts;
create policy "cuenta propia: editar" on public.accounts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "registros propios" on public.records;
create policy "registros propios" on public.records
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Permisos: nada para visitantes sin sesión; el usuario no puede cambiarse el plan ni la prueba.
revoke all on public.accounts from anon;
revoke all on public.records  from anon;
revoke insert, update, delete on public.accounts from authenticated;
grant select on public.accounts to authenticated;
grant update (doc, nombre) on public.accounts to authenticated;
grant select, insert, update on public.records to authenticated;

-- 4) Al registrarse alguien, se crea su cuenta con 30 días de prueba
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (user_id, email, nombre)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'nombre', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5) "Eliminar mi cuenta" desde Configuraciones (los archivos los borra antes la app)
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;
  delete from auth.users where id = auth.uid();   -- borra en cascada accounts y records
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 6) Archivos (legajo, PDF de cotizaciones y liquidaciones, imágenes de plantillas)
--    Bucket privado "archivos". Cada productor usa una carpeta con su id de usuario. Máximo 15 MB por archivo.
insert into storage.buckets (id, name, public, file_size_limit)
values ('archivos', 'archivos', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "archivos propios: ver" on storage.objects;
create policy "archivos propios: ver" on storage.objects for select to authenticated
  using (bucket_id = 'archivos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "archivos propios: subir" on storage.objects;
create policy "archivos propios: subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'archivos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "archivos propios: reemplazar" on storage.objects;
create policy "archivos propios: reemplazar" on storage.objects for update to authenticated
  using (bucket_id = 'archivos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'archivos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "archivos propios: borrar" on storage.objects;
create policy "archivos propios: borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'archivos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 7) Vistas de consulta (opcionales), para armar reportes en SQL sin tocar el JSON.
--    Respetan la seguridad de cada usuario (security_invoker).
create or replace view public.v_clientes with (security_invoker = on) as
select user_id, id,
       data ->> 'nombre'    as nombre,
       data ->> 'dni'       as dni_cuit,
       data ->> 'tel'       as telefono,
       data ->> 'email'     as email,
       data ->> 'tipo'      as tipo,
       data ->> 'segmento'  as segmento,
       created_at, updated_at
from public.records
where coll = 'clients' and not deleted;

create or replace view public.v_polizas with (security_invoker = on) as
select user_id, id,
       data ->> 'cli'                       as cliente_id,
       data ->> 'nro'                       as nro_poliza,
       data ->> 'cia'                       as compania,
       data ->> 'ramo'                      as ramo,
       (data ->> 'desde')::date             as vigencia_desde,
       (data ->> 'hasta')::date             as vigencia_hasta,
       nullif(data ->> 'prima', '')::numeric  as prima_vigencia,
       nullif(data ->> 'premio', '')::numeric as premio_vigencia,
       data ->> 'medio'                     as medio_de_pago,
       created_at, updated_at
from public.records
where coll = 'policies' and not deleted;

-- 8) Búsqueda en el padrón de ARCA: caché de la Edge Function "arca-padron"
--    Guarda el ticket de acceso de ARCA (12 horas), los resultados de las consultas (30 días)
--    y el contador de consultas por productor. Solo la usa la función (con la service role):
--    tiene RLS activado y ninguna política, así que desde la página no se puede leer.
create table if not exists public.arca_cache (
  key        text primary key,
  value      jsonb not null,
  expires_at timestamptz not null
);
alter table public.arca_cache enable row level security;
revoke all on public.arca_cache from anon, authenticated;
-- Limpieza opcional de lo vencido:  delete from public.arca_cache where expires_at < now();

-- Administración (ejemplos, ejecutar a mano cuando haga falta):
--   Activar a un cliente que pagó:   update public.accounts set plan = 'activo' where email = 'productor@ejemplo.com';
--   Extender la prueba 15 días:      update public.accounts set trial_until = trial_until + 15 where email = '...';
--   Ver cuentas y uso:               select email, plan, trial_until, (select count(*) from public.records r where r.user_id = a.user_id and not r.deleted) as registros from public.accounts a order by created_at desc;
