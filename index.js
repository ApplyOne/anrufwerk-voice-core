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
<Say language="de-DE" voice="Polly.Vicki">Guten Tag. Hier ist der telefonische Assistent. Wie kann ich Ihnen helfen?</Say>  <Pause length="1"/>
<Say language="de-DE" voice="Polly.Vicki">Vielen Dank. Dies ist ein erster Verbindungstest.</Say></Response>
  `.trim());
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Voice Core bereit.");
});