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
import { systemMessagePrompt } from "./system_message";

const model = new ChatAnthropic({
  model: "claude-4-opus-20250514",
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

const getComments = tool(
  async ({ owner, repo, pull_number }) => {
    const token = process.env.GITHUB_ACCESS_TOKEN;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };

    const comments = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/comments`,
      { headers },
    ).then((r) => r.json());

    const commentsDetails = comments.map(
      ({ id, body, diff_hunk, user, in_reply_to_id }) => ({
        id,
        body,
        diff_hunk,
        userId: user.id,
        inReplyToId: in_reply_to_id,
      }),
    );

    return { commentsDetails };
  },
  {
    name: "get_pull_request_comments",
    description: "Fetch a GitHub PR's current comments",
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
  [getComments.name]: getComments,
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
    new SystemMessage(systemMessagePrompt),
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
const instruction = process.argv[2];
if (!instruction) {
  console.error("Usage: bun index.ts <instruction>");
  process.exit(1);
}

const result = await agent.invoke({
  messages: [new HumanMessage(instruction)],
});

for (const message of result.messages) {
  console.log(`[${message.type}]: ${message.text}`);
}
