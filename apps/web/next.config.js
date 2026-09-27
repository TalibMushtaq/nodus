import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Content-Security-Policy for the single-origin app. `script-src` keeps
// 'unsafe-inline' because the App Router emits inline hydration scripts and the
// theme shim in app/layout.tsx is an inline script; external scripts are still
// blocked, so an injected <script src=…> cannot load. `connect-src` covers the
// same-origin /api + /ws gateway, an explicit dev Relay URL, LAN node
// signaling (http/ws on :9378), and STUN for WebRTC path establishment.
// `img-src blob:` is required for decrypted file previews (object URLs);
// `object-src 'none'` + `frame-ancestors 'none'` block plugin/frame abuse.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:8080 ws://localhost:8080 http://*:9378 ws://*:9378 stun:stun.l.google.com:19302",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the single-origin deploy image.
  output: "standalone",
  // Trace from the monorepo root so pnpm workspace packages are included in
  // the standalone output rather than resolved from a higher node_modules.
  outputFileTracingRoot: path.join(dirname, "../../"),
  // Defense-in-depth response headers (the primary XSS mitigation backing the
  // client-side key-storage choices). HSTS is ignored on plain-http dev origins
  // and enforced once deployed behind TLS.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
