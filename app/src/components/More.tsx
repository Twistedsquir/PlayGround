// "More" tab: pantry, budget, data safety, household (Phase 9 later).
import { useState } from 'react';
import Budget from './Budget';
import Data from './Data';
import Household, { useAutoSync } from './Household';
import Pantry from './Pantry';

type Section = 'menu' | 'pantry' | 'budget' | 'data' | 'household';

export default function More() {
  const [section, setSection] = useState<Section>('menu');
  useAutoSync(); // sync on open / foreground / reconnect while anywhere in the app

  if (section !== 'menu') {
    const title = section === 'pantry' ? 'Pantry' : section === 'budget' ? 'Budget' : section === 'data' ? 'Data & Backup' : 'Household';
    return (
      <div>
        <button className="btn pad" onClick={() => setSection('menu')} aria-label="Back to More menu">‹ {title}</button>
        {section === 'pantry' && <Pantry />}
        {section === 'budget' && <Budget />}
        {section === 'data' && <Data />}
        {section === 'household' && <Household />}
      </div>
    );
  }

  return (
    <section aria-label="More">
      <div className="grid">
        <button className="card menucard" onClick={() => setSection('pantry')}><h2>🥫 Pantry</h2><p className="muted">Stock, expiry, unit costs.</p></button>
        <button className="card menucard" onClick={() => setSection('budget')}><h2>💰 Budget</h2><p className="muted">Estimates vs actual spending.</p></button>
        <button className="card menucard" onClick={() => setSection('data')}><h2>💾 Data & Backup</h2><p className="muted">Export, restore, storage.</p></button>
        <button className="card menucard" onClick={() => setSection('household')}><h2>👪 Household</h2><p className="muted">Sign-in, invites, sync.</p></button>
      </div>
    </section>
  );
}
