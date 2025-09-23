// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KB Legal Assistant",
  description: "RAG + Chat API/GUI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui" }}>
        {children}
      </body>
    </html>
  );
}