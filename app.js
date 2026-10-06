/* Mileage & Gas Tracker — localStorage powered, Excel-friendly export. No dependencies. */
(function () {
  'use strict';

  var LS_TRIPS = 'mgt.trips.v1';
  var LS_SETTINGS = 'mgt.settings.v1';

  var state = {
    trips: loadTrips(),
    settings: loadSettings(),
    editingId: null,
  };

  // ---------- elements ----------
  function $(id) { return document.getElementById(id); }
  var form = $('tripForm'), formTitle = $('formTitle'), formError = $('formError');
  var fDate = $('fDate'), fPurpose = $('fPurpose'), fFrom = $('fFrom'), fTo = $('fTo'),
      fTitle = $('fTitle'), fMiles = $('fMiles'), fGallons = $('fGallons'),
      fPrice = $('fPrice'), fTotal = $('fTotal'), fOdo = $('fOdo'),
      fRoundTrip = $('fRoundTrip'), liveCalc = $('liveCalc');
  var submitBtn = $('submitBtn'), cancelEditBtn = $('cancelEditBtn');
  var tripBody = $('tripBody'), emptyState = $('emptyState'), rowCount = $('rowCount');
  var search = $('search'), filterPurpose = $('filterPurpose'), sortBy = $('sortBy');
  var unitSelect = $('unitSelect'), dPrice = $('dPrice'), dMpg = $('dMpg');
  var toast = $('toast');

  // ---------- init ----------
  fDate.value = todayISO();
  unitSelect.value = state.settings.unit || 'mi';
  dPrice.value = state.settings.defaultPrice || '';
  dMpg.value = state.settings.defaultMpg || '';
  if (state.settings.defaultPrice) fPrice.value = state.settings.defaultPrice;
  updateUnitLabels();
  bindEvents();
  render();

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ---------- storage ----------
  function loadTrips() {
    try {
      var raw = localStorage.getItem(LS_TRIPS);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS_SETTINGS);
      return raw ? JSON.parse(raw) : { unit: 'mi', defaultPrice: '', defaultMpg: '' };
    } catch (e) { return { unit: 'mi' }; }
  }
  function save() {
    localStorage.setItem(LS_TRIPS, JSON.stringify(state.trips));
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
  }

  // ---------- helpers ----------
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (!isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }
  function showError(msg) {
    if (!msg) { formError.hidden = true; formError.textContent = ''; return; }
    formError.hidden = false; formError.textContent = msg;
  }
  function unitLabel() { return state.settings.unit === 'km' ? 'km' : 'mi'; }
  function updateUnitLabels() {
    var labels = document.querySelectorAll('.unitLabel');
    for (var i = 0; i < labels.length; i++) labels[i].textContent = unitLabel();
  }

  /** Derive a complete trip record from raw form values. */
  function derive(t) {
    var miles = num(t.miles) * (t.roundTrip ? 2 : 1);
    var gallons = num(t.gallons);
    var price = num(t.price);
    var total = num(t.total);
    // If user gave total + price but no gallons -> gallons = total / price
    if (!gallons && total && price) gallons = total / price;
    // Estimate gallons from vehicle MPG when only distance known
    var mpgSetting = num(state.settings.defaultMpg);
    if (!gallons && miles && mpgSetting > 0 && !total) {
      gallons = miles / mpgSetting;
    }
    // Cost = gallons*price, fallback to explicit total
    var cost = gallons && price ? gallons * price : total;
    // If cost known + gallons known but price missing -> price = cost/gallons
    if (!price && cost && gallons) price = cost / gallons;
    var mpg = miles && gallons ? miles / gallons : 0;
    return {
      miles: round2(miles), gallons: round3(gallons),
      price: round2(price), cost: round2(cost), mpg: round1(mpg),
    };
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round1(n) { return Math.round(n * 10) / 10; }

  // ---------- events ----------
  function bindEvents() {
    form.addEventListener('submit', onSubmit);
    $('resetBtn').addEventListener('click', resetForm);
    cancelEditBtn.addEventListener('click', resetForm);
    $('clearAllBtn').addEventListener('click', onClearAll);
    $('exportCsvBtn').addEventListener('click', exportCSV);
    $('exportXlsBtn').addEventListener('click', exportXLS);
    $('exportCsvBtn2').addEventListener('click', exportCSV);
    $('exportXlsBtn2').addEventListener('click', exportXLS);
    $('mExportBtn').addEventListener('click', exportCSV);
    $('exportJsonBtn').addEventListener('click', exportJSON);
    $('importFile').addEventListener('change', importCSV);
    $('loadSample').addEventListener('click', loadSampleData);
    [search, filterPurpose, sortBy].forEach(function (el) { el.addEventListener('input', render); });
    unitSelect.addEventListener('change', function () {
      state.settings.unit = unitSelect.value; save(); updateUnitLabels(); render();
    });
    dPrice.addEventListener('change', function () {
      state.settings.defaultPrice = dPrice.value; save();
      if (!fPrice.value && dPrice.value) fPrice.value = dPrice.value;
      previewCalc();
    });
    dMpg.addEventListener('change', function () { state.settings.defaultMpg = dMpg.value; save(); previewCalc(); });
    [fFrom, fTo].forEach(function (el) {
      el.addEventListener('input', function () {
        if (document.activeElement === fTitle) return;
        if (fFrom.value || fTo.value) fTitle.value = (fFrom.value || '?') + ' → ' + (fTo.value || '?');
      });
    });
    [fMiles, fGallons, fPrice, fTotal, fRoundTrip].forEach(function (el) {
      el.addEventListener('input', previewCalc);
    });
    tripBody.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') startEdit(id);
      if (btn.getAttribute('data-act') === 'del') removeTrip(id);
    });
  }

  function previewCalc() {
    var d = derive({
      miles: fMiles.value, gallons: fGallons.value,
      price: fPrice.value, total: fTotal.value, roundTrip: fRoundTrip.checked,
    });
    var parts = [];
    if (d.miles) parts.push('<b>' + d.miles + ' ' + unitLabel() + '</b>');
    if (d.cost) parts.push('cost <b>' + money(d.cost) + '</b>');
    if (d.mpg) parts.push('<b>' + d.mpg + '</b> MPG');
    if (d.gallons && !num(fGallons.value)) parts.push('(≈' + d.gallons + ' gal estimated)');
    liveCalc.innerHTML = parts.length ? '✨ ' + parts.join(' · ') : 'Fill in distance + fuel to preview cost &amp; MPG…';
  }

  function onSubmit(e) {
    e.preventDefault();
    showError('');
    if (!fDate.value) return showError('Please pick a date.');
    if (!num(fMiles.value)) return showError('Please enter the trip distance.');
    var d = derive({
      miles: fMiles.value, gallons: fGallons.value,
      price: fPrice.value, total: fTotal.value, roundTrip: fRoundTrip.checked,
    });
    if (!d.cost && !(d.gallons && d.price)) {
      // Allow mileage-only entries (cost unknown) — common for reimbursement logs.
    }
    var title = fTitle.value.trim() ||
      ((fFrom.value.trim() || fTo.value.trim()) ? (fFrom.value.trim() || '?') + ' → ' + (fTo.value.trim() || '?') : 'Trip');
    var rec = {
      id: state.editingId || uid(),
      date: fDate.value,
      title: title,
      from: fFrom.value.trim(), to: fTo.value.trim(),
      purpose: fPurpose.value,
      miles: d.miles, gallons: d.gallons, price: d.price,
      cost: d.cost, mpg: d.mpg,
      odo: num(fOdo.value) || '',
      notes: $('fNotes').value.trim(),
    };
    if (state.editingId) {
      var i = state.trips.findIndex(function (t) { return t.id === state.editingId; });
      if (i > -1) state.trips[i] = rec;
      showToast('Trip updated ✓');
    } else {
      state.trips.push(rec);
      showToast('Trip added ✓');
    }
    save(); resetForm(); render();
  }

  function resetForm() {
    form.reset();
    fDate.value = todayISO();
    if (state.settings.defaultPrice) fPrice.value = state.settings.defaultPrice;
    state.editingId = null;
    submitBtn.textContent = 'Add trip';
    formTitle.textContent = 'Add a trip';
    cancelEditBtn.hidden = true;
    showError('');
    previewCalc();
  }

  function startEdit(id) {
    var t = state.trips.find(function (x) { return x.id === id; });
    if (!t) return;
    state.editingId = id;
    fDate.value = t.date; fPurpose.value = t.purpose || 'Business';
    fFrom.value = t.from || ''; fTo.value = t.to || ''; fTitle.value = t.title || '';
    fMiles.value = t.miles || ''; fGallons.value = t.gallons || '';
    fPrice.value = t.price || ''; fTotal.value = t.cost || '';
    fOdo.value = t.odo || ''; $('fNotes').value = t.notes || '';
    fRoundTrip.checked = false;
    submitBtn.textContent = 'Save changes';
    formTitle.textContent = 'Edit trip';
    cancelEditBtn.hidden = false;
    previewCalc();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeTrip(id) {
    var t = state.trips.find(function (x) { return x.id === id; });
    if (!t) return;
    if (!confirm('Delete "' + t.title + '" (' + t.date + ')?')) return;
    state.trips = state.trips.filter(function (x) { return x.id !== id; });
    if (state.editingId === id) resetForm();
    save(); render(); showToast('Trip deleted');
  }

  function onClearAll() {
    if (!state.trips.length) return showToast('Nothing to delete');
    if (!confirm('Delete ALL ' + state.trips.length + ' trips? This cannot be undone.')) return;
    state.trips = [];
    save(); render(); showToast('All trips deleted');
  }

  // ---------- filtering / rendering ----------
  function visibleTrips() {
    var q = search.value.trim().toLowerCase();
    var p = filterPurpose.value;
    var list = state.trips.filter(function (t) {
      if (p && t.purpose !== p) return false;
      if (q) {
        var hay = (t.title + ' ' + t.from + ' ' + t.to + ' ' + (t.notes || '') + ' ' + t.date).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var s = sortBy.value;
    list.sort(function (a, b) {
      if (s === 'date-asc') return a.date.localeCompare(b.date);
      if (s === 'miles-desc') return b.miles - a.miles;
      if (s === 'cost-desc') return (b.cost || 0) - (a.cost || 0);
      return b.date.localeCompare(a.date); // date-desc default
    });
    return list;
  }

  function render() {
    var list = visibleTrips();
    var u = unitLabel();
    tripBody.innerHTML = list.map(function (t) {
      var sub = (t.odo ? '<div class="row-sub">odo ' + esc(t.odo) + '</div>' : '') +
        (t.notes ? '<div class="row-sub">' + esc(t.notes) + '</div>' : '');
      return '<tr>' +
        '<td class="no-label"><span><span class="row-title">' + esc(t.title) + '</span>' +
        '<div class="row-sub">' + esc(t.date) + ' · ' + esc(t.purpose || '') + '</div>' + sub + '</span></td>' +
        '<td data-label="Distance">' + (t.miles || '—') + '</td>' +
        '<td data-label="Gallons">' + (t.gallons || '—') + '</td>' +
        '<td data-label="$/gal">' + (t.price ? '$' + t.price.toFixed(2) : '—') + '</td>' +
        '<td data-label="Cost"><b>' + (t.cost ? money(t.cost) : '—') + '</b></td>' +
        '<td data-label="MPG">' + (t.mpg || '—') + '</td>' +
        '<td class="row-actions"><button class="icon-btn" data-act="edit" data-id="' + t.id + '" title="Edit" aria-label="Edit trip">✏️</button>' +
        '<button class="icon-btn" data-act="del" data-id="' + t.id + '" title="Delete" aria-label="Delete trip">🗑️</button></td>' +
        '</tr>';
    }).join('');
    emptyState.style.display = state.trips.length ? 'none' : 'block';
    if (state.trips.length && !list.length) {
      emptyState.style.display = 'block';
      emptyState.innerHTML = '<p><strong>No matches.</strong></p><p>Try a different search or filter.</p>';
    } else if (!state.trips.length) {
      emptyState.innerHTML = '<p><strong>No trips yet.</strong></p><p>Add your first trip with the form, or load <button type="button" class="link" id="loadSample">sample data</button>.</p>';
      var b = $('loadSample'); if (b) b.addEventListener('click', loadSampleData);
    }
    rowCount.textContent = list.length + ' of ' + state.trips.length + ' trips · ' + u;
    renderStats();
    drawChart();
  }

  function totals() {
    return state.trips.reduce(function (a, t) {
      a.miles += num(t.miles); a.cost += num(t.cost); a.gallons += num(t.gallons);
      return a;
    }, { miles: 0, cost: 0, gallons: 0 });
  }

  function renderStats() {
    var t = totals(), u = unitLabel();
    $('statMiles').textContent = t.miles.toFixed(1) + ' ' + u;
    $('statTrips').textContent = state.trips.length + ' trips';
    $('statCost').textContent = money(t.cost);
    $('statFuel').textContent = t.gallons.toFixed(2) + ' gal';
    $('statMpg').textContent = t.gallons > 0 ? (t.miles / t.gallons).toFixed(1) : '—';
    $('statCpm').textContent = t.miles > 0 && t.cost > 0 ? money(t.cost / t.miles) + ' /' + u : '—';
    $('statPrice').textContent = t.gallons > 0 ? 'avg ' + money(t.cost / t.gallons) + ' / gal' : 'avg — / gal';
  }

  // Simple dependency-free bar chart
  function drawChart() {
    var c = $('monthChart');
    var dpr = window.devicePixelRatio || 1;
    var W = c.clientWidth || c.parentElement.clientWidth || 600;
    var H = 160;
    c.width = W * dpr; c.height = H * dpr;
    var ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var months = lastNMonths(6).map(function (m) {
      var cost = 0, miles = 0;
      state.trips.forEach(function (t) {
        if ((t.date || '').slice(0, 7) === m.key) { cost += num(t.cost); miles += num(t.miles); }
      });
      return { key: m.key, label: m.label, cost: cost, miles: miles };
    });
    var max = Math.max.apply(null, months.map(function (m) { return m.cost; }).concat([1]));
    var bw = Math.min(64, (W - 40) / months.length - 18);
    var x0 = 20;
    ctx.font = '11px system-ui';
    months.forEach(function (m, i) {
      var x = x0 + i * ((W - 40) / months.length) + (((W - 40) / months.length) - bw) / 2;
      var h = Math.max(4, (m.cost / max) * (H - 52));
      var y = H - 30 - h;
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#2563eb'); g.addColorStop(1, '#93c5fd');
      ctx.fillStyle = m.cost ? g : '#e5eaf3';
      roundRect(ctx, x, y, bw, h, 6); ctx.fill();
      ctx.fillStyle = '#1a2340'; ctx.textAlign = 'center';
      ctx.fillText(m.cost ? '$' + Math.round(m.cost) : '—', x + bw / 2, y - 6);
      ctx.fillStyle = '#66708e';
      ctx.fillText(m.label, x + bw / 2, H - 12);
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function lastNMonths(n) {
    var out = [], d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (n - 1));
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (var i = 0; i < n; i++) {
      out.push({
        key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        label: names[d.getMonth()],
      });
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }

  // ---------- export / import ----------
  var COLUMNS = ['date', 'title', 'from', 'to', 'purpose', 'miles', 'gallons', 'price_per_gal', 'cost', 'mpg', 'odometer', 'notes'];
  var HEADERS = ['Date', 'Trip', 'From', 'To', 'Purpose', 'Distance (' + unitLabel() + ')', 'Gallons', 'Price/gal ($)', 'Cost ($)', 'MPG', 'Odometer', 'Notes'];

  function rowsForExport() {
    return visibleTrips().map(function (t) {
      return [t.date, t.title, t.from || '', t.to || '', t.purpose || '',
        t.miles || '', t.gallons || '', t.price || '', t.cost || '',
        t.mpg || '', t.odo || '', t.notes || ''];
    });
  }
  function csvCell(v) {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function exportCSV() {
    if (!state.trips.length) return showToast('No trips to export');
    HEADERS[5] = 'Distance (' + unitLabel() + ')';
    var lines = [HEADERS.map(csvCell).join(',')];
    rowsForExport().forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    // Totals row (Excel-friendly)
    var t = totals();
    lines.push('');
    lines.push(['TOTAL', state.trips.length + ' trips', '', '', '', t.miles.toFixed(1), t.gallons.toFixed(2), '', t.cost.toFixed(2), '', '', ''].map(csvCell).join(','));
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, 'trips-' + todayISO() + '.csv');
    showToast('CSV downloaded — open it in Excel ✓');
  }

  function exportXLS() {
    if (!state.trips.length) return showToast('No trips to export');
    var u = unitLabel();
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>' +
      '<table border="1"><tr>' + HEADERS.map(function (h) { return '<th>' + esc(h).replace(unitLabel(), u) + '</th>'; }).join('') + '</tr>' +
      rowsForExport().map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</table></body></html>';
    var blob = new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel' });
    download(blob, 'trips-' + todayISO() + '.xls');
    showToast('.xls downloaded — opens in Excel ✓');
  }

  function exportJSON() {
    if (!state.trips.length) return showToast('No trips to back up');
    var blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), unit: unitLabel(), trips: state.trips }, null, 2)], { type: 'application/json' });
    download(blob, 'trips-backup-' + todayISO() + '.json');
    showToast('Backup downloaded ✓');
  }

  function importCSV(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var list = parseCSV(String(reader.result || ''));
        if (!list.length) return showToast('No rows found in file');
        var added = 0;
        list.forEach(function (r) {
          var g = getCol(r, ['gallons', 'gal', 'fuel']);
          var rec = {
            id: uid(),
            date: getCol(r, ['date']) || todayISO(),
            title: getCol(r, ['trip', 'title', 'name']) || 'Imported trip',
            from: getCol(r, ['from', 'origin']) || '',
            to: getCol(r, ['to', 'destination']) || '',
            purpose: getCol(r, ['purpose', 'category']) || 'Other',
            miles: num(getCol(r, ['distance', 'miles', 'km'])) || 0,
            gallons: num(g) || 0,
            price: num(getCol(r, ['price', 'price_per_gal', 'price/gal'])) || 0,
            cost: num(getCol(r, ['cost', 'total', 'amount'])) || 0,
            mpg: 0, odo: getCol(r, ['odometer', 'odo']) || '',
            notes: getCol(r, ['notes', 'note', 'memo']) || '',
          };
          if (!rec.cost && rec.gallons && rec.price) rec.cost = round2(rec.gallons * rec.price);
          if (rec.miles && rec.gallons) rec.mpg = round1(rec.miles / rec.gallons);
          if (rec.miles || rec.cost) { state.trips.push(rec); added++; }
        });
        save(); render();
        showToast('Imported ' + added + ' trips ✓');
      } catch (err) { showToast('Import failed: ' + err.message); }
    };
    reader.readAsText(f);
  }
  function getCol(row, names) {
    for (var k in row) {
      var nk = k.toLowerCase().replace(/[^a-z]/g, '');
      for (var i = 0; i < names.length; i++) {
        if (nk === names[i].replace(/[^a-z]/g, '')) return row[k];
      }
    }
    return '';
  }
  function parseCSV(text) {
    var rows = [], row = [], cur = '', inQ = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
    row.push(cur); rows.push(row);
    rows = rows.filter(function (r) { return r.join('').trim() !== ''; });
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      header.forEach(function (h, j) { o[h] = (r[j] || '').trim(); });
      return o;
    });
  }

  function loadSampleData() {
    if (state.trips.length && !confirm('Load 5 sample trips? (keeps your existing trips)')) return;
    var s = [
      ['2026-09-02', 'Home → Client office', 'Home', 'Client office', 'Business', 42, 1.6, 3.59],
      ['2026-09-10', 'Austin → Dallas', 'Austin', 'Dallas', 'Business', 195, 7.2, 3.29],
      ['2026-09-18', 'Weekend lake trip', 'Home', 'Lake Travis', 'Personal', 88, 3.5, 3.45],
      ['2026-10-01', 'Morning commute', 'Home', 'Downtown', 'Commute', 24, 1.0, 3.39],
      ['2026-10-05', 'Delivery run', 'Warehouse', 'South store', 'Delivery', 63, 2.6, 3.49],
    ];
    s.forEach(function (r) {
      var miles = r[5], gal = r[6], price = r[7];
      state.trips.push({
        id: uid(), date: r[0], title: r[1], from: r[2], to: r[3], purpose: r[4],
        miles: miles, gallons: gal, price: price,
        cost: round2(gal * price), mpg: round1(miles / gal), odo: '', notes: 'sample',
      });
    });
    save(); render(); showToast('Sample trips loaded');
  }

  window.addEventListener('resize', drawChart);
})();
