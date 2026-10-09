// Household: sign-in, create/join, invites, sync status, conflict inbox.
// If cloud is not configured (.env missing), this screen explains setup and
// the app keeps working 100% offline.
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase, isConfigured, newInviteCode, sha256Hex } from '../lib/supabase';
import { lastSyncAt, pendingCount, resolveKeepMine, resolveKeepTheirs, syncDb, syncNow, type Conflict } from '../lib/sync';

export function useAutoSync() {
  useEffect(() => {
    if (!isConfigured()) return;
    let stop = false;
    const run = async () => {
      const hid = localStorage.getItem('fm.householdId');
      if (!hid || !navigator.onLine) return;
      try {
        const { data } = await getSupabase().auth.getSession();
        if (!data.session || stop) return;
        const r = await syncNow(hid, data.session.user.id);
        if (!stop && !r.error) window.dispatchEvent(new CustomEvent('fm-sync', { detail: r }));
      } catch { /* offline or unconfigured — stay silent, keep local data safe */ }
    };
    run(); // on open
    const onOnline = () => run();
    const onVis = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(run, 60000); // minute heartbeat while open
    return () => { stop = true; clearInterval(t); window.removeEventListener('online', onOnline); document.removeEventListener('visibilitychange', onVis); };
  }, []);
}

function describeConflict(c: Conflict): { mine: string; theirs: string } {
  const pick = (r: Record<string, unknown> | null) => {
    if (!r) return '(deleted)';
    const s = (r.name as string) ?? (r.display_name as string) ?? (r.name_raw as string) ??
      (r.title_override as string) ?? (r.month as string) ?? (r.week_start_sun as string) ??
      (r.date as string) ?? (r.text as string) ?? c.recordId;
    const extra =
      r.servings_planned != null ? ` ×${r.servings_planned}` :
      r.qty_amount != null ? ` ${r.qty_amount}${r.unit_canonical ? ` ${r.unit_canonical}` : ''}` :
      r.amount_cents != null ? ` $${((r.amount_cents as number) / 100).toFixed(2)}` :
      r.qty_on_hand != null ? ` (${r.qty_on_hand}${r.unit_canonical ? ` ${r.unit_canonical}` : ''})` : '';
    return `${String(s).slice(0, 60)}${extra}`;
  };
  return { mine: pick(c.mine), theirs: pick(c.theirs) };
}

const TABLE_LABEL: Record<string, string> = {
  recipes: 'Recipe', recipeIngredients: 'Ingredient', recipeSteps: 'Step',
  plannedMeals: 'Planned meal', groceryLists: 'Grocery list', groceryItems: 'Grocery item',
  pantry: 'Pantry item', spending: 'Spending', prices: 'Price', budgets: 'Budget',
};

export default function Household() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [householdId, setHouseholdId] = useState<string | null>(() => localStorage.getItem('fm.householdId'));
  const [householdName, setHouseholdName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ id: string; expires_at: string; used_count: number; max_uses: number; revoked_at: string | null }[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(() => lastSyncAt());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isConfigured()) return;
    getSupabase().auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = getSupabase().auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    const supabase = getSupabase();
    const { data: ms } = await supabase.from('memberships').select('household_id');
    const hid = (ms?.[0]?.household_id as string | undefined) ?? localStorage.getItem('fm.householdId');
    if (hid) {
      localStorage.setItem('fm.householdId', hid);
      setHouseholdId(hid);
      const { data: h } = await supabase.from('households').select('name').eq('id', hid).maybeSingle();
      if (h) setHouseholdName(h.name as string);
      const { data: inv } = await supabase.from('invites').select('id,expires_at,used_count,max_uses,revoked_at')
        .eq('household_id', hid).order('created_at', { ascending: false }).limit(5);
      setInvites((inv ?? []) as typeof invites);
      setPending(await pendingCount());
      setLastSync(lastSyncAt());
    }
    setConflicts(await syncDb.conflicts.toArray());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    refresh().catch(() => {});
    const onSync = () => refresh().catch(() => {});
    window.addEventListener('fm-sync', onSync);
    return () => window.removeEventListener('fm-sync', onSync);
  }, [refresh]);

  if (!isConfigured()) {
    return (
      <div className="card">
        <h2>Household sharing — not connected</h2>
        <p>This phone works fully offline. To share with your wife's iPhone:</p>
        <ol className="steps">
          <li>Create a free Supabase project.</li>
          <li>Run <code>supabase/schema.sql</code> in its SQL Editor.</li>
          <li>Copy the Project URL + anon key into <code>app/.env</code> (see <code>.env.example</code>).</li>
          <li>Restart the app — this screen becomes sign-in.</li>
        </ol>
        <p className="muted tiny">Full steps: <code>supabase/SETUP.md</code>. The service_role secret key is never needed.</p>
      </div>
    );
  }

  const auth = async (mode: 'signup' | 'signin') => {
    setStatus('');
    setBusy(true);
    try {
      const supabase = getSupabase();
      const { error } = mode === 'signup'
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      setStatus(mode === 'signup' ? 'Account created — check email if confirmation is required, then sign in.' : 'Signed in.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Auth failed.');
    } finally {
      setBusy(false);
    }
  };

  const doSync = async () => {
    if (!householdId || !session) return;
    setBusy(true);
    setStatus('Syncing…');
    try {
      const r = await syncNow(householdId, session.user.id);
      if (r.error) {
        setStatus(`${r.error} Nothing was lost — retry later.`);
      } else {
        setStatus(`Synced: ${r.pushed} up, ${r.pulled} down${r.conflicts ? `, ${r.conflicts} need your pick below` : ''}.`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createHousehold = async () => {
    setBusy(true);
    try {
      const { data, error } = await getSupabase().rpc('create_household', { p_name: householdName.trim() || 'Our Home' });
      if (error) throw new Error(error.message);
      localStorage.setItem('fm.householdId', data as string);
      setStatus('Household created.');
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    try {
      const hash = await sha256Hex(joinCode.trim().toUpperCase());
      const { data, error } = await getSupabase().rpc('join_household', { p_code_hash: hash });
      if (error) throw new Error(error.message);
      localStorage.setItem('fm.householdId', data as string);
      setJoinCode('');
      setStatus('Joined the household.');
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Invite invalid, expired, or already used.');
    } finally {
      setBusy(false);
    }
  };

  const makeInvite = async () => {
    setBusy(true);
    try {
      const code = newInviteCode();
      const hash = await sha256Hex(code);
      const { error } = await getSupabase().from('invites').insert({
        household_id: householdId,
        code_hash: hash,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        max_uses: 1,
      });
      if (error) throw new Error(error.message);
      setFreshCode(code);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="card form">
        <h2>Sign in to sync</h2>
        <p className="muted tiny">One account per person. Your data stays private to your household.</p>
        {status && <p className="muted" role="status">{status}</p>}
        <label>Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <div className="row gap">
          <button className="btn primary big" disabled={busy} onClick={() => auth('signin')}>Sign in</button>
          <button className="btn big" disabled={busy} onClick={() => auth('signup')}>Sign up</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <article className="card">
        <div className="row between">
          <div><h2>{householdName || 'Household'}</h2><p className="muted tiny">{session.user.email}</p></div>
          <button className="btn" onClick={() => { getSupabase().auth.signOut(); localStorage.removeItem('fm.householdId'); setHouseholdId(null); setSession(null); }}>Sign out</button>
        </div>
        {!householdId ? (
          <div className="card form">
            <label>Household name<input className="input" value={householdName} onChange={(e) => setHouseholdName(e.target.value)} placeholder="Our Home" /></label>
            <button className="btn primary" disabled={busy} onClick={createHousehold}>Create household</button>
            <label>…or join with invite code<input className="input" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="XXXX-XXXX" /></label>
            <button className="btn" disabled={busy || !joinCode.trim()} onClick={join}>Join household</button>
          </div>
        ) : (
          <>
            <div className={`net ${navigator.onLine ? 'on' : 'off'}`} role="status">
              <span className="dot" /> {navigator.onLine ? 'Online' : 'Offline'} · Pending {pending} · Last sync {lastSync ? new Date(lastSync).toLocaleString() : 'never'}
            </div>
            <div className="row gap wrap pad">
              <button className="btn primary" disabled={busy} onClick={doSync}>{busy ? '…' : '⟳ Sync now'}</button>
            </div>
          </>
        )}
        {status && <p className="muted" role="status">{status}</p>}
      </article>

      {householdId && (
        <article className="card">
          <h2>Invite</h2>
          <p className="muted tiny">Single-use, expires in 7 days. The code is shown once — copy it now.</p>
          {freshCode && <p className="invite"><b>{freshCode}</b> <button className="btn sm" onClick={() => navigator.clipboard?.writeText(freshCode)}>Copy</button></p>}
          <button className="btn" disabled={busy} onClick={makeInvite}>+ New invite code</button>
          {invites.length > 0 && (
            <ul className="slist">
              {invites.map((i) => (
                <li key={i.id} className="row between">
                  <span className="muted">…{i.id.slice(-4)} · used {i.used_count}/{i.max_uses} · exp {new Date(i.expires_at).toLocaleDateString()}{i.revoked_at ? ' · revoked' : ''}</span>
                  {!i.revoked_at && (
                    <button className="btn danger sm" onClick={async () => {
                      await getSupabase().rpc('revoke_invite', { p_invite_id: i.id });
                      await refresh();
                    }}>Revoke</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="card form">
            <label>Join code (for this phone)<input className="input" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="XXXX-XXXX" /></label>
            <button className="btn" disabled={busy || !joinCode.trim()} onClick={join}>Join household</button>
          </div>
        </article>
      )}

      {conflicts.length > 0 && (
        <article className="card">
          <h2>⚠ {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} need your pick</h2>
          <p className="muted tiny">Both phones changed the same thing. Nothing was overwritten — choose per item.</p>
          {conflicts.map((c) => {
            const d = describeConflict(c);
            return (
              <div key={c.key} className="conflict">
                <p><b>{TABLE_LABEL[c.table] ?? c.table}</b></p>
                <p>Yours: {d.mine}</p>
                <p>Theirs: {d.theirs}</p>
                <div className="row gap">
                  <button className="btn primary sm" onClick={async () => {
                    await resolveKeepMine(c.key, session.user.id);
                    await refresh();
                    setStatus('Kept yours.');
                  }}>Keep mine</button>
                  <button className="btn sm" onClick={async () => {
                    await resolveKeepTheirs(c.key);
                    await refresh();
                    setStatus('Kept theirs.');
                  }}>Keep theirs</button>
                </div>
              </div>
            );
          })}
        </article>
      )}
    </div>
  );
}
