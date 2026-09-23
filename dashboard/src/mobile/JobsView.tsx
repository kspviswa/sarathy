import { Briefcase, Clock, FileText, Loader2, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [selectedJob, setSelectedJob] = useState<JobDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingJobIdRef = useRef<number | null>(null);

  const fetchJobs = async () => {
    try {
      const res = await api.jobs();
      setJobs(res.jobs);

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

  useEffect(() => {
    fetchJobs();
    intervalRef.current = setInterval(fetchJobs, 10000);

    const handleOpenJob = (event: CustomEvent<{ id: number }>) => {
      const jobId = event.detail.id;
      if (jobs.length > 0) {
        const job = jobs.find(j => j.id === jobId);
        if (job) {
          openJob(jobId);
        }
      } else {
        pendingJobIdRef.current = jobId;
      }
    };

    window.addEventListener("sarathy:open-job", handleOpenJob as EventListener);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener("sarathy:open-job", handleOpenJob as EventListener);
    };
  }, [jobs]);

  useEffect(() => {
    if (selectedJob) {
      const handleNotification = () => fetchJobs();
      window.addEventListener("sarathy:notification", handleNotification);
      return () => window.removeEventListener("sarathy:notification", handleNotification);
    }
  }, [selectedJob]);

  const statusBadge = (status: string) => (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium", STATUS_COLORS[status] || "bg-gray-100 text-gray-800 border-gray-200")}
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
      <div className="flex h-full flex-col" data-testid="mobile-jobs">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <Button variant="ghost" size="sm" onClick={closeDetail} className="gap-1">
            <ChevronLeft className="size-4" />
            Jobs
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
    <div className="flex h-full flex-col" data-testid="mobile-jobs">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Jobs</h1>
          <Button variant="ghost" size="sm" onClick={fetchJobs} disabled={loading} className="gap-1">
            <Loader2 className={cn("size-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Briefcase className="size-12 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">No jobs yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <Button
                key={job.id}
                variant="outline"
                className={cn(
                  "w-full justify-start text-left gap-3 p-3 transition-colors hover:bg-accent",
                  "hover:shadow-sm"
                )}
                onClick={() => openJob(job.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-medium">#{job.id}</span>
                    {statusBadge(job.status)}
                    <span className="text-xs text-muted-foreground">{job.kind}</span>
                  </div>
                  <h3 className="font-medium truncate">{job.title}</h3>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {job.repo && <span className="font-mono truncate">{job.repo}</span>}
                    {job.model && <span className="font-mono truncate">{job.model}</span>}
                    <span>{formatRelativeTime(job.updated_at)}</span>
                  </div>
                </div>
                {job.last_event && (
                  <div className="text-right text-xs text-muted-foreground max-w-[200px]">
                    <p className="truncate">{job.last_event.message}</p>
                    <span className="text-[10px]">{formatRelativeTime(job.last_event.ts)}</span>
                  </div>
                )}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}