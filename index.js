import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import twilio from "twilio";
import crypto from "crypto";

// Environment setup
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
  "PORT",
  "CONTEXT_SECRET"  // Added for encryption
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
  CONTEXT_SECRET
} = process.env;

// Encryption functions
const encryptContext = (context) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc', 
    Buffer.from(CONTEXT_SECRET, 'hex'), 
    iv
  );
  let encrypted = cipher.update(JSON.stringify(context));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptContext = (encryptedContext) => {
  if (!encryptedContext) return null;
  try {
    const [ivHex, encryptedHex] = encryptedContext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc', 
      Buffer.from(CONTEXT_SECRET, 'hex'), 
      iv
    );
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString());
  } catch (e) {
    console.error("❌ Context decryption failed:", e);
    return null;
  }
};

// Server setup
const fastify = Fastify({ logger: true });
fastify.register(fastifyCors);
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VOICE = "shimmer";
const callTranscriptMap = new Map();

// Routes
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

  if (!to) return reply.code(400).send({ error: 'Missing "to" phone number' });

  try {
    // Create and encrypt context
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
    const encryptedContext = encryptContext(context);

    // Initiate call with encrypted context
    const call = await twilioClient.calls.create({
      url: `${process.env.BASE_URL}/outgoing-call?context=${encodeURIComponent(encryptedContext)}`,
      to,
      from: TWILIO_PHONE_NUMBER,
    });

    console.log(`📞 Call SID: ${call.sid}`);
    reply.send({ message: "Call initiated", sid: call.sid });
  } catch (err) {
    console.error("❌ Failed to start call:", err);
    reply.code(500).send({ error: "Failed to initiate call" });
  }
});

fastify.all("/outgoing-call", async (req, reply) => {
  const deployedHost = process.env.BASE_URL.replace("https://", "");
  const encryptedContext = req.query.context;
  
  // Pass encrypted context to media stream
  const streamUrl = encryptedContext 
    ? `wss://${deployedHost}/media-stream?context=${encryptedContext}`
    : `wss://${deployedHost}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Polly.Joanna">You are now connected with FAST TRACK AI assistant.</Say>
      <Pause length="1"/>
      <Say voice="Polly.Joanna">Transfering your call to Fast Track Agent, Speak when you are ready.</Say>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twiml);
});

// WebSocket media stream handler
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (conn, req) => {
    // Decrypt context from URL
    let context = null;
    if (req.query.context) {
      context = decryptContext(req.query.context);
      console.log("🔗 Decoded context from URL:", context);
    }

    // WebSocket variables
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let callSid = null;
    let shouldEndCallAfterAudio = false;
    
    // OpenAI WebSocket connection
    const openAiWs = new WebSocket(
      "wttps://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Session initialization
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
You are an AI assistant to verify car insurance details. You are calling ${insuranceProvider} to verify insurance coverage for ${customerName}.
Here are the rental and insurance details:

- Customer Name: ${customerName}
- Vehicle: ${vehicleName}
- Rental start date: ${rentalStartDate}
- Rental duration: ${rentalDays} days
- State: ${state}
- Driver License: ${driverLicense}
- Insurance Provider: ${insuranceProvider}
- Policy Number: ${policyNumber}

Start with: "Hi, I'm calling to verify insurance coverage for ${customerName}. They are renting a ${vehicleName} starting on ${rentalStartDate} for ${rentalDays} days in ${state}. I'd like to ask a few questions to confirm coverage."
`;
      }

      const SYSTEM_MESSAGE = `
${contextString}

Verification questions (ask one at a time):

1. Can I provide policy number and driver's license to verify?
   - Only proceed if confirmed
   - End call if denied or unclear

2. Does this policy have full coverage or liability only?

3. Will it cover comprehensive/collision damage to our rental vehicle?

4. Can you verify liability limit amounts?

5. Has the policy been active for >30 days?

After confirmation: "Thank you for confirming. Have a nice day, goodbye."

Notes:
- Answer policy/vehicle questions using context
- Politely redirect off-topic questions
- Speak clearly, one question at a time
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
          input_audio_transcription: { model: "whisper-1" },
        },
      };

      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify(sessionUpdate));
      } else {
        openAiWs.once("open", () => {
          console.log("✅ OpenAI WS connected!");
          openAiWs.send(JSON.stringify(sessionUpdate));
        });
      }
    };

    // Event handlers
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
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

    // OpenAI message handling
    openAiWs.on("message", (data) => {
      try {
        const res = JSON.parse(data);
        
        if (res.type === "response.audio_transcript.done") {
          console.log("[Full Transcript]", res.transcript);
          
          // Transcript storage
          if (callSid) {
            if (!callTranscriptMap.has(callSid)) {
              callTranscriptMap.set(callSid, []);
            }
            callTranscriptMap.get(callSid).push({
              role: "agent",
              text: res.transcript
            });
          }
          
          // Call termination logic
          const lowerTranscript = res.transcript.toLowerCase();
          if (lowerTranscript.includes("goodbye") || 
              lowerTranscript.includes("thank you")) {
            setTimeout(async () => {
              try {
                await twilioClient.calls(callSid).update({ status: "completed" });
                console.log(`✅ Call ${callSid} ended by AI`);
              } catch (err) {
                console.error(`❌ Failed to end call ${callSid}:`, err);
              }
              callTranscriptMap.delete(callSid);
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
        console.error("Error handling OpenAI message", e);
      }
    });

    // Twilio message handling
    conn.on("message", (message) => {
      try {
        const msg = JSON.parse(message);
        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log("🔗 Call started with SID:", callSid);
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

    // Cleanup handlers
    conn.on("close", async () => {
      console.log(`🔌 Twilio WS disconnected for call ${callSid}`);
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      if (callSid) callTranscriptMap.delete(callSid);
    });

    openAiWs.on("close", () => {
      console.log("🔌 OpenAI WS closed for call", callSid);
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });
  });
});

// Start server
fastify.listen({ port: PORT || 3000, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on port ${PORT}`);
});