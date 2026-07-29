import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Local Video Composer",
  description: "Conversational video agent with generated and YouTube clip workflows",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-[#fff7fd]" suppressHydrationWarning>
      <body>
        <Providers>
          {children}
          <Toaster position="top-right" theme="light" richColors />
        </Providers>
      </body>
    </html>
  );
}
