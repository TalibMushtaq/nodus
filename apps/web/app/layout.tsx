import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";
import { ThemeProvider } from "../providers/theme-provider";
import { AuthProvider } from "../providers/auth-provider";
import { WsProvider } from "../providers/ws-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// Display face for page titles, wordmark, and headline figures. Loaded at the
// two weights the type scale uses (500 for labels, 600 for headings).
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nodus",
  description: "Offline-first P2P storage. Your files, your hardware.",
  // The brand mark (node topology) doubles as the favicon; `app/favicon.ico`
  // is generated from the same artwork for legacy tabs.
  icons: {
    icon: [
      { url: "/favicon.webp", type: "image/webp" },
      { url: "/favicon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The next/font variable classes define --font-inter / --font-jetbrains-mono.
  // They must live on <html>: tokens.css computes --font-sans / --font-mono on
  // :root by alias to those variables, and a custom property whose var() chain
  // fails at the root element computes to the empty (guaranteed-invalid) value
  // that then inherits down. That silently dropped the app back to the system
  // font stack.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable}`}
    >
      <head>
        {/* Pre-hydration theme application to avoid a light-mode flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("nodus.theme")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <AuthProvider>
          <WsProvider>
            <ThemeProvider>{children}</ThemeProvider>
          </WsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}