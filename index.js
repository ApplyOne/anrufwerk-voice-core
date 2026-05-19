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
    phoneDigits.length === 10 &&
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

  if (!usableSwissNumber) {

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

    return;
  }

  const readablePhone =
    phoneDigits
      .match(/.{1,3}/g)
      ?.join(" ") || phoneDigits;

  res.type("text/xml");

  res.send(`
<Response>

  <Gather
    input="speech"
    language="de-CH"
    speechTimeout="auto"
    action="/confirm-phone"
    method="POST"
  >

    <Say language="de-DE" voice="Polly.Vicki">
      Ich habe folgende Telefonnummer verstanden:

      ${readablePhone}

      Ist das korrekt?

      Bitte sagen Sie Ja oder Nein.
    </Say>

  </Gather>

  <Say language="de-DE" voice="Polly.Vicki">
    Entschuldigung.

    Ich konnte die Bestätigung nicht verstehen.
  </Say>

</Response>
  `.trim());
});