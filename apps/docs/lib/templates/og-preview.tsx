// Satori-compatible port of the gallery card header in
// app/[lang]/templates/template-preview.tsx, for template OG images.
// next/og only supports flexbox, inline styles, and a subset of CSS, so the
// layout is rebuilt with explicit dark-mode colors instead of Geist tokens.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import {
  Children,
  type CSSProperties,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { integrationIcons } from "@/app/[lang]/templates/integration-icons";
import { resolveLogo } from "../og-logo";
import type {
  TemplateIntegration,
  TemplateManifestEntry,
  TemplatePreview,
  TemplatePreviewAttachment,
  TemplatePreviewMessage,
  TemplatePreviewThread,
} from "./manifest";

/**
 * Dark-mode Geist tokens resolved to sRGB, plus the Slack, iMessage, and
 * GitHub (Primer) dark palettes the card's previews copy.
 */
export const ogPalette = {
  bg100: "#000000",
  bg200: "#0a0a0a",
  fg: "#ededed",
  gray900: "#a1a1a1",
  gray800: "#7d7d7d",
  gray700: "#8f8f8f",
  border: "rgba(255,255,255,0.14)",
  dot: "#ededed",
  red: "#e5484d",
  slackBg: "#1a1d21",
  slackFg: "#d1d2d3",
  slackStrong: "#f8f8f8",
  slackBorder: "#35373b",
  slackMuted: "#ababad",
  slackLink: "#1d9bd1",
  slackCodeFg: "#e8912d",
  slackCodeBg: "rgba(232,232,232,0.04)",
  slackCodeBorder: "rgba(232,232,232,0.13)",
  slackMentionBg: "rgba(29,155,209,0.18)",
  slackTint: "rgba(232,232,232,0.04)",
  slackBadgeBg: "rgba(232,232,232,0.13)",
  slackBadgeFg: "#ababad",
  slackGreen: "#2bac76",
  slackButton: "#148567",
  slackUnfurl: "#545454",
  imReceived: "#262628",
  glass: "rgba(255,255,255,0.12)",
  ghBg: "#0d1117",
  ghFg: "#f0f6fc",
  ghMuted: "#9198a1",
  ghBorder: "#3d444d",
  ghMutedBg: "#151b23",
  ghLink: "#4493f8",
  ghOpen: "#238636",
  ghDraft: "#656c76",
  ghTimeline: "rgba(61,68,77,0.7)",
  ghBadgeBg: "#212830",
  ghCodeBg: "rgba(101,108,118,0.2)",
  ghAvatarRing: "rgba(255,255,255,0.15)",
  ghLabelFg: "#c5def5",
  ghLabelBg: "rgba(197,222,245,0.18)",
  ghLabelBorder: "rgba(197,222,245,0.3)",
  ghAddNumberBg: "rgba(63,185,80,0.3)",
  ghAddLineBg: "rgba(46,160,67,0.15)",
  ghKeyword: "#ff7b72",
  ghNumber: "#79c0ff",
};

type Palette = typeof ogPalette;

const hashString = (seed: string) => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
};

// Same noise as scripts/generate-dot-matrix.mjs, so the OG dots match the card's.
const noiseHash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
const noise = (x: number, y: number, seed: number) => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = noiseHash(x0, y0, seed);
  const b = noiseHash(x0 + 1, y0, seed);
  const c = noiseHash(x0, y0 + 1, seed);
  const d = noiseHash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
};
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The card's dot matrix as an SVG data URI. `fade` is the height over which
 * dots fade out downward; pass `Infinity` for an even field.
 */
export const dotMatrixSrc = ({
  color,
  fade = 176,
  gap = 8,
  height,
  seed,
  strength = 1,
  width,
  fadeLeft,
}: {
  /** Fade dots in from the left edge until this x. */
  fadeLeft?: number;
  color: string;
  fade?: number;
  gap?: number;
  height: number;
  seed: string;
  strength?: number;
  width: number;
}) => {
  const noiseSeed = (hashString(seed) % 4) * 7919 + 1;
  const dots: string[] = [];
  for (let y = gap / 2; y < height; y += gap) {
    for (let x = gap / 2; x < width; x += gap) {
      const n = noise(x / ((56 * gap) / 8), y / ((40 * gap) / 8), noiseSeed);
      const falloff = Number.isFinite(fade) ? clamp(1.1 - y / (fade * 0.8)) : 1;
      const leftFalloff = fadeLeft ? smooth(clamp(x / fadeLeft)) : 1;
      const opacity = (0.12 + 0.88 * n ** 2) * falloff * leftFalloff * strength;
      if (opacity < 0.02) continue;
      dots.push(
        `<circle cx="${x}" cy="${y}" r="${gap / 8}" fill-opacity="${+opacity.toFixed(2)}"/>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" fill="${color}">${dots.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

/** Images the header needs, resolved to data URIs before rendering. */
export interface OgPreviewAssets {
  agentIcon?: string;
  userAvatar?: string;
  userName: string;
  userLogin: string;
}

// Matches PREVIEW_USERS in template-preview.tsx, so the OG image shows the same person.
const PREVIEW_USERS = [
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

const toDataUri = (data: Buffer, type: string) => `data:${type};base64,${data.toString("base64")}`;

const loadPublicImage = async (path: string) => {
  const data = await readFile(join(process.cwd(), "public", path));
  return toDataUri(data, path.endsWith(".svg") ? "image/svg+xml" : "image/png");
};

const loadRemoteImage = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "image/png";
    return toDataUri(Buffer.from(await response.arrayBuffer()), type);
  } catch {
    // A missing avatar falls back to a gray square rather than failing the image.
    return undefined;
  }
};

export const loadOgPreviewAssets = async (
  template: TemplateManifestEntry,
): Promise<OgPreviewAssets> => {
  const agent = template.preview?.agent ?? template.title;
  const user = PREVIEW_USERS[hashString(agent) % PREVIEW_USERS.length]!;
  const [agentIcon, userAvatar] = await Promise.all([
    template.preview?.icon ? loadPublicImage(template.preview.icon) : undefined,
    template.preview?.surface === "slack" || template.preview?.surface === "github"
      ? loadRemoteImage(`https://avatars.githubusercontent.com/u/${user.githubId}?s=72&v=4`)
      : undefined,
  ]);
  return { agentIcon, userAvatar, userLogin: user.login, userName: user.name };
};

const EveLogo = ({ color, height }: { color: string; height: number }) => (
  <div style={{ color, display: "flex" }}>{resolveLogo(<LogoEveSvg height={height} />)}</div>
);

const IntegrationIcon = ({
  color,
  integration,
  size,
}: {
  color?: string;
  integration: TemplateIntegration;
  size: number;
}) => {
  // Lucide icons read React context, which next/og cannot provide, so draw this one directly.
  if (integration === "HTTP API") {
    return (
      <div style={{ display: "flex" }}>
        <LucideIcon color={color ?? "currentColor"} paths={LUCIDE.braces} size={size} />
      </div>
    );
  }
  const Icon = integrationIcons[integration];
  return (
    <div style={{ color, display: "flex" }}>{resolveLogo(<Icon height={size} width={size} />)}</div>
  );
};

/** Lucide icons the web surface uses, as plain SVG. */
const LucideIcon = ({
  color,
  paths,
  size,
  strokeWidth = 2,
}: {
  color: string;
  paths: string[];
  size: number;
  strokeWidth?: number;
}) => (
  <svg
    fill="none"
    height={size}
    stroke={color}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={strokeWidth}
    viewBox="0 0 24 24"
    width={size}
  >
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

const LUCIDE = {
  terminal: ["M12 19h8", "m4 17 6-6-6-6"],
  wrench: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",
  ],
  chevronRight: ["m9 18 6-6-6-6"],
  braces: [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ],
  mic: [
    "M12 19v3",
    "M19 10v2a7 7 0 0 1-14 0v-2",
    "M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z",
  ],
  phoneOff: [
    "M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272",
    "M22 2 2 22",
    "M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473",
  ],
};

interface SceneProps {
  assets: OgPreviewAssets;
  height: number;
  palette: Palette;
  template: TemplateManifestEntry;
  width: number;
  /** Window inset from the scene edges, in scene pixels: top, right, bottom, left. */
  inset?: [number, number, number, number];
  /**
   * Height of the part of the scene that is not faded out. The Voice
   * template's call controls pin to it, as they pin to the card's bottom edge.
   */
  visibleHeight: number;
}

/**
 * Messages through the agent's first reply. The OG image shows one exchange,
 * so a long preview doesn't leave half a message in the fade.
 */
const firstExchange = (messages: TemplatePreviewMessage[]) => {
  const reply = messages.findIndex((message) => message.from === "agent" && !message.event);
  return reply === -1 ? messages : messages.slice(0, reply + 1);
};

/**
 * The gallery card header's foreground at card scale (`width` × `height` CSS
 * pixels): a conversation window, or the eve-plus-integrations placeholder.
 * Size it for the OG canvas with `scaleTree`.
 */
export const HeaderScene = ({
  assets,
  height,
  inset = [20, -12, -20, 24],
  palette,
  template,
  visibleHeight,
  width,
}: SceneProps) => {
  const preview = template.preview && {
    ...template.preview,
    messages: firstExchange(template.preview.messages),
  };
  return (
    <div style={{ display: "flex", height, position: "relative", width }}>
      {preview ? (
        <Conversation
          agent={preview.agent ?? template.title}
          assets={assets}
          context={preview.context}
          footerBottom={height - inset[2] - visibleHeight}
          inset={inset}
          messages={preview.messages}
          palette={palette}
          preview={preview}
        />
      ) : (
        <Placeholder integrations={template.integrations} palette={palette} />
      )}
    </div>
  );
};

const insetStyle = ([top, right, bottom, left]: [number, number, number, number]) =>
  ({ bottom, left, position: "absolute", right, top }) satisfies CSSProperties;

/** A window: hairline border, rounded corners, and clipped content. */
const Frame = ({
  children,
  inner,
  outer,
  palette,
  radius,
}: {
  children: ReactNode;
  inner: CSSProperties;
  outer: CSSProperties;
  palette: Palette;
  radius: number;
}) => (
  <div
    style={{
      ...outer,
      ...inner,
      border: `1px solid ${palette.border}`,
      borderRadius: radius,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}
  >
    {children}
  </div>
);

const Conversation = ({
  agent,
  assets,
  context,
  inset,
  messages,
  footerBottom,
  palette,
  preview,
}: {
  agent: string;
  assets: OgPreviewAssets;
  context?: string;
  footerBottom: number;
  inset: [number, number, number, number];
  messages: TemplatePreviewMessage[];
  palette: Palette;
  preview: TemplatePreview;
}) => {
  const surface = preview.surface;
  if (surface === "github") {
    return (
      <GitHub
        agent={agent}
        assets={assets}
        inset={[inset[0] - 8, inset[1], inset[2], inset[3]]}
        palette={palette}
        preview={preview}
      />
    );
  }
  if (surface === "imessage") {
    return <IMessage agent={agent} assets={assets} messages={messages} palette={palette} />;
  }
  if (surface === "slack") {
    return (
      <Slack
        agent={agent}
        assets={assets}
        channel={context}
        inset={[inset[0] - 8, inset[1], inset[2], inset[3]]}
        messages={messages}
        palette={palette}
      />
    );
  }
  return (
    <WebWindow
      address={context}
      footerBottom={footerBottom}
      inset={inset}
      messages={messages}
      palette={palette}
      voice={surface === "voice"}
    />
  );
};

const WebWindow = ({
  address,
  footerBottom,
  inset,
  messages,
  palette,
  voice,
}: {
  address?: string;
  /** Distance from the window's bottom edge to the Voice call controls. */
  footerBottom: number;
  inset: [number, number, number, number];
  messages: TemplatePreviewMessage[];
  palette: Palette;
  voice: boolean;
}) => (
  <Frame
    inner={{ backgroundColor: palette.bg100, color: palette.fg, fontSize: 11.5, lineHeight: 1.35 }}
    outer={insetStyle(inset)}
    palette={palette}
    radius={8}
  >
    <div
      style={{
        alignItems: "center",
        borderBottom: `1px solid ${palette.border}`,
        color: palette.gray800,
        display: "flex",
        flexShrink: 0,
        gap: 6,
        height: 28,
        paddingLeft: 12,
        paddingRight: 12,
      }}
    >
      {[0, 1, 2].map((dot) => (
        <div
          key={dot}
          style={{ backgroundColor: palette.border, borderRadius: 999, height: 6, width: 6 }}
        />
      ))}
      {address ? <div style={{ fontSize: 10.5, marginLeft: 8 }}>{address}</div> : null}
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px" }}>
      {messages.map((message) =>
        message.from === "user" ? (
          <div
            key={message.text}
            style={{
              alignSelf: "flex-end",
              backgroundColor: palette.fg,
              borderRadius: 12,
              color: palette.bg100,
              display: "flex",
              maxWidth: "85%",
              padding: "6px 10px",
            }}
          >
            {message.text}
          </div>
        ) : (
          <div key={message.text} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {message.tools?.map((tool) => (
              <div
                key={tool}
                style={{ alignItems: "center", color: palette.gray900, display: "flex", gap: 6 }}
              >
                <LucideIcon
                  color={palette.gray900}
                  paths={tool === "bash" ? LUCIDE.terminal : LUCIDE.wrench}
                  size={12}
                />
                <div>{tool}</div>
                <LucideIcon color={palette.gray900} paths={LUCIDE.chevronRight} size={10} />
              </div>
            ))}
            <div style={{ display: "flex" }}>{message.text}</div>
          </div>
        ),
      )}
    </div>
    {voice ? (
      <div
        style={{
          alignItems: "center",
          backgroundImage: `linear-gradient(to top, ${palette.bg100} 60%, ${palette.bg100}00)`,
          bottom: footerBottom,
          display: "flex",
          gap: 6,
          justifyContent: "center",
          left: 0,
          padding: "16px 0 8px",
          position: "absolute",
          right: 0,
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: palette.bg100,
            border: `1px solid ${palette.border}`,
            borderRadius: 6,
            display: "flex",
            height: 24,
            justifyContent: "center",
            width: 24,
          }}
        >
          <LucideIcon color={palette.fg} paths={LUCIDE.mic} size={12} />
        </div>
        <div
          style={{
            alignItems: "center",
            backgroundColor: palette.red,
            borderRadius: 6,
            color: "white",
            display: "flex",
            fontSize: 10.5,
            fontWeight: 500,
            gap: 4,
            height: 24,
            padding: "0 8px",
          }}
        >
          <LucideIcon color="white" paths={LUCIDE.phoneOff} size={12} />
          End call
        </div>
      </div>
    ) : null}
  </Frame>
);

const AgentAvatar = ({
  assets,
  fallbackBackground,
  fallbackColor,
  logoHeight,
  radius,
  size,
}: {
  assets: OgPreviewAssets;
  fallbackBackground: string;
  fallbackColor: string;
  logoHeight: number;
  radius: number;
  size: number;
}) =>
  assets.agentIcon ? (
    // oxlint-disable-next-line nextjs/no-img-element -- next/og only renders img
    <img
      alt=""
      height={size}
      src={assets.agentIcon}
      style={{ borderRadius: radius, flexShrink: 0, objectFit: "cover" }}
      width={size}
    />
  ) : (
    <div
      style={{
        alignItems: "center",
        backgroundColor: fallbackBackground,
        borderRadius: radius,
        display: "flex",
        flexShrink: 0,
        height: size,
        justifyContent: "center",
        width: size,
      }}
    >
      <EveLogo color={fallbackColor} height={logoHeight} />
    </div>
  );

/** Slack's desktop metrics (15/22 type, 36px avatars), scaled by 0.72 like the card. */
const SLACK_ZOOM = 0.72;

const Slack = ({
  agent,
  assets,
  channel,
  inset,
  messages,
  palette,
}: {
  agent: string;
  assets: OgPreviewAssets;
  channel?: string;
  inset: [number, number, number, number];
  messages: TemplatePreviewMessage[];
  palette: Palette;
}) => (
  <Frame
    inner={{ backgroundColor: palette.slackBg }}
    outer={insetStyle(inset)}
    palette={palette}
    radius={8}
  >
    <div
      style={{
        color: palette.slackFg,
        display: "flex",
        flexDirection: "column",
        fontFamily: "Lato",
        fontSize: 15,
        left: 0,
        lineHeight: 1.46668,
        position: "absolute",
        top: 0,
        right: 0,
        zoom: SLACK_ZOOM,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${palette.slackBorder}`,
          color: palette.slackStrong,
          display: "flex",
          fontSize: 18,
          fontWeight: 900,
          height: 49,
          lineHeight: 1,
          padding: "0 20px",
        }}
      >
        <div style={{ fontWeight: 700, marginRight: 4 }}>#</div>
        {channel ?? "general"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", paddingTop: 8 }}>
        {messages.map((message, index) => {
          const isAgent = message.from === "agent";
          if (messages[index - 1]?.from === message.from) {
            return (
              <div
                key={message.text}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  marginTop: -8,
                  padding: "2px 20px 2px 64px",
                }}
              >
                <SlackText palette={palette} text={message.text} />
                {message.attachment ? (
                  <SlackAttachment attachment={message.attachment} palette={palette} />
                ) : null}
              </div>
            );
          }
          return (
            <div key={message.text} style={{ display: "flex", gap: 8, padding: "8px 20px" }}>
              {isAgent ? (
                <AgentAvatar
                  assets={assets}
                  fallbackBackground={palette.fg}
                  fallbackColor={palette.bg100}
                  logoHeight={11}
                  radius={8}
                  size={36}
                />
              ) : assets.userAvatar ? (
                // oxlint-disable-next-line nextjs/no-img-element -- next/og only renders img
                <img
                  alt=""
                  height={36}
                  src={assets.userAvatar}
                  style={{ borderRadius: 8, flexShrink: 0 }}
                  width={36}
                />
              ) : (
                <div
                  style={{
                    backgroundColor: palette.slackBadgeBg,
                    borderRadius: 8,
                    flexShrink: 0,
                    height: 36,
                    width: 36,
                  }}
                />
              )}
              <div style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
                <div style={{ alignItems: "center", display: "flex", gap: 4 }}>
                  <div style={{ color: palette.slackStrong, fontWeight: 900 }}>
                    {isAgent ? agent : assets.userName}
                  </div>
                  {isAgent ? (
                    <div
                      style={{
                        backgroundColor: palette.slackBadgeBg,
                        borderRadius: 2,
                        color: palette.slackBadgeFg,
                        fontSize: 10,
                        fontWeight: 700,
                        lineHeight: "14px",
                        marginLeft: 4,
                        padding: "1px 3px",
                      }}
                    >
                      APP
                    </div>
                  ) : null}
                  <div style={{ color: palette.slackMuted, fontSize: 12, marginLeft: 4 }}>
                    10:42 AM
                  </div>
                </div>
                <SlackText palette={palette} text={message.text} />
                {message.attachment ? (
                  <SlackAttachment attachment={message.attachment} palette={palette} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </Frame>
);

const SLACK_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+)/;

interface Run {
  gap: boolean;
  style?: CSSProperties;
  text: string;
}

/**
 * Message text with inline styles. next/og has no inline formatting context,
 * so text is laid out word by word in a wrapping flex row. `styleToken`
 * returns the style and text for a token matched by `tokens`; words keep the
 * token's style, so a multi-word link still wraps.
 */
const RichText = ({
  styleToken,
  text,
  tokens,
}: {
  styleToken: (token: string) => { style: CSSProperties; text: string; split?: boolean };
  text: string;
  tokens: RegExp;
}) => {
  if (!tokens.test(text)) return <div style={{ display: "flex" }}>{text}</div>;
  const runs: Run[] = [];
  const addWords = (value: string, style?: CSSProperties) => {
    for (const piece of value.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        const last = runs.at(-1);
        if (last) last.gap = true;
      } else {
        runs.push({ gap: false, style, text: piece });
      }
    }
  };
  text.split(tokens).forEach((part, index) => {
    if (!part) return;
    // split() puts captured tokens at odd indexes.
    if (index % 2 === 0) return addWords(part);
    const token = styleToken(part);
    if (token.split) addWords(token.text, token.style);
    else runs.push({ gap: false, style: token.style, text: token.text });
  });
  return (
    <div style={{ display: "flex", flexWrap: "wrap" }}>
      {runs.map((run, index) => (
        <div
          key={`${index}${run.text}`}
          style={{ ...run.style, display: "flex", marginRight: run.gap ? "0.27em" : 0 }}
        >
          {run.text}
        </div>
      ))}
    </div>
  );
};

/** `code`, [label](url), and @mentions in Slack's styles. The URL is not rendered. */
const SlackText = ({ palette, text }: { palette: Palette; text: string }) => (
  <RichText
    styleToken={(token) => {
      if (token.startsWith("`")) {
        return {
          style: {
            backgroundColor: palette.slackCodeBg,
            border: `1px solid ${palette.slackCodeBorder}`,
            borderRadius: 3,
            color: palette.slackCodeFg,
            fontFamily: "Geist Mono",
            fontSize: 12,
            padding: "0 3px",
          },
          text: token.slice(1, -1),
        };
      }
      if (token.startsWith("[")) {
        return {
          split: true,
          style: { color: palette.slackLink },
          text: token.slice(1, token.indexOf("]")),
        };
      }
      return {
        style: {
          backgroundColor: palette.slackMentionBg,
          borderRadius: 3,
          color: palette.slackLink,
          padding: "0 2px",
        },
        text: token,
      };
    }}
    text={text}
    tokens={SLACK_TOKEN}
  />
);

const NUMERIC = /^[-+$€£]?[\d.,]+[%KMB]?$/;
const CHART_WIDTH = 320;
const CHART_HEIGHT = 36;

const SlackAttachment = ({
  attachment,
  palette,
}: {
  attachment: TemplatePreviewAttachment;
  palette: Palette;
}) => {
  const box: CSSProperties = {
    border: `1px solid ${palette.slackBorder}`,
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    marginTop: 4,
    maxWidth: "100%",
    width: 360,
  };
  switch (attachment.type) {
    case "table": {
      const [header = [], ...body] = attachment.rows;
      const row = (cells: string[], bold: boolean, key: string) => (
        <div
          key={key}
          style={{
            backgroundColor: bold ? palette.slackTint : "transparent",
            display: "flex",
            fontWeight: bold ? 700 : 400,
          }}
        >
          {cells.map((cell, index) => (
            <div
              key={`${index}${cell}`}
              style={{
                border: `1px solid ${palette.slackBorder}`,
                display: "flex",
                flex: 1,
                justifyContent: !bold && NUMERIC.test(cell) ? "flex-end" : "flex-start",
                marginLeft: -1,
                marginTop: -1,
                padding: "0 8px",
              }}
            >
              {cell}
            </div>
          ))}
        </div>
      );
      return (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 5, paddingLeft: 1 }}>
          {row(header, true, "header")}
          {body.map((cells) => row(cells, false, cells.join()))}
        </div>
      );
    }
    case "chart": {
      const { values } = attachment;
      const min = Math.min(...values);
      const span = Math.max(...values) - min || 1;
      const points = values.map((value, index) => [
        (index / Math.max(values.length - 1, 1)) * CHART_WIDTH,
        CHART_HEIGHT - 4 - ((value - min) / span) * (CHART_HEIGHT - 8),
      ]);
      const line = points.map(([x, y]) => `${x},${y}`).join(" ");
      const [lastX, lastY] = points.at(-1) ?? [0, 0];
      return (
        <div style={{ ...box, padding: "8px 12px 10px" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{attachment.title}</div>
          <svg
            preserveAspectRatio="none"
            style={{ height: CHART_HEIGHT, marginTop: 4, overflow: "visible", width: "100%" }}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          >
            {[0.25, 0.75].map((ratio) => (
              <line
                key={ratio}
                stroke={palette.slackBorder}
                strokeDasharray="3 3"
                x1={0}
                x2={CHART_WIDTH}
                y1={CHART_HEIGHT * ratio}
                y2={CHART_HEIGHT * ratio}
              />
            ))}
            <polygon
              fill={palette.slackLink}
              fillOpacity={0.12}
              points={`0,${CHART_HEIGHT} ${line} ${CHART_WIDTH},${CHART_HEIGHT}`}
            />
            <polyline
              fill="none"
              points={line}
              stroke={palette.slackLink}
              strokeLinejoin="round"
              strokeWidth={2}
            />
            <circle cx={lastX} cy={lastY} fill={palette.slackLink} r={3} />
          </svg>
        </div>
      );
    }
    case "tasks":
      return (
        <div style={{ ...box, padding: "6px 12px" }}>
          {attachment.title ? (
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{attachment.title}</div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {attachment.tasks.map((task) => (
              <div key={task.title} style={{ display: "flex", gap: 8 }}>
                <svg height={16} style={{ marginTop: 3 }} viewBox="0 0 24 24" width={16}>
                  <circle cx="12" cy="12" fill={palette.slackGreen} r="10" />
                  <path
                    d="m9 12 2 2 4-4"
                    fill="none"
                    stroke={palette.slackBg}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                  />
                </svg>
                <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700 }}>{task.title}</div>
                  {task.output ? (
                    <div style={{ color: palette.slackMuted, fontSize: 13, marginLeft: 8 }}>
                      {task.output}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    case "link":
      return (
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <div
            style={{
              backgroundColor: palette.slackUnfurl,
              borderRadius: 999,
              flexShrink: 0,
              width: 4,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div
              style={{
                alignItems: "center",
                color: palette.slackMuted,
                display: "flex",
                fontSize: 12,
                gap: 6,
              }}
            >
              <IntegrationIcon integration={attachment.site} size={14} />
              {attachment.site}
            </div>
            <div style={{ color: palette.slackLink, fontWeight: 700 }}>{attachment.title}</div>
            {attachment.description ? <div>{attachment.description}</div> : null}
          </div>
        </div>
      );
    case "approval":
      return (
        <div style={{ display: "flex", fontSize: 13, fontWeight: 700, gap: 8, marginTop: 6 }}>
          <div
            style={{
              backgroundColor: palette.slackButton,
              border: "1px solid transparent",
              borderRadius: 4,
              color: "white",
              padding: "2px 10px",
            }}
          >
            {attachment.approve ?? "Approve"}
          </div>
          <div
            style={{
              border: `1px solid ${palette.slackBorder}`,
              borderRadius: 4,
              padding: "2px 10px",
            }}
          >
            Cancel
          </div>
        </div>
      );
  }
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

const Octicon = ({
  color,
  paths,
  size = 16,
  style,
}: {
  color: string;
  paths: string[];
  size?: number;
  style?: CSSProperties;
}) => (
  <svg fill={color} height={size} style={style} viewBox="0 0 16 16" width={size}>
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

/** github.com's metrics (Mona Sans 14/21, 40px timeline avatars), zoomed down like the card. */
const GITHUB_ZOOM = 0.7;
const GH_MONO = "Geist Mono";

/**
 * An issue timeline, or a review thread when `preview.review` is set, under
 * GitHub's sticky header, in Primer's dark palette.
 */
const GitHub = ({
  agent,
  assets,
  inset,
  palette,
  preview,
}: {
  agent: string;
  assets: OgPreviewAssets;
  inset: [number, number, number, number];
  palette: Palette;
  preview: TemplatePreview;
}) => (
  <Frame
    inner={{ backgroundColor: palette.ghBg }}
    outer={insetStyle(inset)}
    palette={palette}
    radius={8}
  >
    <div
      style={{
        color: palette.ghFg,
        display: "flex",
        flexDirection: "column",
        fontFamily: "Mona Sans",
        fontSize: 14,
        left: 0,
        lineHeight: "21px",
        position: "absolute",
        right: 0,
        top: 0,
        zoom: GITHUB_ZOOM,
      }}
    >
      <GitHubHeader
        palette={palette}
        thread={preview.thread ?? { kind: "issue", number: 1, title: agent }}
      />
      {preview.review ? (
        <GitHubReview
          agent={agent}
          assets={assets}
          palette={palette}
          preview={preview}
          review={preview.review}
        />
      ) : (
        <GitHubTimeline agent={agent} assets={assets} palette={palette} preview={preview} />
      )}
    </div>
  </Frame>
);

const GitHubHeader = ({ palette, thread }: { palette: Palette; thread: TemplatePreviewThread }) => {
  const draft = thread.kind === "pull" && thread.draft;
  const stateIcon =
    thread.kind === "issue"
      ? OCTICONS.issueOpened
      : draft
        ? OCTICONS.pullRequestDraft
        : OCTICONS.pullRequest;
  return (
    <div
      style={{
        alignItems: "center",
        borderBottom: `1px solid ${palette.ghBorder}`,
        display: "flex",
        gap: 8,
        padding: "8px 16px",
      }}
    >
      <div
        style={{
          alignItems: "center",
          backgroundColor: draft ? palette.ghDraft : palette.ghOpen,
          borderRadius: 999,
          color: "white",
          display: "flex",
          flexShrink: 0,
          fontWeight: 600,
          height: 32,
          lineHeight: "16px",
          padding: "0 12px",
        }}
      >
        <Octicon color="white" paths={stateIcon} style={{ marginRight: 4 }} />
        {draft ? "Draft" : "Open"}
      </div>
      <div style={{ alignItems: "baseline", display: "flex", gap: 8, minWidth: 0 }}>
        <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{thread.title}</div>
        <div
          style={{ color: palette.ghMuted, display: "flex", flexShrink: 0 }}
        >{`#${thread.number}`}</div>
      </div>
    </div>
  );
};

const GitHubAvatar = ({
  assets,
  isAgent,
  palette,
  size,
}: {
  assets: OgPreviewAssets;
  isAgent: boolean;
  palette: Palette;
  size: number;
}) => {
  // GitHub draws apps with rounded squares and people with circles.
  const radius = isAgent ? 6 : 999;
  const ring = { boxShadow: `0 0 0 1px ${palette.ghAvatarRing}` };
  if (isAgent) {
    return (
      <div style={{ ...ring, borderRadius: radius, display: "flex", flexShrink: 0 }}>
        <AgentAvatar
          assets={assets}
          fallbackBackground={palette.fg}
          fallbackColor={palette.bg100}
          logoHeight={Math.round(size * 0.3)}
          radius={radius}
          size={size}
        />
      </div>
    );
  }
  return assets.userAvatar ? (
    // oxlint-disable-next-line nextjs/no-img-element -- next/og only renders img
    <img
      alt=""
      height={size}
      src={assets.userAvatar}
      style={{ ...ring, borderRadius: radius, flexShrink: 0 }}
      width={size}
    />
  ) : (
    <div
      style={{
        backgroundColor: palette.ghBorder,
        borderRadius: radius,
        flexShrink: 0,
        height: size,
        width: size,
      }}
    />
  );
};

/** Author, the `Bot` label for the agent, and the underlined relative time. */
const GitHubAuthor = ({
  agent,
  assets,
  isAgent,
  palette,
}: {
  agent: string;
  assets: OgPreviewAssets;
  isAgent: boolean;
  palette: Palette;
}) => (
  <div style={{ alignItems: "center", display: "flex", gap: 4 }}>
    <div style={{ color: palette.ghFg, fontWeight: 600 }}>{isAgent ? agent : assets.userLogin}</div>
    {isAgent ? (
      <div
        style={{
          border: `1px solid ${palette.ghBorder}`,
          borderRadius: 999,
          color: palette.ghMuted,
          fontSize: 12,
          fontWeight: 500,
          lineHeight: "18px",
          padding: "0 6px",
        }}
      >
        Bot
      </div>
    ) : null}
    <div style={{ color: palette.ghMuted, textDecoration: "underline" }}>now</div>
  </div>
);

const GitHubTimeline = ({
  agent,
  assets,
  palette,
  preview,
}: {
  agent: string;
  assets: OgPreviewAssets;
  palette: Palette;
  preview: TemplatePreview;
}) => (
  <div
    style={{ display: "flex", flexDirection: "column", padding: "0 16px", position: "relative" }}
  >
    {/* The timeline line sits 16px into the comment column, after the 40px avatar and a 16px gap. */}
    <div
      style={{
        backgroundColor: palette.ghTimeline,
        bottom: 0,
        left: 88,
        position: "absolute",
        top: 0,
        width: 2,
      }}
    />
    {preview.messages.map((message) =>
      message.event === "labeled" ? (
        <div
          key={message.text}
          style={{ display: "flex", padding: "16px 0 16px 56px", position: "relative" }}
        >
          <div
            style={{
              alignItems: "center",
              backgroundColor: palette.ghBadgeBg,
              border: `2px solid ${palette.ghBg}`,
              borderRadius: 999,
              display: "flex",
              flexShrink: 0,
              height: 32,
              justifyContent: "center",
              marginLeft: 1,
              marginRight: 8,
              width: 32,
            }}
          >
            <Octicon color={palette.ghMuted} paths={OCTICONS.tag} />
          </div>
          <div
            style={{
              alignItems: "center",
              color: palette.ghMuted,
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
            }}
          >
            <GitHubAvatar assets={assets} isAgent={false} palette={palette} size={20} />
            <div style={{ color: palette.ghFg, fontWeight: 600 }}>{assets.userLogin}</div>
            <div>added the</div>
            <div
              style={{
                backgroundColor: palette.ghLabelBg,
                border: `1px solid ${palette.ghLabelBorder}`,
                borderRadius: 999,
                color: palette.ghLabelFg,
                fontSize: 12,
                fontWeight: 500,
                lineHeight: "18px",
                padding: "0 7px",
              }}
            >
              {message.text}
            </div>
            <div>label now</div>
          </div>
        </div>
      ) : (
        <div
          key={message.text}
          style={{ display: "flex", padding: "16px 0 16px 56px", position: "relative" }}
        >
          <div style={{ display: "flex", left: 0, position: "absolute", top: 16 }}>
            <GitHubAvatar
              assets={assets}
              isAgent={message.from === "agent"}
              palette={palette}
              size={40}
            />
          </div>
          <div
            style={{
              backgroundColor: palette.ghBg,
              border: `1px solid ${palette.ghBorder}`,
              borderRadius: 6,
              display: "flex",
              flexDirection: "column",
              flexGrow: 1,
              position: "relative",
            }}
          >
            {/* GitHub's caret toward the avatar: a border-colored triangle under a header-colored one. */}
            <svg
              height={16}
              style={{ left: -8, position: "absolute", top: 11 }}
              viewBox="0 0 8 16"
              width={8}
            >
              <polygon fill={palette.ghBorder} points="0,8 8,0 8,16" />
              <polygon fill={palette.ghMutedBg} points="1.5,8 8,1.5 8,14.5" />
            </svg>
            <div
              style={{
                alignItems: "center",
                backgroundColor: palette.ghMutedBg,
                borderBottom: `1px solid ${palette.ghBorder}`,
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 16px",
              }}
            >
              <GitHubAuthor
                agent={agent}
                assets={assets}
                isAgent={message.from === "agent"}
                palette={palette}
              />
              <Octicon color={palette.ghMuted} paths={OCTICONS.kebab} />
            </div>
            <div style={{ display: "flex", padding: 16 }}>
              <GitHubText palette={palette} text={message.text} />
            </div>
          </div>
        </div>
      ),
    )}
  </div>
);

/** A review thread on one added line, as it appears in the PR's conversation. */
const GitHubReview = ({
  agent,
  assets,
  palette,
  preview,
  review,
}: {
  agent: string;
  assets: OgPreviewAssets;
  palette: Palette;
  preview: TemplatePreview;
  review: { line: number; code: string };
}) => (
  <div style={{ display: "flex", padding: "0 16px" }}>
    <div
      style={{
        border: `1px solid ${palette.ghBorder}`,
        borderBottomLeftRadius: 6,
        borderBottomRightRadius: 6,
        borderTopWidth: 0,
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", fontFamily: GH_MONO, fontSize: 12, lineHeight: "20px" }}>
        <div style={{ backgroundColor: palette.ghAddNumberBg, flexShrink: 0, width: 50 }} />
        <div
          style={{
            backgroundColor: palette.ghAddNumberBg,
            display: "flex",
            flexShrink: 0,
            justifyContent: "flex-end",
            padding: "0 10px",
            width: 50,
          }}
        >
          {review.line}
        </div>
        <div
          style={{
            backgroundColor: palette.ghAddLineBg,
            display: "flex",
            flexGrow: 1,
            gap: 8,
            padding: "0 10px 0 8px",
            whiteSpace: "pre",
          }}
        >
          <div>+</div>
          <DiffCode code={review.code} palette={palette} />
        </div>
      </div>
      {preview.messages.map((message) => (
        <div
          key={message.text}
          style={{
            borderTop: `1px solid ${palette.ghBorder}`,
            display: "flex",
            flexDirection: "column",
            padding: "8px 16px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", marginLeft: -4, padding: "4px 0" }}>
            <div style={{ display: "flex", marginRight: 8 }}>
              <GitHubAvatar
                assets={assets}
                isAgent={message.from === "agent"}
                palette={palette}
                size={24}
              />
            </div>
            <GitHubAuthor
              agent={agent}
              assets={assets}
              isAgent={message.from === "agent"}
              palette={palette}
            />
            <Octicon
              color={palette.ghMuted}
              paths={OCTICONS.kebab}
              style={{ marginLeft: "auto" }}
            />
          </div>
          <div style={{ display: "flex", marginLeft: 28 }}>
            <GitHubText palette={palette} text={message.text} />
          </div>
        </div>
      ))}
    </div>
  </div>
);

const DIFF_TOKEN = /(\b(?:const|let|var|return|await|if|new|function)\b|\b\d+\b)/;

/** GitHub's syntax colors for the few tokens a one-line sample needs. */
const DiffCode = ({ code, palette }: { code: string; palette: Palette }) => (
  <div style={{ display: "flex" }}>
    {code.split(DIFF_TOKEN).map((part, index) => (
      <div
        key={`${index}${part}`}
        style={{
          color: /^\d+$/.test(part)
            ? palette.ghNumber
            : index % 2 === 1
              ? palette.ghKeyword
              : undefined,
          display: "flex",
        }}
      >
        {part}
      </div>
    ))}
  </div>
);

/** `code`, [label](url), @mentions, and #123 references. */
const GITHUB_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+|#\d+)/;

/** Comment text in GitHub's Markdown styles, with link underlines on. */
const GitHubText = ({ palette, text }: { palette: Palette; text: string }) => (
  <RichText
    styleToken={(token) => {
      if (token.startsWith("`")) {
        return {
          style: {
            backgroundColor: palette.ghCodeBg,
            borderRadius: 6,
            fontFamily: GH_MONO,
            fontSize: 12,
            padding: "0 5px",
          },
          text: token.slice(1, -1),
        };
      }
      if (token.startsWith("@")) {
        return {
          style: { color: palette.ghFg, fontWeight: 600, textDecoration: "underline" },
          text: token,
        };
      }
      return {
        split: true,
        style: { color: palette.ghLink, textDecoration: "underline" },
        text: token.startsWith("[") ? token.slice(1, token.indexOf("]")) : token,
      };
    }}
    text={text}
    tokens={GITHUB_TOKEN}
  />
);

const IMessage = ({
  agent,
  assets,
  messages,
  palette,
}: {
  agent: string;
  assets: OgPreviewAssets;
  messages: TemplatePreviewMessage[];
  palette: Palette;
}) => (
  <Frame
    inner={{ backgroundColor: palette.bg100, color: palette.fg, fontSize: 10.5, lineHeight: 1.3 }}
    outer={{
      bottom: -40,
      left: "50%",
      marginLeft: -128,
      position: "absolute",
      top: 12,
      width: 256,
    }}
    palette={palette}
    radius={30}
  >
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "column",
        paddingTop: 10,
        position: "relative",
      }}
    >
      <div
        style={{
          alignItems: "center",
          backgroundColor: palette.glass,
          border: `0.5px solid ${palette.border}`,
          borderRadius: 999,
          display: "flex",
          height: 24,
          justifyContent: "center",
          left: 12,
          position: "absolute",
          top: 14,
          width: 24,
        }}
      >
        <svg fill="none" height={10} viewBox="0 0 7 12" width={6}>
          <path
            d="M6 1 1 6l5 5"
            stroke={palette.fg}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </div>
      <AgentAvatar
        assets={assets}
        fallbackBackground="#959aa5"
        fallbackColor="white"
        logoHeight={8}
        radius={999}
        size={32}
      />
      <div
        style={{
          backgroundColor: palette.glass,
          border: `0.5px solid ${palette.border}`,
          borderRadius: 999,
          display: "flex",
          fontSize: 9.5,
          fontWeight: 500,
          marginTop: -4,
          padding: "2px 8px",
        }}
      >
        {agent}
        <div style={{ color: "#8e8e93", fontWeight: 400, marginLeft: 2 }}>›</div>
      </div>
    </div>
    <div style={{ display: "flex", flexDirection: "column", padding: "8px 14px 0" }}>
      {messages.map((message, index) => {
        const sent = message.from === "user";
        const next = messages[index + 1];
        const tail = !next || next.from !== message.from;
        return (
          <div
            key={message.text}
            style={{
              alignSelf: sent ? "flex-end" : "flex-start",
              backgroundColor: sent ? "#0a84ff" : palette.imReceived,
              borderRadius: 14,
              borderBottomLeftRadius: tail && !sent ? 4 : 14,
              borderBottomRightRadius: tail && sent ? 4 : 14,
              color: sent ? "white" : palette.fg,
              display: "flex",
              marginBottom: tail && next ? 6 : 2,
              maxWidth: "78%",
              padding: "5px 10px",
            }}
          >
            {message.text}
          </div>
        );
      })}
    </div>
  </Frame>
);

const Placeholder = ({
  integrations,
  palette,
}: {
  integrations: TemplateIntegration[];
  palette: Palette;
}) => {
  const tile: CSSProperties = {
    alignItems: "center",
    backgroundColor: palette.bg100,
    border: `1px solid ${palette.border}`,
    borderRadius: 10,
    display: "flex",
    flexShrink: 0,
    height: 44,
    justifyContent: "center",
    minWidth: 44,
    padding: "0 10px",
  };
  return (
    <div
      style={{
        alignItems: "center",
        bottom: 0,
        display: "flex",
        gap: 10,
        justifyContent: "center",
        left: 0,
        position: "absolute",
        right: 0,
        top: 0,
      }}
    >
      <div style={tile}>
        <EveLogo color={palette.fg} height={14} />
      </div>
      <div style={{ color: palette.gray700, fontSize: 14 }}>+</div>
      {integrations.slice(0, 4).map((integration) => (
        <div key={integration} style={{ ...tile, filter: "grayscale(1)" }}>
          <IntegrationIcon color={palette.fg} integration={integration} size={20} />
        </div>
      ))}
    </div>
  );
};

const UNITLESS = new Set([
  "flex",
  "flexGrow",
  "flexShrink",
  "fontWeight",
  "lineHeight",
  "opacity",
  "zIndex",
  "zoom",
]);
const PX = /(-?\d*\.?\d+)px/g;

const scaleValue = (key: string, value: unknown, factor: number): unknown => {
  if (typeof value === "number") return UNITLESS.has(key) ? value : value * factor;
  if (typeof value === "string" && !key.startsWith("mask") && !key.startsWith("background")) {
    return value.replace(PX, (_, n: string) => `${Number(n) * factor}px`);
  }
  return value;
};

type ScalableProps = {
  children?: ReactNode;
  height?: number | string;
  style?: CSSProperties & { zoom?: number };
  width?: number | string;
};

/**
 * Multiplies every length in a card-scale tree by `factor`. next/og clips
 * `overflow` and `mask-image` in untransformed coordinates, so a CSS
 * `transform: scale()` cuts the scaled content off; scaling the lengths
 * themselves keeps clipping correct. A `zoom` style scales its subtree further,
 * like the card's Slack preview.
 */
export const scaleTree = (node: ReactNode, factor: number): ReactNode => {
  if (Array.isArray(node)) return node.map((child) => scaleTree(child, factor));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<ScalableProps>;
  if (typeof element.type === "function") {
    const component = element.type as (props: ScalableProps) => ReactNode;
    return scaleTree(component(element.props), factor);
  }
  const { children, style, ...props } = element.props;
  const zoom = style?.zoom ?? 1;
  const nextProps: ScalableProps & Record<string, unknown> = { ...props };
  if (style) {
    const scaled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
      if (key === "zoom") continue;
      // `fontSize` and friends inside a zoomed box use the zoomed factor.
      scaled[key] = scaleValue(key, value, factor * zoom);
    }
    nextProps.style = scaled as ScalableProps["style"];
  }
  // Only the root svg's size scales; children live in its viewBox.
  if (element.type === "svg" || element.type === "img") {
    if (typeof props.width === "number") nextProps.width = props.width * factor;
    if (typeof props.height === "number") nextProps.height = props.height * factor;
    return cloneElement(element, nextProps, children);
  }
  return cloneElement(
    element,
    nextProps,
    ...Children.toArray(children).map((child) => scaleTree(child, factor * zoom)),
  );
};
