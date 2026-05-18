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