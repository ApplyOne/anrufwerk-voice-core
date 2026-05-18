require("dotenv").config();

const fs = require("fs");

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
  "GOOGLE_APPLICATION_CREDENTIALS",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Fehlt: ${key}`);
    process.exit(1);
  }
}

if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  console.error("Google JSON Datei nicht gefunden.");
  process.exit(1);
}

console.log("Alle Environment Variablen vorhanden.");
console.log("Google Credentials gefunden.");
console.log("Voice Core bereit.");