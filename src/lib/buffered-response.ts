export function bufferedResponse(originalStream: ReadableStream<Uint8Array>) {
  const textDecoder = new TextDecoder();
  const chunkBuffer: Uint8Array[] = [];
  let processingBuffer = false;
  let totalAvailableLines = 0;

  // Count newlines in a chunk of text
  function countNewlines(text: string): number {
    return (text.match(/\\n/g) || []).length;
  }

  // Process the buffer and send chunks with adaptive delays
  async function processBuffer(
    controller: ReadableStreamDefaultController<Uint8Array>
  ) {
    if (processingBuffer || chunkBuffer.length === 0) return;

    processingBuffer = true;

    while (chunkBuffer.length > 0) {
      const chunk = chunkBuffer.shift()!;
      const text = textDecoder.decode(chunk.slice(), { stream: true });

      // Only add delays for tool call content with newlines
      if (text.includes("argsTextDelta") && text.includes("\\n")) {
        // Calculate delay based on available content in the buffer
        const chunkLines = countNewlines(text);

        // Decrease available line count
        totalAvailableLines = Math.max(0, totalAvailableLines - chunkLines);

        // Use an inverse exponential curve for smooth transition:
        // - As available lines approach 0, delay approaches MAX_DELAY
        // - As available lines increase, delay approaches MIN_DELAY
        const MIN_DELAY = 100; // Minimum delay in ms
        const MAX_DELAY = 1500; // Maximum delay in ms
        const CURVE_FACTOR = 0.15; // Controls how quickly the curve transitions

        // Reserve at least 1 line to ensure we never fully catch up
        const adjustedLines = Math.max(totalAvailableLines - 1, 0);

        // Calculate delay: MAX_DELAY when lines=0, approaches MIN_DELAY as lines increase
        const delay =
          MIN_DELAY +
          (MAX_DELAY - MIN_DELAY) * Math.exp(-CURVE_FACTOR * adjustedLines);

        // Add a small random variation (±10%) to make it feel more natural
        const variationFactor = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
        const finalDelay = Math.round(delay * variationFactor);

        await new Promise((resolve) => setTimeout(resolve, finalDelay));
      }

      controller.enqueue(chunk);
    }

    processingBuffer = false;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = originalStream.getReader();

      // Start a separate process to read from the original stream as fast as possible
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // When done, wait for buffer to empty before closing
              while (chunkBuffer.length > 0 || processingBuffer) {
                await new Promise((r) => setTimeout(r, 10));
              }
              controller.close();
              break;
            }

            // Count available newlines in incoming chunk
            const text = textDecoder.decode(value.slice(), { stream: true });
            if (text.includes("argsTextDelta") && text.includes("\\n")) {
              totalAvailableLines += countNewlines(text);
            }

            // Add chunk to buffer immediately without waiting
            chunkBuffer.push(value);

            // Trigger buffer processing if not already running
            processBuffer(controller);
          }
        } catch (error) {
          controller.error(error);
        }
      })();
    },

    cancel() {
      // Clear buffer if stream is cancelled
      chunkBuffer.length = 0;
    },
  });

  return stream;
}
