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

function signPayload(payload) {
  return signString(payload);
}

function twilioSay(text) {
  return `
<Say language="de-DE" voice="Polly.Vicki">
  ${escapeXml(text)}
</Say>
  `.trim();
}

async function loadVoiceConfig(toNumber) {
  if (!process.env.VOICE_CONFIG_URL) {
    console.log("VOICE_CONFIG_URL fehlt.");
    return null;
  }

  if (!process.env.VOICE_WEBHOOK_SECRET) {
    console.log("VOICE_WEBHOOK_SECRET fehlt.");
    return null;
  }

  const signature = signString(toNumber);
  const url =
    `${process.env.VOICE_CONFIG_URL}?to_number=` +
    encodeURIComponent(toNumber);

  console.log("Lade Voice Config für:", toNumber);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-anrufwerk-signature": signature,
    },
  });

  const data = await response.json();

  console.log("Voice Config geladen:", JSON.stringify(data));

  return data;
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

  console.log("FULL OPENAI RESPONSE:", JSON.stringify(data));

  let content = data.choices?.[0]?.message?.content || "{}";

  content = content
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return content;
}

async function analyzeIssue(text, config) {
  const style = config?.voice?.style || "professionell";
  const responseLength = config?.voice?.response_length || "medium";
  const friendliness = config?.voice?.friendliness || "high";

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
- Gesprächsstil: ${style}
- Antwortlänge: ${responseLength}
- Freundlichkeit: ${friendliness}

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
    {
      role: "user",
      content: text,
    },
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
- Sie beginnen oft mit 076, 077, 078 oder 079.
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
- Beispiel: "null sieben neun vier zwei fünf null null zwei drei" = 0794250023
      `.trim(),
    },
    {
      role: "user",
      content: text,
    },
  ]);
}

async function sendToLovable(callSid) {
  const session = callSessions[callSid];

  if (!session) {
    console.log("Keine Session gefunden:", callSid);
    return;
  }

  if (!process.env.LOVABLE_WEBHOOK_URL || !process.env.VOICE_WEBHOOK_SECRET) {
    console.log("Lovable Webhook nicht konfiguriert.");
    return;
  }

  const payload = {
    organization_id:
      session.organization_id || process.env.ORGANIZATION_ID || null,

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
  const signature = signPayload(body);

  const headers = {
    "Content-Type": "application/json",
    "x-anrufwerk-signature": signature,
  };

  console.log("Sende Call an Lovable:", body);

  try {
    const response = await fetch(process.env.LOVABLE_WEBHOOK_URL, {
      method: "POST",
      headers,
      body,
    });

    const text = await response.text();

    console.log("Lovable Webhook Status:", response.status);
    console.log("Lovable Webhook Response:", text);
  } catch (error) {
    console.error("Lovable Webhook Fehler:", error.message);
  }
}

app.get("/", (req, res) => {
  res.status(200).send("Anrufwerk Voice Core läuft.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
  });
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
    const reason = config?.active_reason || "unavailable";

    console.log("Assistent nicht aktiv:", reason);

    res.send(`
<Response>
  ${twilioSay(
    "Guten Tag. Der Telefonassistent ist aktuell nicht aktiv. Bitte versuchen Sie es später nochmals."
  )}
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
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/speech" method="POST">
    ${twilioSay(greeting)}
  </Gather>

  ${twilioSay("Ich habe leider nichts verstanden. Bitte rufen Sie nochmals an.")}
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
    console.error("OpenAI Fehler:", error.message);

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

  const reply =
    aiResult.reply || "Vielen Dank. Ich nehme Ihr Anliegen auf.";

  res.type("text/xml");

  res.send(`
<Response>
  ${twilioSay(reply)}

  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/name" method="POST">
    ${twilioSay("Bitte sagen Sie mir jetzt nur Ihren Vor- und Nachnamen.")}
  </Gather>

  ${twilioSay("Ich habe den Namen leider nicht verstanden.")}

  <Redirect method="POST">/ask-phone</Redirect>
</Response>
  `.trim());
});

app.post("/name", (req, res) => {
  const callSid = req.body?.CallSid;
  const nameText = req.body?.SpeechResult || "";

  console.log("Name Result:", nameText);
  console.log("Name Confidence:", req.body?.Confidence);

  if (callSessions[callSid]) {
    callSessions[callSid].name = nameText;
    callSessions[callSid].transcript.push(`Name: ${nameText}`);
  }

  res.type("text/xml");

  res.send(`
<Response>
  <Redirect method="POST">/ask-phone</Redirect>
</Response>
  `.trim());
});

app.post("/ask-phone", (req, res) => {
  res.type("text/xml");

  res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/phone" method="POST">
    ${twilioSay(
      "Danke. Bitte sagen Sie Ihre Telefonnummer langsam, Ziffer für Ziffer. Zum Beispiel: null sieben neun vier zwei fünf null null zwei drei."
    )}
  </Gather>

  ${twilioSay("Ich habe die Telefonnummer leider nicht verstanden.")}
</Response>
  `.trim());
});

app.post("/phone", async (req, res) => {
  const callSid = req.body?.CallSid;
  const phoneText = req.body?.SpeechResult || "";

  console.log("Phone Result:", phoneText);
  console.log("Phone Confidence:", req.body?.Confidence);

  if (callSessions[callSid]) {
    callSessions[callSid].transcript.push(`Telefon Rohtext: ${phoneText}`);
  }

  let phoneResult = {};

  try {
    const rawPhone = await extractPhone(phoneText);
    console.log("Phone AI Raw Result:", rawPhone);
    phoneResult = JSON.parse(rawPhone);
    console.log("Phone Extracted:", JSON.stringify(phoneResult));
  } catch (error) {
    console.error("Phone Extraction Fehler:", error.message);
    phoneResult = {};
  }

  const phoneDigits = (phoneResult.phone_digits || "").replace(/\D/g, "");

  const usableSwissNumber =
    phoneDigits.length === 10 &&
    (
      phoneDigits.startsWith("076") ||
      phoneDigits.startsWith("077") ||
      phoneDigits.startsWith("078") ||
      phoneDigits.startsWith("079")
    );

  console.log("Final usable number:", phoneDigits);

  if (!usableSwissNumber) {
    res.type("text/xml");

    res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/phone-final" method="POST">
    ${twilioSay(
      "Entschuldigung. Ich habe die Telefonnummer nicht ganz verstanden. Bitte sagen Sie sie nochmals langsam, Ziffer für Ziffer."
    )}
  </Gather>

  ${twilioSay(
    "Danke. Wir haben Ihr Anliegen aufgenommen. Falls Ihre Telefonnummer nicht vollständig erkannt wurde, verwenden wir wenn möglich die angezeigte Anrufernummer."
  )}
</Response>
    `.trim());

    return;
  }

  if (callSessions[callSid]) {
    callSessions[callSid].phone = phoneDigits;
    callSessions[callSid].phone_blocks = phoneResult.phone_blocks || null;
  }

  const readablePhone = phoneDigits.split("").join(" ");

  res.type("text/xml");

  res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/confirm-phone?phone=${phoneDigits}" method="POST">
    ${twilioSay(
      `Ich habe folgende Telefonnummer verstanden: ${readablePhone}. Ist das korrekt? Bitte sagen Sie Ja oder Nein.`
    )}
  </Gather>

  ${twilioSay("Ich konnte die Bestätigung nicht verstehen.")}
</Response>
  `.trim());
});

app.post("/phone-final", async (req, res) => {
  const callSid = req.body?.CallSid;
  const phoneText = req.body?.SpeechResult || "";

  console.log("Final phone attempt:", phoneText);
  console.log("Final phone confidence:", req.body?.Confidence);

  if (callSessions[callSid]) {
    callSessions[callSid].transcript.push(
      `Telefon finaler Versuch: ${phoneText}`
    );
  }

  res.type("text/xml");

  await sendToLovable(callSid);

  res.send(`
<Response>
  ${twilioSay(
    "Vielen Dank. Wir haben Ihr Anliegen aufgenommen. Falls Ihre Telefonnummer nicht korrekt erfasst wurde, verwenden wir wenn möglich die angezeigte Anrufernummer."
  )}
</Response>
  `.trim());
});

app.post("/confirm-phone", async (req, res) => {
  const callSid = req.body?.CallSid;
  const confirmation = (req.body?.SpeechResult || "").toLowerCase();
  const phone = req.query.phone || "";

  console.log("Phone confirmation:", confirmation);
  console.log("Confirmed phone candidate:", phone);

  const isYes =
    confirmation.includes("ja") ||
    confirmation.includes("korrekt") ||
    confirmation.includes("stimmt") ||
    confirmation.includes("richtig");

  if (callSessions[callSid]) {
    callSessions[callSid].phone_confirmed = isYes;
    callSessions[callSid].transcript.push(`Telefon bestätigt: ${confirmation}`);

    if (isYes && phone) {
      callSessions[callSid].phone = phone;
    }
  }

  res.type("text/xml");

  if (isYes) {
    await sendToLovable(callSid);

    res.send(`
<Response>
  ${twilioSay(
    "Perfekt. Vielen Dank. Wir haben Ihr Anliegen aufgenommen und melden uns so schnell wie möglich bei Ihnen."
  )}
</Response>
    `.trim());

    return;
  }

  res.send(`
<Response>
  <Redirect method="POST">/ask-phone</Redirect>
</Response>
  `.trim());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Voice Core bereit.");
});