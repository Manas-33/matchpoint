"use client";

import Image from "next/image";
import { useState } from "react";
import type { CatalogImage } from "@/lib/shop";

export function Gallery({ images, title }: { images: CatalogImage[]; title: string }) {
  const [active, setActive] = useState(0);
  const shown = images.slice(0, 6);
  const current = shown[active];
  return (
    <div className="flex flex-col gap-3">
      <div className="product-frame relative aspect-square overflow-hidden rounded-3xl border border-line">
        {current ? (
          <Image
            key={current.url}
            src={current.url}
            alt={current.alt}
            fill
            preload
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-contain p-10"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-stone-500">{title}</div>
        )}
      </div>
      {shown.length > 1 && (
        <div className="grid grid-cols-6 gap-2">
          {shown.map((img, i) => (
            <button
              key={img.url}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Show image ${i + 1}`}
              aria-current={i === active}
              className={`product-frame relative aspect-square overflow-hidden rounded-xl border transition ${
                i === active ? "border-accent ring-2 ring-accent/30" : "border-line opacity-80 hover:opacity-100"
              }`}
            >
              <Image src={img.url} alt="" fill sizes="96px" className="object-contain p-1.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
