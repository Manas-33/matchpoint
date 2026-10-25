import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/db/schema";
import { formatCents } from "@/lib/money";
import { productDetails, productImages, variantLabel } from "@/lib/shop";
import { ShieldIcon, StarIcon } from "./icons";

export function ProductCard({ product, protectionDays }: { product: Product; protectionDays: number | null }) {
  const image = productImages(product)[0];
  const { rating } = productDetails(product);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(31,29,24,0.25)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="product-frame relative aspect-square">
        {image && (
          <Image
            src={image.url}
            alt={image.alt}
            fill
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
            className="object-contain p-6 transition duration-300 group-hover:scale-[1.04]"
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 border-t border-line p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{product.brand}</p>
        <h3 className="line-clamp-2 font-medium leading-snug">{product.title}</h3>
        <p className="line-clamp-1 text-sm text-muted">{variantLabel(product.variant)}</p>
        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <span className="text-lg font-semibold tabular-nums">{formatCents(product.shopPriceCents, product.currency)}</span>
          {rating && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <StarIcon className="size-3.5 text-amber" />
              {rating.value.toFixed(1)}
            </span>
          )}
        </div>
        {protectionDays !== null && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-accent">
            <ShieldIcon className="size-3.5" />
            Price match + {protectionDays}-day protection
          </p>
        )}
      </div>
    </Link>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="aspect-square animate-pulse bg-surface-2" />
      <div className="flex flex-col gap-2 border-t border-line p-4">
        <div className="h-3 w-16 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-surface-2" />
      </div>
    </div>
  );
}
