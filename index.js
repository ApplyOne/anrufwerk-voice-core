require("dotenv").config();

const fs = require("fs");
const express = require("express");

const {
  defineAgent,
  cli,
} = require("@livekit/agents");

const { openai } = require("@livekit/agents-plugin-openai");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Anrufwerk Voice Core läuft.");
});

app.listen(PORT, () => {
  console.log(`HTTP Server läuft auf Port ${PORT}`);
});

console.log("Anrufwerk Voice Core startet...");

const googlePath = "/tmp/google.json";

fs.writeFileSync(
  googlePath,
  process.env.GOOGLE_CREDENTIALS_JSON
);

process.env.GOOGLE_APPLICATION_CREDENTIALS = googlePath;

const agent = defineAgent({
  entry: async (ctx) => {
    console.log("Agent gestartet");

    const model = openai.realtime.RealtimeModel.withAzure({
      apiKey: process.env.OPENAI_API_KEY,
      instructions: `
Du bist der Telefonassistent eines Schweizer Sanitär-, Heizungs- und Elektrobetriebs.

Antworte immer auf Deutsch.
Sprich professionelles Schweizer Hochdeutsch.
Verstehe Schweizerdeutsch.
Halte Antworten kurz.
`,
    });

    await ctx.connect();

    const session = model.session();

    session.conversation.item.create({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "input_text",
          text: "Guten Tag. Wie kann ich Ihnen helfen?",
        },
      ],
    });

    session.response.create();
  },
});

cli.runApp(agent);