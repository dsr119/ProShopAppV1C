// The staff roster.
//
// One list, read by the tickets board, the drilling queue and the appointment
// dialog, so a name typed once spells the same way everywhere. Loaded once per
// page and cached -- it is a handful of rows that change a few times a year,
// and re-fetching it for every dropdown on a 200-row table would be absurd.
//
// Names are matched by text, not by id. orders.staff_member arrived from the
// workbook as free text, so the roster's job is to supply the spelling, not to
// reject the history.

(function () {

let cache = null;      // the rows, once they have arrived
let inflight = null;   // the promise while a request is still in the air

function invalidate() {
  cache = null;
  inflight = null;
}

const staff = {
  // Everyone, inactive included -- callers filter. Sorted the way the
  // dropdowns want them: hand-ordered first, then alphabetical.
  //
  // The in-flight promise is cached as well as the result, and that is the
  // important half. A drilling queue draws one assign dropdown per row and
  // fills them all in the same tick; caching only the result would leave every
  // one of those calls looking at an empty cache and firing its own request --
  // two hundred identical round trips to fetch a list of six names.
  async list(force = false) {
    if (cache && !force) return cache;
    if (inflight && !force) return inflight;

    const mine = (async () => {
      const rows = await db.selectAll("staff", "select=*&order=name.asc");
      rows.sort((a, b) => {
        const ao = a.sort_order, bo = b.sort_order;
        if (ao !== null && bo !== null && ao !== bo) return ao - bo;
        if (ao !== null && bo === null) return -1;
        if (ao === null && bo !== null) return 1;
        return a.name.localeCompare(b.name);
      });
      cache = rows;
      return rows;
    })();
    inflight = mine;

    try {
      return await mine;
    } finally {
      // Cleared either way: a failed load must not be remembered as pending,
      // or the roster would never be retried for the life of the page. Only
      // if it is still ours -- an edit during the fetch starts a newer one,
      // and clearing that would throw away the request everyone is waiting on.
      if (inflight === mine) inflight = null;
    }
  },

  async active() {
    return (await staff.list()).filter((s) => s.active);
  },

  async names() {
    return (await staff.active()).map((s) => s.name);
  },

  async add(name) {
    const [row] = await db.insert("staff", { name: name.trim() });
    invalidate();
    return row;
  },

  async rename(id, name) {
    await db.update("staff", `id=eq.${id}`, { name: name.trim() });
    invalidate();
  },

  async setActive(id, active) {
    await db.update("staff", `id=eq.${id}`, { active });
    invalidate();
  },

  async setOrder(id, sort_order) {
    await db.update("staff", `id=eq.${id}`, { sort_order });
    invalidate();
  },

  // Fills a <select> with the roster. `current` is kept as an option even when
  // it is not on the roster any more -- otherwise opening a two-year-old
  // ticket would silently blank out who did the work, and the next save would
  // write that blank back.
  async fillSelect(sel, current, blankLabel = "Unassigned") {
    const rows = await staff.active();
    sel.innerHTML = "";

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = blankLabel;
    sel.appendChild(blank);

    for (const s of rows) {
      const o = document.createElement("option");
      o.value = o.textContent = s.name;
      sel.appendChild(o);
    }
    if (current && !rows.some((s) => s.name === current)) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current + " — no longer on the roster";
      sel.appendChild(o);
    }
    sel.value = current || "";
  },
};

window.staff = staff;

})();
