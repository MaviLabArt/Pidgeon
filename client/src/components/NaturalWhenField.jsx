import React, { useEffect, useMemo, useState } from "react";
import { Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseNaturalWhen } from "@/utils/naturalWhen.js";
import { cn } from "@/lib/utils";

function parseLocalDateTimeInput(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatLocalDateTimeInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (val) => String(val).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPreview(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatRelative(target, now) {
  const t = target instanceof Date ? target : new Date(target);
  const n = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return "";
  const diffMs = t.getTime() - n.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `in ${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function NaturalWhenField({
  value,
  onChange,
  className,
  disabled = false,
  placeholder = "e.g. in 2h, tomorrow 9am, next friday",
  showPresets = true,
  showPicker = true,
}) {
  const [nl, setNl] = useState("");
  const [preview, setPreview] = useState(null);

  const defaultTime = useMemo(() => {
    const parsed = parseLocalDateTimeInput(value);
    if (!parsed) return null;
    return { hours: parsed.getHours(), minutes: parsed.getMinutes() };
  }, [value]);

  useEffect(() => {
    if (!nl.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      setPreview(parseNaturalWhen(nl, { now: new Date(), defaultTime }));
    }, 250);
    return () => clearTimeout(t);
  }, [nl, defaultTime]);

  const canApply = Boolean(preview?.ok);
  const applyPreview = () => {
    if (!preview?.ok) return;
    const d = new Date(preview.date);
    if (Number.isNaN(d.getTime())) return;
    d.setSeconds(0, 0);
    onChange?.(formatLocalDateTimeInput(d));
    setNl("");
    setPreview(null);
  };

  const applyDate = (date) => {
    const d = date instanceof Date ? new Date(date) : new Date(date);
    if (Number.isNaN(d.getTime())) return;
    d.setSeconds(0, 0);
    onChange?.(formatLocalDateTimeInput(d));
    setNl("");
    setPreview(null);
  };

  const minValue = (() => {
    const d = new Date();
    d.setSeconds(0, 0);
    return formatLocalDateTimeInput(d);
  })();

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <Input
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyPreview();
            }
            if (e.key === "Escape") {
              setNl("");
              setPreview(null);
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={applyPreview}
          disabled={!canApply || disabled}
          title={canApply ? "Apply parsed time" : "Type a valid time first"}
          className={cn(
            canApply &&
              !disabled &&
              "bg-emerald-500/25 text-emerald-50 ring-2 ring-emerald-400/50 shadow-[0_0_0_4px_rgba(16,185,129,0.12)] hover:bg-emerald-500/35 hover:ring-emerald-300/70"
          )}
        >
          <Check className="h-4 w-4" />
        </Button>
      </div>

      {nl.trim() ? (
        preview?.ok ? (
          <div className="flex items-center gap-2 text-[11px] text-white/60">
            <Clock className="h-3.5 w-3.5 opacity-60" />
            <span className="text-white/80">{formatPreview(preview.date)}</span>
            <span className="text-white/50">({formatRelative(preview.date, new Date())})</span>
            <span className="text-white/40">Tap ✓ or press Enter</span>
          </div>
        ) : (
          <div className="text-[11px] text-red-300">{preview?.error || "Couldn’t parse that."}</div>
        )
      ) : (
        <div className="text-[11px] text-white/50">Try: in 2h · tomorrow 9am · next friday · at 18:30</div>
      )}

      {showPresets ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const d = new Date();
              d.setMinutes(d.getMinutes() + 30);
              applyDate(d);
            }}
          >
            +30m
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const d = new Date();
              d.setHours(d.getHours() + 1);
              applyDate(d);
            }}
          >
            +1h
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() + 1);
              d.setHours(9, 0, 0, 0);
              applyDate(d);
            }}
          >
            Tomorrow 09:00
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() + 7);
              applyDate(d);
            }}
          >
            Next week
          </Button>
        </div>
      ) : null}

      {showPicker ? (
        <Input
          type="datetime-local"
          value={value}
          onChange={(e) => {
            onChange?.(e.target.value);
            setNl("");
            setPreview(null);
          }}
          min={minValue}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
