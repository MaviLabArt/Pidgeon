export function getSupportPolicy() {
  const horizonDaysRaw = Number(process.env.DVM_SUPPORT_HORIZON_DAYS || 7);
  const windowSchedulesRaw = Number(process.env.DVM_SUPPORT_WINDOW_SCHEDULES || 10);
  const gatedFeaturesRaw = String(process.env.DVM_SUPPORT_GATED_FEATURES || "").trim();
  const lud16 = String(process.env.DVM_SUPPORT_LUD16 || "").trim();
  const message = String(process.env.DVM_SUPPORT_MESSAGE || "").trim();
  const paymentModeRaw = String(process.env.DVM_SUPPORT_PAYMENT_MODE || "").trim().toLowerCase();
  const invoiceSatsRaw = Number(process.env.DVM_SUPPORT_INVOICE_SATS || 1000);
  const supporterDaysRaw = Number(process.env.DVM_SUPPORT_SUPPORTER_DAYS || 30);
  const minSatsRaw = Number(process.env.DVM_SUPPORT_MIN_SATS || 0);
  const invoiceTtlSecRaw = Number(process.env.DVM_SUPPORT_INVOICE_TTL_SEC || 3600);
  const verifyPollSecRaw = Number(process.env.DVM_SUPPORT_VERIFY_POLL_SECS || 15);
  const verifyTimeoutMsRaw = Number(process.env.DVM_SUPPORT_VERIFY_TIMEOUT_MS || 5000);

  const horizonDays = Number.isFinite(horizonDaysRaw) && horizonDaysRaw >= 0 ? Math.floor(horizonDaysRaw) : 7;
  const windowSchedules =
    Number.isFinite(windowSchedulesRaw) && windowSchedulesRaw >= 0 ? Math.floor(windowSchedulesRaw) : 10;

  const gatedFeatures = Array.from(
    new Set(
      gatedFeaturesRaw
        .split(/[,\s]+/)
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    )
  );

  const paymentMode =
    paymentModeRaw === "lnurl_verify" ||
    paymentModeRaw === "lnurl-verify" ||
    paymentModeRaw === "lnurlverify" ||
    paymentModeRaw === "verify"
      ? "lnurl_verify"
      : paymentModeRaw === "nwc" ||
          paymentModeRaw === "nostr_wallet_connect" ||
          paymentModeRaw === "nostr-wallet-connect" ||
          paymentModeRaw === "walletconnect" ||
          paymentModeRaw === "wallet_connect"
        ? "nwc"
      : "none";
  const invoiceSats = Number.isFinite(invoiceSatsRaw) && invoiceSatsRaw > 0 ? Math.floor(invoiceSatsRaw) : 0;
  const supporterDays =
    Number.isFinite(supporterDaysRaw) && supporterDaysRaw > 0 ? Math.floor(supporterDaysRaw) : 0;
  const invoiceTtlSec =
    Number.isFinite(invoiceTtlSecRaw) && invoiceTtlSecRaw > 0 ? Math.floor(invoiceTtlSecRaw) : 0;
  const verifyPollSec =
    Number.isFinite(verifyPollSecRaw) && verifyPollSecRaw > 0 ? Math.floor(verifyPollSecRaw) : 0;
  const verifyTimeoutMs =
    Number.isFinite(verifyTimeoutMsRaw) && verifyTimeoutMsRaw > 0 ? Math.floor(verifyTimeoutMsRaw) : 5000;
  const minSats = Number.isFinite(minSatsRaw) && minSatsRaw > 0 ? Math.floor(minSatsRaw) : 0;

  return {
    v: 2,
    horizonDays,
    windowSchedules,
    gatedFeatures,
    cta: {
      lud16,
      message
    },
    payment: {
      mode: paymentMode,
      invoiceSats,
      minSats,
      supporterDays,
      invoiceTtlSec,
      verifyPollSec,
      verifyTimeoutMs
    }
  };
}
