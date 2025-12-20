import React from "react";
import { Heart, MessageSquare, Zap, Repeat2, Quote, Bookmark, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function formatSatsFromMsat(msat) {
  const n = Number(msat) || 0;
  if (!Number.isFinite(n) || n <= 0) return "0";
  return Math.floor(n / 1000).toLocaleString();
}

function MetricChip({ icon, label, value }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-slate-950/60 px-4 py-3 ring-1 ring-white/10">
      <div className="flex items-center gap-2 text-white/60">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function PostRow({ item }) {
  const title = (item.content || "").trim().replace(/\s+/g, " ");
  const clipped = title.length > 72 ? `${title.slice(0, 72)}…` : title || item.noteId;
  return (
    <div className="grid grid-cols-12 gap-2 rounded-2xl bg-slate-950/40 px-4 py-3 ring-1 ring-white/10">
      <div className="col-span-12 lg:col-span-5">
        <div className="text-sm font-medium text-white/90">{clipped}</div>
        <div className="mt-1 text-xs text-white/50">{(item.createdAt || item.updatedAt || "").slice(0, 19).replace("T", " ")}</div>
      </div>
      <div className="col-span-12 lg:col-span-7 grid grid-cols-6 gap-2 text-center text-sm text-white/80">
        <div>
          <div className="text-xs text-white/50">Score</div>
          <div className="font-semibold">{item.score || 0}</div>
        </div>
        <div>
          <div className="text-xs text-white/50">Likes</div>
          <div className="font-semibold">{item.likes || 0}</div>
        </div>
        <div>
          <div className="text-xs text-white/50">Replies</div>
          <div className="font-semibold">{item.replies || 0}</div>
        </div>
        <div>
          <div className="text-xs text-white/50">Quotes</div>
          <div className="font-semibold">{item.quotes || 0}</div>
        </div>
        <div>
          <div className="text-xs text-white/50">Reposts</div>
          <div className="font-semibold">{item.reposts || 0}</div>
        </div>
        <div>
          <div className="text-xs text-white/50">Zaps</div>
          <div className="font-semibold">{item.zaps || 0}</div>
        </div>
      </div>
    </div>
  );
}

export function AnalyticsView({ loading = false, global, series, latest = [], quickEstimate, onQuickEstimate }) {
  const totals = global || { likes: 0, replies: 0, quotes: 0, reposts: 0, zaps: 0, zapMsat: 0, bookmarks: 0, score: 0, noteCount: 0, rangeDays: 7 };

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Overview</CardTitle>
          <CardDescription className="">
            Engagement in last {totals.rangeDays || 7}d (across {totals.noteCount || 0} DVM posts)
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <MetricChip icon={<TrendingUp className="h-4 w-4" />} label="Score" value={totals.score || 0} />
          <MetricChip icon={<Heart className="h-4 w-4" />} label="Likes" value={totals.likes || 0} />
          <MetricChip icon={<MessageSquare className="h-4 w-4" />} label="Replies" value={totals.replies || 0} />
          <MetricChip icon={<Quote className="h-4 w-4" />} label="Quotes" value={totals.quotes || 0} />
          <MetricChip icon={<Repeat2 className="h-4 w-4" />} label="Reposts" value={totals.reposts || 0} />
          <MetricChip icon={<Zap className="h-4 w-4" />} label="Zaps" value={`${totals.zaps || 0} (${formatSatsFromMsat(totals.zapMsat)} sats)`} />
          <MetricChip icon={<Bookmark className="h-4 w-4" />} label="Bookmarks (≈)" value={totals.bookmarks || 0} />
          <div className="flex items-center justify-end">
            <Button variant="secondary" size="sm" onClick={onQuickEstimate} disabled={loading || !onQuickEstimate}>
              Quick estimate
            </Button>
          </div>
          {quickEstimate ? (
            <div className="col-span-2 rounded-2xl bg-slate-950/40 px-4 py-3 text-xs text-white/60 ring-1 ring-white/10">
              Quick estimate from {quickEstimate.relay}: likes {quickEstimate.likes}, replies {quickEstimate.replies}, quotes {quickEstimate.quotes}, reposts {quickEstimate.reposts}, zaps {quickEstimate.zaps}
              {quickEstimate.approximate ? " (≈)" : ""}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Daily score</CardTitle>
          <CardDescription className="">Buckets by engagement event time</CardDescription>
        </CardHeader>
        <CardContent className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.10)" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: "rgba(255,255,255,0.60)", fontSize: 12 }}
                axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
                tickLine={{ stroke: "rgba(255,255,255,0.12)" }}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.60)", fontSize: 12 }}
                axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
                tickLine={{ stroke: "rgba(255,255,255,0.12)" }}
              />
              <RTooltip
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.95)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  borderRadius: 16,
                }}
                labelStyle={{ color: "rgba(255,255,255,0.85)" }}
                itemStyle={{ color: "rgba(255,255,255,0.85)" }}
              />
              <Legend wrapperStyle={{ color: "rgba(255,255,255,0.70)" }} />
              <Area type="monotone" dataKey="score" stroke="#a78bfa" fillOpacity={0.22} fill="#a78bfa" />
              <Area type="monotone" dataKey="replies" stroke="#34d399" fillOpacity={0.14} fill="#34d399" />
              <Area type="monotone" dataKey="zaps" stroke="#f59e0b" fillOpacity={0.12} fill="#f59e0b" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Latest 20 DVM posts</CardTitle>
          <CardDescription className="">Per-post performance in the same window</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {latest.length ? latest.map((it) => <PostRow key={it.noteId} item={it} />) : (
            <div className="rounded-2xl bg-slate-950/40 px-4 py-3 text-sm text-white/60 ring-1 ring-white/10">
              {loading ? "Loading…" : "No posted notes available yet."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
