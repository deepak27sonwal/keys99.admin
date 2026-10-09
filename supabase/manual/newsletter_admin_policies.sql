-- Run once in Supabase → SQL Editor (it couldn't be applied from the admin session).
--
-- The newsletter tables' row-level-security policies only allow the 'admin' and 'editor'
-- roles, so super admins get an empty / failing Newsletter page. This switches them to the
-- shared private.is_admin() helper (admin + super_admin) that every other admin table uses.
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('newsletter_subscribers', 'newsletter_campaigns', 'newsletter_campaign_recipients') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "newsletter subscribers admin all" on public.newsletter_subscribers
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "newsletter campaigns admin all" on public.newsletter_campaigns
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "newsletter recipients admin all" on public.newsletter_campaign_recipients
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
