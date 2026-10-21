import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLinqAdapter, directMessage, fetchMessage, markRead, newMessage, reaction, send } =
  vi.hoisted(() => ({
    createLinqAdapter: vi.fn((_config: { credentials?: () => unknown | Promise<unknown> }) => ({
      name: "linq",
    })),
    directMessage: vi.fn(),
    fetchMessage: vi.fn(),
    markRead: vi.fn(),
    newMessage: vi.fn(),
    reaction: vi.fn(),
    send: vi.fn(),
  }));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ fetchMessage, markRead }),
      onDirectMessage: directMessage,
      onNewMessage: newMessage,
      onReaction: reaction,
    },
    channel: { routes: [] },
    send,
  }),
  messageToUserContent: (message: Message) => message.text,
}));
vi.mock("#compiled/@chat-adapter/state-memory/index.js", () => ({
  createMemoryState: vi.fn(),
}));
vi.mock("#compiled/@linqapp/chat-sdk-adapter/index.js", () => ({
  createLinqAdapter,
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc: vi.fn() }));

import type * as LinqAdapterModule from "#compiled/@linqapp/chat-sdk-adapter/index.js";
import { vercelOidc } from "#public/channels/auth.js";
import { Message } from "#compiled/chat/index.js";
import { defaultLinqAuth, linqChannel } from "#public/channels/linq/linqChannel.js";

describe("linqChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches direct messages to eve", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: { dateSent: new Date(0), edited: false },
      author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello Linq",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).toHaveBeenCalledWith("Hello Linq", {
      auth: {
        attributes: { user_name: "user" },
        authenticator: "linq-message",
        issuer: "linq",
        principalId: "linq:user",
        principalType: "user",
        subject: "user",
      },
      context: [],
      thread,
      title: undefined,
    });
  });

  it("tells the model which message a reply quotes", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = (text: string, raw: unknown, isMe = false) =>
      new Message({
        attachments: [],
        formatted: { type: "root", children: [] },
        metadata: { dateSent: new Date(0), edited: false },
        author: { fullName: "User", isBot: isMe, isMe, userId: "user", userName: "user" },
        id: "message-id",
        raw,
        text,
        threadId: thread.id,
      });
    fetchMessage.mockResolvedValueOnce(message("Dinner at 7?", {}, true));

    await handler(thread, message("yes", { reply_to: { message_id: "target-id" } }));

    expect(fetchMessage).toHaveBeenCalledWith(thread.id, "target-id");
    expect(send).toHaveBeenCalledWith(
      "yes",
      expect.objectContaining({
        context: [
          [
            "<reply_context>",
            'The person\'s message "yes" is a reply to one of your earlier messages (message_id: target-id).',
            "<quoted_message>",
            "Dinner at 7?",
            "</quoted_message>",
            "</reply_context>",
          ].join("\n"),
        ],
      }),
    );
  });

  it("uses lazy credentials and the managed credential verifier", async () => {
    const apiKey = vi.fn(async () => "rotating-token");
    const signingSecret = vi.fn(async () => "rotating-secret");
    const webhookVerifier = vi.fn();

    linqChannel({ credentials: { apiKey, signingSecret, webhookVerifier } });

    const config = createLinqAdapter.mock.calls[0]?.[0];
    expect(config).toHaveProperty("webhookVerifier");
    expect(config).not.toHaveProperty("signingSecret");
    await expect(config?.credentials?.()).resolves.toEqual({
      apiKey: "rotating-token",
      signingSecret: "rotating-secret",
    });
  });

  it.each([
    ["the default Vercel OIDC verifier", undefined],
    ["a custom verifier", vi.fn(async () => undefined)],
  ])("rejects unsigned webhooks that %s does not accept", async (_name, webhookVerifier) => {
    vi.mocked(vercelOidc).mockReturnValue(async () => null);
    linqChannel({ credentials: { apiKey: "linq-api-key", webhookVerifier } });
    const config = createLinqAdapter.mock.calls[0]?.[0] as LinqAdapterModule.LinqAdapterConfig;
    const real = await vi.importActual<typeof LinqAdapterModule>(
      "#compiled/@linqapp/chat-sdk-adapter/index.js",
    );

    const response = await real.createLinqAdapter(config).handleWebhook(
      new Request("https://agent.example.com/eve/v1/linq", {
        body: JSON.stringify({
          data: { chat: { id: "chat" }, direction: "inbound", id: "message", parts: [] },
          event_type: "message.received",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("drops blank inbound messages", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: { dateSent: new Date(0), edited: false },
      author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "  \n",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores tapbacks unless onTapback accepts them", () => {
    linqChannel({ credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" } });
    expect(reaction).not.toHaveBeenCalled();

    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
      onTapback: (_ctx, tapback) => ({ auth: defaultLinqAuth(tapback) }),
    });
    expect(reaction).toHaveBeenCalledTimes(1);
  });

  it("offers a tapback tool that takes standard tapbacks and emoji", () => {
    const channel = linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });

    expect(channel.tapbackTool().inputSchema).toMatchObject({
      properties: {
        tapback: {
          description: "One of love, like, dislike, laugh, emphasize, question, or a single emoji.",
        },
      },
    });
  });
});
