import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  ReducedValue,
  GraphNode,
  ConditionalEdgeRouter,
  START,
  END,
} from "@langchain/langgraph";
import { SystemMessage } from "@langchain/core/messages";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import * as z from "zod";

const model = new ChatAnthropic({
  model: "claude-haiku-4-5",
  temperature: 0,
});

// Define tools

// const add = tool(({ a, b }) => a + b, {
//   name: "add",
//   description: "Add two numbers",
//   schema: z.object({
//     a: z.number().describe("First number"),
//     b: z.number().describe("Second number"),
//   }),
// });

// Augment the LLM with tools
const toolsByName = {
  //   [add.name]: add,
};
const tools = Object.values(toolsByName);
const modelWithTools = model.bindTools(tools);

// State
const MessagesState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new ReducedValue(z.number().default(0), {
    reducer: (x, y) => x + y,
  }),
});

// Model node
const llmCall: GraphNode<typeof MessagesState> = async (state) => {
  const response = await modelWithTools.invoke([
    new SystemMessage(
      "You are a helpful assistant tasked with performing arithmetic on a set of inputs.",
    ),
    ...state.messages,
  ]);
  return {
    messages: [response],
    llmCalls: 1,
  };
};

// Tool node
const toolNode: GraphNode<typeof MessagesState> = async (state) => {
  const lastMessage = state.messages.at(-1);

  if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
    return { messages: [] };
  }

  const result: ToolMessage[] = [];
  for (const toolCall of lastMessage.tool_calls ?? []) {
    const tool = toolsByName[toolCall.name as keyof typeof toolsByName];
    const observation = await tool.invoke(toolCall);
    result.push(observation);
  }

  return { messages: result };
};

// Conditional edge
const shouldContinue: ConditionalEdgeRouter<typeof MessagesState> = (state) => {
  const lastMessage = state.messages.at(-1);

  // Check if it's an AIMessage before accessing tool_calls
  if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
    return END;
  }

  // If the LLM makes a tool call, then perform an action
  if (lastMessage.tool_calls?.length) {
    return "toolNode";
  }

  // Otherwise, we stop (reply to the user)
  return END;
};

// Compile agent
const agent = new StateGraph(MessagesState)
  .addNode("llmCall", llmCall)
  .addNode("toolNode", toolNode)
  .addEdge(START, "llmCall")
  .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
  .addEdge("toolNode", "llmCall")
  .compile();

// Invoke

const result = await agent.invoke({
  messages: [new HumanMessage("Add 3 and 4.")],
});

for (const message of result.messages) {
  console.log(`[${message.type}]: ${message.text}`);
}
