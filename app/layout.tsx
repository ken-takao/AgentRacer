import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Grand Prix — Two agents. One finish line.",
  description: "2つのAIエージェントが、画面を見て、リアルタイムで競う。Agents API Computer Useのレーシングデモ。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
