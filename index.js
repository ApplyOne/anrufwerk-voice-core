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

async function analyzeWithOpenAI(text) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
Du bist der Telefonassistent eines Schweizer Sanitär-, Heizungs- und Elektrobetriebs.
Analysiere den Anruftext.
Antworte nur als JSON.

Felder:
intent: sanitaer|heizung|elektro|sonstiges
emergency: true|false
summary: kurze Zusammenfassung
reply: kurze professionelle Antwort auf Hochdeutsch

Notfall = Wasserleck, Rohrbruch, Überschwemmung, Heizung komplett ausgefallen, Stromausfall.
          `.trim(),
        },
        {
          role: "user",
          content: text,
        },
      ],
    }),
  });

  const data = await response.json();
  console.log("FULL OPENAI RESPONSE:", JSON.stringify(data));

return data.choices?.[0]?.message?.content || "{}";
}

app.get("/", (req, res) => {
  res.status(200).send("Anrufwerk Voice Core läuft.");
});

app.post("/", (req, res) => {
  console.log("Twilio Call erhalten:", req.body?.CallSid);

  res.type("text/xml");
  res.send(`
<Response>
  <Gather input="speech" language="de-CH" speechTimeout="auto" action="/speech" method="POST">
    <Say language="de-DE" voice="Polly.Vicki">Guten Tag. Bitte sagen Sie kurz, was Ihr Anliegen ist.</Say>
  </Gather>
  <Say language="de-DE" voice="Polly.Vicki">Ich habe leider nichts verstanden. Bitte rufen Sie nochmals an.</Say>
</Response>
  `.trim());
});

app.post("/speech", async (req, res) => {
  const speechText = req.body?.SpeechResult || "";

  console.log("Speech Result:", speechText);
  console.log("Confidence:", req.body?.Confidence);

  let aiResult = {};
  try {
    const raw = await analyzeWithOpenAI(speechText);
    console.log("AI Raw Result:", raw);
    aiResult = JSON.parse(raw);
  } catch (error) {
    console.error("OpenAI Fehler:", error.message);
    aiResult = {
      emergency: false,
      reply: "Vielen Dank. Ich habe Ihr Anliegen erfasst.",
    };
  }

  const reply = aiResult.reply || "Vielen Dank. Ich habe Ihr Anliegen erfasst.";

  res.type("text/xml");
  res.send(`
<Response>
  <Say language="de-DE" voice="Polly.Vicki">${reply}</Say>
</Response>
  `.trim());
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Voice Core bereit.");
});