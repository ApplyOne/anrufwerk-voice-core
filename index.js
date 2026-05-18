require("dotenv").config();

const fs = require("fs");
const express = require("express");

console.log("Anrufwerk Voice Core startet...");

const requiredEnv = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "OPENAI_API_KEY",
  "AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "GOOGLE_CREDENTIALS_JSON",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Fehlt: ${key}`);
    process.exit(1);
  }
}

const googlePath = "/tmp/google.json";
fs.writeFileSync(googlePath, process.env.GOOGLE_CREDENTIALS_JSON);
process.env.GOOGLE_APPLICATION_CREDENTIALS = googlePath;

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.status(200).send("Anrufwerk Voice Core läuft.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "anrufwerk-voice-core",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
  console.log("Alle Environment Variablen vorhanden.");
  console.log("Google Credentials aus Railway Variable erstellt.");
  console.log("Voice Core bereit.");
});