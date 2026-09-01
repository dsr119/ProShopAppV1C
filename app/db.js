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

const PAGE = 1000;   // Supabase caps any single response at 1000 rows

const db = {
  select(table, query = "") {
    return request(`${table}?${query}`);
  },

  // Same as select, but walks past the 1000-row cap. Asking for limit=10000
  // does NOT work -- the server silently returns the first 1000 and the
  // caller has no idea it is looking at a truncated table.
  async selectAll(table, query = "") {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const res = await fetch(`${REST}${table}?${query}`, {
        headers: { ...HEADERS, Range: `${from}-${from + PAGE - 1}` },
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`${res.status} ${res.statusText} -- ${await res.text()}`);
      }
      const batch = JSON.parse((await res.text()) || "[]");
      out.push(...batch);

      // "0-999/2176" -- stop once we have them all, or on a short page.
      const total = Number((res.headers.get("content-range") || "").split("/")[1]);
      if (batch.length < PAGE || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  },

  insert(table, rows) {
    return request(table, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    });
  },

  // Insert-or-update in one request. `conflict` names the unique constraint's
  // columns -- rows matching an existing one are merged rather than rejected.
  //
  // The alternative is a PATCH per row, which for the fourteen hours rows is
  // fourteen round trips that can half-succeed and leave the week straddling
  // two states. One request either lands or it does not.
  upsert(table, rows, conflict) {
    return request(`${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
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
