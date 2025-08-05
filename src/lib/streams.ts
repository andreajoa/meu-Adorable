"use server";

import { StreamTextResult, UIMessage } from "ai";
import { after } from "next/server";

import { createResumableStreamContext } from "resumable-stream";
import { redis, redisPublisher } from "./redis";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export async function stopStream(appId: string) {
  await redisPublisher.publish(
    "events:" + appId,
    JSON.stringify({
      type: "abort-stream",
    })
  );
}

export async function getStream(appId: string) {
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
}

export async function setStream(
  appId: string,
  prompt: UIMessage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: StreamTextResult<any, unknown>
) {
  console.log("Setting stream for appId:", appId, "with prompt:", prompt);
  const responseBody = stream.toUIMessageStreamResponse().body;

  if (!responseBody) {
    throw new Error(
      "Error creating resumable stream: response body is undefined"
    );
  }

  await redisPublisher.set(`app:${appId}:stream-state`, "running", { EX: 15 });

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
      getAbortCallback(appId, () => {
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
}

export async function getAbortCallback(appId: string, callback: () => void) {
  redis.subscribe("events:" + appId, (event) => {
    const data = JSON.parse(event);
    if (data.type === "abort-stream") {
      console.log("Stream aborted for appId:", appId);
      callback();
    }
  });
}
