import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LG7 · Unsere Community",
  description: "Der private Treffpunkt der Lerngruppe 7.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
