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

async function handle(event, fetchFn = fetch) {
  const req = event.request || {};

  if (req.type === "LaunchRequest") return askForRequest(ASK);
  if (req.type !== "IntentRequest") return speak("", { endSession: true });

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
    return askForRequest("Tell me the problem, like: the ball return on lane 3 is jammed. " + ASK);
  }
  if (name === "AMAZON.FallbackIntent") {
    return askForRequest("Sorry, I didn't catch that. " + ASK);
  }
  // Stop, Cancel, and anything else.
  return speak("Okay.");
}

exports.handler = (event) => handle(event);
exports.handle = handle;
