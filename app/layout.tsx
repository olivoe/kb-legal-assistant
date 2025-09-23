// app/layout.tsx
export const metadata = {
  title: "KB Legal Assistant",
  description: "RAG + SSE demo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}