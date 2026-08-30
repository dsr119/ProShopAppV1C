// Thin wrapper over the Supabase REST API (PostgREST).
//
// No SDK on purpose -- the whole surface we need is four verbs over fetch,
// and skipping the dependency means nothing to pin, bundle, or upgrade.

const HEADERS = {
  apikey: window.SUPABASE_KEY,
  Authorization: "Bearer " + window.SUPABASE_KEY,
  "Content-Type": "application/json",
};

const REST = window.SUPABASE_URL + "/rest/v1/";

async function request(path, options = {}) {
  const res = await fetch(REST + path, {
    ...options,
    headers: { ...HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText} -- ${body}`);
  }
  // PATCH/POST with return=minimal give back an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const db = {
  select(table, query = "") {
    return request(`${table}?${query}`);
  },

  insert(table, rows) {
    return request(table, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    });
  },

  update(table, filter, patch) {
    return request(`${table}?${filter}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
  },

  // Never a real DELETE. The database is reachable by anyone with the URL,
  // so rows are hidden and stay recoverable.
  softDelete(table, id) {
    return db.update(table, `id=eq.${id}`, { deleted_at: new Date().toISOString() });
  },

  restore(table, id) {
    return db.update(table, `id=eq.${id}`, { deleted_at: null });
  },
};

window.db = db;
