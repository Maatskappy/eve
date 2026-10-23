import type { SlackApiResponse, SlackThreadMessage } from "#public/channels/slack/api.js";
import { isPrivateSlackConversation } from "#public/channels/slack/privacy.js";
import { isObject } from "#shared/guards.js";

/** Bounds the Slack API calls one inbound message can trigger. */
const MAX_LINKED_MESSAGES = 3;
const SLACK_MESSAGE_PERMALINK =
  /https:\/\/[\w.-]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})[^\s|>]*/gu;

interface SlackMessageLink {
  readonly url: string;
  readonly channelId: string;
  readonly ts: string;
}

/** A Slack message the inbound message links to, read as the bot sees it. */
export interface SlackLinkedMessage extends SlackMessageLink {
  readonly message: SlackThreadMessage;
}

/**
 * Reads the Slack messages an inbound message links to, so the model sees the
 * linked content the way a person sees Slack's unfurl. Slack delivers events
 * before it unfurls links, and its unfurls skip many messages, so a payload
 * rarely carries the content itself.
 *
 * Links to the current conversation always resolve. Links elsewhere resolve
 * only when `conversations.info` confirms a public channel, so private content
 * the bot can read never leaks into another audience. Links Slack already
 * unfurled in the payload, messages already in context, and failed reads are
 * skipped.
 */
export async function loadLinkedSlackMessages(input: {
  readonly channelId: string;
  readonly knownTs: ReadonlySet<string>;
  readonly parse: (raw: Record<string, unknown>) => SlackThreadMessage;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
  readonly text: string;
}): Promise<readonly SlackLinkedMessage[]> {
  const unfurled = unfurledMessageKeys(input.raw.attachments);
  const links = slackMessageLinks(input.text)
    .filter(
      (link) =>
        !unfurled.has(link.url.split("?")[0] ?? link.url) &&
        !unfurled.has(`${link.channelId}:${link.ts}`) &&
        !(link.channelId === input.channelId && input.knownTs.has(link.ts)),
    )
    .slice(0, MAX_LINKED_MESSAGES);

  const resolved = await Promise.all(
    links.map(async (link) => {
      try {
        if (
          link.channelId !== input.channelId &&
          (await isPrivateSlackConversation({
            channelId: link.channelId,
            raw: undefined,
            request: input.request,
          }))
        ) {
          return undefined;
        }
        const response = await input.request("conversations.replies", {
          channel: link.channelId,
          inclusive: true,
          latest: link.ts,
          limit: 2,
          oldest: link.ts,
          ts: link.ts,
        });
        if (response.ok !== true || !Array.isArray(response.messages)) return undefined;
        const raw = response.messages.find(
          (message): message is Record<string, unknown> =>
            isObject(message) && message.ts === link.ts,
        );
        return raw === undefined ? undefined : { ...link, message: input.parse(raw) };
      } catch {
        return undefined;
      }
    }),
  );
  return resolved.filter((linked): linked is SlackLinkedMessage => linked !== undefined);
}

function slackMessageLinks(text: string): SlackMessageLink[] {
  const links: SlackMessageLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SLACK_MESSAGE_PERMALINK)) {
    const [url, channelId, seconds, micros] = match;
    if (channelId === undefined || seconds === undefined || micros === undefined) continue;
    const ts = `${seconds}.${micros}`;
    const key = `${channelId}:${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, channelId, ts });
  }
  return links;
}

function unfurledMessageKeys(attachments: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(attachments)) return keys;
  for (const attachment of attachments) {
    if (!isObject(attachment) || !Array.isArray(attachment.message_blocks)) continue;
    if (typeof attachment.from_url === "string") {
      keys.add(attachment.from_url.split("?")[0] ?? attachment.from_url);
    }
    if (typeof attachment.channel_id === "string" && typeof attachment.ts === "string") {
      keys.add(`${attachment.channel_id}:${attachment.ts}`);
    }
  }
  return keys;
}
