// Only include orders from when drilling tracking began.
let exportOrders = [];
let exportRemoved = new Set();
let exportReady = false;
let exportRequest = 0;

const exportClean = value => String(value || '').replace(/\s+/g, ' ').trim();
const exportNorm = value => exportClean(value).toLowerCase();

const EXPORT_START_DATE = '2026-07-01';
function exportTrackingStarted(order) {
  if (order.shop_order_date) return order.shop_order_date.slice(0, 10) >= EXPORT_START_DATE;
  // Unplaced orders use their intake timestamp in the shop's timezone.
  if (!order.submitted_at) return false;
  const submitted = new Date(order.submitted_at);
  return Number.isFinite(submitted.getTime()) && submitted >= new Date('2026-07-01T00:00:00-04:00');
}

function unscheduledOrders(orders, appointments) {
  const linked = new Set(appointments.filter(a => !a.deleted_at && a.order_id).map(a => a.order_id));
  const legacy = new Set(appointments.filter(a => !a.deleted_at && !a.order_id)
    .map(a => JSON.stringify([exportNorm(a.customer_name), exportNorm(a.service)])));
  return orders.filter(o => exportTrackingStarted(o) && !o.deleted_at && !o.is_stock && !finished(o) &&
    !NOT_A_CUSTOMER.has(exportNorm(o.customer_name)) && !linked.has(o.id) &&
    ![o.item, `Drill ${o.item}`].some(service => legacy.has(JSON.stringify([exportNorm(o.customer_name), exportNorm(service)]))))
    .sort((a, b) => exportClean(a.customer_name).localeCompare(exportClean(b.customer_name)) ||
      exportClean(a.item).localeCompare(exportClean(b.item)) || String(a.id).localeCompare(String(b.id)));
}

function exportLocation(order) {
  return exportClean(order.pickup_location || order.order_location) || 'Unassigned location';
}

function exportMatchesLocation(order, location) {
  if (location === 'Both') return true;
  const assigned = exportNorm(exportLocation(order)).replace(/\s/g, '');
  return assigned === 'both' || assigned === exportNorm(location).replace(/\s/g, '');
}

function exportLine(order) {
  const quantity = Number(order.quantity) > 1 ? ` ×${Number(order.quantity)}` : '';
  return `${exportClean(order.customer_name)} — ${exportClean(order.item)}${quantity}`;
}

function exportText(orders, location) {
  const title = `Not drilled or scheduled — ${location === 'South Side' ? 'Southside' : location}`;
  return [title, '', ...orders.map(o => `• ${exportLine(o)}${location === 'Both' ? ` (${exportLocation(o)})` : ''}`)].join('\n');
}

function currentExportOrders() {
  return exportOrders.filter(o => !exportRemoved.has(o.id) && exportMatchesLocation(o, $('export_location').value));
}

function renderExport() {
  const rows = currentExportOrders();
  $('export_list').replaceChildren();
  for (const order of rows) {
    const row = document.createElement('div');
    row.className = 'export-row';
    const text = document.createElement('span');
    text.textContent = exportLine(order) + ($('export_location').value === 'Both' ? ` (${exportLocation(order)})` : '');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${exportLine(order)} from export`);
    remove.title = 'Remove from this export only';
    remove.addEventListener('click', () => {
      exportRemoved.add(order.id);
      renderExport();
    });
    row.append(text, remove);
    $('export_list').appendChild(row);
  }
  $('export_count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
  $('export_empty').classList.toggle('hidden', !exportReady || rows.length > 0);
  $('export_copy').disabled = !exportReady || !rows.length;
  $('export_reset').disabled = !exportRemoved.size;
  $('export_manual').classList.add('hidden');
}

async function openDrillingExport() {
  const requestId = ++exportRequest;
  exportRemoved = new Set();
  exportOrders = [];
  exportReady = false;
  $('export_location').value = ['Valley', 'South Side'].includes($('location').value) ? $('location').value : 'Both';
  $('export_status').textContent = 'Loading orders and appointments…';
  $('export_notice').textContent = '';
  renderExport();
  $('exportdlg').showModal();
  try {
    const [orders, appointments] = await Promise.all([
      db.selectAll('orders', 'select=id,shop_order_date,submitted_at,customer_name,item,quantity,is_stock,drilled,no_drill_needed,out_the_door,pickup_location,order_location&deleted_at=is.null&is_stock=is.false&drilled=is.false&no_drill_needed=is.false&out_the_door=is.false&or=(shop_order_date.gte.2026-07-01,and(shop_order_date.is.null,submitted_at.gte.2026-07-01T00:00:00-04:00))&order=id.asc'),
      db.selectAll('appointments', 'select=order_id,customer_name,service&deleted_at=is.null&order=id.asc'),
    ]);
    if (requestId !== exportRequest) return;
    exportOrders = unscheduledOrders(orders, appointments);
    exportReady = true;
    $('export_status').textContent = 'Orders from July 1, 2026 onward. Removing an entry only changes this export.';
    renderExport();
  } catch (err) {
    if (requestId !== exportRequest) return;
    $('export_status').textContent = 'Could not load the complete list. Close and reopen to retry. ' + err.message;
  }
}

async function copyDrillingExport() {
  const rows = currentExportOrders();
  if (!exportReady || !rows.length) return;
  const text = exportText(rows, $('export_location').value);
  $('export_copy').disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    $('export_notice').textContent = 'Copied to clipboard';
    $('exportdlg').close();
  } catch (err) {
    $('export_status').textContent = 'Clipboard access failed. Select and copy the text below, or try Copy again.';
    const manual = $('export_manual');
    manual.value = text;
    manual.classList.remove('hidden');
    manual.focus();
    manual.select();
  } finally {
    $('export_copy').disabled = false;
  }
}

$('export_open').addEventListener('click', openDrillingExport);
$('export_location').addEventListener('change', renderExport);
$('export_reset').addEventListener('click', () => { exportRemoved.clear(); renderExport(); });
$('export_close').addEventListener('click', () => $('exportdlg').close());
$('export_copy').addEventListener('click', copyDrillingExport);
$('exportdlg').addEventListener('close', () => { exportRequest++; });
