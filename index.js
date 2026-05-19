require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const express = require("express");

console.log("Anrufwerk Voice Core startet...");

const googlePath = "/tmp/google.json";

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  fs.writeFileSync(
    googlePath,
    process.env.GOOGLE_CREDENTIALS_JSON
  );

  process.env.GOOGLE_APPLICATION_CREDENTIALS =
    googlePath;
}

const app = express();
const PORT = process.env.PORT || 8080;

const callSessions = {};

app.use(
  express.urlencoded({
    extended: false,
  })
);

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

function signString(value) {
  return crypto
    .createHmac(
      "sha256",
      process.env
        .VOICE_WEBHOOK_SECRET || ""
    )
    .update(value)
    .digest("hex");
}

function isElevenPremium(config) {
  return (
    config?.voice
      ?.quality_mode ===
      "premium" &&
    String(
      config?.voice
        ?.provider || ""
    )
      .toLowerCase()
      .includes("eleven") &&
    config?.voice?.voice_id &&
    process.env
      .ELEVENLABS_API_KEY
  );
}

function cleanVoiceId(raw) {
  return String(raw || "")
    .split(",")[0]
    .trim();
}

function twilioSay(text) {
  return `
<Say language="de-DE" voice="Polly.Vicki">
  ${escapeXml(text)}
</Say>
  `.trim();
}

function speak(
  req,
  text,
  config
) {
  if (
    isElevenPremium(config)
  ) {
    const cleanId =
      cleanVoiceId(
        config?.voice
          ?.voice_id
      );

    const url =
      `${publicUrl(req)}/tts-elevenlabs?text=${encodeURIComponent(
        text
      )}` +
      `&voice_id=${encodeURIComponent(
        cleanId
      )}`;

    return `<Play>${escapeXml(
      url
    )}</Play>`;
  }

  return twilioSay(text);
}

function gather(
  action,
  text,
  req,
  config
) {
  if (
    isElevenPremium(config)
  ) {
    return `
${speak(
  req,
  text,
  config
)}

<Pause length="1"/>

<Gather
  input="speech"
  language="de-CH"
  timeout="6"
  speechTimeout="auto"
  actionOnEmptyResult="true"
  action="${action}"
  method="POST"
>
</Gather>
      `.trim();
  }

  return `
<Gather
  input="speech"
  language="de-CH"
  timeout="6"
  speechTimeout="auto"
  actionOnEmptyResult="true"
  action="${action}"
  method="POST"
>

  ${twilioSay(text)}

</Gather>
  `.trim();
}

async function loadVoiceConfig(
  toNumber
) {
  const signature =
    signString(toNumber);

  const url =
    `${process.env.VOICE_CONFIG_URL}?to_number=` +
    encodeURIComponent(
      toNumber
    );

  console.log(
    "Lade Voice Config für:",
    toNumber
  );

  const response =
    await fetch(url, {
      headers: {
        "x-anrufwerk-signature":
          signature,
      },
    });

  const text =
    await response.text();

  try {
    const data =
      JSON.parse(text);

    console.log(
      "Voice Config geladen:",
      JSON.stringify(data)
    );

    return data;
  } catch {
    console.error(
      "Voice Config JSON Fehler:",
      text.slice(0, 500)
    );

    return null;
  }
}

async function callOpenAI(
  messages
) {
  const response =
    await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            "gpt-4o-mini",

          temperature: 0.1,

          messages,
        }),
      }
    );

  const data =
    await response.json();

  let content =
    data.choices?.[0]
      ?.message?.content ||
    "{}";

  return content
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

async function analyzeIssue(
  text,
  config
) {
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
- Gesprächsstil: ${
        config?.voice
          ?.style ||
        "professionell"
      }

- Antwortlänge: ${
        config?.voice
          ?.response_length ||
        "medium"
      }

- Freundlichkeit: ${
        config?.voice
          ?.friendliness ||
        "high"
      }

- Natürlichkeit: ${
        config?.voice
          ?.naturalness_level ||
        "standard"
      }

Regeln:
- Antworte kurz und natürlich.
- Keine langen Robotertexte.
- Bei Notfällen:
"Ich nehme Ihre Angaben auf und leite es sofort weiter."
      `.trim(),
    },

    {
      role: "user",
      content: text,
    },
  ]);
}

async function extractPhone(
  text
) {
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
      `.trim(),
    },

    {
      role: "user",
      content: text,
    },
  ]);
}

async function sendToLovable(
  callSid
) {
  const session =
    callSessions[callSid];

  if (
    !session ||
    !process.env
      .LOVABLE_WEBHOOK_URL
  )
    return;

  const payload = {
    organization_id:
      session.organization_id,

    call_id: callSid,

    caller_name:
      session.name || null,

    caller_phone:
      session.phone ||
      session.from ||
      null,

    phone_blocks:
      session.phone_blocks ||
      null,

    intent:
      session.intent ||
      "sonstiges",

    problem_summary:
      session.summary ||
      session.issue ||
      "Anliegen telefonisch erfasst.",

    emergency: Boolean(
      session.emergency
    ),

    city: null,
    postcode: null,
    postcode_digits: null,
    street: null,
    house_number: null,
    object_details: null,

    transcript:
      session.transcript.join(
        "\n"
      ),

    slot_completion_rate:
      session.phone
        ? 0.8
        : 0.5,

    phone_exact_match:
      Boolean(
        session.phone_confirmed
      ),

    postcode_exact_match:
      false,

    city_confirmed: false,

    name_confirmed:
      Boolean(session.name),

    english_fallback_detected:
      false,

    median_turn_latency_ms: 0,
  };

  const body =
    JSON.stringify(payload);

  console.log(
    "Sende Call an Lovable:",
    body
  );

  const response =
    await fetch(
      process.env
        .LOVABLE_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-anrufwerk-signature":
            signString(body),
        },

        body,
      }
    );

  console.log(
    "Lovable Webhook Status:",
    response.status
  );

  console.log(
    "Lovable Webhook Response:",
    await response.text()
  );
}

app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "Anrufwerk Voice Core läuft."
    );
});

app.get(
  "/health",
  (req, res) => {
    res
      .status(200)
      .json({
        status: "ok",
      });
  }
);

app.get(
  "/tts-elevenlabs",
  async (req, res) => {
    try {
      const text =
        String(
          req.query.text ||
            "Guten Tag."
        );

      const voiceId =
        cleanVoiceId(
          req.query
            .voice_id
        );

      console.log(
        "ElevenLabs TTS Request:",
        {
          voiceId,
          textLength:
            text.length,
        }
      );

      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
            voiceId
          )}?optimize_streaming_latency=3&output_format=mp3_22050_32`,
          {
            method: "POST",

            headers: {
              "xi-api-key":
                process.env
                  .ELEVENLABS_API_KEY,

              "Content-Type":
                "application/json",

              Accept:
                "audio/mpeg",
            },

            body: JSON.stringify(
              {
                text,

                model_id:
                  "eleven_multilingual_v2",

                voice_settings:
                  {
                    stability: 0.55,

                    similarity_boost: 0.75,

                    style: 0.2,

                    use_speaker_boost:
                      true,
                  },
              }
            ),
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        console.error(
          "ElevenLabs TTS Fehler Status:",
          response.status
        );

        console.error(
          "ElevenLabs TTS Fehler Body:",
          errorText
        );

        res
          .status(500)
          .send(
            "ElevenLabs TTS Fehler"
          );

        return;
      }

      const audio =
        Buffer.from(
          await response.arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      res.send(audio);
    } catch (error) {
      console.error(
        "ElevenLabs TTS Fehler:",
        error.message
      );

      res
        .status(500)
        .send(
          "ElevenLabs TTS Fehler"
        );
    }
  }
);

app.post(
  "/",
  async (req, res) => {
    const callSid =
      req.body?.CallSid;

    const fromNumber =
      req.body?.From ||
      null;

    const toNumber =
      req.body?.To || "";

    console.log(
      "Twilio Call erhalten:",
      callSid
    );

    let config = null;

    try {
      config =
        await loadVoiceConfig(
          toNumber
        );
    } catch (error) {
      console.error(
        "Voice Config Fehler:",
        error.message
      );
    }

    callSessions[
      callSid
    ] = {
      from: fromNumber,
      to: toNumber,
      config,

      organization_id:
        config?.organization_id ||
        process.env
          .ORGANIZATION_ID,

      transcript: [],

      created_at:
        new Date().toISOString(),
    };

    res.type("text/xml");

    if (
      !config ||
      config.active !== true
    ) {
      res.send(`
<Response>
  ${twilioSay(
    "Guten Tag. Der Telefonassistent ist aktuell nicht aktiv."
  )}
</Response>
      `.trim());

      return;
    }

    console.log(
      "Voice Mode:",
      {
        provider:
          config?.voice
            ?.provider,

        quality_mode:
          config?.voice
            ?.quality_mode,

        elevenlabs_available:
          config?.voice
            ?.elevenlabs_available,

        premium_active:
          isElevenPremium(
            config
          ),
      }
    );

    const greeting =
      config?.routing
        ?.custom_greeting ||
      `Guten Tag. Sie sprechen mit dem Telefonassistenten von ${
        config?.organization_name ||
        "Anrufwerk"
      }. Bitte sagen Sie kurz, was Ihr Anliegen ist.`;

    res.send(`
<Response>

  ${gather(
    "/speech",
    greeting,
    req,
    config
  )}

</Response>
    `.trim());
  }
);

app.post(
  "/speech",
  async (req, res) => {
    const callSid =
      req.body?.CallSid;

    const speechText =
      req.body
        ?.SpeechResult ||
      "";

    const session =
      callSessions[
        callSid
      ];

    console.log(
      "Speech Result:",
      speechText
    );

    if (session) {
      session.issue =
        speechText;

      session.transcript.push(
        `Anliegen: ${speechText}`
      );
    }

    let aiResult = {};

    try {
      const raw =
        await analyzeIssue(
          speechText,
          session?.config
        );

      console.log(
        "AI Raw Result:",
        raw
      );

      aiResult =
        JSON.parse(raw);
    } catch (error) {
      console.error(
        "OpenAI Analyse Fehler:",
        error.message
      );

      aiResult = {
        intent:
          "sonstiges",

        emergency:
          false,

        summary:
          speechText,

        reply:
          "Vielen Dank. Ich nehme Ihr Anliegen auf.",
      };
    }

    if (session) {
      session.intent =
        aiResult.intent ||
        "sonstiges";

      session.emergency =
        Boolean(
          aiResult.emergency
        );

      session.summary =
        aiResult.summary ||
        speechText;
    }

    const reply =
      aiResult.reply ||
      "Vielen Dank. Ich nehme Ihr Anliegen auf.";

    res.type("text/xml");

    res.send(`
<Response>

  ${speak(
    req,
    reply,
    session?.config
  )}

  ${gather(
    "/name",
    "Bitte sagen Sie mir jetzt nur Ihren Vor- und Nachnamen.",
    req,
    session?.config
  )}

</Response>
    `.trim());
  }
);

app.post(
  "/name",
  (req, res) => {
    const callSid =
      req.body?.CallSid;

    const nameText =
      req.body
        ?.SpeechResult ||
      "";

    const session =
      callSessions[
        callSid
      ];

    if (session) {
      session.name =
        nameText;

      session.transcript.push(
        `Name: ${nameText}`
      );
    }

    res.type("text/xml");

    res.send(`
<Response>

  ${gather(
    "/phone",
    "Danke. Bitte sagen Sie Ihre Telefonnummer langsam, Ziffer für Ziffer.",
    req,
    session?.config
  )}

</Response>
    `.trim());
  }
);

app.post(
  "/phone",
  async (req, res) => {
    const callSid =
      req.body?.CallSid;

    const phoneText =
      req.body
        ?.SpeechResult ||
      "";

    const session =
      callSessions[
        callSid
      ];

    let phoneResult = {};

    try {
      const rawPhone =
        await extractPhone(
          phoneText
        );

      phoneResult =
        JSON.parse(
          rawPhone
        );
    } catch {
      phoneResult = {};
    }

    const phoneDigits =
      (
        phoneResult.phone_digits ||
        ""
      ).replace(/\D/g, "");

    const usableSwissNumber =
      phoneDigits.length ===
        10 &&
      [
        "076",
        "077",
        "078",
        "079",
      ].some((p) =>
        phoneDigits.startsWith(
          p
        )
      );

    if (
      !usableSwissNumber
    ) {
      res.type(
        "text/xml"
      );

      res.send(`
<Response>

  ${speak(
    req,
    "Ich konnte die Telefonnummer leider nicht korrekt verstehen.",
    session?.config
  )}

</Response>
      `.trim());

      await sendToLovable(
        callSid
      );

      return;
    }

    if (session) {
      session.phone =
        phoneDigits;

      session.phone_blocks =
        phoneResult.phone_blocks ||
        null;

      session.phone_confirmed =
        true;
    }

    await sendToLovable(
      callSid
    );

    res.type("text/xml");

    res.send(`
<Response>

  ${speak(
    req,
    "Vielen Dank. Wir haben Ihr Anliegen aufgenommen und melden uns so schnell wie möglich bei Ihnen.",
    session?.config
  )}

</Response>
    `.trim());
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `HTTP Server läuft auf Port ${PORT}`
    );

    console.log(
      "Voice Core bereit."
    );
  }
);