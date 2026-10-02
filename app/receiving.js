// Arrival is independent of payment, drilling and collection.
(() => {
  const DAY = 24 * 60 * 60 * 1000;
  function status(row) {
    if (row.checked_in_at) return { key: 'received', label: 'Checked in' };
    if (!row.shop_order_date) return { key: 'pending', label: 'Not ordered' };
    return { key: 'ordered', label: 'Ordered · not checked in' };
  }
  function visible(row, now = Date.now()) {
    if (row.deleted_at || !row.shop_order_date) return false;
    if (row.checked_in_at) return Date.parse(row.checked_in_at) > now - DAY;
    return !row.out_the_door;
  }
  // The customer said they need measuring before the ball is drilled -- the
  // website, the Google Form and the counter dialog all ask. Matched loosely
  // because imported rows carry the workbook's own wording.
  function needsFitting(row) { return /need/i.test(row.fitting || '') && /fit/i.test(row.fitting || ''); }
  function destination(row) { return row.pickup_location || row.order_location || 'Not specified'; }
  function badge(row) {
    const state = status(row), el = document.createElement('span');
    el.className = 'badge ' + state.key;
    el.textContent = state.label;
    if (row.checked_in_at) el.title = 'Checked in ' + new Date(row.checked_in_at).toLocaleString();
    return el;
  }
  // Keep existing pages usable during the interval between publishing and SQL setup.
  async function selectAll(table, query) {
    try { return await db.selectAll(table, query); }
    catch (error) {
      if (!query.includes('checked_in_at') || !/checked_in_at/.test(error.message) || !/42703|PGRST204|does not exist/.test(error.message)) throw error;
      return db.selectAll(table, query.replace('checked_in_at,', ''));
    }
  }
  function notify() {
    try { localStorage.setItem('proshop.receiving.changed', String(Date.now())); } catch { /* refresh remains available */ }
  }
  function watch(refresh, canRefresh = () => true) {
    const update = () => { if (!document.hidden && canRefresh()) refresh(); };
    setInterval(update, 30000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('storage', e => { if (e.key === 'proshop.receiving.changed') update(); });
  }
  window.receiving = { status, visible, destination, needsFitting, badge, selectAll, notify, watch };
})();
