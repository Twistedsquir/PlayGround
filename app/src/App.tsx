// Phase 9/10: cloud sync ready — connected when app/.env holds the Supabase URL + anon key.
import { useEffect, useState } from 'react';
import Recipes from './components/Recipes';
import Plan from './components/Plan';
import Groceries from './components/Groceries';
import More from './components/More';
import { getOrCreateList } from './lib/groceries';
import { computeMonthlyActual, estimateItems, monthKey } from './lib/budget';
import { prettyDay, addDays, startOfWeekSunday, todayISO } from './lib/meals';
import { isConfigured } from './lib/supabase';
import { lastSyncAt, pendingCount } from './lib/sync';
import type { PlannedMeal, Recipe } from './lib/types';
import { db, requestPersistence } from './lib/db';

type Tab = 'home' | 'recipes' | 'plan' | 'groceries' | 'more';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'recipes', label: 'Recipes', icon: '📖' },
  { id: 'plan', label: 'Plan', icon: '📅' },
  { id: 'groceries', label: 'Lists', icon: '🛒' },
  { id: 'more', label: 'More', icon: '⋯' },
];

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const online = useOnline();
  const [standalone, setStandalone] = useState(false);
  const [counts, setCounts] = useState({ recipes: 0, meals: 0, pantry: 0 });
  const [todayMeals, setTodayMeals] = useState<PlannedMeal[]>([]);
  const [recipeNames, setRecipeNames] = useState<Map<string, string>>(new Map());
  const [groceryProgress, setGroceryProgress] = useState({ bought: 0, total: 0 });
  const [budgetLive, setBudgetLive] = useState<{ budget: number | null; est: number; spent: number }>(
    { budget: null, est: 0, spent: 0 });
  const [cloudNote, setCloudNote] = useState('Local-only — connect sync in More → Household.');

  useEffect(() => {
    setStandalone(isStandalone());
    requestPersistence().catch(() => {});
    // Local counts prove IndexedDB works offline.
    db.recipes.count().then((recipes) =>
      db.plannedMeals.count().then((meals) =>
        db.pantry.count().then((pantry) => setCounts({ recipes, meals, pantry })),
      ),
    ).catch(() => {});
    db.plannedMeals.where('date').equals(todayISO()).toArray()
      .then(async (rows) => {
        setTodayMeals(rows);
        const rs: Recipe[] = await db.recipes.toArray();
        setRecipeNames(new Map(rs.map((r) => [r.id, r.name])));
        try {
          const l = await getOrCreateList(startOfWeekSunday(new Date()));
          const items = await db.groceryItems.where('list_id').equals(l.id).toArray();
          setGroceryProgress({ bought: items.filter((i) => i.is_checked).length, total: items.length });
        } catch { /* list is optional on Home */ }
        try {
          const mk = monthKey();
          const [y, m] = mk.split('-').map(Number);
          const first = `${mk}-01`;
          const last = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
          const lists = (await db.groceryLists.toArray()).filter((x) => {
            const end = addDays(x.week_start_sun, 6);
            return x.week_start_sun <= last && end >= first;
          });
          const ids = new Set(lists.map((x) => x.id));
          const monthItems = lists.length
            ? (await db.groceryItems.toArray()).filter((i) => ids.has(i.list_id))
            : [];
          const [px, spending, b] = await Promise.all([
            db.prices.toArray(),
            db.spending.toArray().then((all) => all.filter((s) => s.date >= first && s.date <= last)),
            db.budgets.get(mk),
          ]);
          setBudgetLive({
            budget: b?.amount_cents ?? null,
            est: estimateItems(monthItems, px).total_cents,
            spent: computeMonthlyActual(spending).total_cents,
          });
        } catch { /* budget is optional on Home */ }
      })
      .catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (!isConfigured()) {
      setCloudNote('Local-only — connect sync in More → Household.');
      return;
    }
    pendingCount().then((p) => {
      const last = lastSyncAt();
      setCloudNote(
        `Cloud ${online ? 'reachable' : 'unreachable'} · Pending ${p} · Last sync ${last ? new Date(last).toLocaleString() : 'never'}. Details in More → Household.`,
      );
    }).catch(() => {});
    const onSync = () => {
      pendingCount().then((p) => {
        const last = lastSyncAt();
        setCloudNote(`Synced · Pending ${p} · Last sync ${last ? new Date(last).toLocaleString() : 'never'}.`);
      }).catch(() => {});
    };
    window.addEventListener('fm-sync', onSync);
    return () => window.removeEventListener('fm-sync', onSync);
  }, [tab, online]);

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Family Meals</h1>
          <p className="sub">Private household · offline-first</p>
        </div>
        <div className={`net ${online ? 'on' : 'off'}`} role="status" aria-live="polite">
          <span className="dot" /> {online ? 'Online' : 'Offline'}
        </div>
      </header>

      {!standalone && (
        <div className="banner">
          📲 On iPhone: Safari → Share → <b>Add to Home Screen</b> (keep “Open as Web App” ON) to install.
        </div>
      )}

      <main className="content">
        {tab === 'home' && (
          <section aria-label="Dashboard">
            <div className="grid">
              <article className="card"><h2>Today · {prettyDay(todayISO())}</h2>
                {todayMeals.length === 0
                  ? <p className="muted">No meals planned — open Plan to add one.</p>
                  : todayMeals.map((m) => (
                    <p key={m.id}>{m.meal_type}: <b>{m.recipe_id ? (recipeNames.get(m.recipe_id) ?? '…') : (m.title_override ?? 'Meal')}</b> <span className="muted">×{m.servings_planned}{m.is_leftovers ? ' 🥡' : ''}</span></p>
                  ))}
              </article>
              <article className="card"><h2>Groceries</h2><p className="muted">{groceryProgress.bought} of {groceryProgress.total} bought this week.</p></article>
              <article className="card"><h2>Budget</h2><p className="muted">
                {budgetLive.budget == null
                  ? 'No budget set — open More → Budget.'
                  : `Budget $${(budgetLive.budget / 100).toFixed(2)} · Est $${(budgetLive.est / 100).toFixed(2)} · Spent $${(budgetLive.spent / 100).toFixed(2)} · Left $${((budgetLive.budget - budgetLive.spent) / 100).toFixed(2)}`}
              </p></article>
              <article className="card"><h2>Sync</h2><p className="muted">{cloudNote}</p></article>
              <article className="card"><h2>Library</h2><p>{counts.recipes} recipes · {counts.meals} meals · {counts.pantry} pantry items stored on this phone.</p></article>
            </div>
          </section>
        )}
        {tab === 'recipes' && <Recipes />}
        {tab === 'plan' && <Plan />}
        {tab === 'groceries' && <Groceries />}
        {tab === 'more' && <More />}
      </main>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            <span className="ico" aria-hidden>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
