-- Sign After Six production-readiness migration
-- Safe to run more than once. It changes structure only and does not delete customer data.

create extension if not exists btree_gist;

alter table public.appointment_requests
  add column if not exists management_token_hash text,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists refund_status text not null default 'not_applicable',
  add column if not exists refund_amount numeric(10,2),
  add column if not exists refund_note text,
  add column if not exists reschedule_requested_at timestamptz,
  add column if not exists requested_appointment_at timestamptz,
  add column if not exists requested_backup_time text,
  add column if not exists reschedule_reason text,
  add column if not exists reschedule_count integer not null default 0,
  add column if not exists previous_appointment_at timestamptz,
  add column if not exists lifecycle_previous_status text;

alter table public.appointment_requests
  drop constraint if exists appointment_requests_refund_status_check;
alter table public.appointment_requests
  add constraint appointment_requests_refund_status_check
  check (refund_status in ('not_applicable','pending','manual_required','completed','denied'));

alter table public.appointment_requests
  drop constraint if exists appointment_requests_reschedule_count_check;
alter table public.appointment_requests
  add constraint appointment_requests_reschedule_count_check
  check (reschedule_count >= 0);

-- Rebuild the protected time range from the exact values used by Calendar.
alter table public.appointment_requests
  add column if not exists booking_block tstzrange generated always as (
    tstzrange(
      appointment_at - make_interval(secs => coalesce(one_way_travel_seconds, 0)),
      appointment_at + make_interval(mins => coalesce(duration_minutes, 30))
        + make_interval(secs => coalesce(one_way_travel_seconds, 0)),
      '[)'
    )
  ) stored;

-- Rebuild the constraint so requests awaiting cancellation or reschedule approval
-- continue protecting the original appointment from double-booking.
alter table public.appointment_requests
  drop constraint if exists appointment_requests_no_active_overlap;
alter table public.appointment_requests
  add constraint appointment_requests_no_active_overlap
  exclude using gist (booking_block with &&)
  where (status in ('pending','revised_quote','awaiting_payment','confirmed','cancel_requested','reschedule_requested'));

create index if not exists appointment_requests_management_token_idx
  on public.appointment_requests (id, management_token_hash)
  where management_token_hash is not null;

create index if not exists appointment_requests_requested_time_idx
  on public.appointment_requests (requested_appointment_at)
  where status = 'reschedule_requested';

-- Keep the private customer-document bucket constrained to one-file limits.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'notary-documents', 'notary-documents', false, 10485760,
  array['application/pdf','image/jpeg','image/png']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.admin_users enable row level security;
revoke all on table public.admin_users from anon, authenticated;
grant select on table public.admin_users to authenticated;

drop policy if exists "authenticated users read admin membership" on public.admin_users;
create policy "authenticated users read own admin membership"
  on public.admin_users for select to authenticated
  using (user_id = auth.uid());

alter table public.appointment_requests enable row level security;
alter table public.request_documents enable row level security;
alter table public.quote_revisions enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.audit_log enable row level security;

revoke all on table public.appointment_requests from anon;
revoke all on table public.request_documents from anon;
revoke all on table public.quote_revisions from anon;
revoke all on table public.availability_blocks from anon;
revoke all on table public.audit_log from anon;

-- Cancellation retention: delete private uploads 24 hours after final cancellation.
-- Completion retention remains seven days and is never restarted by retries.
create or replace function public.request_status_side_effects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('approved','awaiting_payment','confirmed','completed','cancel_requested','reschedule_requested','cancelled')
     and old.status is distinct from new.status then
    update public.request_documents set locked = true where request_id = new.id;
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at = coalesce(new.completed_at, now());
    update public.request_documents
       set delete_after = coalesce(delete_after, new.completed_at + interval '7 days')
     where request_id = new.id;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
    update public.request_documents
       set delete_after = least(coalesce(delete_after, new.cancelled_at + interval '24 hours'),
                                new.cancelled_at + interval '24 hours')
     where request_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_request_status_side_effects on public.appointment_requests;
create trigger trg_request_status_side_effects
before update on public.appointment_requests
for each row execute function public.request_status_side_effects();

comment on column public.appointment_requests.management_token_hash is
  'SHA-256 hash of the customer management token; plaintext is never stored.';
comment on column public.appointment_requests.refund_status is
  'Launch policy uses manual Square refunds; this records operational state.';

create or replace function public.has_booking_conflict(
  proposed_start timestamptz,
  proposed_end timestamptz,
  ignore_request_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.appointment_requests r
    where r.status in ('pending','revised_quote','awaiting_payment','confirmed','cancel_requested','reschedule_requested')
      and (ignore_request_id is null or r.id <> ignore_request_id)
      and r.booking_block && tstzrange(proposed_start, proposed_end, '[)')
  );
$$;
revoke all on function public.has_booking_conflict(timestamptz,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.has_booking_conflict(timestamptz,timestamptz,uuid) to service_role;
