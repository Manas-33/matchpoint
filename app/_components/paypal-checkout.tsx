"use client";

// PayPal button on the PayPal JS SDK v6 (web-sdk/v6/core). The browser only tells our server which product
// to buy; the server creates the PayPal order at the database price and captures it after approval.
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { LockIcon } from "./icons";

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

// The slice of the v6 SDK this page uses.
type OneTimePaymentSession = {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
};
type SdkInstance = {
  findEligibleMethods(options?: { currencyCode?: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove(data: { orderId: string; payerId?: string }): Promise<void>;
    onCancel?(data: { orderId?: string }): void;
    onError?(error: Error): void;
  }): OneTimePaymentSession;
};
declare global {
  interface Window {
    paypal?: { createInstance(options: { clientId: string; components: string[]; pageType?: string }): Promise<SdkInstance> };
  }
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "paying" }
  | { kind: "capturing" }
  | { kind: "cancelled" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

// matchRequestId: pay the matched price of that (server-checked) match request instead of the list price.
type Props = { productSlug: string; currency: string; matchRequestId?: string; label?: string } & ({ mode: "live"; clientId: string } | { mode: "demo" });

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? `Request failed (${res.status})`);
  return json as T;
}

export function PayPalCheckout(props: Props) {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const clientId = props.mode === "live" ? props.clientId : null;
  const { productSlug, currency, matchRequestId } = props;
  const [status, setStatus] = useState<Status>(props.mode === "demo" ? { kind: "ready" } : { kind: "loading" });
  const busy = status.kind === "paying" || status.kind === "capturing";

  // Only the product goes to the server; it answers with the PayPal order it created.
  const createOrder = useCallback(async () => {
    const { paypalOrderId } = await postJson<{ paypalOrderId: string }>("/api/checkout/orders", {
      productSlug,
      matchRequestId,
    });
    return { orderId: paypalOrderId };
  }, [productSlug, matchRequestId]);

  const capture = useCallback(
    async (paypalOrderId: string) => {
      setStatus({ kind: "capturing" });
      try {
        const { orderId } = await postJson<{ orderId: string }>(
          `/api/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
        );
        router.push(`/orders/${orderId}`);
      } catch (err) {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Payment failed" });
      }
    },
    [router],
  );

  const setUpButton = useCallback(async () => {
    if (!clientId || !window.paypal || !container.current || initialized.current) return;
    initialized.current = true;
    try {
      const sdk = await window.paypal.createInstance({
        clientId,
        components: ["paypal-payments"],
        pageType: "checkout",
      });
      const eligibility = await sdk.findEligibleMethods({ currencyCode: currency });
      if (!eligibility.isEligible("paypal")) {
        setStatus({ kind: "unavailable", message: "PayPal isn't available for this purchase." });
        return;
      }
      const session = sdk.createPayPalOneTimePaymentSession({
        onApprove: ({ orderId }) => capture(orderId),
        onCancel: () => setStatus({ kind: "cancelled" }),
        onError: (error) => {
          console.error("PayPal error", error);
          setStatus({ kind: "error", message: "PayPal couldn't complete the payment. Please try again." });
        },
      });
      const button = document.createElement("paypal-button");
      button.setAttribute("type", "pay");
      button.className = "block w-full";
      button.addEventListener("click", async () => {
        setStatus({ kind: "paying" });
        try {
          // Not awaited before start(): the popup has to open within the click (transient activation).
          await session.start({ presentationMode: "auto" }, createOrder());
        } catch (err) {
          console.error(err);
          setStatus({ kind: "error", message: err instanceof Error ? err.message : "Couldn't start PayPal checkout" });
        }
      });
      container.current.replaceChildren(button);
      setStatus({ kind: "ready" });
    } catch (err) {
      console.error(err);
      setStatus({ kind: "unavailable", message: "PayPal checkout couldn't load. Check your connection and refresh." });
    }
  }, [clientId, currency, createOrder, capture]);

  async function payDemo() {
    setStatus({ kind: "paying" });
    try {
      const { orderId } = await createOrder();
      await capture(orderId);
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Payment failed" });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {props.mode === "live" && (
        // onReady also fires on remount when the script is already loaded (e.g. client-side navigation back).
        <Script src={SDK_URL} strategy="afterInteractive" onReady={() => void setUpButton()} />
      )}

      <div className={busy ? "pointer-events-none opacity-60 transition" : "transition"}>
        {props.mode === "live" ? (
          <>
            <div ref={container} className="min-h-12" />
            {status.kind === "loading" && <div className="h-12 animate-pulse rounded-full bg-surface-2" aria-label="Loading PayPal" />}
          </>
        ) : (
          <button
            type="button"
            onClick={payDemo}
            disabled={busy}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#ffc439] font-semibold text-[#111] transition hover:brightness-95"
          >
            <LockIcon className="size-4" />
            {props.label ?? "Pay with PayPal"} <span className="font-normal opacity-70">(demo)</span>
          </button>
        )}
      </div>

      <StatusLine status={status} />
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  switch (status.kind) {
    case "paying":
      return <p className="text-sm text-muted">Waiting for PayPal…</p>;
    case "capturing":
      return <p className="text-sm text-muted">Confirming your payment…</p>;
    case "cancelled":
      return <p className="text-sm text-amber">Payment cancelled. You haven&apos;t been charged.</p>;
    case "unavailable":
    case "error":
      return (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {status.message}
        </p>
      );
    default:
      return null;
  }
}
