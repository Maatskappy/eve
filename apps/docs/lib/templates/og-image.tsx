import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import type { TemplateManifestEntry } from "./manifest";
import { dotMatrixSrc, HeaderScene, loadOgPreviewAssets, ogPalette, scaleTree } from "./og-preview";

const WIDTH = 1200;
const HEIGHT = 628;

/** Page margin and text column, on Geist's 4px grid. */
const MARGIN = 64;
const TEXT_WIDTH = 504;

/**
 * The card header, at 2x card scale, runs off the right edge and fades out
 * over its last `SCENE_FADE` so only the first exchange shows, rather than
 * a mostly empty window running to the bottom of the image.
 */
const SCENE_LEFT = 616;
const SCENE_HEIGHT = 410;
/** Centers the header vertically on the canvas. */
const SCENE_TOP = (HEIGHT - SCENE_HEIGHT) / 2;
const SCENE_FADE = 0.22;
const SCENE_SCALE = 2;
/** The eve-plus-integrations placeholder has no window to bleed, so it centers vertically. */
const PLACEHOLDER_SCALE = 2.4;

const fontPath = (file: string) => join(process.cwd(), "lib/templates/fonts", file);
const ogFontDirectory = join(process.cwd(), "app/[lang]/og/[...slug]");
const fonts = Promise.all(
  [
    { name: "Geist", path: join(ogFontDirectory, "geist-sans-regular.ttf"), weight: 400 },
    { name: "Geist", path: join(ogFontDirectory, "geist-sans-semibold.ttf"), weight: 600 },
    { name: "Geist Mono", path: fontPath("GeistMono-Regular.ttf"), weight: 400 },
    // The Slack and GitHub previews use those apps' own typefaces, like the card.
    { name: "Lato", path: fontPath("Lato-Regular.ttf"), weight: 400 },
    { name: "Lato", path: fontPath("Lato-Bold.ttf"), weight: 700 },
    { name: "Lato", path: fontPath("Lato-Black.ttf"), weight: 900 },
    { name: "Mona Sans", path: fontPath("MonaSans-Regular.ttf"), weight: 400 },
    { name: "Mona Sans", path: fontPath("MonaSans-Medium.ttf"), weight: 500 },
    { name: "Mona Sans", path: fontPath("MonaSans-SemiBold.ttf"), weight: 600 },
  ].map(async ({ name, path, weight }) => ({
    data: await readFile(path),
    name,
    weight: weight as 400 | 500 | 600 | 700 | 900,
  })),
);

const palette = ogPalette;

type Fonts = Awaited<typeof fonts>;

const renderPng = async (node: ReactNode, width: number, height: number, fontData: Fonts) => {
  const response = new ImageResponse(<div style={{ display: "flex" }}>{node}</div>, {
    fonts: fontData,
    height,
    width,
  });
  return `data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
};

/**
 * Text on the left and the template's gallery card header (its sample
 * conversation, or the eve-plus-integrations placeholder) bleeding off the
 * right, like vercel.com's blog, changelog, and templates OG images. Sizes
 * follow Geist's scale: `text-label-20` for "Template", `text-heading-72`
 * metrics for the title (in regular weight, as those OG images set titles),
 * and `text-copy-24` for the tagline.
 */
export const createTemplateOgImage = async (
  template: TemplateManifestEntry,
): Promise<ImageResponse> => {
  const [fontData, assets] = await Promise.all([fonts, loadOgPreviewAssets(template)]);
  const scale = template.preview ? SCENE_SCALE : PLACEHOLDER_SCALE;
  const sceneLeft = template.preview ? SCENE_LEFT : SCENE_LEFT - 40;
  const sceneTop = template.preview ? SCENE_TOP : 0;
  const sceneWidth = WIDTH - sceneLeft;
  const sceneHeight = template.preview ? SCENE_HEIGHT : HEIGHT;
  // next/og leaves borders out of `mask-image`, so masking the live tree would
  // keep every border solid through the fade. Render the header to a PNG
  // first, then fade the image.
  const scene = await renderPng(
    scaleTree(
      <HeaderScene
        assets={assets}
        height={sceneHeight / scale}
        // Slack and GitHub windows sit 8px higher than the others, as on the card, which puts them at the top edge.
        inset={[8, -12, -20, 0]}
        palette={palette}
        template={template}
        width={sceneWidth / scale}
      />,
      scale,
    ),
    sceneWidth,
    sceneHeight,
    fontData,
  );

  return new ImageResponse(
    <div
      style={{
        backgroundColor: palette.bg100,
        color: palette.fg,
        display: "flex",
        fontFamily: "Geist",
        height: "100%",
        position: "relative",
        width: "100%",
      }}
    >
      {/* oxlint-disable-next-line nextjs/no-img-element -- next/og only renders img */}
      <img
        alt=""
        height={HEIGHT}
        // Dots fade in from the left so they stay out from behind the title.
        src={dotMatrixSrc({
          color: palette.dot,
          fade: Infinity,
          fadeLeft: 900,
          gap: 16,
          height: HEIGHT,
          seed: template.title,
          strength: 0.7,
          width: WIDTH,
        })}
        style={{ left: 0, position: "absolute", top: 0 }}
        width={WIDTH}
      />
      {/* oxlint-disable-next-line nextjs/no-img-element -- next/og only renders img */}
      <img
        alt=""
        height={sceneHeight}
        src={scene}
        style={{
          left: sceneLeft,
          // Fade the conversation out toward the bottom, like the card.
          ...(template.preview && {
            maskImage: `linear-gradient(to bottom, #000 ${(1 - SCENE_FADE) * 100}%, transparent)`,
          }),
          position: "absolute",
          top: sceneTop,
        }}
        width={sceneWidth}
      />
      <svg
        height={49}
        style={{ left: MARGIN, position: "absolute", top: MARGIN }}
        viewBox="0 0 64 56"
        width={56}
      >
        <path d="M32 0L64 56H0L32 0Z" fill={palette.fg} />
      </svg>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: HEIGHT,
          justifyContent: "center",
          left: MARGIN,
          position: "absolute",
          top: 0,
          width: TEXT_WIDTH,
        }}
      >
        <div style={{ color: palette.gray900, display: "flex", fontSize: 20, lineHeight: "32px" }}>
          Template
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 400,
            letterSpacing: "-4.32px",
            lineHeight: "72px",
            marginTop: 16,
            textWrap: "balance",
          }}
        >
          {template.title}
        </div>
        {template.tagline ? (
          <div
            style={{
              color: palette.gray900,
              display: "flex",
              fontSize: 24,
              lineHeight: "36px",
              marginTop: 24,
            }}
          >
            {template.tagline}
          </div>
        ) : null}
      </div>
    </div>,
    { fonts: fontData, height: HEIGHT, width: WIDTH },
  );
};
