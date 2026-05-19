require("dotenv").config();

const fs = require("fs");
const express = require("express");

console.log("Anrufwerk Voice Core startet...");

const googlePath = "/tmp/google.json";

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  fs.writeFileSync(
    googlePath,
    process.env.GOOGLE_CREDENTIALS_JSON
  );

  process.env.GOOGLE_APPLICATION_CREDENTIALS = googlePath;
}

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

async function callOpenAI(messages) {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
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
    }
  );

  const data = await response.json();

  console.log(
    "FULL OPENAI RESPONSE:",
    JSON.stringify(data)
  );

  let content =
    data.choices?.[0]?.message?.content || "{}";

  content = content
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return content;
}

async function analyzeIssue(text) {
  return callOpenAI([
    {
      role: "system",
      content: `
Du bist der Telefonassistent eines Schweizer Sanitär-, Heizungs- und Elektrobetriebs.

Analysiere den Text.

Antworte NUR als JSON.

Felder:
intent: sanitaer|heizung|elektro|sonstiges
emergency: true|false
summary: kurze Zusammenfassung
reply: professionelle kurze Antwort

Wichtig:
- Sage nie, dass der Kunde selbst einen Techniker kontaktieren soll.
- Du bist die Annahmestelle.
- Bei Notfällen sage:
  "Ich nehme Ihre Angaben auf und leite es sofort weiter."
- Frage NICHT nach Telefonnummer oder Name.

Notfall:
- Wasserleck
- Wasser läuft aus
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

Wenn eine Nummer wie:
"null sieben neun vier zwei fünf null null zwei drei"
erkannt wird,
gib 0794250023 zurück.

Wenn mindestens 9 sinnvolle Ziffern erkannt wurden,
gilt die Nummer als verwendbar.
      `.trim(),
    },
    {
      role: "user",
      content: text,
    },
  ]);
}

app.get("/", (req, res) => {
  res
    .status(200)
    .send("Anrufwerk Voice Core läuft.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.post("/", (req, res) => {
  console.log(
    "Twilio Call erhalten:",
    req.body?.CallSid
  );

  res.type("text/xml");

  res.send(`
<Response>

  <Gather
    input="speech"
    language="de-CH"
    speechTimeout="auto"
    action="/speech"
    method="POST"
  >
    <Say language="de-DE" voice="Polly.Vicki">
      Guten Tag.
      Bitte sagen Sie kurz, was Ihr Anliegen ist.
    </Say>
  </Gather>

  <Say language="de-DE" voice="Polly.Vicki">
    Ich habe leider nichts verstanden.
    Bitte rufen Sie nochmals an.
  </Say>

</Response>
  `.trim());
});

app.post("/speech", async (req, res) => {
  const speechText =
    req.body?.SpeechResult || "";

  console.log(
    "Speech Result:",
    speechText
  );

  console.log(
    "Confidence:",
    req.body?.Confidence
  );

  let aiResult = {};

  try {
    const raw =
      await analyzeIssue(speechText);

    console.log(
      "AI Raw Result:",
      raw
    );

    aiResult = JSON.parse(raw);
  } catch (error) {
    console.error(
      "OpenAI Fehler:",
      error.message
    );

    aiResult = {
      emergency: false,
      reply:
        "Vielen Dank. Ich nehme Ihr Anliegen auf.",
    };
  }

  const reply =
    aiResult.reply ||
    "Vielen Dank. Ich nehme Ihr Anliegen auf.";

  res.type("text/xml");

  res.send(`
<Response>

  <Say language="de-DE" voice="Polly.Vicki">
    ${reply}
  </Say>

  <Gather
    input="speech"
    language="de-CH"
    speechTimeout="auto"
    action="/name"
    method="POST"
  >
    <Say language="de-DE" voice="Polly.Vicki">
      Bitte sagen Sie mir jetzt nur Ihren Vor-
      und Nachnamen.
    </Say>
  </Gather>

  <Say language="de-DE" voice="Polly.Vicki">
    Ich habe den Namen leider nicht verstanden.
  </Say>

  <Redirect method="POST">
    /ask-phone
  </Redirect>

</Response>
  `.trim());
});

app.post("/name", (req, res) => {
  const nameText =
    req.body?.SpeechResult || "";

  console.log(
    "Name Result:",
    nameText
  );

  console.log(
    "Name Confidence:",
    req.body?.Confidence
  );

  res.type("text/xml");

  res.send(`
<Response>

  <Redirect method="POST">
    /ask-phone
  </Redirect>

</Response>
  `.trim());
});

app.post("/ask-phone", (req, res) => {
  res.type("text/xml");

  res.send(`
<Response>

  <Gather
    input="speech"
    language="de-CH"
    speechTimeout="auto"
    action="/phone"
    method="POST"
  >
    <Say language="de-DE" voice="Polly.Vicki">
      Danke.

      Bitte sagen Sie Ihre Telefonnummer langsam,
      Ziffer für Ziffer.

      Zum Beispiel:
      null sieben neun vier zwei fünf null null zwei drei.
    </Say>
  </Gather>

  <Say language="de-DE" voice="Polly.Vicki">
    Ich habe die Telefonnummer leider nicht verstanden.
  </Say>

</Response>
  `.trim());
});

app.post("/phone", async (req, res) => {
  const phoneText =
    req.body?.SpeechResult || "";

  console.log(
    "Phone Result:",
    phoneText
  );

  console.log(
    "Phone Confidence:",
    req.body?.Confidence
  );

  let phoneResult = {};

  try {
    const rawPhone =
      await extractPhone(phoneText);

    console.log(
      "Phone AI Raw Result:",
      rawPhone
    );

    phoneResult = JSON.parse(rawPhone);

    console.log(
      "Phone Extracted:",
      JSON.stringify(phoneResult)
    );
  } catch (error) {
    console.error(
      "Phone Extraction Fehler:",
      error.message
    );

    phoneResult = {};
  }

  const phoneDigits =
    (phoneResult.phone_digits || "")
      .replace(/\D/g, "");

  const usableSwissNumber =
    phoneDigits.length >= 9 &&
    phoneDigits.length <= 10 &&
    (
      phoneDigits.startsWith("07") ||
      phoneDigits.startsWith("79") ||
      phoneDigits.startsWith("78") ||
      phoneDigits.startsWith("77") ||
      phoneDigits.startsWith("76")
    );

  console.log(
    "Final usable number:",
    phoneDigits
  );

  if (usableSwissNumber) {

    res.type("text/xml");

    res.send(`
<Response>

  <Say language="de-DE" voice="Polly.Vicki">
    Vielen Dank.

    Ich habe Ihre Telefonnummer aufgenommen.

    Wir melden uns so schnell wie möglich bei Ihnen.
  </Say>

</Response>
    `.trim());

    return;
  }

  res.type("text/xml");

  res.send(`
<Response>

  <Gather
    input="speech"
    language="de-CH"
    speechTimeout="auto"
    action="/phone-final"
    method="POST"
  >
    <Say language="de-DE" voice="Polly.Vicki">
      Entschuldigung.

      Ich habe die Telefonnummer nicht ganz verstanden.

      Bitte sagen Sie sie nochmals langsam,
      Ziffer für Ziffer.
    </Say>
  </Gather>

  <Say language="de-DE" voice="Polly.Vicki">
    Danke.

    Wir haben Ihr Anliegen aufgenommen.

    Falls Ihre Telefonnummer nicht vollständig erkannt wurde,
    verwenden wir wenn möglich die angezeigte Anrufernummer.
  </Say>

</Response>
  `.trim());
});

app.post("/phone-final", (req, res) => {

  console.log(
    "Final phone attempt:",
    req.body?.SpeechResult
  );

  console.log(
    "Final phone confidence:",
    req.body?.Confidence
  );

  res.type("text/xml");

  res.send(`
<Response>

  <Say language="de-DE" voice="Polly.Vicki">
    Vielen Dank.

    Wir haben Ihr Anliegen aufgenommen
    und melden uns so schnell wie möglich bei Ihnen.
  </Say>

</Response>
  `.trim());
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `HTTP Server läuft auf Port ${PORT}`
  );

  console.log("Voice Core bereit.");
});