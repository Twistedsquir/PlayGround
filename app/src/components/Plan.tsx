// Meal planning calendar — weekly + monthly, Sunday-start (SPEC section 7).
// Local-only in Phase 5. Per-meal servings never touch the original recipe.
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/db';
import {
  MEAL_TYPES, addDays, copyMeal, createMeal, deleteMeal, listMealsForMonth,
  listMealsForWeek, monthGrid, moveMeal, prettyDay, repeatMeal, startOfWeekSunday,
  swapMeals, todayISO, updateMeal, type MealDraft,
} from '../lib/meals';
import type { MealType, PlannedMeal, Recipe } from '../lib/types';

export default function Plan() {
  const [view, setView] = useState<'week' | 'month'>('week');
  const [weekStart, setWeekStart] = useState(() => startOfWeekSunday(new Date()));
  const [monthCursor, setMonthCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [meals, setMeals] = useState<PlannedMeal[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [formFor, setFormFor] = useState<{ date: string; meal_type: MealType; meal?: PlannedMeal } | null>(null);
  const [moveFor, setMoveFor] = useState<PlannedMeal | null>(null);
  const [repeatFor, setRepeatFor] = useState<PlannedMeal | null>(null);
  const [swapFrom, setSwapFrom] = useState<PlannedMeal | null>(null);
  const [openMealId, setOpenMealId] = useState<string | null>(null);
  const [monthDay, setMonthDay] = useState<string>(todayISO());
  const [status, setStatus] = useState('');

  const recipeName = useMemo(() => {
    const map = new Map(recipes.map((r) => [r.id, r.name]));
    return (m: PlannedMeal) =>
      m.recipe_id ? (map.get(m.recipe_id) ?? '(deleted recipe)') : (m.title_override ?? 'Meal');
  }, [recipes]);

  const refresh = async () => {
    const [w, r] = await Promise.all([
      view === 'week' ? listMealsForWeek(weekStart) : listMealsForMonth(monthCursor.y, monthCursor.m),
      db.recipes.toArray(),
    ]);
    setMeals(w);
    setRecipes(r);
  };

  useEffect(() => {
    refresh().catch(() => setStatus('Could not load the plan from this phone.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, weekStart, monthCursor]);

  const byDaySlot = useMemo(() => {
    const map = new Map<string, PlannedMeal[]>();
    for (const m of meals) {
      const k = `${m.date}|${m.meal_type}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return map;
  }, [meals]);

  const doDelete = async (m: PlannedMeal) => {
    if (!window.confirm(`Remove “${recipeName(m)}” on ${prettyDay(m.date)}?`)) return;
    await deleteMeal(m.id);
    setOpenMealId(null);
    await refresh();
  };

  const doSwapTap = async (m: PlannedMeal) => {
    if (!swapFrom) {
      setSwapFrom(m);
      setStatus(`Swap: tap another meal to swap with “${recipeName(m)}”.`);
      return;
    }
    if (swapFrom.id === m.id) {
      setSwapFrom(null);
      setStatus('');
      return;
    }
    await swapMeals(swapFrom.id, m.id);
    setSwapFrom(null);
    setOpenMealId(null);
    setStatus('Swapped.');
    await refresh();
  };

  return (
    <section aria-label="Meal plan">
      <div className="row gap">
        <button className={view === 'week' ? 'btn primary' : 'btn'} onClick={() => setView('week')}>Week</button>
        <button className={view === 'month' ? 'btn primary' : 'btn'} onClick={() => setView('month')}>Month</button>
        {swapFrom && <button className="btn" onClick={() => { setSwapFrom(null); setStatus(''); }}>Cancel swap</button>}
      </div>
      {status && <p className="muted pad" role="status">{status}</p>}

      {view === 'week' ? (
        <WeekView
          weekStart={weekStart} setWeekStart={setWeekStart}
          byDaySlot={byDaySlot} recipeName={recipeName}
          openMealId={openMealId} setOpenMealId={setOpenMealId}
          onAdd={(date, meal_type) => setFormFor({ date, meal_type })}
          onEdit={(meal) => setFormFor({ date: meal.date, meal_type: meal.meal_type, meal })}
          onDelete={doDelete} onMove={setMoveFor} onRepeat={setRepeatFor}
          onSwap={doSwapTap} swapFromId={swapFrom?.id ?? null}
          onToggleLeftovers={async (m) => { await updateMeal(m.id, { is_leftovers: !m.is_leftovers }); await refresh(); }}
        />
      ) : (
        <MonthView
          cursor={monthCursor} setCursor={setMonthCursor}
          meals={meals} recipeName={recipeName} monthDay={monthDay} setMonthDay={setMonthDay}
          onAdd={(date, meal_type) => setFormFor({ date, meal_type })}
        />
      )}

      {formFor && (
        <MealForm
          initial={formFor} recipes={recipes}
          onClose={() => setFormFor(null)}
          onSaved={async () => { setFormFor(null); setStatus('Saved.'); await refresh(); }}
        />
      )}
      {moveFor && (
        <MoveCopyDialog
          title="Move meal" meal={moveFor} recipeName={recipeName}
          onClose={() => setMoveFor(null)}
          onSave={async (date, slot) => {
            const sameSpot = date === moveFor.date && slot === moveFor.meal_type;
            if (!sameSpot) await moveMeal(moveFor.id, date, slot);
            setMoveFor(null);
            await refresh();
          }}
          onCopy={async (date, slot) => {
            await copyMeal(moveFor.id, date, slot);
            setMoveFor(null);
            setStatus('Copied.');
            await refresh();
          }}
        />
      )}
      {repeatFor && (
        <RepeatDialog
          meal={repeatFor} recipeName={recipeName} weekStart={weekStart}
          onClose={() => setRepeatFor(null)}
          onSave={async (targets) => {
            await repeatMeal(repeatFor.id, targets);
            setRepeatFor(null);
            setStatus('Repeated.');
            await refresh();
          }}
        />
      )}
    </section>
  );
}

/* ---------- Week view ---------- */

function WeekView(props: {
  weekStart: string; setWeekStart: (s: string) => void;
  byDaySlot: Map<string, PlannedMeal[]>; recipeName: (m: PlannedMeal) => string;
  openMealId: string | null; setOpenMealId: (id: string | null) => void;
  onAdd: (date: string, slot: MealType) => void;
  onEdit: (m: PlannedMeal) => void; onDelete: (m: PlannedMeal) => void;
  onMove: (m: PlannedMeal) => void; onRepeat: (m: PlannedMeal) => void;
  onSwap: (m: PlannedMeal) => void; swapFromId: string | null;
  onToggleLeftovers: (m: PlannedMeal) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.weekStart, i));
  const today = todayISO();
  return (
    <div>
      <div className="row between pad">
        <button className="btn" onClick={() => props.setWeekStart(addDays(props.weekStart, -7))} aria-label="Previous week">‹</button>
        <b>Week of {prettyDay(props.weekStart)}</b>
        <button className="btn" onClick={() => props.setWeekStart(addDays(props.weekStart, 7))} aria-label="Next week">›</button>
      </div>
      <div className="pad"><button className="btn" onClick={() => props.setWeekStart(startOfWeekSunday(new Date()))}>Today</button></div>
      {days.map((date) => (
        <article className="card day" key={date}>
          <h3>{prettyDay(date)} {date === today && <span className="pill">Today</span>}</h3>
          {MEAL_TYPES.map((slot) => {
            const items = props.byDaySlot.get(`${date}|${slot.id}`) ?? [];
            return (
              <div className="slot" key={slot.id}>
                <span className="slotlabel">{slot.label}</span>
                <div className="slotitems">
                  {items.map((m) => (
                    <div key={m.id}>
                      <button
                        className={`meal ${props.swapFromId === m.id ? 'swapping' : ''}`}
                        onClick={() => {
                          if (props.swapFromId) props.onSwap(m);
                          else props.setOpenMealId(props.openMealId === m.id ? null : m.id);
                        }}
                        aria-label={`${props.recipeName(m)}, ${m.servings_planned} servings`}
                      >
                        {m.is_leftovers && <span aria-hidden>🥡 </span>}{props.recipeName(m)}
                        <small className="muted"> ×{m.servings_planned}{m.notes ? ' 📝' : ''}</small>
                      </button>
                      {props.openMealId === m.id && !props.swapFromId && (
                        <div className="actions">
                          <button className="btn" onClick={() => props.onEdit(m)}>Edit</button>
                          <button className="btn" onClick={() => props.onMove(m)}>Move/Copy</button>
                          <button className="btn" onClick={() => props.onRepeat(m)}>Repeat</button>
                          <button className="btn" onClick={() => props.onSwap(m)}>Swap</button>
                          <button className="btn" onClick={() => props.onToggleLeftovers(m)}>{m.is_leftovers ? 'Unmark 🥡' : 'Leftover 🥡'}</button>
                          <button className="btn danger" onClick={() => props.onDelete(m)}>Remove</button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button className="addslot" onClick={() => props.onAdd(date, slot.id)} aria-label={`Add ${slot.label} on ${prettyDay(date)}`}>
                    + Add {slot.label}
                  </button>
                </div>
              </div>
            );
          })}
        </article>
      ))}
    </div>
  );
}

/* ---------- Month view ---------- */

function MonthView(props: {
  cursor: { y: number; m: number }; setCursor: (c: { y: number; m: number }) => void;
  meals: PlannedMeal[]; recipeName: (m: PlannedMeal) => string;
  monthDay: string; setMonthDay: (d: string) => void;
  onAdd: (date: string, slot: MealType) => void;
}) {
  const { y, m } = props.cursor;
  const cells = monthGrid(y, m);
  const countByDay = new Map<string, number>();
  for (const meal of props.meals) countByDay.set(meal.date, (countByDay.get(meal.date) ?? 0) + 1);
  const dayMeals = props.meals.filter((x) => x.date === props.monthDay);
  const title = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shift = (n: number) => {
    const d = new Date(y, m + n, 1);
    props.setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  return (
    <div>
      <div className="row between pad">
        <button className="btn" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <b>{title}</b>
        <button className="btn" onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="mgrid" role="grid" aria-label="Monthly calendar, weeks start Sunday">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="mhead">{d}</span>)}
        {cells.map((c) => {
          const n = countByDay.get(c.date) ?? 0;
          return (
            <button
              key={c.date}
              className={`mcell ${c.inMonth ? '' : 'out'} ${c.date === props.monthDay ? 'sel' : ''}`}
              onClick={() => props.setMonthDay(c.date)}
              aria-label={`${c.date}, ${n} meals`}
            >
              <span>{Number(c.date.slice(8))}</span>
              {n > 0 && <span className="mdots">{n <= 3 ? '●'.repeat(n) : `●×${n}`}</span>}
            </button>
          );
        })}
      </div>
      <article className="card day">
        <h3>{prettyDay(props.monthDay)}</h3>
        {dayMeals.length === 0 && <p className="muted">Nothing planned.</p>}
        {dayMeals.map((x) => (
          <p key={x.id}>{x.meal_type}: <b>{props.recipeName(x)}</b> <span className="muted">×{x.servings_planned}{x.is_leftovers ? ' 🥡' : ''}</span></p>
        ))}
        <div className="row gap wrap">
          {MEAL_TYPES.map((s) => (
            <button key={s.id} className="btn" onClick={() => props.onAdd(props.monthDay, s.id)}>+ {s.label}</button>
          ))}
        </div>
      </article>
    </div>
  );
}

/* ---------- Meal form ---------- */

function MealForm({ initial, recipes, onClose, onSaved }: {
  initial: { date: string; meal_type: MealType; meal?: PlannedMeal };
  recipes: Recipe[];
  onClose: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<MealDraft>(() => ({
    date: initial.meal?.date ?? initial.date,
    meal_type: initial.meal?.meal_type ?? initial.meal_type,
    recipe_id: initial.meal?.recipe_id ?? (recipes[0]?.id ?? null),
    title_override: initial.meal?.title_override ?? null,
    servings_planned: initial.meal?.servings_planned ?? (recipes[0]?.servings_original ?? 2),
    is_leftovers: initial.meal?.is_leftovers ?? false,
    notes: initial.meal?.notes ?? '',
  }));
  const [useCustom, setUseCustom] = useState(() => !initial.meal?.recipe_id && !!initial.meal?.title_override);
  const [error, setError] = useState('');

  const pickRecipe = (id: string) => {
    const r = recipes.find((x) => x.id === id);
    setDraft((d) => ({ ...d, recipe_id: id, servings_planned: r ? r.servings_original : d.servings_planned }));
  };

  const save = async () => {
    setError('');
    try {
      const payload: MealDraft = useCustom
        ? { ...draft, recipe_id: null }
        : { ...draft, title_override: null };
      if (initial.meal) await updateMeal(initial.meal.id, payload);
      else await createMeal(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <div className="sheet" role="dialog" aria-label={initial.meal ? 'Edit meal' : 'Plan meal'}>
      <div className="sheetbox">
        <div className="row between">
          <h2>{initial.meal ? 'Edit meal' : 'Plan meal'}</h2>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <label>Date<input className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
        <label>Meal slot
          <select className="input" value={draft.meal_type} onChange={(e) => setDraft({ ...draft, meal_type: e.target.value as MealType })}>
            {MEAL_TYPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} /> Custom name (no recipe)</label>
        {useCustom ? (
          <label>Meal name<input className="input" value={draft.title_override ?? ''} onChange={(e) => setDraft({ ...draft, title_override: e.target.value })} placeholder="e.g. Takeout, Leftovers" /></label>
        ) : (
          <label>Recipe
            <select className="input" value={draft.recipe_id ?? ''} onChange={(e) => pickRecipe(e.target.value)}>
              {recipes.length === 0 && <option value="">No recipes yet — use a custom name</option>}
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name} (serves {r.servings_original})</option>)}
            </select>
          </label>
        )}
        <label>Servings for this meal (does not change the recipe)
          <span className="stepper">
            <button className="btn" onClick={() => setDraft({ ...draft, servings_planned: Math.max(1, draft.servings_planned - 1) })} aria-label="Fewer servings">−</button>
            <b>{draft.servings_planned}</b>
            <button className="btn" onClick={() => setDraft({ ...draft, servings_planned: Math.min(99, draft.servings_planned + 1) })} aria-label="More servings">+</button>
          </span>
        </label>
        <label className="check"><input type="checkbox" checked={draft.is_leftovers} onChange={(e) => setDraft({ ...draft, is_leftovers: e.target.checked })} /> Leftovers 🥡</label>
        <label>Notes<textarea className="input" rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Prep reminders…" /></label>
        <div className="row gap">
          <button className="btn primary big" onClick={save}>{initial.meal ? 'Save changes' : 'Add meal'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Move / Repeat dialogs ---------- */

function MoveCopyDialog({ title, meal, recipeName, onClose, onSave, onCopy }: {
  title: string; meal: PlannedMeal; recipeName: (m: PlannedMeal) => string;
  onClose: () => void;
  onSave: (date: string, slot: MealType) => void;
  onCopy: (date: string, slot: MealType) => void;
}) {
  const [date, setDate] = useState(meal.date);
  const [slot, setSlot] = useState<MealType>(meal.meal_type);
  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheetbox">
        <div className="row between"><h2>{title}</h2><button className="btn" onClick={onClose}>Cancel</button></div>
        <p className="muted">“{recipeName(meal)}” ×{meal.servings_planned}</p>
        <label>Date<input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Slot
          <select className="input" value={slot} onChange={(e) => setSlot(e.target.value as MealType)}>
            {MEAL_TYPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <div className="row gap">
          <button className="btn primary big" onClick={() => onSave(date, slot)}>Move here</button>
          <button className="btn big" onClick={() => onCopy(date, slot)}>Copy here</button>
        </div>
      </div>
    </div>
  );
}

function RepeatDialog({ meal, recipeName, weekStart, onClose, onSave }: {
  meal: PlannedMeal; recipeName: (m: PlannedMeal) => string; weekStart: string;
  onClose: () => void; onSave: (t: { date: string; meal_type: MealType }[]) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (date: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(date)) n.delete(date);
      else n.add(date);
      return n;
    });
  return (
    <div className="sheet" role="dialog" aria-label="Repeat meal">
      <div className="sheetbox">
        <div className="row between"><h2>Repeat</h2><button className="btn" onClick={onClose}>Cancel</button></div>
        <p className="muted">“{recipeName(meal)}” as {meal.meal_type} on:</p>
        {days.filter((d) => d !== meal.date).map((d) => (
          <label className="check" key={d}><input type="checkbox" checked={picked.has(d)} onChange={() => toggle(d)} /> {prettyDay(d)}</label>
        ))}
        <button className="btn primary big" onClick={() => onSave([...picked].map((date) => ({ date, meal_type: meal.meal_type })))}>
          Repeat on {picked.size} day{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
