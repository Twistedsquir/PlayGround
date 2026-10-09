// Data safety screen: backup, restore, spreadsheet export, storage, erase.
// Plain rule shown in-app: JSON restores everything; CSV is for spreadsheets.
import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import {
  buildBackup, downloadFile, eraseAllLocal, importBackup, planCsv,
  recipesCsv, spendingCsv, validateBackup,
} from '../lib/export';

export default function Data() {
  const [status, setStatus] = useState('');
  const [storage, setStorage] = useState('unknown');
  const [eraseArm, setEraseArm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      const mb = (b?: number) => (b == null ? '?' : `${(b / 1048576).toFixed(1)} MB`);
      setStorage(`${mb(e.usage)} used of ${mb(e.quota)}`);
    }).catch(() => {});
  }, []);

  const stamp = () => new Date().toISOString().slice(0, 10);

  const doJsonExport = async () => {
    setBusy(true);
    try {
      const b = await buildBackup();
      downloadFile(`family-meals-${stamp()}.json`, JSON.stringify(b, null, 1), 'application/json');
      setStatus('Backup downloaded — save it to iCloud Drive or Files.');
    } catch {
      setStatus('Export failed — nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setStatus('');
    try {
      const parsed: unknown = JSON.parse(await f.text());
      const v = validateBackup(parsed);
      if (!v.ok) {
        setStatus(`Not imported: ${v.error}`);
        return;
      }
      const r = await importBackup(v.data);
      const added = Object.values(r.added).reduce((a, b) => a + b, 0);
      const skipped = Object.values(r.skipped).reduce((a, b) => a + b, 0);
      setStatus(`Restored: ${added} new records added, ${skipped} already here (kept). Nothing was deleted.`);
    } catch {
      setStatus('Could not read that file — is it a Family Meals JSON backup?');
    } finally {
      setBusy(false);
    }
  };

  const doSpendingCsv = async () => {
    const rows = await db.spending.toArray();
    rows.sort((a, b) => a.date.localeCompare(b.date));
    downloadFile(`spending-${stamp()}.csv`, spendingCsv(rows), 'text/csv');
    setStatus(`Exported ${rows.length} spending records to CSV.`);
  };

  const doRecipesCsv = async () => {
    const recipes = await db.recipes.toArray();
    const rows = await Promise.all(recipes.map(async (r) => ({
      name: r.name,
      servings_original: r.servings_original,
      tags: r.tags,
      ingredients: await db.recipeIngredients.where('recipe_id').equals(r.id).sortBy('position'),
      steps: await db.recipeSteps.where('recipe_id').equals(r.id).sortBy('position'),
      source_url: r.source_url,
    })));
    downloadFile(`recipes-${stamp()}.csv`, recipesCsv(rows), 'text/csv');
    setStatus(`Exported ${rows.length} recipes to CSV (photos stay in the JSON backup).`);
  };

  const doPlanCsv = async () => {
    const meals = await db.plannedMeals.toArray();
    meals.sort((a, b) => a.date.localeCompare(b.date));
    const names = new Map((await db.recipes.toArray()).map((r) => [r.id, r.name]));
    downloadFile(`meal-plan-${stamp()}.csv`, planCsv(meals.map((m) => ({
      date: m.date, meal_type: m.meal_type,
      title: m.recipe_id ? (names.get(m.recipe_id) ?? '(deleted recipe)') : (m.title_override ?? ''),
      servings: m.servings_planned, leftovers: m.is_leftovers, notes: m.notes,
    }))), 'text/csv');
    setStatus(`Exported ${meals.length} planned meals to CSV.`);
  };

  const doErase = async () => {
    if (eraseArm !== 'ERASE') {
      setStatus('Type ERASE in the box to confirm — this wipes this phone only.');
      return;
    }
    await eraseAllLocal();
    setEraseArm('');
    setStatus('All local data erased. Restore from a JSON backup to get it back.');
  };

  return (
    <section aria-label="Data and backup">
      <article className="card">
        <h2>Backup (JSON)</h2>
        <p className="muted tiny">Full-fidelity: recipes with photos, plans, lists, pantry, budget, prices. Restores everything.</p>
        <div className="row gap wrap pad">
          <button className="btn primary" disabled={busy} onClick={doJsonExport}>⬇ Export backup</button>
          <label className="btn">⬆ Import backup<input type="file" accept="application/json,.json" hidden onChange={(e) => doImport(e.target.files?.[0])} /></label>
        </div>
      </article>

      <article className="card">
        <h2>Spreadsheet export (CSV)</h2>
        <p className="muted tiny">For viewing in Numbers/Excel. CSV cannot restore photos or links — keep a JSON backup too.</p>
        <div className="row gap wrap pad">
          <button className="btn" onClick={doRecipesCsv}>Recipes CSV</button>
          <button className="btn" onClick={doPlanCsv}>Meal plan CSV</button>
          <button className="btn" onClick={doSpendingCsv}>Spending CSV</button>
        </div>
      </article>

      <article className="card">
        <h2>Storage on this phone</h2>
        <p className="muted">{storage}</p>
        <p className="muted tiny">Browser storage is best-effort. A monthly JSON export is your safety net until cloud sync (Phase 9/10).</p>
      </article>

      <article className="card danger-zone">
        <h2>Erase this phone</h2>
        <p className="muted tiny">Wipes all local data on this phone only. Export a JSON backup first.</p>
        <div className="row gap">
          <input className="input grow" value={eraseArm} onChange={(e) => setEraseArm(e.target.value)} placeholder='Type ERASE to confirm' aria-label="Type ERASE to confirm erasure" />
          <button className="btn danger" onClick={doErase}>Erase</button>
        </div>
      </article>

      {status && <p className="muted pad" role="status">{status}</p>}
    </section>
  );
}
