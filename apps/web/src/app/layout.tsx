import type { Metadata } from "next"
import { Fraunces, Sora } from "next/font/google"
import "./globals.css"

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sora",
})

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
})

export const metadata: Metadata = {
  title: "MindOS Studio",
  description: "A personal, multi-model MindOS interface powered by Restate.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${fraunces.variable}`}>
      <body>{children}</body>
    </html>
  )
}
