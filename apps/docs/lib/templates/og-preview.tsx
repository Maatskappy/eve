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
import {
  grayscaleIntegrationIcons,
  integrationIcons,
} from "@/app/[lang]/templates/integration-icons";
import { resolveLogo } from "../og-logo";
import type {
  TemplateIntegration,
  TemplateManifestEntry,
  TemplatePreview,
  TemplatePreviewAttachment,
  TemplatePreviewMessage,
  TemplatePreviewThread,
} from "./manifest";
import {
  APP_WINDOW_RAISE,
  clamp01,
  DOT_MATRIX,
  dotMatrixVariant,
  dotOpacity,
  GITHUB_COLORS,
  GITHUB_ZOOM,
  githubAvatarUrl,
  IMESSAGE_COLORS,
  isNumericCell,
  MAX_PLACEHOLDER_ICONS,
  OCTICONS,
  PHONE_FRAME,
  parseDiffCode,
  parseMessageText,
  pickPreviewUser,
  SLACK_CHART,
  SLACK_COLORS,
  SLACK_TIMESTAMP,
  SLACK_ZOOM,
  smoothstep,
  type TextSegment,
  WINDOW_INSET,
} from "./preview-kit";

/** Dark-mode Geist tokens resolved to sRGB, plus the app palettes the card uses. */
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
  glass: "rgba(255,255,255,0.12)",
  slack: SLACK_COLORS.dark,
  github: GITHUB_COLORS.dark,
  imessage: IMESSAGE_COLORS.dark,
};

type Palette = typeof ogPalette;

/**
 * The card's dot matrix as an SVG data URI. `fade` is the height over which
 * dots fade out downward; pass `Infinity` for an even field.
 */
export const dotMatrixSrc = ({
  color,
  fade = DOT_MATRIX.height,
  gap = DOT_MATRIX.gap,
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
  const variant = dotMatrixVariant(seed);
  const dots: string[] = [];
  for (let y = gap / 2; y < height; y += gap) {
    for (let x = gap / 2; x < width; x += gap) {
      const leftFalloff = fadeLeft ? smoothstep(clamp01(x / fadeLeft)) : 1;
      const opacity =
        dotOpacity({ fadeHeight: fade, scale: gap / DOT_MATRIX.gap, variant, x, y }) *
        leftFalloff *
        strength;
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
  const user = pickPreviewUser(agent);
  const [agentIcon, userAvatar] = await Promise.all([
    template.preview?.icon ? loadPublicImage(template.preview.icon) : undefined,
    template.preview?.surface === "slack" || template.preview?.surface === "github"
      ? loadRemoteImage(githubAvatarUrl(user))
      : undefined,
  ]);
  return { agentIcon, userAvatar, userLogin: user.login, userName: user.name };
};

const EveLogo = ({ color, height }: { color: string; height: number }) => (
  <div style={{ color, display: "flex" }}>{resolveLogo(<LogoEveSvg height={height} />)}</div>
);

/**
 * Sizes a logo to fit a `size` square at its own aspect ratio. next/og
 * stretches an SVG to its width and height, ignoring `preserveAspectRatio`.
 */
const fitLogo = (node: ReactNode, size: number): ReactNode => {
  if (!isValidElement<{ viewBox?: string }>(node)) return node;
  const [, , width = 1, height = 1] = (node.props.viewBox ?? "").split(/[\s,]+/).map(Number);
  const aspect = width / height || 1;
  return cloneElement(node as ReactElement<{ height?: number; width?: number }>, {
    height: aspect >= 1 ? size / aspect : size,
    width: aspect >= 1 ? size : size * aspect,
  });
};

const IntegrationIcon = ({
  color,
  grayscale = false,
  integration,
  size,
}: {
  color?: string;
  /** Use the icon set meant for grayscale, like the card's placeholder tiles. */
  grayscale?: boolean;
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
  const Icon = (grayscale ? grayscaleIntegrationIcons : integrationIcons)[integration];
  return <div style={{ color, display: "flex" }}>{fitLogo(resolveLogo(<Icon />), size)}</div>;
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
  /** Window inset from the scene edges, in scene pixels. Defaults to the card's. */
  inset?: Inset;
  /**
   * Height of the part of the scene that is not faded out. The Voice
   * template's call controls pin to it, as they pin to the card's bottom edge.
   */
  visibleHeight: number;
}

/**
 * The gallery card header's foreground at card scale (`width` × `height` CSS
 * pixels): a conversation window, or the eve-plus-integrations placeholder.
 * Size it for the OG canvas with `scaleTree`.
 */
export const HeaderScene = ({
  assets,
  height,
  inset = WINDOW_INSET,
  palette,
  template,
  visibleHeight,
  width,
}: SceneProps) => {
  const preview = template.preview;
  return (
    <div style={{ display: "flex", height, position: "relative", width }}>
      {preview ? (
        <Conversation
          agent={preview.agent ?? template.title}
          assets={assets}
          context={preview.context}
          footerBottom={height - inset.bottom - visibleHeight}
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

type Inset = typeof WINDOW_INSET;

const insetStyle = (inset: Inset) => ({ ...inset, position: "absolute" }) satisfies CSSProperties;

/** Slack and GitHub windows start higher, to fit their channel or thread header. */
const raise = (inset: Inset): Inset => ({ ...inset, top: inset.top - APP_WINDOW_RAISE });

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
  inset: Inset;
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
        inset={raise(inset)}
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
        inset={raise(inset)}
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
  inset: Inset;
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
        ...(fallbackBackground.startsWith("linear-gradient(")
          ? { backgroundImage: fallbackBackground }
          : { backgroundColor: fallbackBackground }),
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
  inset: Inset;
  messages: TemplatePreviewMessage[];
  palette: Palette;
}) => (
  <Frame
    inner={{ backgroundColor: palette.slack.bg }}
    outer={insetStyle(inset)}
    palette={palette}
    radius={8}
  >
    <div
      style={{
        color: palette.slack.fg,
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
          borderBottom: `1px solid ${palette.slack.border}`,
          color: palette.slack.strong,
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
                    backgroundColor: palette.slack.hairline,
                    borderRadius: 8,
                    flexShrink: 0,
                    height: 36,
                    width: 36,
                  }}
                />
              )}
              <div style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
                <div style={{ alignItems: "center", display: "flex", gap: 4 }}>
                  <div style={{ color: palette.slack.strong, fontWeight: 900 }}>
                    {isAgent ? agent : assets.userName}
                  </div>
                  {isAgent ? (
                    <div
                      style={{
                        backgroundColor: palette.slack.hairline,
                        borderRadius: 2,
                        color: palette.slack.badgeFg,
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
                  <div style={{ color: palette.slack.muted, fontSize: 12, marginLeft: 4 }}>
                    {SLACK_TIMESTAMP}
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

interface Run {
  gap: boolean;
  style?: CSSProperties;
  text: string;
}

/**
 * Message text with inline styles. next/og has no inline formatting context,
 * so text is laid out word by word in a wrapping flex row. Words keep their
 * segment's style, so a multi-word link still wraps.
 */
const RichText = ({
  segments,
  styleOf,
}: {
  segments: TextSegment[];
  styleOf: (kind: TextSegment["kind"]) => CSSProperties | undefined;
}) => {
  if (segments.every((segment) => segment.kind === "text")) {
    return (
      <div style={{ display: "flex" }}>{segments.map((segment) => segment.text).join("")}</div>
    );
  }
  const runs: Run[] = [];
  for (const segment of segments) {
    const style = styleOf(segment.kind);
    // Code and mentions stay whole; text and links wrap between words.
    if (segment.kind === "code" || segment.kind === "mention") {
      runs.push({ gap: false, style, text: segment.text });
      continue;
    }
    for (const piece of segment.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        const last = runs.at(-1);
        if (last) last.gap = true;
      } else {
        runs.push({ gap: false, style, text: piece });
      }
    }
  }
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

/** Message text with Slack's inline code, link, and user mention styles. */
const SlackText = ({ palette, text }: { palette: Palette; text: string }) => (
  <RichText
    segments={parseMessageText(text, "slack")}
    styleOf={(kind) => {
      if (kind === "code") {
        return {
          backgroundColor: palette.slack.codeBg,
          border: `1px solid ${palette.slack.hairline}`,
          borderRadius: 3,
          color: palette.slack.codeFg,
          fontFamily: "Geist Mono",
          fontSize: 12,
          padding: "0 3px",
        };
      }
      if (kind === "link") return { color: palette.slack.link };
      if (kind === "mention") {
        return {
          backgroundColor: palette.slack.mentionBg,
          borderRadius: 3,
          color: palette.slack.link,
          padding: "0 2px",
        };
      }
      return undefined;
    }}
  />
);

const { height: CHART_HEIGHT, width: CHART_WIDTH } = SLACK_CHART;

const SlackAttachment = ({
  attachment,
  palette,
}: {
  attachment: TemplatePreviewAttachment;
  palette: Palette;
}) => {
  const box: CSSProperties = {
    border: `1px solid ${palette.slack.border}`,
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
            backgroundColor: bold ? palette.slack.tint : "transparent",
            display: "flex",
            fontWeight: bold ? 700 : 400,
          }}
        >
          {cells.map((cell, index) => (
            <div
              key={`${index}${cell}`}
              style={{
                border: `1px solid ${palette.slack.border}`,
                display: "flex",
                flex: 1,
                justifyContent: !bold && isNumericCell(cell) ? "flex-end" : "flex-start",
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
                stroke={palette.slack.border}
                strokeDasharray="3 3"
                x1={0}
                x2={CHART_WIDTH}
                y1={CHART_HEIGHT * ratio}
                y2={CHART_HEIGHT * ratio}
              />
            ))}
            <polygon
              fill={palette.slack.link}
              fillOpacity={0.12}
              points={`0,${CHART_HEIGHT} ${line} ${CHART_WIDTH},${CHART_HEIGHT}`}
            />
            <polyline
              fill="none"
              points={line}
              stroke={palette.slack.link}
              strokeLinejoin="round"
              strokeWidth={2}
            />
            <circle cx={lastX} cy={lastY} fill={palette.slack.link} r={3} />
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
                  <circle cx="12" cy="12" fill={palette.slack.green} r="10" />
                  <path
                    d="m9 12 2 2 4-4"
                    fill="none"
                    stroke={palette.slack.bg}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                  />
                </svg>
                <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700 }}>{task.title}</div>
                  {task.output ? (
                    <div style={{ color: palette.slack.muted, fontSize: 13, marginLeft: 8 }}>
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
              backgroundColor: palette.slack.unfurl,
              borderRadius: 999,
              flexShrink: 0,
              width: 4,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div
              style={{
                alignItems: "center",
                color: palette.slack.muted,
                display: "flex",
                fontSize: 12,
                gap: 6,
              }}
            >
              <IntegrationIcon integration={attachment.site} size={14} />
              {attachment.site}
            </div>
            <div style={{ color: palette.slack.link, fontWeight: 700 }}>{attachment.title}</div>
            {attachment.description ? <div>{attachment.description}</div> : null}
          </div>
        </div>
      );
    case "approval":
      return (
        <div style={{ display: "flex", fontSize: 13, fontWeight: 700, gap: 8, marginTop: 6 }}>
          <div
            style={{
              backgroundColor: palette.slack.button,
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
              border: `1px solid ${palette.slack.border}`,
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
  inset: Inset;
  palette: Palette;
  preview: TemplatePreview;
}) => (
  <Frame
    inner={{ backgroundColor: palette.github.bg }}
    outer={insetStyle(inset)}
    palette={palette}
    radius={8}
  >
    <div
      style={{
        color: palette.github.fg,
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
        borderBottom: `1px solid ${palette.github.border}`,
        display: "flex",
        gap: 8,
        padding: "8px 16px",
      }}
    >
      <div
        style={{
          alignItems: "center",
          backgroundColor: draft ? palette.github.draft : palette.github.open,
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
          style={{ color: palette.github.muted, display: "flex", flexShrink: 0 }}
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
  const ring = { boxShadow: `0 0 0 1px ${palette.github.avatarRing}` };
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
        backgroundColor: palette.github.border,
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
    <div style={{ color: palette.github.fg, fontWeight: 600 }}>
      {isAgent ? agent : assets.userLogin}
    </div>
    {isAgent ? (
      <div
        style={{
          border: `1px solid ${palette.github.border}`,
          borderRadius: 999,
          color: palette.github.muted,
          fontSize: 12,
          fontWeight: 500,
          lineHeight: "18px",
          padding: "0 6px",
        }}
      >
        Bot
      </div>
    ) : null}
    <div style={{ color: palette.github.muted, textDecoration: "underline" }}>now</div>
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
        backgroundColor: palette.github.timeline,
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
              backgroundColor: palette.github.badgeBg,
              border: `2px solid ${palette.github.bg}`,
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
            <Octicon color={palette.github.muted} paths={OCTICONS.tag} />
          </div>
          <div
            style={{
              alignItems: "center",
              color: palette.github.muted,
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
            }}
          >
            <GitHubAvatar assets={assets} isAgent={false} palette={palette} size={20} />
            <div style={{ color: palette.github.fg, fontWeight: 600 }}>{assets.userLogin}</div>
            <div>added the</div>
            <div
              style={{
                backgroundColor: palette.github.labelBg,
                border: `1px solid ${palette.github.labelBorder}`,
                borderRadius: 999,
                color: palette.github.labelFg,
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
              backgroundColor: palette.github.bg,
              border: `1px solid ${palette.github.border}`,
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
              <polygon fill={palette.github.border} points="0,8 8,0 8,16" />
              <polygon fill={palette.github.mutedBg} points="1.5,8 8,1.5 8,14.5" />
            </svg>
            <div
              style={{
                alignItems: "center",
                backgroundColor: palette.github.mutedBg,
                borderBottom: `1px solid ${palette.github.border}`,
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
              <Octicon color={palette.github.muted} paths={OCTICONS.kebab} />
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
        border: `1px solid ${palette.github.border}`,
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
        <div style={{ backgroundColor: palette.github.addNumberBg, flexShrink: 0, width: 50 }} />
        <div
          style={{
            backgroundColor: palette.github.addNumberBg,
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
            backgroundColor: palette.github.addLineBg,
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
            borderTop: `1px solid ${palette.github.border}`,
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
              color={palette.github.muted}
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

/** GitHub's syntax colors for the few tokens a one-line sample needs. */
const DiffCode = ({ code, palette }: { code: string; palette: Palette }) => (
  <div style={{ display: "flex" }}>
    {parseDiffCode(code).map((token, index) => (
      <div
        key={`${index}${token.text}`}
        style={{
          color:
            token.kind === "number"
              ? palette.github.number
              : token.kind === "keyword"
                ? palette.github.keyword
                : undefined,
          display: "flex",
        }}
      >
        {token.text}
      </div>
    ))}
  </div>
);

/** Comment text in GitHub's Markdown styles, with link underlines on. */
const GitHubText = ({ palette, text }: { palette: Palette; text: string }) => (
  <RichText
    segments={parseMessageText(text, "github")}
    styleOf={(kind) => {
      if (kind === "code") {
        return {
          backgroundColor: palette.github.codeBg,
          borderRadius: 6,
          fontFamily: GH_MONO,
          fontSize: 12,
          padding: "0 5px",
        };
      }
      if (kind === "mention") {
        return { color: palette.github.fg, fontWeight: 600, textDecoration: "underline" };
      }
      if (kind === "link" || kind === "reference") {
        return { color: palette.github.link, textDecoration: "underline" };
      }
      return undefined;
    }}
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
      ...PHONE_FRAME,
      left: "50%",
      marginLeft: -PHONE_FRAME.width / 2,
      position: "absolute",
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
        fallbackBackground={`linear-gradient(${palette.imessage.avatarTop}, ${palette.imessage.avatarBottom})`}
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
        <div style={{ color: palette.imessage.muted, fontWeight: 400, marginLeft: 2 }}>›</div>
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
              backgroundColor: sent ? palette.imessage.sent : palette.imessage.received,
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
      {integrations.slice(0, MAX_PLACEHOLDER_ICONS).map((integration) => (
        <div key={integration} style={{ ...tile, filter: "grayscale(1)" }}>
          <IntegrationIcon color={palette.fg} grayscale integration={integration} size={20} />
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
