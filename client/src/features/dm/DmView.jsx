import React from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MemoJobCard } from "@/components/JobCard.jsx";

function sortByScheduledAtAsc(list = []) {
  return Array.from(list || []).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

export function DmView({
  to,
  setTo,
  message,
  setMessage,
  scheduleAt,
  setScheduleAt,
  onSchedule,
  schedulingStep,
  jobs,
  profileRelays,
  onCancelJob,
  onRescheduleJob,
  onRetryJob
}) {
  const queued = sortByScheduledAtAsc(Array.from(jobs || []).filter((j) => j && j.status !== "canceled" && j.status !== "cancelled"));
  const schedulingBusy = Boolean(schedulingStep) && !String(schedulingStep).startsWith("Scheduled for ");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" /> Schedule DM (NIP-17)
          </CardTitle>
          <CardDescription>
            Gift-wrapped DM delivery.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium text-white/70">Recipient npub</div>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="npub1…"
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-white/70">Send at</div>
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-white/70">Message</div>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write a private message…"
              className="min-h-[120px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={onSchedule}
              disabled={!to.trim() || !message.trim()}
              loading={schedulingBusy}
              busyText={schedulingStep || "Scheduling…"}
            >
              Schedule DM
            </Button>
            {schedulingStep ? <div className="text-sm text-white/60">{schedulingStep}</div> : null}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-white/90">Queued messages</div>
          <div className="text-xs text-white/50">{queued.length ? `${queued.length} queued` : "No queued DMs"}</div>
        </div>
        {queued.length ? (
	          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
	            {queued.map((job) => {
	              const canRetry = job?.status === "error";
	                  return (
	                    <div key={job.requestId || job.id} className="space-y-2">
	                  <MemoJobCard
	                    job={job}
	                    onCancel={onCancelJob}
	                    onReschedule={onRescheduleJob}
	                    showActions
	                    profileRelays={profileRelays}
	                  />
	                  {canRetry && onRetryJob ? (
	                    <Button
	                      variant="outline"
	                      className="w-full"
	                      onClick={(e) => {
                        e.stopPropagation();
                        onRetryJob(job);
                      }}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" /> Retry now
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
