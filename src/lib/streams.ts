"use server";
import { StreamTextResult, UIMessage } from "ai";
import { redis, redisPublisher } from "./redis";

// Store ativo de streams em memória (para ambiente serverless)
const activeStreams = new Map<string, {
  controller: ReadableStreamDefaultController<string>;
  stream: ReadableStream<string>;
  abortController: AbortController;
}>();

export async function stopStream(appId: string) {
  try {
    // Cancela stream local se existir
    const activeStream = activeStreams.get(appId);
    if (activeStream) {
      activeStream.abortController.abort();
      activeStream.controller.close();
      activeStreams.delete(appId);
    }

    // Publica evento de abort via Redis
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
    // Verifica se existe stream ativo na memória
    const activeStream = activeStreams.get(appId);
    if (activeStream) {
      return {
        async readableStream() {
          return activeStream.stream;
        },
        async response() {
          return new Response(activeStream.stream, {
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

    // Verifica se existe estado persistido no Redis
    const streamState = await redisPublisher.get(`app:${appId}:stream-state`);
    if (streamState) {
      console.log(`Found persisted stream state for ${appId}:`, streamState);
      // Poderia implementar recuperação de estado aqui se necessário
    }

    return null;
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
      await redisPublisher.set(`app:${appId}:stream-state`, "running", { EX: 30 });
    } catch (redisError) {
      console.warn('Redis set failed, continuing without state persistence:', redisError);
    }

    // Cria AbortController para cancelamento
    const abortController = new AbortController();
    
    // Declare controller variable that will be set in start()
    let streamController: ReadableStreamDefaultController<string>;
    
    // Cria ReadableStream customizado com controle de abort
    const customStream = new ReadableStream<string>({
      start(controller) {
        // Store the controller reference
        streamController = controller;
        
        // Armazena o controller para controle externo
        activeStreams.set(appId, {
          controller,
          stream: customStream,
          abortController
        });

        // Setup do callback de abort
        setupAbortCallback(appId, () => {
          console.log("Stream aborted via Redis for appId:", appId);
          abortController.abort();
          controller.close();
          activeStreams.delete(appId);
        });

        // Processa o stream original
        const reader = responseBody.pipeThrough(new TextDecoderStream()).getReader();
        
        const pump = async () => {
          try {
            while (!abortController.signal.aborted) {
              const { done, value } = await reader.read();
              
              if (done) {
                controller.close();
                activeStreams.delete(appId);
                // Limpa estado do Redis
                try {
                  await redisPublisher.del(`app:${appId}:stream-state`);
                } catch (redisError) {
                  console.warn('Redis cleanup failed:', redisError);
                }
                break;
              }
              
              controller.enqueue(value);
            }
          } catch (error) {
            if (!abortController.signal.aborted) {
              console.error('Stream error:', error);
              controller.error(error);
            }
            activeStreams.delete(appId);
          }
        };

        pump();
      },
      
      cancel() {
        console.log("Stream cancelled for appId:", appId);
        abortController.abort();
        activeStreams.delete(appId);
      }
    });

    return {
      response() {
        return new Response(customStream, {
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
    const unsubscribe = redisPublisher.subscribe("events:" + appId, (event) => {
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

    // Auto cleanup após 60 segundos para evitar memory leaks
    setTimeout(() => {
      unsubscribe?.();
    }, 60000);
  } catch (error) {
    console.error('Error setting up abort callback:', error);
  }
}

// Função legacy para compatibilidade
export async function getAbortCallback(appId: string, callback: () => void) {
  return setupAbortCallback(appId, callback);
}

// Função utilitária para limpar streams órfãos - FIXED: Made async
export async function cleanupOrphanedStreams() {
  const now = Date.now();
  for (const [appId, streamData] of activeStreams.entries()) {
    // Remove streams que estão ativos há mais de 5 minutos
    if (streamData.abortController.signal.aborted) {
      activeStreams.delete(appId);
    }
  }
}
