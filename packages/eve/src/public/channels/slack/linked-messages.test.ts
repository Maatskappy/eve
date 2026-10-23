import { describe, expect, it } from "vitest";

import { parseThreadMessage, type SlackApiResponse } from "#public/channels/slack/api.js";
import { loadLinkedSlackMessages } from "#public/channels/slack/linked-messages.js";
import { formatSlackLinkedMessages } from "#public/channels/slack/model-context.js";

const CURRENT = "C0CURRENT1";
const OTHER = "C0OTHER001";
const PRIVATE = "G0PRIVATE1";

const dataTableMessage = {
  ts: "1792700060.000200",
  bot_id: "B_REPORT",
  text: "Ratings",
  blocks: [
    {
      type: "data_table",
      caption: "PR ratings",
      rows: [
        [
          { type: "raw_text", text: "PR" },
          { type: "raw_text", text: "Rating" },
        ],
        [
          { type: "raw_text", text: "#4866" },
          { type: "raw_number", value: 3 },
        ],
      ],
    },
  ],
};

function slackApi(messages: Record<string, readonly Record<string, unknown>[]>) {
  const calls: { operation: string; body: Record<string, unknown> }[] = [];
  const request = async (operation: string, body: unknown): Promise<SlackApiResponse> => {
    const args = body as Record<string, unknown>;
    calls.push({ operation, body: args });
    const channel = String(args.channel);
    if (operation === "conversations.info") {
      return { ok: true, channel: { id: channel, is_private: channel === PRIVATE } };
    }
    if (operation === "conversations.replies") {
      const found = messages[channel];
      return found === undefined
        ? { ok: false, error: "channel_not_found" }
        : { ok: true, messages: found };
    }
    return { ok: false, error: "unknown_method" };
  };
  return { calls, request };
}

function load(
  text: string,
  request: (operation: string, body: unknown) => Promise<SlackApiResponse>,
  overrides: { raw?: Record<string, unknown>; knownTs?: ReadonlySet<string> } = {},
) {
  return loadLinkedSlackMessages({
    channelId: CURRENT,
    knownTs: overrides.knownTs ?? new Set(),
    parse: (raw) =>
      parseThreadMessage(raw, String(raw.ts), { appId: undefined, botUserId: "U_BOT" }),
    raw: overrides.raw ?? {},
    request,
    text,
  });
}

describe("loadLinkedSlackMessages", () => {
  it("reads a linked public-channel message with its Block Kit content", async () => {
    const { request } = slackApi({ [OTHER]: [dataTableMessage] });

    const linked = await load(
      `<@U_BOT> compare against <https://acme.slack.com/archives/${OTHER}/p1792700060000200|this table>`,
      request,
    );

    expect(linked).toHaveLength(1);
    expect(linked[0]?.channelId).toBe(OTHER);
    expect(linked[0]?.message.markdown).toBe("PR ratings\nPR | Rating\n#4866 | 3");
    expect(formatSlackLinkedMessages(linked)).toContain(
      `<linked_message url="https://acme.slack.com/archives/${OTHER}/p1792700060000200">`,
    );
  });

  it("picks the linked reply when Slack returns its thread parent too", async () => {
    const { request } = slackApi({
      [CURRENT]: [
        { ts: "1792700000.000100", user: "U_A", text: "parent" },
        { ts: "1792700001.000100", user: "U_B", text: "the reply", thread_ts: "1792700000.000100" },
      ],
    });

    const linked = await load(
      `https://acme.slack.com/archives/${CURRENT}/p1792700001000100?thread_ts=1792700000.000100&cid=${CURRENT}`,
      request,
    );

    expect(linked.map((entry) => entry.message.text)).toEqual(["the reply"]);
  });

  it("never reads links into private conversations other than the current one", async () => {
    const { calls, request } = slackApi({ [PRIVATE]: [dataTableMessage] });

    const linked = await load(
      `https://acme.slack.com/archives/${PRIVATE}/p1792700060000200`,
      request,
    );

    expect(linked).toEqual([]);
    expect(calls.map((call) => call.operation)).toEqual(["conversations.info"]);
  });

  it("skips links Slack already unfurled and messages already in context", async () => {
    const { calls, request } = slackApi({ [OTHER]: [dataTableMessage] });

    const linked = await load(
      [
        `https://acme.slack.com/archives/${OTHER}/p1792700060000200`,
        `https://acme.slack.com/archives/${CURRENT}/p1792700000000100`,
      ].join(" "),
      request,
      {
        knownTs: new Set(["1792700000.000100"]),
        raw: {
          attachments: [
            {
              from_url: `https://acme.slack.com/archives/${OTHER}/p1792700060000200`,
              is_msg_unfurl: true,
              message_blocks: [{ message: { text: "Ratings" } }],
            },
          ],
        },
      },
    );

    expect(linked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("drops a link it cannot read instead of failing", async () => {
    const linked = await load(`https://acme.slack.com/archives/${OTHER}/p1792700060000200`, () =>
      Promise.reject(new Error("network down")),
    );

    expect(linked).toEqual([]);
  });
});
