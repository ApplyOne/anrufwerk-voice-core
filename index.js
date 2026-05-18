require("dotenv").config();

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

function publicUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function azureSay(req, text) {
  const url = `${publicUrl(req)}/tts?text=${encodeURIComponent(text)}`;
  return `<Play>${url}</Play>`;
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
  content = content.replace(/```json/g, "").replace(/```/g, "").trim();

  return content;
}

async function analyzeIssue(text) {
  return callOpenAI([
    {
      role: "system",
      content: `
Du bist der Telefonassistent eines Schweizer Sanitär-, Heizungs- und Elektrobetriebs.
Antworte NUR als JSON.

Felder:
intent: sanitaer|heizung|elektro|sonstiges
emergency: true|false
summary: kurze Zusammenfassung
reply: professionelle kurze Antwort

Wichtig:
- Du bist die Annahmestelle.
- Sage nie, dass der Kunde selbst einen Techniker kontaktieren soll.
- Bei Notfällen sage: "Ich nehme Ihre Angaben auf und leite es sofort weiter."
- Frage nicht nach Name oder Telefonnummer.

Notfall:
- Wasserleck
- Wasser läuft aus
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
- Schweizer Mobile Nummern beginnen mit 076, 077, 078 oder 079.
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
    { role: "user", content: text },
  ]);
}

app.get("/", (req, res) => {
  res.status(200).send("Anrufwerk Voice Core läuft.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/tts", async (req, res) => {
  const text = req.query.text || "Guten Tag.";

  try {
    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;

    const ssml = `
<speak version="1.0" xml:lang="de-CH">
  <voice xml:lang="de-CH" name="de-CH-LeniNeural">
    <prosody rate="-5%" pitch="+0%">
      ${escapeXml(text)}
    </prosody>
  </voice>
</speak>
    `.trim();

    const azureResponse = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
          "User-Agent": "anrufwerk-voice-core",
        },
        body: ssml,
      }
    );

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.error("Azure TTS Fehler:", errorText);
      res.status(500).send("TTS Fehler");
      return;
    }

    const audioBuffer = Buffer.from(await azureResponse.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (error) {
    console.error("TTS Fehler:", error.message);
    res.status(500).send("TTS Fehler");
  }
});

app.post("/", (req, res) => {
  console.log("Twilio Call erhalten:", req.body?.CallSid);

  res.type("text/xml");
  res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/speech" method="POST">
    ${azureSay(req, "Guten Tag. Bitte sagen Sie kurz, was Ihr Anliegen ist.")}
  </Gather>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/speech" method="POST">
    ${azureSay(req, "Ich habe leider nichts verstanden. Bitte sagen Sie Ihr Anliegen nochmals kurz.")}
  </Gather>
  ${azureSay(req, "Entschuldigung. Ich konnte Sie nicht verstehen. Bitte versuchen Sie es später nochmals.")}
</Response>
  `.trim());
});

app.post("/speech", async (req, res) => {
  const speechText = req.body?.SpeechResult || "";

  console.log("Speech Result:", speechText);
  console.log("Confidence:", req.body?.Confidence);

  let aiResult = {};

  try {
    const raw = await analyzeIssue(speechText);
    console.log("AI Raw Result:", raw);
    aiResult = JSON.parse(raw);
  } catch (error) {
    console.error("OpenAI Fehler:", error.message);
    aiResult = {
      reply: "Vielen Dank. Ich nehme Ihr Anliegen auf.",
    };
  }

  const reply = aiResult.reply || "Vielen Dank. Ich nehme Ihr Anliegen auf.";

  res.type("text/xml");
  res.send(`
<Response>
  ${azureSay(req, reply)}
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/name" method="POST">
    ${azureSay(req, "Bitte sagen Sie mir jetzt nur Ihren Vor- und Nachnamen.")}
  </Gather>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/name" method="POST">
    ${azureSay(req, "Ich habe den Namen leider nicht verstanden. Bitte sagen Sie nur Ihren Vor- und Nachnamen.")}
  </Gather>
  ${azureSay(req, "Ich konnte den Namen leider nicht sicher erfassen. Ich fahre trotzdem fort.")}
  <Redirect method="POST">/ask-phone</Redirect>
</Response>
  `.trim());
});

app.post("/name", (req, res) => {
  console.log("Name Result:", req.body?.SpeechResult);
  console.log("Name Confidence:", req.body?.Confidence);

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
    ${azureSay(req, "Danke. Bitte sagen Sie Ihre Telefonnummer langsam, Ziffer für Ziffer. Zum Beispiel: null sieben neun vier zwei fünf null null zwei drei.")}
  </Gather>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/phone" method="POST">
    ${azureSay(req, "Ich habe die Telefonnummer leider nicht verstanden. Bitte sagen Sie nur die Telefonnummer langsam, Ziffer für Ziffer.")}
  </Gather>
  ${azureSay(req, "Ich konnte die Telefonnummer leider nicht sicher erfassen. Ihr Anliegen wurde trotzdem aufgenommen.")}
</Response>
  `.trim());
});

app.post("/phone", async (req, res) => {
  const phoneText = req.body?.SpeechResult || "";

  console.log("Phone Result:", phoneText);
  console.log("Phone Confidence:", req.body?.Confidence);

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

  const phoneDigits = phoneResult.phone_digits || "";
  const isValidSwissMobile =
    phoneResult.is_valid_swiss_mobile &&
    phoneDigits.length === 10 &&
    phoneDigits.startsWith("07");

  if (!isValidSwissMobile) {
    res.type("text/xml");
    res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/phone" method="POST">
    ${azureSay(req, "Entschuldigung. Ich habe die Telefonnummer nicht sicher verstanden. Bitte sagen Sie sie nochmals langsam, Ziffer für Ziffer.")}
  </Gather>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/phone" method="POST">
    ${azureSay(req, "Ich versuche es nochmals. Bitte nennen Sie nur die Telefonnummer.")}
  </Gather>
  ${azureSay(req, "Danke. Wir haben Ihr Anliegen aufgenommen. Falls Ihre Telefonnummer nicht korrekt erfasst wurde, rufen wir Sie über die angezeigte Anrufernummer zurück, sofern diese verfügbar ist.")}
</Response>
    `.trim());
    return;
  }

  const readablePhone =
    phoneResult.phone_blocks && phoneResult.phone_blocks.length
      ? phoneResult.phone_blocks.join(" ")
      : phoneDigits;

  res.type("text/xml");
  res.send(`
<Response>
  ${azureSay(req, `Vielen Dank. Ich habe Ihre Telefonnummer als ${readablePhone} erfasst. Wir melden uns so schnell wie möglich bei Ihnen.`)}
</Response>
  `.trim());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Voice Core bereit.");
});