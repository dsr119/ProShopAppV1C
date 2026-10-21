// The "Pro Shop" Alexa skill. Paste this whole file over lambda/index.js in
// the Alexa developer console (Code tab), fill in the three settings below,
// then Save and Deploy. No other packages are needed.
//
// It hears "create a work order for ..." and hands the sentence to the
// alexa-work-order Supabase function, which adds the ticket. This file holds
// no database key -- only the password that function checks.

// --- settings ---------------------------------------------------------------
const FUNCTION_URL = "https://ngghyuvykqqklztvvmld.supabase.co/functions/v1/alexa-work-order";
const SHARED_SECRET = "paste the same password you set as ALEXA_SHARED_SECRET";
// The building this Echo is in: "Valley", "South Side", or "" for none.
// Saying "valley" or "south side" in the work order overrides it.
const DEFAULT_LOCATION = "";
// ----------------------------------------------------------------------------

const ASK = "What's the work order for?";

function speak(text, { endSession = true, reprompt, directives } = {}) {
  const response = {
    outputSpeech: { type: "PlainText", text },
    shouldEndSession: endSession,
  };
  if (reprompt) response.reprompt = { outputSpeech: { type: "PlainText", text: reprompt } };
  if (directives) {
    response.directives = directives;
    delete response.shouldEndSession; // dialog directives keep the mic open
  }
  return { version: "1.0", response };
}

// Ask for the request slot of the work order intent, so the next thing said
// is taken as the whole work order.
function askForRequest(prompt) {
  return speak(prompt, {
    reprompt: ASK,
    directives: [{
      type: "Dialog.ElicitSlot",
      slotToElicit: "request",
      updatedIntent: { name: "CreateWorkOrderIntent", confirmationStatus: "NONE", slots: {} },
    }],
  });
}

async function createWorkOrder(text, fetchFn) {
  const res = await fetchFn(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-alexa-secret": SHARED_SECRET },
    body: JSON.stringify({ text, location: DEFAULT_LOCATION }),
  });
  if (!res.ok) throw new Error(`Function said ${res.status}: ${await res.text()}`);
  return res.json();
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

async function handle(event, fetchFn = defaultFetch) {
  const req = event.request || {};

  // A plain question, not a dialog directive: Alexa refuses those in reply to
  // "open pro shop" ("not supported on this device"). The answer "it's for
  // ..." matches the intent's own sample utterances.
  if (req.type === "LaunchRequest") {
    return speak(ASK + " Start with: it's for.", { endSession: false, reprompt: ASK });
  }
  // SessionEndedRequest and the like take no speech.
  if (req.type !== "IntentRequest") return { version: "1.0", response: {} };

  const name = req.intent && req.intent.name;

  if (name === "CreateWorkOrderIntent") {
    const slot = req.intent.slots && req.intent.slots.request;
    const text = slot && slot.value ? slot.value.trim() : "";
    if (!text) return askForRequest(ASK);
    try {
      const made = await createWorkOrder(text, fetchFn);
      return speak(`Done. Work order added: ${made.title}.`);
    } catch (err) {
      console.log("work order failed", err);
      return speak("Sorry, I couldn't add that work order. Please put it in the app instead.");
    }
  }
  if (name === "AMAZON.HelpIntent") {
    return speak("Say: it's for, then the problem. Like: it's for the ball return on lane 3 is jammed.",
      { endSession: false, reprompt: ASK });
  }
  if (name === "AMAZON.FallbackIntent") {
    return speak("Sorry, I didn't catch that. Say: it's for, then the problem.", { endSession: false, reprompt: ASK });
  }
  // Stop, Cancel, and anything else.
  return speak("Okay.");
}

exports.handler = (event) => handle(event);
exports.handle = handle;
