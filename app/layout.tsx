import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import Link from "next/link";
import { SHOP } from "@/lib/shop-info";
import { ShieldIcon } from "./_components/icons";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", axes: ["opsz"] });

export const metadata: Metadata = {
  title: { default: `${SHOP.name} · Price match & protection by Matchpoint`, template: `%s · ${SHOP.name}` },
  description: "An independent shop that matches major retailers' prices and refunds price drops after you buy.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="font-display text-lg font-semibold tracking-tight whitespace-nowrap sm:text-xl">{SHOP.name}</span>
              <span className="hidden text-xs text-muted sm:inline">{SHOP.city}</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link href="/" className="hidden rounded-full px-3 py-1.5 text-muted transition hover:bg-surface-2 hover:text-foreground sm:block">
                Shop
              </Link>
              <Link
                href="/#promise"
                className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 font-medium whitespace-nowrap text-accent transition hover:brightness-95"
              >
                <ShieldIcon className="size-4" />
                Price promise
              </Link>
            </nav>
          </div>
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
        <footer className="mt-24 border-t border-line">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>
              {SHOP.name} · {SHOP.tagline}
            </p>
            <p>
              Price match and price protection by <span className="font-medium text-foreground">Matchpoint</span>. Product
              data from Channel3, payments by PayPal (sandbox).
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
