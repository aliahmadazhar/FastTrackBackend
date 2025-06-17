import Fastify from "fastify";

import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import twilio from "twilio";

import Redis from "ioredis"; 
dotenv.config({ path: ".env" });
const {
  OPENAI_API_KEY,
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  REDIS_URL,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !REDIS_URL
) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

// Redis setup
const redis = new Redis(REDIS_URL);
const storeCallContext = async (callSid, context) => {
  await redis.set(
    `call_context:${callSid}`,
    JSON.stringify(context),
    "EX",
    3600
  );
};
const getCallContext = async (callSid) => {
  const raw = await redis.get(`call_context:${callSid}`);
  return raw ? JSON.parse(raw) : null;
};
const deleteCallContext = async (callSid) => {
  await redis.del(`call_context:${callSid}`);
};

//Transcript functions for Redis
const storeTranscriptEntry = async (callSid, entry) => {
  await redis.rpush(`transcript:${callSid}`, JSON.stringify(entry));
  await redis.expire(`transcript:${callSid}`, 3600); // Expire in 1 hour
};

const getTranscript = async (callSid) => {
  const items = await redis.lrange(`transcript:${callSid}`, 0, -1);
  return items.map(JSON.parse);
};

const deleteTranscript = async (callSid) => {
  await redis.del(`transcript:${callSid}`);
};
const formatDateNatural = (rawDate) => {
  const date = new Date(rawDate);
  const day = date.getDate();
  const month = date.toLocaleDateString("en-US", { month: "long" });

  // Convert day to ordinal (1st, 2nd, 3rd, etc)
  const suffixes = ["th", "st", "nd", "rd"];
  const suffix = suffixes[(day - 20) % 10] || suffixes[day] || suffixes[0];

  return `${month} ${day}${suffix}`;
};

const formatPriceNatural = (priceStr) => {
  // Handle different price formats: "86k", "$86,000", "86000"
  const cleanPrice = priceStr.replace(/[^\dkK.]/gi, "").toLowerCase();

  if (cleanPrice.includes("k")) {
    const numValue = parseFloat(cleanPrice.replace("k", "")) * 1000;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(numValue);
  }

  const numValue = parseFloat(cleanPrice);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(numValue);
};

// 2. Update the vehicle parsing logic
const parseVehicleInfo = (vehicleStr) => {
  const [namePart, pricePart] = vehicleStr.split("-").map((s) => s.trim());
  return {
    vehicleName: namePart,
    vehiclePrice: pricePart ? formatPriceNatural(pricePart) : null,
  };
};

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
      // 1368-154-80-30-9.ngrok-free.app
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

    await storeCallContext(call.sid, context);
    console.log(`📞 Call SID: ${call.sid}`);
    console.log("🗂️ Stored call context to Redis:", context);
  } catch (err) {
    console.error("❌ Failed to start call:", err);
    reply.code(500).send({ error: "Failed to initiate call" });
  }
});

fastify.all("/outgoing-call", async (req, reply) => {
  const deployedHost = process.env.BASE_URL.replace("https://", "");
  //"1368-154-80-30-9.ngrok-free.app";

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
        const { vehicletype, vehiclePrice } = parseVehicleInfo(
          context.vehicleName
        );

        // Format dates naturally
        const startDateNatural = formatDateNatural(context.rentalStartDate);
        const daysNatural =
          context.rentalDays === "1" ? "one day" : `${context.rentalDays} days`;

        // Build natural language strings
        const vehicleDesc = vehiclePrice
          ? `${vehicletype} valued at ${vehiclePrice}`
          : vehicletype;

        const introPhrase = `Hi, I'm calling to verify insurance coverage for ${context.customerName}. 
    They are renting a ${vehicleDesc} starting on ${startDateNatural} for ${daysNatural} in ${context.state}. 
    I'd like to ask a few questions to confirm coverage.`;

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

  Start the conversation with a short, clear introduction like: Start the conversation with: "${introPhrase}"
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

    openAiWs.on("message", async (data) => {
      const message = data.toString(); // ✅ convert buffer to string

      try {
        const res = JSON.parse(data);

        if (
          res.type === "conversation.item.input_audio_transcription.completed"
        ) {
          const userSpeech = res.transcript;

          if (callSid) {
            await storeTranscriptEntry(callSid, {
              role: "user",
              text: userSpeech,
            });
          }
        }

        if (res.type === "response.audio_transcript.done") {
          console.log("[Full Transcript]", res.transcript);

          const lowerTranscript = res.transcript.toLowerCase();
          if (callSid) {
            await storeTranscriptEntry(callSid, {
              role: "agent",
              text: res.transcript,
            });
          }

          if (
            lowerTranscript.includes("goodbye") ||
            lowerTranscript.includes("take care") ||
            lowerTranscript.includes("have a nice day")
          ) {
            if (callSid) {
              setTimeout(async () => {
                try {
                  await twilioClient
                    .calls(callSid)
                    .update({ status: "completed" });
                  console.log(`✅ Call ${callSid} ended by AI after delay.`);
                } catch (err) {
                  console.error(`❌ Failed to end call ${callSid}:`, err);
                }

                try {
                  const conversation = await getTranscript(callSid);
                  console.log("📜 Full conversation transcript:", conversation);
                  // Uncomment below to send the email if needed
                  /*
              const formatted = conversation
                .map((entry) => `${entry.role === "agent" ? "Agent" : "User"}: ${entry.text}`)
                .join("\n");

              await sgMail.send({
                to: "youremail@example.com",
                from: "noreply@fasttrack.ai",
                subject: `Call Transcript for ${callSid}`,
                text: formatted,
              });

              console.log(`📧 Transcript emailed for call ${callSid}`);
              */
                } catch (e) {
                  console.error("❌ Failed to handle post-call tasks:", e);
                }
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
            console.log("📦 Loaded context from Redis:", context);
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
      (async () => {
        if (callSid) {
          await deleteCallContext(callSid);
          console.log(`🧹 Redis context deleted for ${callSid}`);
          await deleteTranscript(callSid); // Add this line
          console.log(`🧹 Redis context & transcript deleted for ${callSid}`);
        }
        console.log(`Connection closed for callSid ${callSid}`);
      })();
    });

    openAiWs.on("close", () => {
      (async () => {
        console.log("OpenAI WebSocket connection closed");
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        if (callSid) {
          await deleteCallContext(callSid);
          console.log(`🧹 Redis context deleted (on AI close) for ${callSid}`);
        }
        console.log(`Connection closed for callSid ${callSid}`);
      })();
    });

    openAiWs.on("error", (err) => console.error("OpenAI WS error:", err));
  });
});

fastify.listen({ port: PORT || 3000, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server running at ${address}`);
});
