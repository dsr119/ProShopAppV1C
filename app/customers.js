// Shared customer picker: saved activity plus the supplemental customer directory.
(() => {
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  function phoneKey(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  }
  function contacts(rows) {
    const unique = new Map();
    for (const row of rows) {
      const name = String(row.customer_name || '').trim();
      const phone = String(row.phone || '').trim();
      if (!name || !phoneKey(phone) || row.is_stock || normalize(name) === 'stock') continue;
      const key = normalize(name) + '\n' + phoneKey(phone);
      if (!unique.has(key)) unique.set(key, { name, phone });
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.phone.localeCompare(b.phone));
  }
  function ticketContact(details) {
    const match = /^Customer: ([^\n]+)\nPhone: ([^\n]+)/.exec(details || '');
    return match ? { customer_name: match[1], phone: match[2] } : {};
  }
  function ticketDetails(name, phone, details) {
    const contact = name.trim() || phone.trim()
      ? `Customer: ${name.trim()}\nPhone: ${phone.trim()}` : '';
    return [contact, details.trim()].filter(Boolean).join('\n\n') || null;
  }
  let pending;
  async function load() {
    if (!pending) pending = (async () => {
      const results = await Promise.allSettled([
        db.selectAll('orders', 'select=id,customer_name,phone,is_stock&deleted_at=is.null&is_stock=is.false&phone=not.is.null&order=id.asc'),
        db.selectAll('appointments', 'select=id,customer_name,phone&deleted_at=is.null&phone=not.is.null&order=id.asc'),
        db.selectAll('tickets', 'select=id,details&deleted_at=is.null&details=like.Customer:*&order=id.asc'),
        db.selectAll('customer_directory', 'select=id,customer_name,phone&deleted_at=is.null&order=id.asc'),
      ]);
      const rows = results.flatMap((result, i) => result.status === 'fulfilled'
        ? (i === 2 ? result.value.map(row => ticketContact(row.details)) : result.value) : []);
      const partial = results.some(result => result.status === 'rejected');
      if (partial) pending = null;
      return { rows: contacts(rows), partial };
    })();
    return pending;
  }
  function attach(nameId, phoneId) {
    const input = document.getElementById(nameId), phone = document.getElementById(phoneId);
    if (!input || !phone) return;
    const wrap = document.createElement('div');
    wrap.className = 'customer-picker';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
    const list = document.createElement('div');
    list.className = 'customer-options';
    list.id = nameId + '_customers';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Saved customer phone numbers');
    list.hidden = true;
    wrap.append(list);
    const status = document.createElement('small');
    status.className = 'customer-hint';
    status.setAttribute('aria-live', 'polite');
    wrap.append(status);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';
    let matches = [], active = -1, generation = 0, selected = null;
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function choose(index) {
      const match = matches[index];
      if (!match) return;
      input.value = match.name;
      phone.value = match.phone;
      selected = match;
      close();
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      phone.focus();
    }
    async function show() {
      const request = ++generation;
      const query = normalize(input.value);
      close();
      status.textContent = '';
      if (query.length < 2) return;
      status.textContent = 'Looking up saved numbers…';
      const data = await load();
      if (request !== generation || document.activeElement !== input) return;
      matches = data.rows.filter(row => query.split(' ').every(part => normalize(row.name).includes(part))).slice(0, 12);
      list.replaceChildren();
      matches.forEach((row, i) => {
        const option = document.createElement('div');
        option.id = list.id + '_' + i;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.textContent = row.name + ' — ' + row.phone;
        option.addEventListener('mousedown', e => e.preventDefault());
        option.addEventListener('click', e => { e.preventDefault(); choose(i); });
        list.append(option);
      });
      status.textContent = data.partial ? 'Some saved numbers could not load. You can still enter a number.'
        : matches.length ? 'Select a saved number, or enter one yourself.' : 'No saved number found. Enter one below.';
      list.hidden = !matches.length;
      input.setAttribute('aria-expanded', String(matches.length > 0));
    }
    input.addEventListener('input', () => {
      // Never leave an automatically filled number attached to a different name.
      if (selected && normalize(input.value) !== normalize(selected.name)) {
        if (phone.value === selected.phone) phone.value = '';
        selected = null;
      }
      show();
    });
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => { ++generation; close(); status.textContent = ''; });
    input.addEventListener('keydown', e => {
      if (list.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
        input.setAttribute('aria-activedescendant', list.children[active].id);
        list.children[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    });
  }
  window.customers = { attach, contacts, ticketContact, ticketDetails, invalidate() { pending = null; } };
})();
