import { SYSTEM_MESSAGE } from "@/lib/system";
import { groq } from "@ai-sdk/groq";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

console.log('Mastra Agent: Initializing without memory (to avoid connection issues)');

export const builderAgent = new Agent({
  name: "BuilderAgent",
  model: groq("llama-3.1-70b-versatile"),
  instructions: SYSTEM_MESSAGE,
  // memory, // Commented out to avoid connection issues
  tools: {
    update_todo_list: createTool({
      id: "update_todo_list",
      description:
        "Use the update todo list tool to keep track of the tasks you need to do to accomplish the user's request. You should should update the todo list each time you complete an item. You can remove tasks from the todo list, but only if they are no longer relevant or you've finished the user's request completely and they are asking for something else. Make sure to update the todo list each time the user asks you do something new. If they're asking for something new, you should probably just clear the whole todo list and start over with new items. For complex logic, use multiple todos to ensure you get it all right rather than just a single todo for implementing all logic.",
      inputSchema: z.object({
        items: z.array(
          z.object({
            description: z.string(),
            completed: z.boolean(),
          })
        ),
      }),
      execute: async ({}) => {
        return {};
      },
    }),
  },
});

// Export empty memory for compatibility
export const memory = null;
