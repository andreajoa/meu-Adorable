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
  
  let appId: string;
  let app: any;
  let messages: UIMessage[];
  
  try {
    // Validate appId first
    appId = getAppIdFromHeaders(req);
    if (!appId) {
      console.error("Missing App Id header");
      return new Response(JSON.stringify({ error: "Missing App Id header" }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get app data
    app = await getApp(appId);
    if (!app) {
      console.error("App not found for appId:", appId);
      return new Response(JSON.stringify({ error: "App not found" }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse request body safely
    try {
      const body = await req.json();
      messages = body.messages;
      
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        throw new Error("Invalid or empty messages array");
      }
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check for existing streams with better error handling
    let streamState: string | null = null;
    try {
      streamState = await redisPublisher.get("app:" + appId + ":stream-state");
    } catch (error) {
      console.warn("Failed to get stream state from Redis:", error);
      // Continue without Redis check if it fails
    }

    if (streamState === "running") {
      console.log("Stopping previous stream for appId:", appId);
      
      try {
        await stopStream(appId);

        // Wait for cleanup with timeout
        const maxAttempts = 20; // Reduced from 60
        let attempts = 0;
        
        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250)); // Reduced from 500ms
          
          try {
            const updatedState = await redisPublisher.get("app:" + appId + ":stream-state");
            if (updatedState !== "running") {
              break;
            }
          } catch (error) {
            console.warn("Failed to check stream state:", error);
            break; // If Redis fails, assume cleanup worked
          }
          
          attempts++;
        }

        // Force cleanup if needed
        if (attempts >= maxAttempts) {
          try {
            await redisPublisher.del(`app:${appId}:stream-state`);
          } catch (error) {
            console.warn("Failed to force delete stream state:", error);
          }
        }
      } catch (stopError) {
        console.error("Failed to stop previous stream:", stopError);
        // Continue anyway - don't block new requests
      }
    }

    // Get the latest message safely
    const latestMessage = messages[messages.length - 1];
    if (!latestMessage) {
      return new Response(JSON.stringify({ error: "No message to process" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Request dev server with timeout and error handling
    let mcpEphemeralUrl: string;
    try {
      const devServerResponse = await Promise.race([
        freestyle.requestDevServer({
          repoId: app.info.gitRepo,
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Dev server request timeout")), 30000)
        )
      ]);
      
      mcpEphemeralUrl = (devServerResponse as any).mcpEphemeralUrl;
      
      if (!mcpEphemeralUrl) {
        throw new Error("No MCP URL returned from dev server");
      }
    } catch (devServerError) {
      console.error("Failed to get dev server:", devServerError);
      return new Response(JSON.stringify({ 
        error: "Failed to initialize dev server",
        details: devServerError.message 
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create resumable stream with comprehensive error handling
    const resumableStream = await sendMessage(
      appId,
      mcpEphemeralUrl,
      latestMessage
    );

    return resumableStream.response();

  } catch (error) {
    console.error("Chat route error:", error);
    
    // Cleanup on error
    if (appId) {
      try {
        await redisPublisher.del(`app:${appId}:stream-state`);
      } catch (cleanupError) {
        console.warn("Failed to cleanup on error:", cleanupError);
      }
    }

    return new Response(JSON.stringify({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : 'Please try again'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function sendMessage(
  appId: string,
  mcpUrl: string,
  message: UIMessage
) {
  let mcp: MCPClient | null = null;
  
  try {
    // Validate inputs
    if (!appId || !mcpUrl || !message) {
      throw new Error("Invalid parameters for sendMessage");
    }

    // Create MCP client with error handling
    mcp = new MCPClient({
      id: crypto.randomUUID(),
      servers: {
        dev_server: {
          url: new URL(mcpUrl),
        },
      },
    });

    // Get toolsets with timeout
    const toolsets = await Promise.race([
      mcp.getToolsets(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Toolsets timeout")), 15000)
      )
    ]);

    // Save message to memory with error handling
    try {
      const memory = await builderAgent.getMemory();
      if (memory) {
        await memory.saveMessages({
          messages: [
            {
              content: {
                parts: message.parts || [],
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
      }
    } catch (error) {
      console.warn("Failed to save message to memory:", error);
      // Continue without saving to memory
    }

    const controller = new AbortController();
    let shouldAbort = false;
    
    // Setup abort callback with error handling
    try {
      await getAbortCallback(appId, () => {
        console.log("Abort signal received for appId:", appId);
        shouldAbort = true;
        controller.abort("External abort signal");
      });
    } catch (error) {
      console.warn("Failed to setup abort callback:", error);
    }

    let lastKeepAlive = Date.now();

    const messageList = new MessageList({
      resourceId: appId,
      threadId: appId,
    });

    // Create stream with comprehensive error handling
    const stream = await builderAgent.stream([], {
      threadId: appId,
      resourceId: appId,
      maxSteps: 100,
      maxRetries: 0,
      maxOutputTokens: 64000,
      toolsets: toolsets as any,
      async onChunk() {
        // Keep alive with error handling and less frequent updates
        if (Date.now() - lastKeepAlive > 10000) { // Increased to 10s
          lastKeepAlive = Date.now();
          try {
            await redisPublisher.set(`app:${appId}:stream-state`, "running", {
              EX: 60, // Increased to 60s
            });
          } catch (error) {
            console.warn("Failed to update keep-alive:", error);
          }
        }
      },
      async onStepFinish(step) {
        try {
          messageList.add(step.response.messages, "response");

          if (shouldAbort) {
            console.log("Aborting stream after step finish for appId:", appId);
            
            // Cleanup Redis state
            try {
              await redisPublisher.del(`app:${appId}:stream-state`);
            } catch (error) {
              console.warn("Failed to delete stream state on abort:", error);
            }
            
            // Save unsaved messages
            const messages = messageList.drainUnsavedMessages();
            if (messages.length > 0) {
              try {
                const memory = await builderAgent.getMemory();
                if (memory) {
                  await memory.saveMessages({ messages });
                }
              } catch (error) {
                console.warn("Failed to save messages on abort:", error);
              }
            }
            
            controller.abort("Aborted after step finish");
          }
        } catch (error) {
          console.error("Error in onStepFinish:", error);
        }
      },
      onError: async (error) => {
        console.error("Stream error for appId:", appId, error);
        
        // Disconnect MCP safely
        if (mcp) {
          try {
            await mcp.disconnect();
          } catch (disconnectError) {
            console.warn("Failed to disconnect MCP on error:", disconnectError);
          }
        }
        
        // Cleanup Redis state
        try {
          await redisPublisher.del(`app:${appId}:stream-state`);
        } catch (redisError) {
          console.warn("Failed to delete stream state on error:", redisError);
        }
      },
      onFinish: async () => {
        console.log("Stream finished for appId:", appId);
        
        // Cleanup Redis state
        try {
          await redisPublisher.del(`app:${appId}:stream-state`);
        } catch (error) {
          console.warn("Failed to delete stream state on finish:", error);
        }
        
        // Disconnect MCP safely
        if (mcp) {
          try {
            await mcp.disconnect();
          } catch (error) {
            console.warn("Failed to disconnect MCP on finish:", error);
          }
        }
      },
      abortSignal: controller.signal,
    });

    console.log("Stream created for appId:", appId, "with prompt:", message);

    return await setStream(appId, message, stream);

  } catch (error) {
    console.error("SendMessage error:", error);
    
    // Cleanup on error
    if (mcp) {
      try {
        await mcp.disconnect();
      } catch (disconnectError) {
        console.warn("Failed to disconnect MCP on sendMessage error:", disconnectError);
      }
    }
    
    try {
      await redisPublisher.del(`app:${appId}:stream-state`);
    } catch (redisError) {
      console.warn("Failed to cleanup Redis on sendMessage error:", redisError);
    }
    
    throw error;
  }
}
