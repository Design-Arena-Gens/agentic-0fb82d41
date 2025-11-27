export const metadata = {
  title: "TextToVideo Converter Pro",
  description: "Text to MP3 and MP4 converter",
};

import "./globals.css";
import { ThemeProvider } from "next-themes";
import { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-br" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

