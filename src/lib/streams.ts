"use server";
import { StreamTextResult, UIMessage } from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { redis, redisPublisher } from "./redis";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export async function stopStream(appId: string) {
  try {
    await redisPublisher.publish(
      "events:" + appId,
      JSON.stringify({
        type: "abort-stream",
      })
    );
  } catch (error) {
    console.error('Error stopping stream:', error);
  }
}

export async function getStream(appId: string) {
  try {
    if (await streamContext.hasExistingStream(appId)) {
      return {
        async readableStream() {
          const stream = await streamContext.resumeExistingStream(appId);
          return stream;
        },
        async response() {
          const resumableStream = await streamContext.resumeExistingStream(appId);
          return new Response(resumableStream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-vercel-ai-ui-message-stream": "v1",
              "x-accel-buffering": "no",
            },
          });
        },
      };
    }
  } catch (error) {
    console.error('Error getting stream:', error);
    return null;
  }
}

export async function setStream(
  appId: string,
  prompt: UIMessage,
  stream: StreamTextResult<any, unknown>
) {
  console.log("Setting stream for appId:", appId, "with prompt:", prompt);
  
  try {
    const responseBody = stream.toUIMessageStreamResponse().body;
    if (!responseBody) {
      throw new Error(
        "Error creating resumable stream: response body is undefined"
      );
    }

    // Set stream state with error handling
    try {
      await redisPublisher.set(`app:${appId}:stream-state`, "running", { EX: 15 });
    } catch (redisError) {
      console.warn('Redis set failed, continuing without state persistence:', redisError);
    }

    const resumableStream = await streamContext.createNewResumableStream(
      appId,
      () => {
        return responseBody.pipeThrough(
          new TextDecoderStream()
        ) as ReadableStream<string>;
      }
    );

    return {
      response() {
        // Setup abort callback with error handling
        setupAbortCallback(appId, () => {
          console.log("cancelling http stream");
          resumableStream?.cancel();
        });

        return new Response(resumableStream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-vercel-ai-ui-message-stream": "v1",
            "x-accel-buffering": "no",
          },
          status: 200,
        });
      },
    };
  } catch (error) {
    console.error('Error setting stream:', error);
    throw error;
  }
}

// Função auxiliar para setup do callback com timeout
async function setupAbortCallback(appId: string, callback: () => void) {
  try {
    const unsubscribe = await redisPublisher.subscribe("events:" + appId, (event) => {
      try {
        const data = JSON.parse(event);
        if (data.type === "abort-stream") {
          console.log("Stream aborted for appId:", appId);
          callback();
          unsubscribe?.(); // Para o polling
        }
      } catch (parseError) {
        console.error('Error parsing abort event:', parseError);
      }
    });

    // Auto cleanup após 30 segundos para evitar memory leaks
    setTimeout(() => {
      unsubscribe?.();
    }, 30000);
  } catch (error) {
    console.error('Error setting up abort callback:', error);
  }
}

// Função legacy para compatibilidade
export async function getAbortCallback(appId: string, callback: () => void) {
  return setupAbortCallback(appId, callback);
}
