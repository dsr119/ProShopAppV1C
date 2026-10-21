// The "Shop Tickets" Alexa skill. Paste this whole file over lambda/index.js in
// the Alexa developer console (Code tab), fill in the three settings below,
// then Save and Deploy. No other packages are needed.
//
// It passes what's said to the alexa-work-order Supabase function, which runs
// the conversation (who's it for, what are we doing) and adds the ticket. This
// file only relays: it holds no database key, just the password that function
// checks, and keeps the conversation's state between turns.
//
// Note: Alexa+ does not run unpublished skills like this one. It works on an
// Echo using the original Alexa.

// --- settings ---------------------------------------------------------------
const FUNCTION_URL = "https://ngghyuvykqqklztvvmld.supabase.co/functions/v1/alexa-work-order";
const SHARED_SECRET = "paste the same password you set as ALEXA_SHARED_SECRET";
// The building this Echo is in: "Valley", "South Side", or "" for none.
// Saying "valley" or "south side" in the work order overrides it.
const DEFAULT_LOCATION = "";
// ----------------------------------------------------------------------------

function speak(text, { endSession = true, reprompt, directives, state } = {}) {
  const response = {
    outputSpeech: { type: "PlainText", text },
    shouldEndSession: endSession,
  };
  if (reprompt) response.reprompt = { outputSpeech: { type: "PlainText", text: reprompt } };
  if (directives) {
    response.directives = directives;
    delete response.shouldEndSession; // dialog directives keep the mic open
  }
  const out = { version: "1.0", response };
  if (state) out.sessionAttributes = { state };
  return out;
}

// Ask the next question, taking the answer as the work order intent's
// request slot, so it comes straight back here with the state.
function askNext(say, state) {
  return speak(say, {
    reprompt: say,
    state,
    directives: [{
      type: "Dialog.ElicitSlot",
      slotToElicit: "request",
      updatedIntent: { name: "CreateWorkOrderIntent", confirmationStatus: "NONE", slots: {} },
    }],
  });
}

// Alexa-hosted skills may run a Node version without a built-in fetch, so
// fall back to a tiny one on the https module.
function httpsFetch(url, { method, headers, body }) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: async () => data,
        json: async () => JSON.parse(data),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/* global fetch */
const defaultFetch = typeof fetch === "function" ? fetch : httpsFetch;

async function turn(text, state, fetchFn) {
  const res = await fetchFn(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-alexa-secret": SHARED_SECRET },
    body: JSON.stringify({ text, state, location: DEFAULT_LOCATION }),
  });
  if (!res.ok) throw new Error(`Function said ${res.status}: ${await res.text()}`);
  return res.json();
}

async function relay(text, state, fetchFn, opening) {
  try {
    const out = await turn(text, state, fetchFn);
    if (out.done) return speak(out.say);
    // "open shop tickets" can't take a dialog directive, so ask plainly there;
    // the answer then needs to match a sample like "for ...".
    if (opening) return speak(out.say, { endSession: false, reprompt: out.say, state: out.state });
    return askNext(out.say, out.state);
  } catch (err) {
    console.log("work order failed", err);
    // Say why, briefly: it's the only clue anyone at the Echo gets.
    const why = String(err.message || err).slice(0, 120);
    return speak(`Sorry, I couldn't add that work order. Please put it in the app instead. ${why}`);
  }
}

async function handle(event, fetchFn = defaultFetch) {
  const req = event.request || {};
  const state = (event.session && event.session.attributes && event.session.attributes.state) || "";

  if (req.type === "LaunchRequest") return relay("", "", fetchFn, true);
  // SessionEndedRequest and the like take no speech.
  if (req.type !== "IntentRequest") return { version: "1.0", response: {} };

  const name = req.intent && req.intent.name;
  if (name === "CreateWorkOrderIntent") {
    const slot = req.intent.slots && req.intent.slots.request;
    const text = slot && slot.value ? slot.value.trim() : "";
    return relay(text, state, fetchFn, false);
  }
  if (name === "AMAZON.HelpIntent" || name === "AMAZON.FallbackIntent") {
    return speak("Say who it's for and what we're doing, like: for Doug Smith to plug his 14 pound ball.",
      { endSession: false, reprompt: "Who's it for, and what are we doing?", state });
  }
  // Stop, Cancel, and anything else.
  return speak("Okay.");
}

exports.handler = (event) => handle(event);
exports.handle = handle;
