import Fastify from "fastify";

import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import twilio from "twilio";

const callContextMap = new Map(); // Stores context per callSid
const callTranscriptMap = new Map(); // Stores [{ role, text }] per callSid

dotenv.config({ path: ".env" });
const requiredEnv = [
  "OPENAI_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_PHONE_NUMBER",
  "STREAM_URL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "SENDGRID_API_KEY",
  "FASTTRK_EMAIL",
  "BASE_URL",
  "PORT"
];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`❌ Missing env variable: ${name}`);
    process.exit(1);
  }
}
const {
  OPENAI_API_KEY,
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyCors);
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VOICE = "shimmer";

fastify.get("/", async (req, reply) => {
  reply.send({ status: "Twilio Voice AI server running" });
});

fastify.post("/start-call", async (req, reply) => {
  const {
    to,
    customerName,
    vehicleName,
    rentalStartDate,
    rentalDays,
    state,
    driverLicense,
    insuranceProvider,
    policyNumber,
  } = req.body;

  if (!to) {
    return reply.code(400).send({ error: 'Missing "to" phone number' });
  }

  reply.send({ message: "Form validated, call will be initiated shortly" });

  try {
    const call = await twilioClient.calls.create({
       url: `${process.env.BASE_URL}/outgoing-call`,
      to,
      from: TWILIO_PHONE_NUMBER,
    });
    const context = {
      customerName,
      vehicleName,
      rentalStartDate,
      rentalDays,
      state,
      driverLicense,
      insuranceProvider,
      policyNumber,
    };

    callContextMap.set(call.sid, context);
    console.log(`📞 Call SID: ${call.sid}`);
    console.log("🗂️ Stored call context:", context);
  } catch (err) {
    console.error("❌ Failed to start call:", err);
    reply.code(500).send({ error: "Failed to initiate call" });
  }
});

fastify.all("/outgoing-call", async (req, reply) => {
  const deployedHost = process.env.BASE_URL.replace("https://", "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="Polly.Joanna">You are now connected with FAST TRACK AI assistant.</Say>
        <Pause length="1"/>
        <Say voice="Polly.Joanna">Transfering your call to Fast Track Agent, Speak when you are ready.</Say>
        <Connect>
          <Stream url="wss://${deployedHost}/media-stream" />
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twiml);
});

// WebSocket route for media stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (conn, req) => {
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let callSid = null;
    let shouldEndCallAfterAudio = false;
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = (context) => {
      let contextString = "";
      if (context) {
        const {
          customerName,
          phoneNumber,
          vehicleName,
          rentalStartDate,
          rentalDays,
          state,
          driverLicense,
          insuranceProvider,
          policyNumber,
        } = context;

        console.log("📦 Context received:", context);
        contextString = `
  You are and AI assistant to verfiy the persons car insurance details You are calling insurance comapnt to verify insurance coverage for ${customerName}.
  Here are the rental and insurance details:

  - Customer Name: ${customerName}
  - Vehicle: ${vehicleName}
  - Rental start date: ${rentalStartDate}
  - Rental duration: ${rentalDays} days
  - State: ${state}
  - Driver License: ${driverLicense}
  - Insurance Provider: ${insuranceProvider}
  - Policy Number: ${policyNumber}

  Start the conversation with a short, clear introduction like:

  "Hi, I’m calling to verify insurance coverage for ${customerName}. They are renting a ${vehicleName} starting on ${rentalStartDate} for ${rentalDays} days in ${state}. I’d like to ask a few questions to confirm coverage."

  After the introduction, follow the steps below one at a time.
  Ask **only one question at a time** and do **not proceed to the next until a valid answer is received**.
  If the first question is not clearly answered or denied, plesae ask it again ultil got that details.
  If you get interrupted by the user during the conversation, respond to theri query and then return to the verification questions.
  Do not answer any out-of-context or unrelated questions. Stay strictly on topic.
  `;
      }

      const SYSTEM_MESSAGE = `
  ${contextString}

  Verification questions (ask and wait for confirmation before continuing):

  1. Can I provide you with their policy number and driver’s license number to verify their policy?
    - Only proceed if the agent confirms that they can verify using the policy number and driver’s license.
    - If the answer is unclear or denied, **end the verification attempt politely and do not continue.**

  2. Does this policy have full coverage or liability only?

  3. Can you verify that the customer’s policy will carry over to our rental vehicle and your company will cover comprehensive, collision, and/or physical damage to our vehicle while being rented — including theft or vandalism while in the renter’s care and custody?

  4. Are you able to verify the renter’s liability limit amounts and confirm that it will carry over as well?

  5. Can you confirm that they have an active policy that’s been effective for more than 30 days? (If not, ask if it would still provide coverage.)

  Once all answers are collected, say:
  “Thank you for confirming and being of assistance today. Have a nice day, goodbye”

  Notes:
  - If the user asks a question about the customer’s policy, vehicle, dates, or license, you may respond based on the given data.
  - Be polite, clear, and stick to one question at a time.
  - If the user asks about unrelated topics, politely redirect them back to the verification questions.
  - o 
  `;

      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          input_audio_transcription: {
            model: "whisper-1",
          },
        },
      };

      openAiWs.on("open", () => {
        console.log("✅ OpenAI WS connected!");
        console.log("📨 Sending sessionUpdate to OpenAI", sessionUpdate);
        openAiWs.send(JSON.stringify(sessionUpdate));
      });
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          openAiWs.send(
            JSON.stringify({
              type: "conversation.item.truncate",
              item_id: lastAssistantItem,
              content_index: 0,
              audio_end_ms: elapsed,
            })
          );
        }

        conn.send(JSON.stringify({ event: "clear", streamSid }));
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (streamSid) {
        conn.send(
          JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "responsePart" },
          })
        );
        markQueue.push("responsePart");
      }
    };

    openAiWs.on("message", (data) => {
      const message = data.toString(); // ✅ convert buffer to string
      // console.log("📨 Got message from OpenAI:", message);

      try {
        const res = JSON.parse(data);
        //  /   console.log(res);
        // console.log("📨 OpenAI response:", res.type);
        if (
          res.type === "conversation.item.input_audio_transcription.completed"
        ) {
          const userSpeech = res.transcript;
          if (callSid) {
            if (!callTranscriptMap.has(callSid))
              callTranscriptMap.set(callSid, []);
            callTranscriptMap
              .get(callSid)
              .push({ role: "user", text: userSpeech });
          }
        }

        if (res.type === "response.audio_transcript.done") {
          console.log("[Full Transcript]", res.transcript);

          const lowerTranscript = res.transcript.toLowerCase();
          if (callSid) {
            if (!callTranscriptMap.has(callSid))
              callTranscriptMap.set(callSid, []);
              callTranscriptMap
              .get(callSid)
              .push({ role: "agent", text: res.transcript });
          }

          // Check if the transcript includes any goodbye phrases
          if (
            lowerTranscript.includes("goodbye") ||
            lowerTranscript.includes("take care") ||
            lowerTranscript.includes("have a nice day")
          ) {
            if (callSid) {
              //Let the audio to finish playing before ending the call 6 sec pause
              setTimeout(async () => {
                try {
                  await twilioClient
                    .calls(callSid)
                    .update({ status: "completed" });
                  console.log(`✅ Call ${callSid} ended by AI after delay.`);
                } catch (err) {
                  console.error(`❌ Failed to end call ${callSid}:`, err);
                }
                callContextMap.delete(callSid);

                const conversation = callTranscriptMap.get(callSid);
                // console.log(conversation)
                // if (conversation) {
                //   const formatted = conversation
                //     .map(
                //       (entry) =>
                //         `${entry.role === "agent" ? "Agent" : "User"}: ${
                //           entry.text
                //         }`
                //     )
                //     .join("\n");

                //   try {
                //     await sgMail.send({
                //       to: "youremail@example.com", // 🔁 Replace with your real email
                //       from: "noreply@fasttrack.ai", // 🔁 Must be verified sender in SendGrid
                //       subject: `Call Transcript for ${callSid}`,
                //       text: formatted,
                //     });

                //     console.log(`📧 Transcript emailed for call ${callSid}`);
                //   } catch (err) {
                //     console.error("❌ Failed to send email:", err);
                //   }

                //   callTranscriptMap.delete(callSid);
                // }
              }, 6000);
            } else {
              console.warn(`⚠️ callSid is missing, cannot end call.`);
            }
          }
        }

        if (res.type === "response.audio.delta" && res.delta) {
          conn.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: res.delta },
            })
          );

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (res.item_id) {
            lastAssistantItem = res.item_id;
          }

          sendMark();
        }

        if (res.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch (e) {
        console.error("Error handling OpenAI message", e);
      }
    });

    conn.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;

            callSid = msg.start.callSid;
            const context = callContextMap.get(callSid);
            console.log("🔗 Got callSid:", callSid);
            console.log("📦 Loaded context:", context);

            initializeSession(context);
            break;

          case "media":
            latestMediaTimestamp = msg.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: msg.media.payload,
                })
              );
            }
            break;
          case "mark":
            markQueue.shift();
            break;
          default:
            console.log("Unhandled event:", msg.event);
        }
      } catch (e) {
        console.error("Error parsing message", e);
      }
    });

    conn.on("close", () => {
      if (callSid) {
        callContextMap.delete(callSid);
      }
      console.log(`Connection closed for callSid ${callSid}`);
    });

    openAiWs.on("close", () => {
      console.log("OpenAI WebSocket connection closed");
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      if (callSid) {
        callContextMap.delete(callSid);
      }
      console.log(`Connection closed for callSid ${callSid}`);
    });
    openAiWs.on("error", (err) => console.error("OpenAI WS error:", err));
  });
});

fastify.listen({ port: PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server running at ${address}`);
});

