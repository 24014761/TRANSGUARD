revoke execute on function public.my_role() from public, anon;
revoke execute on function public.my_ward() from public, anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_ward() to authenticated;
