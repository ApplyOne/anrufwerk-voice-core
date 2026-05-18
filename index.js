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

app.post("/speech", (req, res) => {
  console.log("Speech Result:", req.body?.SpeechResult);
  console.log("Confidence:", req.body?.Confidence);

  res.type("text/xml");
  res.send(`
<Response>
  <Say language="de-DE" voice="Polly.Vicki">Vielen Dank. Ich habe Ihr Anliegen erfasst.</Say>
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