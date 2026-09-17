(() => {
  const $ = id => document.getElementById(id);
  let rows = [], loading = false;
  const saving = new Set();
  function error(message) { $('error').textContent = message; $('error').classList.toggle('hidden', !message); }
  async function load() {
    if (loading || saving.size) return;
    loading = true; $('refresh').disabled = true;
    try {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      rows = await db.selectAll('orders',
        'select=id,item,quantity,customer_name,is_stock,pickup_location,order_location,shop_order_date,checked_in_at,out_the_door,supplier,supplier_order_no,invoice_no' +
        '&deleted_at=is.null&shop_order_date=not.is.null' +
        `&or=(and(checked_in_at.is.null,out_the_door.eq.false),checked_in_at.gt.${cutoff})&order=shop_order_date.desc,id.asc`);
      error(''); render();
    } catch (err) {
      const setup = /checked_in_at/.test(err.message) && /42703|PGRST204|does not exist/.test(err.message);
      error(setup ? 'Order Check In needs a one-time database update: run add_order_check_in.sql in Supabase, then tap Refresh.' : 'Could not refresh equipment. ' + err.message);
      $('count').textContent = 'Refresh failed — the list may be out of date.';
    } finally { loading = false; $('refresh').disabled = false; }
  }
  async function checkIn(row, undo = false) {
    if (saving.has(row.id) || loading) return;
    saving.add(row.id); render(); error('');
    try {
      // Compare-and-set prevents repeated taps/devices from resetting the 24-hour clock.
      const filter = `id=eq.${encodeURIComponent(row.id)}&deleted_at=is.null&shop_order_date=not.is.null&` +
        (undo ? `checked_in_at=eq.${encodeURIComponent(row.checked_in_at)}` : 'checked_in_at=is.null&out_the_door=is.false');
      const updated = await db.update('orders', filter, { checked_in_at: undo ? null : new Date().toISOString() });
      if (!updated || !updated.length) {
        $('notice').textContent = 'This item changed on another device. The list has been refreshed.';
      } else {
        Object.assign(row, updated[0]);
        $('notice').textContent = undo ? `${row.item}: check-in undone.` : `${row.item}: checked in.`;
        receiving.notify();
      }
      saving.delete(row.id);
      render();
      // Read fresh state, including any concurrent change.
      await load();
    } catch (err) {
      error('Could not save check-in. Nothing was changed here. ' + err.message);
    } finally { saving.delete(row.id); render(); }
  }
  function render() {
    const query = $('search').value.trim().toLowerCase(), location = $('location').value;
    const visible = rows.filter(row => receiving.visible(row) &&
      (!location || receiving.destination(row) === location || receiving.destination(row) === 'Both') &&
      (!query || [row.item, row.customer_name, row.is_stock ? 'stock' : '', row.supplier, row.supplier_order_no, row.invoice_no].join(' ').toLowerCase().includes(query)))
      .sort((a, b) => Number(Boolean(a.checked_in_at)) - Number(Boolean(b.checked_in_at)) ||
        (b.shop_order_date || '').localeCompare(a.shop_order_date || '') || a.item.localeCompare(b.item));
    $('rows').replaceChildren();
    for (const row of visible) {
      const card = document.createElement('article');
      card.className = 'checkin-card' + (row.checked_in_at ? ' is-received' : '');
      const info = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = row.item + (row.quantity > 1 ? ` × ${row.quantity}` : '');
      info.append(heading);
      const line = (text, cls = '') => { const el = document.createElement('p'); el.textContent = text; el.className = cls; info.append(el); };
      line(row.is_stock ? 'Shop stock' : row.customer_name);
      line('To: ' + receiving.destination(row).replace('South Side', 'Southside'), 'destination');
      line(['Ordered ' + row.shop_order_date, row.supplier, row.supplier_order_no ? 'Order #' + row.supplier_order_no : '', row.invoice_no ? 'Invoice #' + row.invoice_no : ''].filter(Boolean).join(' · '), 'meta');
      if (row.checked_in_at) line('Checked in ' + new Date(row.checked_in_at).toLocaleString(), 'meta');
      const actions = document.createElement('div'); actions.className = 'checkin-actions';
      const button = document.createElement('button'); button.type = 'button';
      button.className = row.checked_in_at ? '' : 'primary';
      button.textContent = saving.has(row.id) ? 'Saving…' : row.checked_in_at ? 'Undo check-in' : row.quantity > 1 ? `Check in all ${row.quantity}` : 'Check in';
      button.disabled = saving.has(row.id);
      button.setAttribute('aria-label', button.textContent + ': ' + row.item + ' for ' + (row.is_stock ? 'Shop stock' : row.customer_name));
      button.addEventListener('click', () => checkIn(row, Boolean(row.checked_in_at)));
      if (row.checked_in_at) actions.append(receiving.badge(row));
      actions.append(button); card.append(info, actions); $('rows').append(card);
    }
    const checked = visible.filter(row => row.checked_in_at).length;
    $('count').textContent = `${visible.length - checked} awaiting check-in · ${checked} checked in within 24 hours`;
    $('empty').classList.toggle('hidden', Boolean(visible.length));
  }
  $('refresh').addEventListener('click', load);
  $('search').addEventListener('input', render);
  $('location').addEventListener('change', render);
  receiving.watch(load);
  setInterval(() => { if (!document.hidden) { render(); load(); } }, 60000);
  load();
})();
