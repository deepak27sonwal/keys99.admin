import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const { createClient } = window.supabase;

// Single shared Supabase client — every module (and login.html) imports this instead of
// creating its own.
//
// PKCE, as on keys99.com: when a sign-in link from Supabase's email is opened, Supabase returns
// a one-time ?code= that this browser swaps for the session using a secret it kept when the
// code was requested, so no access token ever sits in the page address. A link opened in a
// different browser or app can't be completed (the admin types the emailed code instead).
export const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { flowType: 'pkce' } });
