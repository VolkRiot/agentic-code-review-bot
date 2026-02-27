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
const getPullRequest = tool(
  async ({ owner, repo, pull_number }) => {
    const token = process.env.GITHUB_ACCESS_TOKEN;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };

    const [pr, files] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}`,
        { headers },
      ).then((r) => r.json()),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/files`,
        { headers },
      ).then((r) => r.json()),
    ]);

    return { pr, files };
  },
  {
    name: "get_pull_request",
    description: "Fetch a GitHub PR with its changed files and diffs",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      pull_number: z.number(),
    }),
  },
);

const postPullRequestReview = tool(
  async ({ owner, repo, pull_number, comments, body }) => {
    const token = process.env.GITHUB_ACCESS_TOKEN;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body, // top-level review summary
          event: "COMMENT",
          comments, // inline comments
        }),
      },
    );
    const data = await res.json();
    return { id: data.id, html_url: data.html_url };
  },
  {
    name: "post_pull_request_review",
    description: "Post a code review with inline comments to a GitHub PR",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      pull_number: z.number(),
      body: z.string().describe("Top-level review summary"),
      comments: z.array(
        z.object({
          path: z.string().describe("File path, e.g. src/index.ts"),
          line: z.number().describe("Line number in the file (right side)"),
          side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
          body: z.string().describe("The inline comment text"),
        }),
      ),
    }),
  },
);

// Augment the LLM with tools
const toolsByName = {
  [getPullRequest.name]: getPullRequest,
  [postPullRequestReview.name]: postPullRequestReview,
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
      `You are a code reviewer for Github repositories. When asked to review a PR:
        1. Call get_pull_request to fetch the diff.
        2. Analyze each changed file in the diff.
        3. Call post_pull_request_review with:
            - A brief top-level summary in "body"
            - Inline "comments" for specific issues: include the file path, the exact line number from the diff, and a clear explanation.
        Only comment on lines that actually appear in the diff (additions or context lines on the RIGHT side).`,
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
  messages: [
    new HumanMessage(
      "Provide a review for the open pull request found at https://github.com/VolkRiot/nextjs_2024/pull/1",
    ),
  ],
});

for (const message of result.messages) {
  console.log(`[${message.type}]: ${message.text}`);
}
