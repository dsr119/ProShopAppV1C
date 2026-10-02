// Minimal Supabase REST client for the scheduled jobs. Uses the service-role
// key, which bypasses RLS -- it lives only in GitHub Actions secrets, never in
// anything served to a browser.

const URL_BASE = (process.env.SUPABASE_URL || 'https://ngghyuvykqqklztvvmld.supabase.co').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(extra = {}) {
  if (!KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.');
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...extra };
}

async function check(response, what) {
  if (response.ok) return response;
  throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
}

/** Every row of a table, paged -- PostgREST caps a response at 1000 rows. */
export async function selectAll(table, order = 'id', pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const response = await check(
      await fetch(`${URL_BASE}/rest/v1/${table}?select=*&order=${order}`, {
        headers: headers({ Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' }),
      }),
      `Reading ${table}`
    );
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

export async function upsertRows(table, rows, onConflict, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await check(
      await fetch(`${URL_BASE}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows.slice(i, i + batchSize)),
      }),
      `Saving ${table}`
    );
  }
}

export async function deleteRows(table, ids, batchSize = 100) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const list = ids.slice(i, i + batchSize).join(',');
    await check(
      await fetch(`${URL_BASE}/rest/v1/${table}?id=in.(${list})`, {
        method: 'DELETE',
        headers: headers({ Prefer: 'return=minimal' }),
      }),
      `Deleting from ${table}`
    );
  }
}
