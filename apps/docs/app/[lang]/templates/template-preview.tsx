import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  MicIcon,
  PhoneOffIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { Lato, Mona_Sans } from "next/font/google";
import type { ReactNode } from "react";
import type {
  TemplateIntegration,
  TemplatePreview as TemplatePreviewData,
  TemplatePreviewAttachment,
  TemplatePreviewMessage,
  TemplatePreviewThread,
} from "@/lib/templates/manifest";
import { integrationIcons } from "./integration-icons";

/** Slack's UI typeface. Loaded only for the Slack preview. */
const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  display: "swap",
  fallback: ["Helvetica Neue", "Helvetica", "Segoe UI", "Arial", "sans-serif"],
});

/** GitHub's UI typeface. Loaded only for the GitHub preview. */
const monaSans = Mona_Sans({
  subsets: ["latin"],
  display: "swap",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Noto Sans", "Helvetica", "Arial"],
});

interface TemplatePreviewProps {
  integrations: TemplateIntegration[];
  preview?: TemplatePreviewData;
  title: string;
}

/** Decorative card header: a sample conversation, or a placeholder built from integrations. */
export const TemplatePreview = ({ integrations, preview, title }: TemplatePreviewProps) => (
  <div
    aria-hidden="true"
    className="relative -mx-4 -mt-4 mb-4 h-48 overflow-hidden rounded-t-lg border-b border-gray-alpha-400 bg-background-200"
  >
    {preview ? (
      // Fade the conversation out toward the title so it reads as a hint, not competing text.
      // The dots fade with it, so they never show through the translucent part of the window.
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]">
        <DotMatrix seed={title} />
        <Conversation agent={preview.agent ?? title} preview={preview} />
      </div>
    ) : (
      <>
        <DotMatrix seed={title} />
        <Placeholder integrations={integrations} />
      </>
    )}
  </div>
);

/** Matches SEEDS in scripts/generate-dot-matrix.mjs. */
const DOT_MATRIX_VARIANTS = 4;

/**
 * Dot-matrix backdrop after the vercel.com/agent OG image. The SVG masks
 * gray-1000, so light and dark mode come from tokens.
 */
const DotMatrix = ({ seed }: { seed: string }) => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <div
      className="absolute inset-0 bg-gray-1000 [mask-position:0_0] [mask-repeat:no-repeat]"
      style={{ maskImage: `url(/templates/dot-matrix/${hash % DOT_MATRIX_VARIANTS}.svg)` }}
    />
  );
};

const Conversation = ({ agent, preview }: { agent: string; preview: TemplatePreviewData }) => {
  if (preview.surface === "github") {
    return (
      <GitHub agent={agent} icon={preview.icon} preview={preview} user={pickPreviewUser(agent)} />
    );
  }
  if (preview.surface === "imessage") {
    return <IMessage agent={agent} icon={preview.icon} messages={preview.messages} />;
  }
  if (preview.surface === "slack") {
    return (
      <Slack
        agent={agent}
        channel={preview.context}
        icon={preview.icon}
        messages={preview.messages}
        user={pickPreviewUser(agent)}
      />
    );
  }
  if (preview.surface === "voice") {
    return <VoiceCall address={preview.context} messages={preview.messages} />;
  }
  return <WebChat address={preview.context} messages={preview.messages} />;
};

const Window = ({
  children,
  footer,
  header,
}: {
  children: ReactNode;
  footer?: ReactNode;
  header: ReactNode;
}) => (
  <div className="absolute top-5 -right-3 -bottom-5 left-6 overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-100 text-[11.5px] leading-[1.35] text-gray-1000 shadow-sm">
    <div className="flex h-7 items-center gap-1.5 border-b border-gray-alpha-400 px-3 text-gray-800">
      {header}
    </div>
    <div className="flex flex-col gap-2 px-3 py-2.5">{children}</div>
    {footer}
  </div>
);

const BrowserBar = ({ address }: { address?: string }) => (
  <>
    <span className="size-1.5 rounded-full bg-gray-alpha-400" />
    <span className="size-1.5 rounded-full bg-gray-alpha-400" />
    <span className="size-1.5 rounded-full bg-gray-alpha-400" />
    {address ? <span className="ml-2 text-[10.5px]">{address}</span> : null}
  </>
);

const ChatMessages = ({ messages }: { messages: TemplatePreviewMessage[] }) =>
  messages.map((message) =>
    message.from === "user" ? (
      <p
        className="ml-auto w-fit max-w-[85%] rounded-xl bg-gray-1000 px-2.5 py-1.5 text-background-100"
        key={message.text}
      >
        {message.text}
      </p>
    ) : (
      <div className="flex flex-col gap-1" key={message.text}>
        {message.tools?.map((tool) => (
          <WebToolCall key={tool} name={tool} />
        ))}
        <p>{message.text}</p>
      </div>
    ),
  );

const WebChat = ({
  address,
  messages,
}: {
  address?: string;
  messages: TemplatePreviewMessage[];
}) => (
  <Window header={<BrowserBar address={address} />}>
    <ChatMessages messages={messages} />
  </Window>
);

/**
 * The eve Voice template's web app: a live transcript with tool calls in
 * place and its in-call controls (mute and a destructive "End call" button)
 * pinned to the visible bottom of the card.
 */
const VoiceCall = ({
  address,
  messages,
}: {
  address?: string;
  messages: TemplatePreviewMessage[];
}) => (
  <Window
    footer={
      <div className="absolute inset-x-0 bottom-5 flex items-center justify-center gap-1.5 bg-linear-to-t from-background-100 from-60% to-transparent pt-4 pb-2">
        <span className="flex size-6 items-center justify-center rounded-md border border-gray-alpha-400 bg-background-100">
          <MicIcon className="size-3" />
        </span>
        <span className="flex h-6 items-center gap-1 rounded-md bg-red-800 px-2 font-medium text-[10.5px] text-white">
          <PhoneOffIcon className="size-3" />
          End call
        </span>
      </div>
    }
    header={<BrowserBar address={address} />}
  >
    <ChatMessages messages={messages} />
  </Window>
);

/** Mirrors the eve Web Chat `ToolHeader` for a completed, collapsed tool call. */
const WebToolCall = ({ name }: { name: string }) => {
  const Icon = name === "bash" ? TerminalIcon : WrenchIcon;
  return (
    <span className="flex items-center gap-1.5 text-gray-900">
      <Icon className="size-3 shrink-0" />
      <span>{name}</span>
      <ChevronRightIcon className="size-2.5 shrink-0" />
    </span>
  );
};

interface PreviewUser {
  name: string;
  /** GitHub username, shown on the GitHub surface. */
  login: string;
  /** GitHub user ID, for a rename-proof avatar URL. */
  githubId: number;
}

/** eve contributors who play the person talking to the agent. */
const PREVIEW_USERS: PreviewUser[] = [
  { name: "barba", login: "AndrewBarba", githubId: 1316152 },
  { name: "Casey Gowrie", login: "ctgowrie", githubId: 6045519 },
  { name: "pankow", login: "benpankow", githubId: 10215173 },
  { name: "owen", login: "OwenKephart", githubId: 22457492 },
  { name: "prha", login: "prha", githubId: 1040172 },
  { name: "chad", login: "chadhietala", githubId: 183799 },
  { name: "rui", login: "ruiconti", githubId: 1834568 },
  { name: "colton", login: "cmpadden", githubId: 5807118 },
  { name: "shar", login: "darafsheh", githubId: 2982650 },
];

/** Stable per template, so server and client render the same person. */
const pickPreviewUser = (seed: string): PreviewUser => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PREVIEW_USERS[hash % PREVIEW_USERS.length]!;
};

const githubAvatar = (user: PreviewUser) =>
  `https://avatars.githubusercontent.com/u/${user.githubId}?s=72&v=4`;

const SLACK_TIMESTAMP = "10:42 AM";

/** The template's own icon when it has one, otherwise the eve logo on `fallbackClassName`. */
const AgentIcon = ({
  className,
  fallbackClassName,
  icon,
  logoHeight,
}: {
  className: string;
  fallbackClassName: string;
  icon?: string;
  logoHeight: number;
}) =>
  icon ? (
    // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar
    <img alt="" className={`${className} object-cover`} src={icon} />
  ) : (
    <span className={`${className} ${fallbackClassName} flex items-center justify-center`}>
      <LogoEveSvg height={logoHeight} />
    </span>
  );

/**
 * Laid out at Slack's real desktop metrics (Lato 15/22, 36px avatars, 8px 20px
 * message gutters, 49px channel header) and Slack's own light and dark
 * palette, then zoomed down as a whole so the proportions match Slack at any
 * card size.
 */
const Slack = ({
  agent,
  channel,
  icon,
  messages,
  user,
}: {
  agent: string;
  channel?: string;
  icon?: string;
  messages: TemplatePreviewMessage[];
  user: PreviewUser;
}) => (
  <div className="absolute top-3 -right-3 -bottom-5 left-6 overflow-hidden rounded-lg border border-gray-alpha-400 bg-white shadow-sm dark:bg-[#1a1d21]">
    <div
      className={`${lato.className} text-[15px] leading-[1.46668] text-[#1d1c1d] antialiased [zoom:0.72] dark:text-[#d1d2d3]`}
    >
      <div className="flex h-[49px] items-center border-b border-[rgba(29,28,29,0.13)] px-5 font-black text-[18px] leading-none dark:border-[#35373b] dark:text-[#f8f8f8]">
        <span className="mr-1 font-bold">#</span>
        {channel ?? "general"}
      </div>
      <div className="flex flex-col pt-2">
        {messages.map((message, index) => {
          const isAgent = message.from === "agent";
          // Slack folds a follow-up from the same sender under the first message's header.
          if (messages[index - 1]?.from === message.from) {
            return (
              <div className="-mt-2 py-0.5 pr-5 pl-[64px]" key={message.text}>
                <p className="break-words">
                  <SlackText text={message.text} />
                </p>
                {message.attachment ? <SlackAttachment attachment={message.attachment} /> : null}
              </div>
            );
          }
          return (
            <div className="flex gap-2 px-5 py-2" key={message.text}>
              {isAgent ? (
                <AgentIcon
                  className="size-9 shrink-0 rounded-lg"
                  fallbackClassName="bg-gray-1000 text-background-100"
                  icon={icon}
                  logoHeight={11}
                />
              ) : (
                // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar
                <img
                  alt=""
                  className="size-9 shrink-0 rounded-lg bg-[rgba(29,28,29,0.13)] object-cover"
                  src={githubAvatar(user)}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="font-black dark:text-[#f8f8f8]">
                    {isAgent ? agent : user.name}
                  </span>
                  {isAgent ? (
                    <span className="ml-1 self-center rounded-[2px] bg-[rgba(29,28,29,0.13)] px-[3px] py-px font-bold text-[10px] text-[rgba(29,28,29,0.7)] leading-[14px] dark:bg-[rgba(232,232,232,0.13)] dark:text-[#ababad]">
                      APP
                    </span>
                  ) : null}
                  <span className="ml-1 text-[#616061] text-[12px] dark:text-[#ababad]">
                    {SLACK_TIMESTAMP}
                  </span>
                </div>
                <p className="break-words">
                  <SlackText text={message.text} />
                </p>
                {message.attachment ? <SlackAttachment attachment={message.attachment} /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

const SLACK_BORDER = "border-[rgba(29,28,29,0.13)] dark:border-[#35373b]";
const SLACK_MUTED = "text-[#616061] dark:text-[#ababad]";
const SLACK_LINK = "text-[#1264a3] dark:text-[#1d9bd1]";

const SlackAttachment = ({ attachment }: { attachment: TemplatePreviewAttachment }) => {
  switch (attachment.type) {
    case "table":
      return <SlackTable rows={attachment.rows} />;
    case "chart":
      return <SlackChart title={attachment.title} values={attachment.values} />;
    case "tasks":
      return <SlackTasks tasks={attachment.tasks} title={attachment.title} />;
    case "link":
      return (
        <SlackUnfurl
          description={attachment.description}
          site={attachment.site}
          title={attachment.title}
        />
      );
    case "approval":
      return <SlackApproval approve={attachment.approve} />;
  }
};

const NUMERIC = /^[-+$€£]?[\d.,]+[%KMB]?$/;

/** Slack's Markdown table: hairline grid, bold tinted header, numbers right-aligned. */
const SlackTable = ({ rows }: { rows: string[][] }) => {
  const [header = [], ...body] = rows;
  const cell = `border px-2 ${SLACK_BORDER}`;
  return (
    <table className="mt-1 border-collapse tabular-nums">
      <thead>
        <tr className="bg-[rgba(29,28,29,0.04)] dark:bg-[rgba(232,232,232,0.04)]">
          {header.map((label) => (
            <th className={`${cell} text-left font-bold`} key={label}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row) => (
          <tr key={row.join()}>
            {row.map((value, index) => (
              <td
                className={`${cell} ${NUMERIC.test(value) ? "text-right" : ""}`}
                key={`${index}${value}`}
              >
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const CHART_WIDTH = 320;
const CHART_HEIGHT = 36;

/** A native Slack line chart: bordered card, bold title, one series with a soft fill. */
const SlackChart = ({ title, values }: { title: string; values: number[] }) => {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => [
    (index / Math.max(values.length - 1, 1)) * CHART_WIDTH,
    CHART_HEIGHT - 4 - ((value - min) / span) * (CHART_HEIGHT - 8),
  ]);
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const [lastX, lastY] = points.at(-1) ?? [0, 0];
  return (
    <div className={`mt-1 w-[360px] max-w-full rounded-lg border px-3 pt-2 pb-2.5 ${SLACK_BORDER}`}>
      <p className="font-bold text-[13px]">{title}</p>
      <svg
        aria-hidden="true"
        className={`mt-1 h-9 w-full overflow-visible ${SLACK_LINK}`}
        preserveAspectRatio="none"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        {[0.25, 0.75].map((ratio) => (
          <line
            className="stroke-[rgba(29,28,29,0.13)] dark:stroke-[#35373b]"
            key={ratio}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            x1={0}
            x2={CHART_WIDTH}
            y1={CHART_HEIGHT * ratio}
            y2={CHART_HEIGHT * ratio}
          />
        ))}
        <polygon
          fill="currentColor"
          fillOpacity={0.12}
          points={`0,${CHART_HEIGHT} ${line} ${CHART_WIDTH},${CHART_HEIGHT}`}
        />
        <polyline
          fill="none"
          points={line}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={lastX} cy={lastY} fill="currentColor" r={3} />
      </svg>
    </div>
  );
};

/** eve's Slack task card for finished subagent work: a green check per task, with its outcome. */
const SlackTasks = ({
  tasks,
  title,
}: {
  tasks: { title: string; output?: string }[];
  title?: string;
}) => (
  <div className={`mt-1 w-[360px] max-w-full rounded-lg border px-3 py-1.5 ${SLACK_BORDER}`}>
    {title ? <p className="mb-1 font-bold">{title}</p> : null}
    <div className="flex flex-col gap-1">
      {tasks.map((task) => (
        <div className="flex gap-2" key={task.title}>
          <CircleCheckIcon
            className="mt-[3px] size-4 shrink-0 fill-[#007a5a] text-white dark:fill-[#2bac76] dark:text-[#1a1d21]"
            strokeWidth={2.5}
          />
          <p className="min-w-0">
            <span className="font-bold">{task.title}</span>
            {task.output ? (
              <span className={`ml-2 text-[13px] ${SLACK_MUTED}`}>{task.output}</span>
            ) : null}
          </p>
        </div>
      ))}
    </div>
  </div>
);

/** A link preview Slack unfurls: a rounded grey bar, the site, and a bold linked title. */
const SlackUnfurl = ({
  description,
  site,
  title,
}: {
  description?: string;
  site: TemplateIntegration;
  title: string;
}) => {
  const Icon = integrationIcons[site];
  return (
    <div className="mt-2 flex gap-3">
      <span className="w-1 shrink-0 rounded-full bg-[#dddddd] dark:bg-[#545454]" />
      <div className="min-w-0">
        <p className={`flex items-center gap-1.5 text-[12px] ${SLACK_MUTED}`}>
          <Icon className="size-3.5" />
          {site}
        </p>
        <p className={`font-bold ${SLACK_LINK}`}>{title}</p>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
};

/** Approve and Cancel buttons under the message, a simplified take on eve's approval card. */
const SlackApproval = ({ approve = "Approve" }: { approve?: string }) => (
  <div className="mt-1.5 flex gap-2 font-bold text-[13px]">
    <span className="rounded-[4px] border border-transparent bg-[#007a5a] px-2.5 py-0.5 text-white dark:bg-[#148567]">
      {approve}
    </span>
    <span className={`rounded-[4px] border px-2.5 py-0.5 ${SLACK_BORDER}`}>Cancel</span>
  </div>
);

/** `code`, [label](url), and @mentions. The URL is not rendered; the card itself is the link. */
const SLACK_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+)/;

/** Message text with Slack's inline code, link, and user mention styles. */
const SlackText = ({ text }: { text: string }) =>
  text.split(SLACK_TOKEN).map((part, index) => {
    const key = `${index}${part}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          className="rounded-[3px] border border-[rgba(29,28,29,0.13)] bg-[rgba(29,28,29,0.04)] px-[3px] pt-[2px] pb-px font-[Monaco,Menlo,Consolas,var(--font-mono),monospace] text-[#e01e5a] text-[12px] dark:border-[rgba(232,232,232,0.13)] dark:bg-[rgba(232,232,232,0.04)] dark:text-[#e8912d]"
          key={key}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("[")) {
      return (
        <span className="text-[#1264a3] dark:text-[#1d9bd1]" key={key}>
          {part.slice(1, part.indexOf("]"))}
        </span>
      );
    }
    if (part.startsWith("@")) {
      return (
        <span
          className="rounded-[3px] bg-[rgba(29,155,209,0.1)] px-0.5 text-[#1264a3] dark:bg-[rgba(29,155,209,0.18)] dark:text-[#1d9bd1]"
          key={key}
        >
          {part}
        </span>
      );
    }
    return part;
  });

// Primer's light and dark tokens, as github.com computes them.
const GH_FG = "text-[#1f2328] dark:text-[#f0f6fc]";
const GH_MUTED = "text-[#59636e] dark:text-[#9198a1]";
const GH_BORDER = "border-[#d1d9e0] dark:border-[#3d444d]";
const GH_MUTED_BG = "bg-[#f6f8fa] dark:bg-[#151b23]";
const GH_LINK = "text-[#0969da] dark:text-[#4493f8]";
const GH_AVATAR = "shadow-[0_0_0_1px_#1f232826] dark:shadow-[0_0_0_1px_#ffffff26]";
const GH_MONO = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

/** Octicons (MIT, github.com/primer/octicons), 16px. */
const OCTICONS = {
  issueOpened: [
    "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  ],
  pullRequest: [
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  ],
  pullRequestDraft: [
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  ],
  tag: [
    "M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
  ],
  kebab: [
    "M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  ],
};

const Octicon = ({ className, paths }: { className: string; paths: string[] }) => (
  <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 16 16">
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

/**
 * An issue timeline, or a review thread when `preview.review` is set, under
 * GitHub's sticky header. Laid out at github.com's measured metrics (Mona
 * Sans 14/21, 40px timeline avatars, 6px boxes, 16px gutters) and Primer's
 * light and dark tokens, then zoomed down like the Slack preview. The card
 * is narrower than GitHub's desktop breakpoint, so gutters use GitHub's
 * 16px narrow-screen padding.
 */
const GitHub = ({
  agent,
  icon,
  preview,
  user,
}: {
  agent: string;
  icon?: string;
  preview: TemplatePreviewData;
  user: PreviewUser;
}) => (
  <div className="absolute top-3 -right-3 -bottom-5 left-6 overflow-hidden rounded-lg border border-gray-alpha-400 bg-white shadow-sm dark:bg-[#0d1117]">
    <div
      className={`${monaSans.className} text-[14px] leading-[21px] antialiased [zoom:0.7] ${GH_FG}`}
    >
      <GitHubHeader thread={preview.thread ?? { kind: "issue", number: 1, title: agent }} />
      {preview.review ? (
        <GitHubReview
          agent={agent}
          icon={icon}
          messages={preview.messages}
          review={preview.review}
          user={user}
        />
      ) : (
        <GitHubTimeline agent={agent} icon={icon} messages={preview.messages} user={user} />
      )}
    </div>
  </div>
);

/** The sticky header GitHub shows once you scroll: state, title, and number. */
const GitHubHeader = ({ thread }: { thread: TemplatePreviewThread }) => {
  const draft = thread.kind === "pull" && thread.draft;
  const stateIcon =
    thread.kind === "issue"
      ? OCTICONS.issueOpened
      : draft
        ? OCTICONS.pullRequestDraft
        : OCTICONS.pullRequest;
  return (
    <div className={`flex items-center gap-2 border-b px-4 py-2 ${GH_BORDER}`}>
      <span
        className={`flex h-8 shrink-0 items-center rounded-full px-3 font-semibold leading-4 text-white ${draft ? "bg-[#59636e] dark:bg-[#656c76]" : "bg-[#1f883d] dark:bg-[#238636]"}`}
      >
        <Octicon className="mr-1 size-4" paths={stateIcon} />
        {draft ? "Draft" : "Open"}
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-semibold">{thread.title}</span>
        <span className={`shrink-0 ${GH_MUTED}`}>#{thread.number}</span>
      </span>
    </div>
  );
};

const GitHubUserAvatar = ({ className, user }: { className: string; user: PreviewUser }) => (
  // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar
  <img
    alt=""
    className={`${className} shrink-0 rounded-full object-cover ${GH_AVATAR}`}
    src={githubAvatar(user)}
  />
);

/** GitHub draws apps and bots with rounded-square avatars. */
const GitHubAppAvatar = ({
  className,
  icon,
  logoHeight,
}: {
  className: string;
  icon?: string;
  logoHeight: number;
}) => (
  <AgentIcon
    className={`${className} shrink-0 rounded-[6px] ${GH_AVATAR}`}
    fallbackClassName="bg-gray-1000 text-background-100"
    icon={icon}
    logoHeight={logoHeight}
  />
);

/** Author, `Bot` label for the agent, and the underlined relative time. */
const GitHubAuthor = ({
  agent,
  isAgent,
  user,
}: {
  agent: string;
  isAgent: boolean;
  user: PreviewUser;
}) => (
  <>
    <span className={`font-semibold ${GH_FG}`}>{isAgent ? agent : user.login}</span>
    {isAgent ? (
      <span
        className={`rounded-full border px-1.5 font-medium text-[12px] leading-[18px] ${GH_BORDER} ${GH_MUTED}`}
      >
        Bot
      </span>
    ) : null}
    <span className={`underline underline-offset-[3.2px] ${GH_MUTED}`}>now</span>
  </>
);

// The timeline's vertical line sits 16px into the comment column, which
// starts after the 40px avatar and a 16px gap.
const TIMELINE_COLUMN = "pl-14";
const TIMELINE_LINE = "left-[88px]";

const GitHubTimeline = ({
  agent,
  icon,
  messages,
  user,
}: {
  agent: string;
  icon?: string;
  messages: TemplatePreviewMessage[];
  user: PreviewUser;
}) => (
  <div className="relative px-4">
    <span
      className={`absolute inset-y-0 w-0.5 bg-[#d1d9e0b3] dark:bg-[#3d444db3] ${TIMELINE_LINE}`}
    />
    {messages.map((message) =>
      message.event === "labeled" ? (
        <div className={`relative flex py-4 ${TIMELINE_COLUMN}`} key={message.text}>
          {/* The badge centers on the line: 16px into the column, pulled back 15px. */}
          <span
            className={`ml-px mr-2 flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-white bg-[#f6f8fa] dark:border-[#0d1117] dark:bg-[#212830] ${GH_MUTED}`}
          >
            <Octicon className="size-4" paths={OCTICONS.tag} />
          </span>
          <p className={`mt-[5px] min-w-0 ${GH_MUTED}`}>
            <GitHubUserAvatar className="mr-1 inline-block size-5 align-middle" user={user} />
            <span className={`font-semibold ${GH_FG}`}>{user.login}</span> added the{" "}
            <span className="inline-block rounded-full border border-transparent bg-[#c5def5] px-[7px] font-medium text-[12px] leading-[18px] text-black dark:border-[#c5def54d] dark:bg-[#c5def52e] dark:text-[#c5def5]">
              {message.text}
            </span>{" "}
            label now
          </p>
        </div>
      ) : (
        <div className={`relative py-4 ${TIMELINE_COLUMN}`} key={message.text}>
          <span className="absolute top-4 left-0">
            {message.from === "agent" ? (
              <GitHubAppAvatar className="size-10" icon={icon} logoHeight={12} />
            ) : (
              <GitHubUserAvatar className="size-10" user={user} />
            )}
          </span>
          <div className={`relative rounded-md border bg-white dark:bg-[#0d1117] ${GH_BORDER}`}>
            {/* GitHub's caret toward the avatar: a border-colored triangle under a header-colored one. */}
            <span className="absolute top-[11px] -left-2 h-4 w-2 bg-[#d1d9e0] [clip-path:polygon(0_50%,100%_0,100%_100%)] dark:bg-[#3d444d]" />
            <span className="absolute top-[11px] -left-[7px] h-4 w-2 bg-[#f6f8fa] [clip-path:polygon(0_50%,100%_0,100%_100%)] dark:bg-[#151b23]" />
            <div
              className={`flex items-center gap-1 rounded-t-md border-b px-4 py-2 ${GH_MUTED_BG} ${GH_BORDER} ${GH_MUTED}`}
            >
              <GitHubAuthor agent={agent} isAgent={message.from === "agent"} user={user} />
              <Octicon className="ml-auto size-4" paths={OCTICONS.kebab} />
            </div>
            <p className="break-words p-4">
              <GitHubText text={message.text} />
            </p>
          </div>
        </div>
      ),
    )}
  </div>
);

/**
 * A review thread on one added line, as it appears in the PR's conversation,
 * scrolled so the file path is under the sticky header and the agent's reply
 * is still on the card.
 */
const GitHubReview = ({
  agent,
  icon,
  messages,
  review,
  user,
}: {
  agent: string;
  icon?: string;
  messages: TemplatePreviewMessage[];
  review: { line: number; code: string };
  user: PreviewUser;
}) => (
  <div className="px-4">
    <div className={`overflow-hidden rounded-b-md border border-t-0 ${GH_BORDER}`}>
      <div className="flex text-[12px] leading-5" style={GH_MONO}>
        <span className="w-[50px] shrink-0 bg-[#aceebb] dark:bg-[#3fb9504d]" />
        <span className="w-[50px] shrink-0 bg-[#aceebb] px-2.5 text-right dark:bg-[#3fb9504d]">
          {review.line}
        </span>
        <span className="relative min-w-0 flex-1 truncate bg-[#dafbe1] pr-2.5 pl-[22px] dark:bg-[#2ea04326]">
          <span className="absolute left-2">+</span>
          <DiffCode code={review.code} />
        </span>
      </div>
      {messages.map((message) => (
        <div className={`border-t px-4 pt-2 pb-2 ${GH_BORDER}`} key={message.text}>
          <div className={`-ml-1 flex items-center gap-1 py-1 ${GH_MUTED}`}>
            {message.from === "agent" ? (
              <GitHubAppAvatar className="mr-2 size-6" icon={icon} logoHeight={8} />
            ) : (
              <GitHubUserAvatar className="mr-2 size-6" user={user} />
            )}
            <GitHubAuthor agent={agent} isAgent={message.from === "agent"} user={user} />
            <Octicon className="ml-auto size-4" paths={OCTICONS.kebab} />
          </div>
          <p className="ml-8 break-words">
            <GitHubText text={message.text} />
          </p>
        </div>
      ))}
    </div>
  </div>
);

const DIFF_TOKEN = /(\b(?:const|let|var|return|await|if|new|function)\b|\b\d+\b)/;

/** GitHub's syntax colors for the few tokens a one-line sample needs. */
const DiffCode = ({ code }: { code: string }) =>
  code.split(DIFF_TOKEN).map((part, index) => {
    const key = `${index}${part}`;
    if (/^\d+$/.test(part)) {
      return (
        <span className="text-[#0550ae] dark:text-[#79c0ff]" key={key}>
          {part}
        </span>
      );
    }
    if (index % 2 === 1) {
      return (
        <span className="text-[#cf222e] dark:text-[#ff7b72]" key={key}>
          {part}
        </span>
      );
    }
    return part;
  });

/** `code`, [label](url), @mentions, and #123 references. */
const GITHUB_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+|#\d+)/;

/** Comment text in GitHub's Markdown styles, with link underlines on. */
const GitHubText = ({ text }: { text: string }) =>
  text.split(GITHUB_TOKEN).map((part, index) => {
    const key = `${index}${part}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          className="rounded-md bg-[#818b981f] px-[0.4em] py-[0.2em] text-[85%] dark:bg-[#656c7633]"
          key={key}
          style={GH_MONO}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("@")) {
      return (
        <span className={`font-semibold underline underline-offset-[3.2px] ${GH_FG}`} key={key}>
          {part}
        </span>
      );
    }
    if (part.startsWith("[") || part.startsWith("#")) {
      return (
        <span className={`underline underline-offset-[3.2px] ${GH_LINK}`} key={key}>
          {part.startsWith("[") ? part.slice(1, part.indexOf("]")) : part}
        </span>
      );
    }
    return part;
  });

/** Liquid glass: translucent fill, blurred backdrop, a bright top edge, and a soft drop shadow. */
const GLASS =
  "bg-white/70 backdrop-blur-md backdrop-saturate-150 shadow-[0_2px_6px_rgba(0,0,0,0.08),inset_0_0.5px_0_rgba(255,255,255,0.9),inset_0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-white/12 dark:shadow-[0_2px_6px_rgba(0,0,0,0.5),inset_0_0.5px_0_rgba(255,255,255,0.25),inset_0_0_0_0.5px_rgba(255,255,255,0.08)]";

// Bubble tails: a bubble-colored corner plus a screen-colored cutout that carves the curve.
const SENT_TAIL =
  "before:absolute before:bottom-0 before:-right-[5px] before:size-3.5 before:rounded-bl-[11px_10px] before:bg-inherit before:content-[''] after:absolute after:bottom-0 after:-right-[18px] after:h-3.5 after:w-[18px] after:rounded-bl-[7px] after:bg-background-100 after:content-['']";
const RECEIVED_TAIL =
  "before:absolute before:bottom-0 before:-left-[5px] before:size-3.5 before:rounded-br-[11px_10px] before:bg-inherit before:content-[''] after:absolute after:bottom-0 after:-left-[18px] after:h-3.5 after:w-[18px] after:rounded-br-[7px] after:bg-background-100 after:content-['']";

const IMessage = ({
  agent,
  icon,
  messages,
}: {
  agent: string;
  icon?: string;
  messages: TemplatePreviewMessage[];
}) => (
  <div className="absolute top-3 -bottom-10 left-1/2 w-64 -translate-x-1/2 overflow-hidden rounded-[30px] border border-gray-alpha-400 bg-background-100 text-[10.5px] leading-[1.3] text-gray-1000 shadow-sm">
    <div className="flex flex-col items-center pt-2.5">
      <span
        className={`absolute top-3.5 left-3 flex size-6 items-center justify-center rounded-full ${GLASS}`}
      >
        <svg aria-hidden="true" className="h-2.5" fill="none" viewBox="0 0 7 12">
          <path
            d="M6 1 1 6l5 5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </span>
      <AgentIcon
        className="relative z-10 size-8 rounded-full shadow-[0_1px_4px_rgba(0,0,0,0.18)] ring-[0.5px] ring-black/5 dark:ring-white/15"
        fallbackClassName="bg-linear-to-b from-[#a6abb8] to-[#858994] text-white"
        icon={icon}
        logoHeight={8}
      />
      <span className={`-mt-1 rounded-full px-2 py-0.5 font-semibold text-[9.5px] ${GLASS}`}>
        {agent}
        <span className="ml-0.5 font-normal text-[#8e8e93]">›</span>
      </span>
    </div>
    <div className="flex flex-col px-3.5 pt-2">
      {messages.map((message, index) => {
        const sent = message.from === "user";
        const next = messages[index + 1];
        const tail = !next || next.from !== message.from;
        return (
          <p
            className={[
              "relative max-w-[78%] rounded-[14px] px-2.5 py-[5px]",
              sent
                ? "self-end bg-[#0a84ff] text-white"
                : "self-start bg-[#e9e9eb] dark:bg-[#262628]",
              tail ? (sent ? SENT_TAIL : RECEIVED_TAIL) : "",
              tail && next ? "mb-1.5" : "mb-0.5",
            ].join(" ")}
            key={message.text}
          >
            {message.text}
          </p>
        );
      })}
    </div>
  </div>
);

const MAX_PLACEHOLDER_ICONS = 4;

const Placeholder = ({ integrations }: { integrations: TemplateIntegration[] }) => (
  <>
    <div className="absolute inset-0 flex items-center justify-center gap-2.5 px-4">
      <Tile>
        <LogoEveSvg height={14} />
      </Tile>
      <span className="text-gray-700">+</span>
      {integrations.slice(0, MAX_PLACEHOLDER_ICONS).map((integration) => {
        const Icon = integrationIcons[integration];
        return (
          <Tile key={integration}>
            <Icon className="size-5 grayscale" />
          </Tile>
        );
      })}
    </div>
  </>
);

const Tile = ({ children }: { children: ReactNode }) => (
  <div className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[10px] border border-gray-alpha-400 bg-background-100 px-2.5 text-gray-1000">
    {children}
  </div>
);
