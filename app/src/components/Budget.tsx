// Monthly grocery budget: estimates vs actuals (SPEC section 10).
// Estimates come from your price guesses; actuals only from trips you record.
// A checked grocery item is NEVER assumed to have a price.
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/db';
import {
  addSpending, cents, computeMonthlyActual, dollarsToCents, deleteSpending,
  estimateItems, monthKey, setBudget, setPrice, spendingByWeek,
  todayISO, weeksOfMonth,
} from '../lib/budget';
import { addDays } from '../lib/meals';
import type { GroceryItem, PriceEstimate, SpendingRecord } from '../lib/types';

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function Budget() {
  const [month, setMonth] = useState(() => monthKey());
  const [budgetCents, setBudgetCents] = useState<number | null>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [items, setItems] = useState<GroceryItem[]>([]);
  const [prices, setPrices] = useState<PriceEstimate[]>([]);
  const [records, setRecords] = useState<SpendingRecord[]>([]);
  const [status, setStatus] = useState('');
  const [showTrip, setShowTrip] = useState(false);

  const refresh = async (mk: string = month) => {
    const [y, m] = mk.split('-').map(Number);
    const first = `${mk}-01`;
    const last = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const lists = (await db.groceryLists.toArray()).filter((l) => {
      const end = addDays(l.week_start_sun, 6);
      return l.week_start_sun <= last && end >= first;
    });
    const listIds = new Set(lists.map((l) => l.id));
    const allItems = lists.length
      ? (await db.groceryItems.toArray()).filter((i) => listIds.has(i.list_id))
      : [];
    const [px, spending, b] = await Promise.all([
      db.prices.toArray(),
      db.spending.toArray(),
      db.budgets.get(mk),
    ]);
    setItems(allItems);
    setPrices(px);
    setRecords(spending.filter((s) => s.date >= first && s.date <= last).sort((a, b2) => b2.date.localeCompare(a.date)));
    setBudgetCents(b?.amount_cents ?? null);
    setBudgetInput(b ? String(b.amount_cents / 100) : '');
  };

  useEffect(() => {
    refresh().catch(() => setStatus('Could not load budget data.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const est = useMemo(() => estimateItems(items, prices), [items, prices]);
  const actual = useMemo(() => computeMonthlyActual(records), [records]);
  const remaining = budgetCents == null ? null : budgetCents - actual.total_cents;
  const weeks = useMemo(() => spendingByWeek(records, weeksOfMonth(month)), [records, month]);
  const maxWeek = Math.max(1, ...weeks.map((w) => w.total_cents));
  const maxBar = Math.max(est.total_cents, actual.total_cents, 1);

  // Distinct ingredients needing prices (from this month's lists).
  const priceRows = useMemo(() => {
    const seen = new Map<string, { name: string; unit: string | null }>();
    for (const i of items) {
      if (i.qty_amount == null) continue;
      const k = `${i.name_canonical}|${i.unit_canonical ?? '∅'}`;
      if (!seen.has(k)) seen.set(k, { name: i.name_canonical, unit: i.unit_canonical });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const saveBudget = async () => {
    const c = dollarsToCents(budgetInput);
    if (c == null) {
      setStatus('Enter a budget like 400 or 400.00.');
      return;
    }
    await setBudget(month, c);
    setStatus('Budget saved.');
    await refresh();
  };

  const title = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <section aria-label="Budget">
      <div className="row between pad">
        <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
        <b>{title}</b>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
      </div>
      {status && <p className="muted pad" role="status">{status}</p>}

      <div className="grid">
        <article className="card">
          <h2>Monthly budget</h2>
          <div className="row gap">
            <input className="input grow" type="number" min={0} step="0.01" value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} placeholder="e.g. 400" aria-label="Monthly budget in dollars" />
            <button className="btn primary" onClick={saveBudget}>Set</button>
          </div>
          <p className="big">{budgetCents == null ? 'No budget set' : cents(budgetCents)}</p>
        </article>
        <article className="card">
          <h2>Estimated vs actual</h2>
          <div className="bars">
            <div className="brow"><span>Est.</span><div className="track"><span className="fill est" style={{ width: `${(est.total_cents / maxBar) * 100}%` }} /></div><b>{cents(est.total_cents)}</b></div>
            <div className="brow"><span>Spent</span><div className="track"><span className="fill spent" style={{ width: `${(actual.total_cents / maxBar) * 100}%` }} /></div><b>{cents(actual.total_cents)}</b></div>
          </div>
          <p className="muted tiny">Estimate covers {est.priced} items · {est.unpriced} without a price or qty (not guessed).</p>
        </article>
        <article className="card">
          <h2>Remaining</h2>
          <p className={`big ${remaining != null && remaining < 0 ? 'neg' : ''}`}>
            {remaining == null ? 'Set a budget to see this' : cents(remaining)}
          </p>
          <p className="muted tiny">Budget − actual spending. Estimates never count as spending.</p>
        </article>
        <article className="card">
          <h2>Spending by week</h2>
          {weeks.every((w) => w.total_cents === 0) ? (
            <p className="muted">No spending recorded this month yet.</p>
          ) : (
            <div className="bars">
              {weeks.map((w) => (
                <div className="brow" key={w.week}>
                  <span>{w.week.slice(5)}</span>
                  <div className="track"><span className="fill spent" style={{ width: `${(w.total_cents / maxWeek) * 100}%` }} /></div>
                  <b>{cents(w.total_cents)}</b>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      <article className="card">
        <div className="row between">
          <h2>Actual spending</h2>
          <button className="btn primary" onClick={() => setShowTrip((v) => !v)}>+ Record trip</button>
        </div>
        <p className="muted tiny">Record the receipt total per trip. Item prices are optional extras — items on a list with a trip total are excluded from the sum (no double-count).</p>
        {showTrip && (
          <TripForm
            onClose={() => setShowTrip(false)}
            onSaved={async () => { setShowTrip(false); setStatus('Trip recorded.'); await refresh(); }}
          />
        )}
        {records.length === 0 ? (
          <p className="muted">Nothing recorded this month.</p>
        ) : (
          <ul className="slist">
            {records.map((r) => (
              <li key={r.id} className="row between">
                <span>
                  <b>{cents(r.amount_cents)}</b> <span className="muted">{r.kind === 'trip_total' ? 'trip' : 'item'} · {r.date}{r.store ? ` · ${r.store}` : ''}{r.memo ? ` · ${r.memo}` : ''}</span>
                </span>
                <button className="btn danger sm" onClick={async () => {
                  if (window.confirm(`Delete this ${cents(r.amount_cents)} record?`)) {
                    await deleteSpending(r.id);
                    await refresh();
                  }
                }}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="card">
        <h2>Price estimates</h2>
        <p className="muted tiny">Editable guesses per ingredient+unit. Used only for estimates — never added to actual spending.</p>
        {priceRows.length === 0 ? (
          <p className="muted">No grocery items this month. Plan meals and recalculate a list first.</p>
        ) : (
          <ul className="slist">
            {priceRows.map((row) => (
              <PriceRow key={`${row.name}|${row.unit}`} name={row.name} unit={row.unit} prices={prices}
                onSaved={async () => { await refresh(); }} />
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}

function TripForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [store, setStore] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    const c = dollarsToCents(amount);
    if (c == null || c <= 0) {
      setError('Enter an amount above $0.00.');
      return;
    }
    try {
      await addSpending({ date, store: store || null, amount_cents: c, kind: 'trip_total', grocery_list_id: null, memo: memo || null });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <div className="card form">
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row gap">
        <label className="grow">Date<input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="grow">Total ($)<input className="input" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="82.40" /></label>
      </div>
      <div className="row gap">
        <label className="grow">Store (optional)<input className="input" value={store} onChange={(e) => setStore(e.target.value)} placeholder="Trader Joe's" /></label>
        <label className="grow">Memo (optional)<input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
      <div className="row gap">
        <button className="btn primary big" onClick={save}>Record trip</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function PriceRow({ name, unit, prices, onSaved }: {
  name: string; unit: string | null; prices: PriceEstimate[]; onSaved: () => void;
}) {
  const existing = prices.find((p) => p.name_canonical === name && (p.unit_canonical ?? null) === (unit ?? null));
  const [val, setVal] = useState(existing ? String(existing.price_cents_per_unit / 100) : '');
  const [msg, setMsg] = useState('');

  const save = async () => {
    const c = dollarsToCents(val);
    if (c == null) {
      setMsg('Enter a price like 2.00.');
      return;
    }
    await setPrice(name, unit, c);
    setMsg('Saved.');
    await onSaved();
  };

  return (
    <li className="row gap">
      <span className="grow">{name}{unit ? ` / ${unit}` : ''} <span className="muted">{existing ? `· ${cents(existing.price_cents_per_unit)}` : '· no price'}</span></span>
      <input className="input price" type="number" min={0} step="0.01" value={val} onChange={(e) => { setVal(e.target.value); setMsg(''); }} aria-label={`Price per ${unit ?? 'unit'} for ${name}`} placeholder="$" />
      <button className="btn sm" onClick={save}>Save</button>
      {msg && <small className="muted">{msg}</small>}
    </li>
  );
}
