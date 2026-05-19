require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const express = require("express");

console.log("Anrufwerk Voice Core startet...");

const googlePath = "/tmp/google.json";
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  fs.writeFileSync(googlePath, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = googlePath;
}

const app = express();
const PORT = process.env.PORT || 8080;
const callSessions = {};

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function signString(value) {
  return crypto
    .createHmac("sha256", process.env.VOICE_WEBHOOK_SECRET || "")
    .update(value)
    .digest("hex");
}

function twilioSay(text) {
  return `<Say language="de-DE" voice="Polly.Vicki">${escapeXml(text)}</Say>`;
}

function gather(action, text) {
  return `
<Gather input="speech" language="de-CH" timeout="6" speechTimeout="auto" actionOnEmptyResult="true" action="${action}" method="POST">
  ${twilioSay(text)}
</Gather>
  `.trim();
}

async function loadVoiceConfig(toNumber) {
  const signature = signString(toNumber);
  const url = `${process.env.VOICE_CONFIG_URL}?to_number=${encodeURIComponent(toNumber)}`;

  console.log("Lade Voice Config für:", toNumber);

  const response = await fetch(url, {
    headers: { "x-anrufwerk-signature": signature },
  });

  const text = await response.text();

  try {
    const data = JSON.parse(text);
    console.log("Voice Config geladen:", JSON.stringify(data));
    return data;
  } catch {
    console.error("Voice Config JSON Fehler:", text.slice(0, 500));
    return null;
  }
}

async function callOpenAI(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages,
    }),
  });

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || "{}";

  return content.replace(/```json/g, "").replace(/```/g, "").trim();
}

async function analyzeIssue(text, config) {
  return callOpenAI([
    {
      role: "system",
      content: `
Du bist der Telefonassistent eines Schweizer Sanitär-, Heizungs- und Elektrobetriebs.

Antworte NUR als JSON.

Felder:
intent
emergency
summary
reply

Stil:
- Gesprächsstil: ${config?.voice?.style || "professionell"}
- Antwortlänge: ${config?.voice?.response_length || "medium"}
- Freundlichkeit: ${config?.voice?.friendliness || "high"}

Regeln:
- Du bist die Annahmestelle.
- Sage nie, dass der Kunde selbst einen Techniker kontaktieren soll.
- Bei Notfällen sage: "Ich nehme Ihre Angaben auf und leite es sofort weiter."
- Frage nicht nach Name oder Telefonnummer.

Notfall:
- Wasserleck
- Wasser läuft aus
- Wasser von der Decke
- Überschwemmung
- Rohrbruch
- Stromausfall
- Heizung komplett ausgefallen
      `.trim(),
    },
    { role: "user", content: text },
  ]);
}

async function extractPhone(text) {
  return callOpenAI([
    {
      role: "system",
      content: `
Du extrahierst Schweizer Telefonnummern aus schlecht transkribierter Sprache.

Antworte NUR als JSON.

Felder:
raw_text
phone_digits
phone_blocks
is_valid_swiss_mobile
confidence

Regeln:
- Schweizer Mobile Nummern haben 10 Ziffern.
- Sie beginnen mit 076, 077, 078 oder 079.
- null/nul/zero = 0
- eins/ein = 1
- zwei = 2
- drei = 3
- vier = 4
- fünf = 5
- sechs = 6
- sieben = 7
- acht = 8
- neun = 9
      `.trim(),
    },
    { role: "user", content: text },
  ]);
}

async function sendToLovable(callSid) {
  const session = callSessions[callSid];
  if (!session || !process.env.LOVABLE_WEBHOOK_URL) return;

  const payload = {
    organization_id: session.organization_id,
    call_id: callSid,
    caller_name: session.name || null,
    caller_phone: session.phone || session.from || null,
    phone_blocks: session.phone_blocks || null,
    intent: session.intent || "sonstiges",
    problem_summary:
      session.summary || session.issue || "Anliegen telefonisch erfasst.",
    emergency: Boolean(session.emergency),
    city: null,
    postcode: null,
    postcode_digits: null,
    street: null,
    house_number: null,
    object_details: null,
    transcript: session.transcript.join("\n"),
    slot_completion_rate: session.phone ? 0.8 : 0.5,
    phone_exact_match: Boolean(session.phone_confirmed),
    postcode_exact_match: false,
    city_confirmed: false,
    name_confirmed: Boolean(session.name),
    english_fallback_detected: false,
    median_turn_latency_ms: 0,
  };

  const body = JSON.stringify(payload);

  console.log("Sende Call an Lovable:", body);

  const response = await fetch(process.env.LOVABLE_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-anrufwerk-signature": signString(body),
    },
    body,
  });

  console.log("Lovable Webhook Status:", response.status);
  console.log("Lovable Webhook Response:", await response.text());
}

app.get("/", (req, res) => {
  res.status(200).send("Anrufwerk Voice Core läuft.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/", async (req, res) => {
  const callSid = req.body?.CallSid;
  const fromNumber = req.body?.From || null;
  const toNumber = req.body?.To || "";

  console.log("Twilio Call erhalten:", callSid);
  console.log("From:", fromNumber);
  console.log("To:", toNumber);

  let config = null;

  try {
    config = await loadVoiceConfig(toNumber);
  } catch (error) {
    console.error("Voice Config Fehler:", error.message);
  }

  callSessions[callSid] = {
    from: fromNumber,
    to: toNumber,
    config,
    organization_id: config?.organization_id || process.env.ORGANIZATION_ID,
    transcript: [],
    created_at: new Date().toISOString(),
  };

  res.type("text/xml");

  if (!config || config.active !== true) {
    res.send(`
<Response>
  ${twilioSay("Guten Tag. Der Telefonassistent ist aktuell nicht aktiv.")}
</Response>
    `.trim());
    return;
  }

  const greeting =
    config?.routing?.custom_greeting ||
    `Guten Tag. Sie sprechen mit dem Telefonassistenten von ${
      config?.organization_name || "Anrufwerk"
    }. Bitte sagen Sie kurz, was Ihr Anliegen ist.`;

  res.send(`
<Response>
  ${gather("/speech", greeting)}
</Response>
  `.trim());
});

app.post("/speech", async (req, res) => {
  const callSid = req.body?.CallSid;
  const speechText = req.body?.SpeechResult || "";
  const session = callSessions[callSid];

  console.log("Speech Result:", speechText);
  console.log("Confidence:", req.body?.Confidence);

  if (session) {
    session.issue = speechText;
    session.transcript.push(`Anliegen: ${speechText}`);
  }

  let aiResult = {};

  try {
    const raw = await analyzeIssue(speechText, session?.config);
    console.log("AI Raw Result:", raw);
    aiResult = JSON.parse(raw);
  } catch (error) {
    console.error("OpenAI Analyse Fehler:", error.message);
    aiResult = {
      intent: "sonstiges",
      emergency: false,
      summary: speechText,
      reply: "Vielen Dank. Ich nehme Ihr Anliegen auf.",
    };
  }

  if (session) {
    session.intent = aiResult.intent || "sonstiges";
    session.emergency = Boolean(aiResult.emergency);
    session.summary = aiResult.summary || speechText;
  }

  const reply = aiResult.reply || "Vielen Dank. Ich nehme Ihr Anliegen auf.";

  res.type("text/xml");

  res.send(`
<Response>
  ${twilioSay(reply)}
  ${gather("/name", "Bitte sagen Sie mir jetzt nur Ihren Vor- und Nachnamen.")}
</Response>
  `.trim());
});

app.post("/name", (req, res) => {
  const callSid = req.body?.CallSid;
  const nameText = req.body?.SpeechResult || "";
  const session = callSessions[callSid];

  console.log("Name Result:", nameText);
  console.log("Name Confidence:", req.body?.Confidence);

  if (session) {
    session.name = nameText;
    session.transcript.push(`Name: ${nameText}`);
  }

  res.type("text/xml");

  res.send(`
<Response>
  ${gather(
    "/phone",
    "Danke. Bitte sagen Sie Ihre Telefonnummer langsam, Ziffer für Ziffer."
  )}
</Response>
  `.trim());
});

app.post("/phone", async (req, res) => {
  const callSid = req.body?.CallSid;
  const phoneText = req.body?.SpeechResult || "";
  const session = callSessions[callSid];

  console.log("Phone Result:", phoneText);
  console.log("Phone Confidence:", req.body?.Confidence);

  if (session) {
    session.transcript.push(`Telefon Rohtext: ${phoneText}`);
  }

  let phoneResult = {};

  try {
    const rawPhone = await extractPhone(phoneText);
    console.log("Phone AI Raw Result:", rawPhone);
    phoneResult = JSON.parse(rawPhone);
  } catch (error) {
    console.error("Phone Extraction Fehler:", error.message);
    phoneResult = {};
  }

  const phoneDigits = (phoneResult.phone_digits || "").replace(/\D/g, "");

  const usableSwissNumber =
    phoneDigits.length === 10 &&
    ["076", "077", "078", "079"].some((p) => phoneDigits.startsWith(p));

  if (!usableSwissNumber) {
    res.type("text/xml");

    res.send(`
<Response>
  ${twilioSay(
    "Ich konnte die Telefonnummer leider nicht korrekt verstehen. Wir verwenden wenn möglich die angezeigte Anrufernummer."
  )}
</Response>
    `.trim());

    await sendToLovable(callSid);
    return;
  }

  if (session) {
    session.phone = phoneDigits;
    session.phone_blocks = phoneResult.phone_blocks || null;
    session.phone_confirmed = true;
  }

  await sendToLovable(callSid);

  res.type("text/xml");

  res.send(`
<Response>
  ${twilioSay(
    "Vielen Dank. Wir haben Ihr Anliegen aufgenommen und melden uns so schnell wie möglich bei Ihnen."
  )}
</Response>
  `.trim());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Voice Core bereit.");
});