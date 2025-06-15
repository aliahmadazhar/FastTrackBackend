import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import twilio from "twilio";
import { createClient } from "redis";

dotenv.config({ path: ".env" });

const requiredEnv = [
  "OPENAI_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_PHONE_NUMBER",
  "BASE_URL",
  "PORT",
  "REDIS_URL", // add this to your .env for Redis connection
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
  BASE_URL,
  REDIS_URL,
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyCors);
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const VOICE = "shimmer";

// Initialize Redis client
const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error("Redis Client Error", err));

await redis.connect();

// Helper functions to store/get context and transcripts in Redis
async function saveCallContext(callSid, context) {
  await redis.set(`callContext:${callSid}`, JSON.stringify(context), { EX: 3600 }); // expire 1 hour
}
async function getCallContext(callSid) {
  const data = await redis.get(`callContext:${callSid}`);
  return data ? JSON.parse(data) : null;
}
async function deleteCallContext(callSid) {
  await redis.del(`callContext:${callSid}`);
}

async function appendCallTranscript(callSid, role, text) {
  await redis.rPush(`callTranscript:${callSid}`, JSON.stringify({ role, text }));
  await redis.expire(`callTranscript:${callSid}`, 3600);
}
async function getCallTranscript(callSid) {
  const arr = await redis.lRange(`callTranscript:${callSid}`, 0, -1);
  return arr.map((item) => JSON.parse(item));
}
async function deleteCallTranscript(callSid) {
  await redis.del(`callTranscript:${callSid}`);
}

// HTTP routes
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

  try {
    const call = await twilioClient.calls.create({
      url: `${BASE_URL}/outgoing-call`,
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

    await saveCallContext(call.sid, context);
    fastify.log.info(`📞 Call SID: ${call.sid}`);
    fastify.log.info("🗂️ Stored call context in Redis", context);

    reply.send({ message: "Call initiated", callSid: call.sid });
  } catch (err) {
    fastify.log.error("❌ Failed to start call:", err);
    reply.code(500).send({ error: "Failed to initiate call" });
  }
});

fastify.all("/outgoing-call", async (req, reply) => {
  const deployedHost = BASE_URL.replace(/^https?:\/\//, "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Polly.Joanna">You are now connected with FAST TRACK AI assistant.</Say>
      <Pause length="1"/>
      <Say voice="Polly.Joanna">Transferring your call to Fast Track Agent, Speak when you are ready.</Say>
      <Connect>
        <Stream url="wss://${deployedHost}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twiml);
});

// WebSocket route for Twilio media streaming
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (conn, req) => {
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let callSid = null;

    // OpenAI Realtime WS connection
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Initialize OpenAI session with context
    const initializeSession = (context) => {
      let contextString = "";

      if (context) {
        const {
          customerName,
          vehicleName,
          rentalStartDate,
          rentalDays,
          state,
          driverLicense,
          insuranceProvider,
          policyNumber,
        } = context;

        contextString = `
You are an AI assistant verifying car insurance details. Calling the insurance company to verify coverage for ${customerName}.

Rental and insurance details:
- Customer Name: ${customerName}
- Vehicle: ${vehicleName}
- Rental start date: ${rentalStartDate}
- Rental duration: ${rentalDays} days
- State: ${state}
- Driver License: ${driverLicense}
- Insurance Provider: ${insuranceProvider}
- Policy Number: ${policyNumber}

Start with a clear introduction like:
"Hi, I’m calling to verify insurance coverage for ${customerName}..."

Follow verification questions one by one, wait for valid answers before proceeding. Repeat if needed. Stay polite and on topic.
`;
      }

      const SYSTEM_MESSAGE = `
${contextString}

Verification questions (ask and wait for confirmation):

1. Can I provide policy number and driver’s license to verify?
  - Proceed only if confirmed; otherwise, end politely.

2. Does policy have full coverage or liability only?

3. Verify if policy covers rental vehicle (comprehensive, collision, theft, vandalism).

4. Confirm renter’s liability limits carry over.

5. Confirm active policy > 30 days or if coverage still applies.

Once done:
"Thank you for confirming and being of assistance today. Have a nice day, goodbye."
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

      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify(sessionUpdate));
      } else {
        openAiWs.once("open", () => openAiWs.send(JSON.stringify(sessionUpdate)));
      }
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

    openAiWs.on("message", async (data) => {
      try {
        const res = JSON.parse(data.toString());

        if (res.type === "conversation.item.input_audio_transcription.completed") {
          const userSpeech = res.transcript;
          if (callSid) {
            await appendCallTranscript(callSid, "user", userSpeech);
          }
        }

        if (res.type === "response.audio_transcript.done") {
          const transcript = res.transcript;
          const lowerTranscript = transcript.toLowerCase();

          fastify.log.info(`[Full Transcript] ${transcript}`);

          if (callSid) {
            await appendCallTranscript(callSid, "agent", transcript);
          }

          // Detect goodbye phrases to end call
          if (
            lowerTranscript.includes("goodbye") ||
            lowerTranscript.includes("take care") ||
            lowerTranscript.includes("have a nice day")
          ) {
            // Delay call hangup to allow audio to finish
            setTimeout(async () => {
              if (callSid) {
                try {
                  await twilioClient.calls(callSid).update({ status: "completed" });
                  fastify.log.info(`✅ Call ${callSid} ended by AI after delay.`);
                } catch (err) {
                  fastify.log.error(`❌ Failed to end call ${callSid}:`, err);
                }

                // Cleanup context & transcript
                await deleteCallContext(callSid);

                // Optionally, email transcript here (uncomment and configure SendGrid)
                /*
                const conversation = await getCallTranscript(callSid);
                if (conversation) {
                  const formatted = conversation
                    .map((entry) => `${entry.role === "agent" ? "Agent" : "User"}: ${entry.text}`)
                    .join("\n");

                  try {
                    await sgMail.send({
                      to: "youremail@example.com",
                      from: "noreply@fasttrack.ai",
                      subject: `Call Transcript for ${callSid}`,
                      text: formatted,
                    });
                    fastify.log.info(`📧 Transcript emailed for call ${callSid}`);
                  } catch (err) {
                    fastify.log.error("❌ Failed to send email:", err);
                  }

                  await deleteCallTranscript(callSid);
                }
                */
                await deleteCallTranscript(callSid);
              }
            }, 6000);
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
        fastify.log.error("Error handling OpenAI message", e);
      }
    });

    conn.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;

            callSid = msg.start.callSid;
            const context = await getCallContext(callSid);
            fastify.log.info(`🔗 Got callSid: ${callSid}`);
            fastify.log.info("📦 Loaded context:", context);

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
            fastify.log.warn(`Unhandled event: ${msg.event}`);
        }
      } catch (e) {
        fastify.log.error("Error parsing message", e);
      }
    });

    conn.on("close", async () => {
      fastify.log.info(`🔌 Twilio WebSocket disconnected for callSid ${callSid}`);

      // Close OpenAI WS connection
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }

      if (callSid) {
        try {
          // Mark call complete on Twilio side if still active
          await twilioClient.calls(callSid).update({ status: "completed" });
          fastify.log.info(`✅ Call ${callSid} marked as completed on hangup.`);
        } catch (err) {
          fastify.log.error(`❌ Failed to mark call ${callSid} as completed:`, err);
        }

        // Clean up Redis
        await deleteCallContext(callSid);
        await deleteCallTranscript(callSid);
      }
    });

    openAiWs.on("close", () => {
      fastify.log.info(`OpenAI WebSocket connection closed for callSid ${callSid}`);
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();

      if (callSid) {
        deleteCallContext(callSid);
      }
    });

    openAiWs.on("error", (err) => fastify.log.error("OpenAI WS error:", err));
  });
});

fastify.listen({ port: PORT || 3000, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server running at ${address}`);
});
