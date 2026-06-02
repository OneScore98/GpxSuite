-- Supabase espone spesso pgcrypto nello schema `extensions`.
-- Le RPC usano digest() per hashare la chiave dispositivo: includiamo
-- extensions nel search_path delle funzioni che lo chiamano.

alter function public.gpxsuite_complete_login(text, text, text)
set search_path = public, extensions;

alter function public.gpxsuite_log_event(text, jsonb, text)
set search_path = public, extensions;
