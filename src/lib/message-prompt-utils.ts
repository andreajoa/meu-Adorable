import { Message } from "ai";

// Number of recent messages to keep intact
const keepIntact = 2;

/**
 * Non-destructively truncates file contents in tool calls and results to reduce token usage
 * Returns a new array of messages with truncated content while preserving the originals
 */
export function truncateFileToolCalls(messages: Message[]): Message[] {
  const messagesToProcess = messages.slice(0, -keepIntact);
  const messagesToKeep = messages.slice(-keepIntact);

  // Create deep copies and truncate the copies
  const truncatedMessages = messagesToProcess.map((message) => {
    // If not assistant message or no parts, return as is
    if (message.role !== "assistant" || !message.parts) {
      return structuredClone(message);
    }

    // Create a deep copy of the message
    const messageCopy = structuredClone(message);

    // Process each part in the copied message
    if (messageCopy.parts) {
      for (const part of messageCopy.parts) {
        if (part.type !== "tool-invocation") continue;

        const toolInvocation = part.toolInvocation;
        // Handle both name and toolName (for compatibility)
        const toolName = toolInvocation.toolName || toolInvocation.name;

        if (!toolName) continue;

        // Handle tool calls with file content
        if (toolName === "read_file" || toolName === "read_multiple_files") {
          // Truncate the result if it exists
          if (toolInvocation.state === "result" && toolInvocation.result) {
            if (typeof toolInvocation.result.content === "string") {
              toolInvocation.result.content =
                "[File content truncated to save tokens]";
            } else if (Array.isArray(toolInvocation.result.content)) {
              toolInvocation.result.content = [
                {
                  type: "text",
                  text: "[File content truncated to save tokens]",
                },
              ];
            }
          }
        }
        // Handle write_file and edit_file tool calls
        else if (toolName === "write_file" || toolName === "edit_file") {
          // Truncate the args in the tool call
          if (toolInvocation.args && typeof toolInvocation.args === "object") {
            if ("content" in toolInvocation.args) {
              toolInvocation.args.content =
                "[Content truncated to save tokens]";
            }
            if (
              "edits" in toolInvocation.args &&
              Array.isArray(toolInvocation.args.edits)
            ) {
              for (const edit of toolInvocation.args.edits) {
                if ("replacement" in edit) {
                  edit.replacement = "[Content truncated to save tokens]";
                }
              }
            }
          }

          // Also truncate any diff output in the results
          if (toolInvocation.state === "result" && toolInvocation.result) {
            if (
              typeof toolInvocation.result.content === "string" &&
              toolInvocation.result.content.includes("diff")
            ) {
              toolInvocation.result.content =
                "[Diff output truncated to save tokens]";
            } else if (Array.isArray(toolInvocation.result.content)) {
              toolInvocation.result.content = [
                {
                  type: "text",
                  text: "[Diff output truncated to save tokens]",
                },
              ];
            }
          }
        }
        // Handle directory listings - truncate large outputs
        else if (toolName === "list_directory" || toolName === "search_files") {
          if (toolInvocation.state === "result" && toolInvocation.result) {
            if (
              Array.isArray(toolInvocation.result.content) &&
              toolInvocation.result.content.length > 0 &&
              typeof toolInvocation.result.content[0].text === "string" &&
              toolInvocation.result.content[0].text.split("\n").length > 10
            ) {
              const originalText = toolInvocation.result.content[0].text;
              const firstFewLines = originalText
                .split("\n")
                .slice(0, 5)
                .join("\n");
              toolInvocation.result.content = [
                {
                  type: "text",
                  text: `${firstFewLines}\n\n[...Directory listing truncated to save tokens...]`,
                },
              ];
            }
          }
        }
        // Handle exec tool - truncate long commands and outputs
        else if (toolName === "exec") {
          // Truncate the command if it's very long
          if (
            toolInvocation.args &&
            typeof toolInvocation.args === "object" &&
            "command" in toolInvocation.args
          ) {
            const command = String(toolInvocation.args.command);
            if (command.length > 200) {
              toolInvocation.args.command =
                command.substring(0, 100) +
                "... [command truncated to save tokens]";
            }
          }

          // Truncate the result if it exists and is long
          if (toolInvocation.state === "result" && toolInvocation.result) {
            if (typeof toolInvocation.result.content === "string") {
              const content = toolInvocation.result.content;
              if (content.length > 500) {
                const lines = content.split("\n");
                if (lines.length > 20) {
                  // Keep first 10 and last 5 lines
                  const truncatedContent = [
                    ...lines.slice(0, 10),
                    "\n[... exec output truncated to save tokens (removed " +
                      (lines.length - 15) +
                      " lines) ...]\n",
                    ...lines.slice(-5),
                  ].join("\n");
                  toolInvocation.result.content = truncatedContent;
                } else if (content.length > 1000) {
                  // If it's just a few very long lines
                  toolInvocation.result.content =
                    content.substring(0, 300) +
                    "\n\n[... exec output truncated to save tokens (removed " +
                    (content.length - 600) +
                    " characters) ...]\n\n" +
                    content.substring(content.length - 300);
                }
              }
            } else if (
              Array.isArray(toolInvocation.result.content) &&
              toolInvocation.result.content.length > 0 &&
              typeof toolInvocation.result.content[0].text === "string"
            ) {
              const text = toolInvocation.result.content[0].text;
              if (text.length > 500) {
                const lines = text.split("\n");
                if (lines.length > 20) {
                  // Keep first 10 and last 5 lines
                  const truncatedText = [
                    ...lines.slice(0, 10),
                    "\n[... exec output truncated to save tokens (removed " +
                      (lines.length - 15) +
                      " lines) ...]\n",
                    ...lines.slice(-5),
                  ].join("\n");
                  toolInvocation.result.content = [
                    { type: "text", text: truncatedText },
                  ];
                } else if (text.length > 1000) {
                  // If it's just a few very long lines
                  const truncatedText =
                    text.substring(0, 300) +
                    "\n\n[... exec output truncated to save tokens (removed " +
                    (text.length - 600) +
                    " characters) ...]\n\n" +
                    text.substring(text.length - 300);
                  toolInvocation.result.content = [
                    { type: "text", text: truncatedText },
                  ];
                }
              }
            }
          }
        }
      }
    }

    return messageCopy;
  });

  // Combine truncated messages with messages to keep intact
  return [
    ...truncatedMessages,
    ...messagesToKeep.map((m) => structuredClone(m)),
  ];
}

export function repairBrokenMessages(messages: Message[]) {
  for (const message of messages) {
    if (message.role !== "assistant" || !message.parts) continue;

    for (const part of message.parts) {
      if (part.type !== "tool-invocation") continue;
      if (part.toolInvocation.state === "result" && part.toolInvocation.result)
        continue;

      part.toolInvocation = {
        ...part.toolInvocation,
        state: "result",
        result: {
          content: [{ type: "text", text: "unknown error" }],
          isError: true,
        },
      };
    }
  }
}
