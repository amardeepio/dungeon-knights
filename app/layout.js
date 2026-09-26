import { OG_IMAGE, SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_URL } from '../lib/site';
import './globals.css';
import PrivyGate from './privy-gate';

// Read here, on the server, and passed down: the provider needs the App ID in the browser,
// and a `NEXT_PUBLIC_` copy in a client config would be a second copy of the same fact.
const PRIVY_APP_ID = (process.env.PRIVY_APP_ID || '').trim();

// The site's faces, fetched from one stylesheet on Google's CDN.
//
// This used to be an `@import` at the top of `theme.css`, which is a different thing from a link and
// a worse one: the browser cannot discover an `@import` until theme.css has arrived, been parsed and
// its own rules matched, so a phone paid a second DNS + TLS + request round trip to a second origin
// before a single woff2 was even asked for. The wordmark is set in one of these — Cinzel Decorative
// on the game screens, JetBrains Mono on the apex — so that gap was the difference between reading
// the headline and watching it re-flow. A link is discovered while the HTML is still being parsed,
// and the two preconnects below open both connections before either request is made.
// `display=swap` is Google's parameter and is deliberate: text renders in the fallback face
// immediately and swaps, rather than staying invisible.
//
// JetBrains Mono is here for the apex page alone (`public/css/home.css`), which is set as a terminal.
// Space Grotesk was trialled there and dropped in favour of the mono. Cinzel and Inter stay because
// every game screen and the legacy pages still use them; removing them would restyle the game.
// One URL rather than a second <link>, so a route that needs the mono still costs one stylesheet
// request, and the font binaries themselves are only downloaded by the routes that set the text.
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Cinzel+Decorative:wght@400;700;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — Blockchain Idle RPG`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  authors: [{ name: 'Dungeon Knights team' }],
  creator: 'Dungeon Knights team',
  category: 'games',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Blockchain Idle RPG`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        width: 2752,
        height: 1536,
        alt: 'Dungeon Knights — Enter the dungeons',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — Blockchain Idle RPG`,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/assets/images/capsule.png',
    apple: '/assets/images/capsule.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#1a1a2e',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_CSS} />
        <PrivyGate appId={PRIVY_APP_ID}>
          {children}
        </PrivyGate>
      </body>
    </html>
  );
}
