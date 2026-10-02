// "What's new" button in the page header. Adds itself to the header and opens
// a popup listing the releases in patch-notes.json.
//
// To add a release, put a new entry at the TOP of patch-notes.json with a
// higher version number. No ?v= bump is needed for that: the file is fetched
// fresh each time the popup opens. The button shows a dot until each browser
// has opened the newest version once.

(function () {
  const SEEN_KEY = "whatsNewSeen";
  const header = document.querySelector("body > header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "whatsnew";
  btn.textContent = "What's new";
  header.appendChild(btn);

  const dlg = document.createElement("dialog");
  dlg.className = "whatsnewdlg";
  dlg.innerHTML =
    '<h3>What\'s new<button type="button" class="xclose" aria-label="Close">&times;</button></h3>' +
    '<div class="body"></div>';
  document.body.appendChild(dlg);
  const body = dlg.querySelector(".body");
  dlg.querySelector(".xclose").addEventListener("click", () => dlg.close());
  // Click on the backdrop closes it too.
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

  function seen() {
    try { return localStorage.getItem(SEEN_KEY); } catch (e) { return null; }
  }
  function markSeen(v) {
    try { localStorage.setItem(SEEN_KEY, v); } catch (e) { /* private window */ }
  }

  function load() {
    return fetch("patch-notes.json", { cache: "no-cache" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  function fmtDate(iso) {
    const d = new Date(iso + "T12:00:00");
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function render(releases) {
    body.textContent = "";
    for (const r of releases) {
      const sec = document.createElement("section");
      const h = document.createElement("h4");
      h.textContent = "Version " + r.version;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = fmtDate(r.date);
      h.appendChild(when);
      const ul = document.createElement("ul");
      for (const n of r.notes || []) {
        const li = document.createElement("li");
        li.textContent = n;
        ul.appendChild(li);
      }
      sec.append(h, ul);
      body.appendChild(sec);
    }
  }

  btn.addEventListener("click", () => {
    body.textContent = "Loading…";
    dlg.showModal();
    load().then(releases => {
      render(releases);
      if (releases[0]) markSeen(releases[0].version);
      btn.classList.remove("unseen");
    }).catch(err => {
      body.textContent = "Couldn't load the notes (" + err.message + ").";
    });
  });

  load().then(releases => {
    if (releases[0] && releases[0].version !== seen()) btn.classList.add("unseen");
  }).catch(() => {});
})();
