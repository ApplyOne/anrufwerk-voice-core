require("dotenv").config();

const fs = require("fs");

const {
  defineAgent,
  cli,
} = require("@livekit/agents");

const { openai } = require("@livekit/agents-plugin-openai");

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