import { Briefcase, FileText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Job, JobDetailResponse, JobEvent } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-800 border-blue-200",
  needs_input: "bg-amber-100 text-amber-800 border-amber-200",
  verified: "bg-green-100 text-green-800 border-green-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  cancelled: "bg-gray-100 text-gray-800 border-gray-200",
  planned: "bg-gray-100 text-gray-800 border-gray-200",
  superseded: "bg-gray-100 text-gray-800 border-gray-200",
  paused: "bg-gray-100 text-gray-800 border-gray-200",
};

const STATUS_ORDER = [
  "running",
  "needs_input",
  "paused",
  "planned",
  "completed",
  "verified",
  "failed",
  "cancelled",
  "superseded",
];

const LEVEL_COLORS: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600",
  error: "text-red-600",
  action: "text-blue-600",
};

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function formatRelativeTime(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  } catch {
    return ts;
  }
}

export function JobsView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<JobDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const pendingJobIdRef = useRef<number | null>(null);

  const fetchJobs = async () => {
    try {
      const res = await api.jobs();
      setJobs(res.jobs);

      // Check if there's a pending job ID to open
      if (pendingJobIdRef.current) {
        const jobId = pendingJobIdRef.current;
        const job = res.jobs.find(j => j.id === jobId);
        if (job) {
          await openJob(jobId);
        }
        pendingJobIdRef.current = null;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  };

  const openJob = async (id: number) => {
    setLoadingDetail(true);
    try {
      const detail = await api.job(id);
      setSelectedJob(detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load job");
    } finally {
      setLoadingDetail(false);
    }
  };

  const closeDetail = () => {
    setSelectedJob(null);
  };

  // Fetch once on mount; refresh only via push notifications, no polling.
  useEffect(() => {
    fetchJobs();

    // Listen for deep link events
    const handleOpenJob = (event: CustomEvent<{ id: number }>) => {
      const jobId = event.detail.id;
      if (jobs.length > 0) {
        const job = jobs.find(j => j.id === jobId);
        if (job) {
          openJob(jobId);
        }
      } else {
        // Jobs not loaded yet, store for later
        pendingJobIdRef.current = jobId;
      }
    };

    // Refresh on WS push notification, not on a timer
    const handleNotification = () => fetchJobs();

    window.addEventListener("sarathy:open-job", handleOpenJob as EventListener);
    window.addEventListener("sarathy:notification", handleNotification);
    return () => {
      window.removeEventListener("sarathy:open-job", handleOpenJob as EventListener);
      window.removeEventListener("sarathy:notification", handleNotification);
    };
  }, []);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    jobs.forEach(j => {
      counts[j.status] = (counts[j.status] || 0) + 1;
    });
    return counts;
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    if (filter === "all") return jobs;
    return jobs.filter(j => j.status === filter);
  }, [jobs, filter]);

  const statusBadge = (status: string) => (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium whitespace-nowrap", STATUS_COLORS[status] || "bg-gray-100 text-gray-800 border-gray-200")}
    >
      {status.replace("_", " ")}
    </Badge>
  );

  const levelBadge = (level: string) => (
    <Badge variant="outline" className={cn("text-xs", LEVEL_COLORS[level] || "text-muted-foreground")}>
      {level}
    </Badge>
  );

  if (selectedJob) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <Button variant="ghost" size="sm" onClick={closeDetail} className="gap-1">
            <X className="size-4" />
            Back
          </Button>
          <span className="text-sm font-medium">Job #{selectedJob.job.id}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            <Card>
              <div className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedJob.job.title}</h2>
                    <div className="flex items-center gap-2 mt-1">
                      {statusBadge(selectedJob.job.status)}
                      <span className="text-xs text-muted-foreground">{selectedJob.job.kind}</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Repo</span>
                    <p className="font-mono text-xs truncate">{selectedJob.job.repo || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Model</span>
                    <p className="font-mono text-xs truncate">{selectedJob.job.model || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Created</span>
                    <p className="font-mono text-xs">{formatDate(selectedJob.job.created_at)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Updated</span>
                    <p className="font-mono text-xs">{formatDate(selectedJob.job.updated_at)}</p>
                  </div>
                  {selectedJob.job.closed_at && (
                    <div>
                      <span className="text-muted-foreground">Closed</span>
                      <p className="font-mono text-xs">{formatDate(selectedJob.job.closed_at)}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Events</span>
                    <p className="font-mono text-xs">{selectedJob.job.event_count}</p>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-4">
                <h3 className="font-medium mb-3">Event Timeline</h3>
                {selectedJob.events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events</p>
                ) : (
                  <ul className="space-y-2">
                    {selectedJob.events.map((event: JobEvent) => (
                      <li key={event.id} className="flex flex-col gap-1 p-3 bg-muted/50 rounded-lg border">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-muted-foreground">{formatDate(event.ts)}</span>
                          <span className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">
                            {event.event_type}
                          </span>
                          {levelBadge(event.level)}
                          <span className="text-muted-foreground">{formatRelativeTime(event.ts)}</span>
                        </div>
                        <p className="text-sm ml-6">{event.message}</p>
                        {event.payload && (
                          <details className="ml-6">
                            <summary className="text-xs text-muted-foreground cursor-pointer">Payload</summary>
                            <pre className="mt-1 text-xs bg-background p-2 rounded overflow-auto">
                              {JSON.stringify(event.payload, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            {selectedJob.spec_text && (
              <Card>
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium">Spec</h3>
                    <FileText className="size-4 text-muted-foreground" />
                  </div>
                  <ScrollArea className="h-64">
                    <pre className="whitespace-pre-wrap text-sm font-mono p-3 bg-muted rounded">
                      {selectedJob.spec_text}
                    </pre>
                  </ScrollArea>
                </div>
              </Card>
            )}

            {selectedJob.result_text && (
              <Card>
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium">Result</h3>
                    <FileText className="size-4 text-muted-foreground" />
                  </div>
                  <ScrollArea className="h-64">
                    <pre className="whitespace-pre-wrap text-sm font-mono p-3 bg-muted rounded">
                      {selectedJob.result_text}
                    </pre>
                  </ScrollArea>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Jobs</h1>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant={filter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("all")}
          >
            All
            <span className="ml-1.5 text-xs opacity-80">{jobs.length}</span>
          </Button>
          {STATUS_ORDER.filter(s => statusCounts[s]).map(status => (
            <Button
              key={status}
              variant={filter === status ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(filter === status ? "all" : status)}
              className={cn(filter !== status && STATUS_COLORS[status])}
            >
              {status.replace("_", " ")}
              <span className="ml-1.5 text-xs opacity-80">{statusCounts[status]}</span>
            </Button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-muted-foreground">Loading jobs…</span>
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Briefcase className="size-12 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">
              {jobs.length === 0 ? "No jobs yet" : "No jobs in this state"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredJobs.map(job => (
              <Card
                key={job.id}
                onClick={() => openJob(job.id)}
                className="cursor-pointer p-4 transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">#{job.id}</span>
                  {statusBadge(job.status)}
                </div>
                <h3 className="mt-2 text-sm font-medium leading-snug line-clamp-2 min-h-[2.5rem]">
                  {job.title}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                  {job.last_event?.message || "No events yet"}
                </p>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-mono truncate">{job.kind}</span>
                  <span className="whitespace-nowrap">{formatRelativeTime(job.updated_at)}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}