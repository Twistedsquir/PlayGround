// Shared pantry inventory (SPEC section 9). Offline-first.
import { useEffect, useState } from 'react';
import { todayISO } from '../lib/meals';
import {
  adjustPantry, createPantryItem, deletePantryItem, expiryStatus,
  listPantry, updatePantryItem, type PantryDraft,
} from '../lib/pantry';
import { cents } from '../lib/budget';
import type { PantryItem } from '../lib/types';

const empty: PantryDraft = {
  display_name: '', qty_on_hand: null, unit_canonical: null,
  category: null, expires_on: null, unit_cost_cents: null, notes: '',
};

export default function Pantry() {
  const [items, setItems] = useState<PantryItem[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ draft: PantryDraft; id: string | null } | null>(null);
  const [status, setStatus] = useState('');

  const refresh = async () => setItems(await listPantry(search));

  useEffect(() => {
    refresh().catch(() => setStatus('Could not load the pantry.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const today = todayISO();

  return (
    <section aria-label="Pantry">
      <div className="row gap">
        <input className="input grow" type="search" placeholder="Search pantry…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search pantry" />
        <button className="btn primary" onClick={() => setForm({ draft: { ...empty }, id: null })}>+ Add</button>
      </div>
      {status && <p className="muted pad" role="status">{status}</p>}
      {form && (
        <PantryForm
          initial={form}
          onClose={() => setForm(null)}
          onSaved={async () => { setForm(null); setStatus('Saved.'); await refresh(); }}
        />
      )}
      {items.length === 0 ? (
        <div className="card"><h2>Pantry is empty</h2><p className="muted">Add staples here — grocery recalculation subtracts what you already have.</p></div>
      ) : (
        <ul className="list">
          {items.map((p) => {
            const exp = expiryStatus(p.expires_on, today);
            return (
              <li key={p.id} className="card pantryrow">
                <div className="row between">
                  <b>{p.display_name}</b>
                  {exp === 'past' && <span className="pill bad">Expired</span>}
                  {exp === 'soon' && <span className="pill warn">Expires soon</span>}
                </div>
                <p className="muted">
                  {p.qty_on_hand ?? '—'}{p.unit_canonical ? ` ${p.unit_canonical}` : ''}
                  {p.category ? ` · ${p.category}` : ''}
                  {p.expires_on ? ` · exp ${p.expires_on}` : ''}
                  {p.unit_cost_cents != null ? ` · ${cents(p.unit_cost_cents)}/unit` : ''}
                  {p.notes ? ` · ${p.notes}` : ''}
                </p>
                <div className="row gap wrap">
                  <button className="btn" onClick={async () => { await adjustPantry(p.id, -1); await refresh(); }} aria-label={`Use one ${p.display_name}`}>−1</button>
                  <button className="btn" onClick={async () => { await adjustPantry(p.id, 1); await refresh(); }} aria-label={`Add one ${p.display_name}`}>+1</button>
                  <button className="btn" onClick={() => setForm({
                    id: p.id,
                    draft: {
                      display_name: p.display_name, qty_on_hand: p.qty_on_hand,
                      unit_canonical: p.unit_canonical, category: p.category,
                      expires_on: p.expires_on, unit_cost_cents: p.unit_cost_cents, notes: p.notes,
                    },
                  })}>Edit</button>
                  <button className="btn danger" onClick={async () => {
                    if (window.confirm(`Remove “${p.display_name}” from the pantry?`)) {
                      await deletePantryItem(p.id);
                      await refresh();
                    }
                  }}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PantryForm({ initial, onClose, onSaved }: {
  initial: { draft: PantryDraft; id: string | null };
  onClose: () => void; onSaved: () => void;
}) {
  const [d, setD] = useState(initial.draft);
  const [cost, setCost] = useState(d.unit_cost_cents == null ? '' : String(d.unit_cost_cents / 100));
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    const costCents = cost.trim() === '' ? null : Math.round(Number(cost) * 100);
    if (cost.trim() !== '' && (!Number.isFinite(costCents) || (costCents as number) < 0)) {
      setError('Unit cost must be $0.00 or more.');
      return;
    }
    try {
      const payload = { ...d, unit_cost_cents: costCents };
      if (initial.id) await updatePantryItem(initial.id, payload);
      else await createPantryItem(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <div className="card form">
      <div className="row between"><h2>{initial.id ? 'Edit item' : 'New item'}</h2><button className="btn" onClick={onClose}>Cancel</button></div>
      {error && <p className="err" role="alert">{error}</p>}
      <label>Name*<input className="input" value={d.display_name} onChange={(e) => setD({ ...d, display_name: e.target.value })} placeholder="e.g. Rice" /></label>
      <div className="row gap">
        <label className="grow">Qty on hand<input className="input" type="number" min={0} step="any" value={d.qty_on_hand ?? ''} onChange={(e) => setD({ ...d, qty_on_hand: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label className="grow">Unit<input className="input" value={d.unit_canonical ?? ''} onChange={(e) => setD({ ...d, unit_canonical: e.target.value || null })} placeholder="g, ml, pcs" /></label>
      </div>
      <div className="row gap">
        <label className="grow">Category<input className="input" value={d.category ?? ''} onChange={(e) => setD({ ...d, category: e.target.value || null })} placeholder="Grains" /></label>
        <label className="grow">Expires<input className="input" type="date" value={d.expires_on ?? ''} onChange={(e) => setD({ ...d, expires_on: e.target.value || null })} /></label>
      </div>
      <label>Est. unit cost ($)<input className="input" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" /></label>
      <label>Notes<input className="input" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></label>
      <button className="btn primary big" onClick={save}>{initial.id ? 'Save changes' : 'Add to pantry'}</button>
    </div>
  );
}
