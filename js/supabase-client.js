import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const { createClient } = window.supabase;

// Single shared Supabase client — every module imports this instead of creating its own.
export const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
