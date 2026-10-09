// Recipe library UI — local-only Phase 4.
// List → Detail (with serving stepper) → Add/Edit form. All data in IndexedDB.
import { useEffect, useMemo, useState } from 'react';
import { fileToDataUrl } from '../lib/images';
import {
  createRecipe, deleteRecipe, draftFromRecipe, emptyDraft, getRecipe,
  listRecipes, toggleFavorite, updateRecipe,
  type RecipeDraft, type RecipeWithChildren,
} from '../lib/recipes';
import { formatAmount, scaleQuantity } from '../lib/scaling';
import type { Recipe } from '../lib/types';

export default function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [search, setSearch] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const refresh = async (sel?: string | null) => {
    const rows = await listRecipes({ search, favoritesOnly: favOnly });
    setRecipes(rows);
    if (sel !== undefined) setSelectedId(sel);
  };

  useEffect(() => {
    refresh().catch(() => setStatus('Could not load recipes from this phone.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, favOnly]);

  const selected = useMemo(() => recipes.find((r) => r.id === selectedId) ?? null, [recipes, selectedId]);

  const startAdd = () => { setEditingId(null); setShowForm(true); };
  const startEdit = () => { if (selectedId) { setEditingId(selectedId); setShowForm(true); } };

  const onDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete “${selected.name}”? This removes it from this phone for everyone sharing it later.`)) return;
    await deleteRecipe(selected.id);
    setStatus(`Deleted “${selected.name}”.`);
    await refresh(null);
  };

  const onToggleFav = async (id: string) => {
    await toggleFavorite(id);
    await refresh(selectedId);
  };

  if (showForm) {
    return (
      <RecipeForm
        editingId={editingId}
        onClose={() => setShowForm(false)}
        onSaved={async (id) => { setShowForm(false); setStatus('Saved.'); await refresh(id); }}
      />
    );
  }

  return (
    <section aria-label="Recipe library">
      <div className="row gap">
        <input
          className="input grow" type="search" placeholder="Search recipes or tags…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search recipes"
        />
        <button className={favOnly ? 'btn primary' : 'btn'} onClick={() => setFavOnly((v) => !v)} aria-pressed={favOnly}>
          ★
        </button>
        <button className="btn primary" onClick={startAdd}>+ Add</button>
      </div>
      {status && <p className="muted pad" role="status">{status}</p>}
      {recipes.length === 0 ? (
        <div className="card"><h2>No recipes yet</h2><p className="muted">Tap + Add to create your first recipe. It stays on this phone and works offline.</p></div>
      ) : (
        <ul className="list">
          {recipes.map((r) => (
            <li key={r.id}>
              <button className={`rowitem ${selectedId === r.id ? 'sel' : ''}`} onClick={() => setSelectedId(r.id)}>
                <span className="rowmain">
                  <b>{r.favorite ? '★ ' : ''}{r.name}</b>
                  <small className="muted">Serves {r.servings_original}{r.tags.length ? ` · ${r.tags.join(', ')}` : ''}</small>
                </span>
                <span aria-hidden>›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <RecipeDetail
          key={selected.id} recipeId={selected.id}
          onEdit={startEdit} onDelete={onDelete} onToggleFav={() => onToggleFav(selected.id)}
        />
      )}
    </section>
  );
}

function RecipeDetail({ recipeId, onEdit, onDelete, onToggleFav }: {
  recipeId: string; onEdit: () => void; onDelete: () => void; onToggleFav: () => void;
}) {
  const [full, setFull] = useState<RecipeWithChildren | null>(null);
  const [viewServings, setViewServings] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getRecipe(recipeId).then((f) => {
      setFull(f);
      setViewServings(f ? f.recipe.servings_original : null);
      if (!f) setError('Recipe not found.');
    }).catch(() => setError('Could not load recipe.'));
  }, [recipeId]);

  if (error) return <div className="card"><p>{error}</p></div>;
  if (!full || viewServings == null) return <div className="card"><p className="muted">Loading…</p></div>;
  const { recipe, ingredients, steps } = full;

  return (
    <article className="card detail">
      {recipe.image_path && <img className="photo" src={recipe.image_path} alt={`Photo of ${recipe.name}`} />}
      <div className="row between">
        <h2>{recipe.favorite ? '★ ' : ''}{recipe.name}</h2>
        <button className="btn" onClick={onToggleFav} aria-label="Toggle favorite">★</button>
      </div>
      {recipe.description && <p>{recipe.description}</p>}
      <div className="stepper" aria-label="Servings viewer">
        <span>Serves {recipe.servings_original} · View as:</span>
        <button className="btn" onClick={() => setViewServings((v) => Math.max(1, (v ?? 1) - 1))} aria-label="Fewer servings">−</button>
        <b>{viewServings}</b>
        <button className="btn" onClick={() => setViewServings((v) => Math.min(99, (v ?? 1) + 1))} aria-label="More servings">+</button>
      </div>
      <h3>Ingredients</h3>
      <ul className="ings">
        {ingredients.map((ing) => {
          const s = scaleQuantity(
            { qty_amount: ing.qty_amount, qty_min: ing.qty_min, qty_max: ing.qty_max, unit_raw: ing.unit_raw, is_scalable: ing.is_scalable },
            recipe.servings_original, viewServings,
          );
          return (
            <li key={ing.id}>
              {s.scaled ? (
                <span><b>{s.display}</b> {ing.name_raw}{ing.preparation ? `, ${ing.preparation}` : ''}</span>
              ) : (
                <span>{ing.name_raw}{ing.preparation ? `, ${ing.preparation}` : ''} <em className="muted">({s.display})</em></span>
              )}
            </li>
          );
        })}
      </ul>
      <h3>Steps</h3>
      <ol className="steps">
        {steps.map((s) => <li key={s.id}>{s.text}</li>)}
      </ol>
      {(recipe.time_prep_min != null || recipe.time_cook_min != null) && (
        <p className="muted">Prep {recipe.time_prep_min ?? '?'} min · Cook {recipe.time_cook_min ?? '?'} min</p>
      )}
      {recipe.tags.length > 0 && <p className="muted">Tags: {recipe.tags.join(', ')}</p>}
      {recipe.source_url && <p><a href={recipe.source_url} target="_blank" rel="noreferrer">Original source ↗</a></p>}
      {recipe.notes && <p className="muted">Notes: {recipe.notes}</p>}
      <div className="row gap">
        <button className="btn primary" onClick={onEdit}>Edit</button>
        <button className="btn danger" onClick={onDelete}>Delete</button>
      </div>
      <p className="muted tiny">Original quantities are kept intact — the stepper only changes the view. Scaled view example: {formatAmount(0.5)} cup at 4 servings → {scaleQuantity({ qty_amount: 0.5, unit_raw: 'cup' }, 4, 6).display} at 6.</p>
    </article>
  );
}

function RecipeForm({ editingId, onClose, onSaved }: {
  editingId: string | null; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState<RecipeDraft>(emptyDraft());
  const [tagsText, setTagsText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    if (editingId) {
      getRecipe(editingId).then((f) => {
        if (f) {
          setDraft(draftFromRecipe(f));
          setTagsText(f.recipe.tags.join(', '));
        }
      }).catch(() => setError('Could not load recipe for editing.'));
    }
  }, [editingId]);

  const set = <K extends keyof RecipeDraft>(k: K, v: RecipeDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const setIng = (i: number, patch: Partial<RecipeDraft['ingredients'][number]>) =>
    setDraft((d) => ({ ...d, ingredients: d.ingredients.map((ing, j) => (j === i ? { ...ing, ...patch } : ing)) }));

  const addIng = () =>
    setDraft((d) => ({ ...d, ingredients: [...d.ingredients, { name_raw: '', qty_amount: null, unit_raw: null, preparation: null }] }));

  const removeIng = (i: number) =>
    setDraft((d) => ({ ...d, ingredients: d.ingredients.filter((_, j) => j !== i) }));

  const setStep = (i: number, text: string) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? text : s)) }));

  const onPhoto = async (f: File | undefined) => {
    if (!f) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await fileToDataUrl(f);
      set('image_path', dataUrl);
    } catch {
      setError('Could not read that photo. Try another image.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      const full: RecipeDraft = { ...draft, tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean) };
      const id = editingId ? (await updateRecipe(editingId, full), editingId) : await createRecipe(full);
      onSaved(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={editingId ? 'Edit recipe' : 'Add recipe'}>
      <div className="row between">
        <h2>{editingId ? 'Edit recipe' : 'New recipe'}</h2>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="card form">
        <label>Name*<input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Weeknight Pasta" /></label>
        <label>Description<textarea className="input" value={draft.description} onChange={(e) => set('description', e.target.value)} rows={2} /></label>
        <div className="row gap">
          <label className="grow">Servings*<input className="input" type="number" min={1} max={99} value={draft.servings_original} onChange={(e) => set('servings_original', Number(e.target.value))} /></label>
          <label>Prep min<input className="input" type="number" min={0} value={draft.time_prep_min ?? ''} onChange={(e) => set('time_prep_min', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label>Cook min<input className="input" type="number" min={0} value={draft.time_cook_min ?? ''} onChange={(e) => set('time_cook_min', e.target.value === '' ? null : Number(e.target.value))} /></label>
        </div>
        <label>Tags (comma separated)<input className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="italian, quick" /></label>
        <label>Source URL<input className="input" type="url" value={draft.source_url ?? ''} onChange={(e) => set('source_url', e.target.value || null)} placeholder="https://…" /></label>
        <label>Photo<input className="input" type="file" accept="image/*" onChange={(e) => onPhoto(e.target.files?.[0])} /></label>
        {photoBusy && <p className="muted">Processing photo…</p>}
        {draft.image_path && <img className="photo" src={draft.image_path} alt="Recipe preview" />}
        {draft.image_path && <button className="btn" onClick={() => set('image_path', null)}>Remove photo</button>}
        <label>Notes<textarea className="input" value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={2} /></label>
        <label className="check"><input type="checkbox" checked={draft.favorite} onChange={(e) => set('favorite', e.target.checked)} /> Favorite</label>

        <h3>Ingredients*</h3>
        {draft.ingredients.map((ing, i) => (
          <div className="ingform" key={i}>
            <input className="input grow" placeholder="Ingredient (e.g. Flour)" value={ing.name_raw} onChange={(e) => setIng(i, { name_raw: e.target.value })} aria-label={`Ingredient ${i + 1} name`} />
            <input className="input qty" placeholder="Qty" type="number" min={0} step="any" value={ing.qty_amount ?? ''} onChange={(e) => setIng(i, { qty_amount: e.target.value === '' ? null : Number(e.target.value) })} aria-label={`Ingredient ${i + 1} quantity`} />
            <input className="input unit" placeholder="Unit" value={ing.unit_raw ?? ''} onChange={(e) => setIng(i, { unit_raw: e.target.value || null })} aria-label={`Ingredient ${i + 1} unit`} />
            <button className="btn" onClick={() => removeIng(i)} aria-label={`Remove ingredient ${i + 1}`}>×</button>
          </div>
        ))}
        <button className="btn" onClick={addIng}>+ Ingredient</button>
        <p className="muted tiny">Leave Qty empty for “to taste” items — the app will never invent a number.</p>

        <h3>Steps*</h3>
        {draft.steps.map((s, i) => (
          <div className="ingform" key={i}>
            <textarea className="input grow" rows={2} placeholder={`Step ${i + 1}`} value={s} onChange={(e) => setStep(i, e.target.value)} aria-label={`Step ${i + 1}`} />
            <button className="btn" onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))} aria-label={`Remove step ${i + 1}`}>×</button>
          </div>
        ))}
        <button className="btn" onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, ''] }))}>+ Step</button>

        <div className="row gap">
          <button className="btn primary big" onClick={save} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save recipe'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </section>
  );
}
