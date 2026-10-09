// Weekly grocery checklist (SPEC section 8).
// One list per Sun–Sat week. Recalculate merges — your checks and custom
// items are never discarded by a plan change.
import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import {
  addBoughtToPantry, addCustomItem, archiveBought, deleteItem, editItem,
  formatQty, getOrCreateList, recalculateWeek, toggleCheck,
} from '../lib/groceries';
import { addDays, prettyDay, startOfWeekSunday } from '../lib/meals';
import type { GroceryItem, GroceryList } from '../lib/types';

export default function Groceries() {
  const [weekStart, setWeekStart] = useState(() => startOfWeekSunday(new Date()));
  const [list, setList] = useState<GroceryList | null>(null);
  const [items, setItems] = useState<GroceryItem[]>([]);
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async (wk: string = weekStart) => {
    const l = await getOrCreateList(wk);
    const rows = await db.groceryItems.where('list_id').equals(l.id).toArray();
    rows.sort((a, b) => Number(a.is_checked) - Number(b.is_checked) || a.display_name.localeCompare(b.display_name));
    setList(l);
    setItems(rows);
  };

  useEffect(() => {
    refresh().catch(() => setStatus('Could not load the grocery list.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const run = async <T,>(fn: () => Promise<T>, done: (r: T) => string) => {
    setBusy(true);
    setStatus('');
    try {
      const r = await fn();
      await refresh();
      setStatus(done(r));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Something failed — nothing was lost.');
    } finally {
      setBusy(false);
    }
  };

  const bought = items.filter((i) => i.is_checked).length;

  return (
    <section aria-label="Grocery lists">
      <div className="row between pad">
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">‹</button>
        <b>Week of {prettyDay(weekStart)}</b>
        <button className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">›</button>
      </div>
      <div className="pad"><button className="btn" onClick={() => setWeekStart(startOfWeekSunday(new Date()))}>This week</button></div>

      <div className="card">
        <div className="progress" role="status" aria-label={`${bought} of ${items.length} bought`}>
          <div className="bar"><span style={{ width: items.length ? `${(bought / items.length) * 100}%` : '0%' }} /></div>
          <p className="muted">{bought} of {items.length} bought</p>
        </div>
        <div className="row gap wrap pad">
          <button
            className="btn primary" disabled={busy}
            onClick={() => run(recalculateWeek.bind(null, weekStart), (r) =>
              `Updated from plan: +${r.added} new, ${r.updated} changed, ${r.removed} removed` +
              (r.coveredByPantry.length ? `. Pantry covers: ${r.coveredByPantry.join(', ')}.` : '.'))}
          >
            {busy ? '…' : '⟳ Recalculate from plan'}
          </button>
          <button className="btn" onClick={() => setShowAdd((v) => !v)}>+ Custom item</button>
        </div>
        {status && <p className="muted" role="status">{status}</p>}
      </div>

      {showAdd && list && (
        <AddItemForm
          onClose={() => setShowAdd(false)}
          onSave={(name, qty, unit, note) => run(() => addCustomItem(list.id, name, qty, unit, note), () => 'Added.')}
        />
      )}

      {items.length === 0 ? (
        <div className="card"><h2>Empty list</h2><p className="muted">Plan some meals, then tap Recalculate — or add a custom item.</p></div>
      ) : (
        <ul className="list">
          {items.map((it) => (
            <li key={it.id} className={`gitem ${it.is_checked ? 'done' : ''}`}>
              {editingId === it.id ? (
                <EditItemForm
                  item={it}
                  onClose={() => setEditingId(null)}
                  onSave={(p) => run(() => editItem(it.id, p), () => { setEditingId(null); return 'Saved — your edit is now protected from recalculation.'; })}
                  onDelete={() => run(() => deleteItem(it.id), () => 'Deleted.')}
                />
              ) : (
                <>
                  <button
                    className="checkbtn" role="checkbox" aria-checked={it.is_checked}
                    aria-label={`Mark ${it.display_name} as ${it.is_checked ? 'not bought' : 'bought'}`}
                    onClick={() => run(() => toggleCheck(it.id), () => '')}
                  >
                    {it.is_checked ? '☑' : '☐'}
                  </button>
                  <button className="grow ItemBtn" onClick={() => setEditingId(it.id)} aria-label={`Edit ${it.display_name}`}>
                    <b>{it.display_name}</b>
                    <small className="muted">
                      {formatQty(it.qty_amount, it.unit_canonical)}
                      {it.is_estimate_uncertain ? ' ⚠ estimate uncertain' : ''}
                      {it.is_custom ? ' · yours' : ` · ${it.source_summary}`}
                      {it.custom_note ? ` · ${it.custom_note}` : ''}
                    </small>
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {list && bought > 0 && (
        <div className="card">
          <div className="row gap wrap">
            <button
              className="btn primary" disabled={busy}
              onClick={() => run(() => addBoughtToPantry(list.id), (r) =>
                `Pantry updated: ${r.added} stocked${r.skipped ? `, ${r.skipped} skipped (no known qty)` : ''}.`)}
            >
              Add bought to pantry
            </button>
            <button
              className="btn" disabled={busy}
              onClick={() => {
                if (!window.confirm(`Archive ${bought} bought item${bought === 1 ? '' : 's'}? They leave the visible list.`)) return;
                run(() => archiveBought(list.id), (n) => `Archived ${n} bought item${n === 1 ? '' : 's'}.`);
              }}
            >
              Archive bought
            </button>
          </div>
          <p className="muted tiny pad">Bought items stay visible until you archive them. “As needed” items are never added to the pantry as a guess.</p>
        </div>
      )}
    </section>
  );
}

function AddItemForm({ onClose, onSave }: {
  onClose: () => void;
  onSave: (name: string, qty: number | null, unit: string | null, note: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="card form">
      <label>Item*<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Olive oil" /></label>
      <div className="row gap">
        <label className="grow">Qty<input className="input" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="grow">Unit<input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="g, ml, pcs…" /></label>
      </div>
      <label>Note<input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="row gap">
        <button className="btn primary big" onClick={() => onSave(name, qty === '' ? null : Number(qty), unit || null, note || null)}>Add</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function EditItemForm({ item, onClose, onSave, onDelete }: {
  item: GroceryItem; onClose: () => void;
  onSave: (p: { display_name: string; qty_amount: number | null; unit_canonical: string | null; custom_note: string | null }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(item.display_name);
  const [qty, setQty] = useState(item.qty_amount == null ? '' : String(item.qty_amount));
  const [unit, setUnit] = useState(item.unit_canonical ?? '');
  const [note, setNote] = useState(item.custom_note ?? '');
  return (
    <div className="card form grow">
      <label>Name*<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="row gap">
        <label className="grow">Qty<input className="input" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="grow">Unit<input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
      </div>
      <label>Note<input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {!item.is_custom && <p className="muted tiny">Saving turns this into “yours” — future recalculations won’t overwrite it.</p>}
      <div className="row gap wrap">
        <button className="btn primary" onClick={() => onSave({ display_name: name, qty_amount: qty === '' ? null : Number(qty), unit_canonical: unit || null, custom_note: note || null })}>Save</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={() => { if (window.confirm(`Delete “${item.display_name}”?`)) onDelete(); }}>Delete</button>
      </div>
    </div>
  );
}
