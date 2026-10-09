// Supabase client singleton. Reads the two public values from .env.
// The anon key is safe to ship (RLS enforces privacy); service_role must
// NEVER appear here or in any frontend code.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function isConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function getSupabase(): SupabaseClient {
  if (!isConfigured()) throw new Error('Cloud sync is not connected. Add the two values to app/.env (see supabase/SETUP.md).');
  if (!client) {
    client = createClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    );
  }
  return client;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newInviteCode(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n: number) => Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}
