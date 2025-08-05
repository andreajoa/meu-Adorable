import { getApp } from "@/actions/get-app";
import { freestyle } from "@/lib/freestyle";
import { getAppIdFromHeaders } from "@/lib/utils";
import { MCPClient } from "@mastra/mcp";
import { builderAgent } from "@/mastra/agents/builder";
import { UIMessage } from "ai";

// "fix" mastra mcp bug
import { EventEmitter } from "events";
import { getAbortCallback, setStream, stopStream } from "@/lib/streams";
EventEmitter.defaultMaxListeners = 1000;

import { NextRequest } from "next/server";
import { redisPublisher } from "@/lib/redis";
import { MessageList } from "@mastra/core/agent";

export async function POST(req: NextRequest) {
  console.log("creating new chat stream");
  const appId = getAppIdFromHeaders(req);

  if (!appId) {
    return new Response("Missing App Id header", { status: 400 });
  }

  const app = await getApp(appId);
  if (!app) {
    return new Response("App not found", { status: 404 });
  }

  // Verifica se há stream rodando
  let streamState;
  try {
    streamState = await redisPublisher.get("app:" + appId + ":stream-state");
  } catch (error) {
    console.warn("Failed to get stream state from Redis:", error);
    streamState = null;
  }

  if (streamState === "running") {
    console.log("Stopping previous stream for appId:", appId);
    await stopStream(appId);

    // Wait until stream state is cleared
    const maxAttempts = 60;
    let attempts = 0;
    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      let updatedState;
      try {
        updatedState = await redisPublisher.get("app:" + appId + ":stream-state");
      } catch (error) {
        console.warn("Failed to check stream state:", error);
        break; // Se Redis falhar, assume que o stream parou
      }
      
      if (updatedState !== "running") {
        break;
      }
      attempts++;
    }

    // If stream is still running after max attempts, force cleanup
    if (attempts >= maxAttempts) {
      try {
        await redisPublisher.del(`app:${appId}:stream-state`);
      } catch (error) {
        console.warn("Failed to delete stream state:", error);
      }
      
      return new Response(
        "Previous stream is still shutting down, please try again",
        { status: 429 }
      );
    }
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  const { mcpEphemeralUrl } = await freestyle.requestDevServer({
    repoId: app.info.gitRepo,
  });

  const resumableStream = await sendMessage(
    appId,
    mcpEphemeralUrl,
    messages.at(-1)!
  );

  return resumableStream.response();
}

export async function sendMessage(
  appId: string,
  mcpUrl: string,
  message: UIMessage
) {
  const mcp = new MCPClient({
    id: crypto.randomUUID(),
    servers: {
      dev_server: {
        url: new URL(mcpUrl),
      },
    },
  });

  const toolsets = await mcp.getToolsets();

  try {
    await (
      await builderAgent.getMemory()
    )?.saveMessages({
      messages: [
        {
          content: {
            parts: message.parts,
            format: 3,
          },
          role: "user",
          createdAt: new Date(),
          id: message.id,
          threadId: appId,
          type: "text",
          resourceId: appId,
        },
      ],
    });
  } catch (error) {
    console.warn("Failed to save message to memory:", error);
  }

  const controller = new AbortController();
  let shouldAbort = false;
  
  // Setup abort callback com error handling
  try {
    await getAbortCallback(appId, () => {
      console.log("Abort signal received for appId:", appId);
      shouldAbort = true;
    });
  } catch (error) {
    console.warn("Failed to setup abort callback:", error);
  }

  let lastKeepAlive = Date.now();

  const messageList = new MessageList({
    resourceId: appId,
    threadId: appId,
  });

  const stream = await builderAgent.stream([], {
    threadId: appId,
    resourceId: appId,
    maxSteps: 100,
    maxRetries: 0,
    maxOutputTokens: 64000,
    toolsets,
    async onChunk() {
      // Keep alive com error handling
      if (Date.now() - lastKeepAlive > 5000) {
        lastKeepAlive = Date.now();
        try {
          await redisPublisher.set(`app:${appId}:stream-state`, "running", {
            EX: 30, // Aumentado para 30s para dar mais tempo
          });
        } catch (error) {
          console.warn("Failed to update keep-alive:", error);
        }
      }
    },
    async onStepFinish(step) {
      messageList.add(step.response.messages, "response");

      if (shouldAbort) {
        console.log("Aborting stream after step finish for appId:", appId);
        
        try {
          await redisPublisher.del(`app:${appId}:stream-state`);
        } catch (error) {
          console.warn("Failed to delete stream state on abort:", error);
        }
        
        controller.abort("Aborted stream after step finish");
        
        const messages = messageList.drainUnsavedMessages();
        console.log("Saving unsaved messages:", messages.length);
        
        try {
          await builderAgent.getMemory()?.saveMessages({
            messages,
          });
        } catch (error) {
          console.warn("Failed to save messages on abort:", error);
        }
      }
    },
    onError: async (error) => {
      console.error("Stream error for appId:", appId, error);
      
      try {
        await mcp.disconnect();
      } catch (disconnectError) {
        console.warn("Failed to disconnect MCP:", disconnectError);
      }
      
      try {
        await redisPublisher.del(`app:${appId}:stream-state`);
      } catch (redisError) {
        console.warn("Failed to delete stream state on error:", redisError);
      }
    },
    onFinish: async () => {
      console.log("Stream finished for appId:", appId);
      
      try {
        await redisPublisher.del(`app:${appId}:stream-state`);
      } catch (error) {
        console.warn("Failed to delete stream state on finish:", error);
      }
      
      try {
        await mcp.disconnect();
      } catch (error) {
        console.warn("Failed to disconnect MCP on finish:", error);
      }
    },
    abortSignal: controller.signal,
  });

  console.log("Stream created for appId:", appId, "with prompt:", message);

  return await setStream(appId, message, stream);
}
