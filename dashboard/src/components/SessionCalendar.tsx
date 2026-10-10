import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  buildMonthMatrix,
  dateKeyFromDate,
  monthLabel,
  shiftMonth,
  type MonthCursor,
} from "@/lib/sessions";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Month calendar for the Sessions drill-down (spec §C, level 1).
 *
 * Month state is owned by the parent so it survives leaving/returning to the
 * calendar. Days with sessions render a marker and are the only selectable
 * cells; empty days are dimmed.
 */
export function SessionCalendar({
  cursor,
  markedDays,
  todayKey,
  selectedDay,
  onSelectDay,
  onMonthChange,
}: {
  cursor: MonthCursor;
  markedDays: Set<string>;
  todayKey: string;
  selectedDay: string | null;
  onSelectDay: (dateKey: string) => void;
  onMonthChange: (cursor: MonthCursor) => void;
}) {
  const weeks = buildMonthMatrix(cursor);

  return (
    <div data-testid="session-calendar">
      <div className="flex items-center justify-between px-1 pb-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous month"
          data-testid="calendar-prev"
          onClick={() => onMonthChange(shiftMonth(cursor, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-sm font-semibold" data-testid="calendar-month">
          {monthLabel(cursor)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next month"
          data-testid="calendar-next"
          onClick={() => onMonthChange(shiftMonth(cursor, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
        {WEEKDAYS.map((d, i) => (
          <span key={`${d}-${i}`} className="py-1">
            {d}
          </span>
        ))}
        {weeks.flat().map((date, i) => {
          if (!date) return <span key={`pad-${i}`} aria-hidden="true" />;
          const dateKey = dateKeyFromDate(date);
          const marked = markedDays.has(dateKey);
          const today = dateKey === todayKey;
          const selected = dateKey === selectedDay;
          return (
            <button
              key={dateKey}
              type="button"
              disabled={!marked}
              onClick={() => onSelectDay(dateKey)}
              data-testid={`calendar-day-${dateKey}`}
              data-has-sessions={marked}
              data-today={today}
              className={cn(
                "relative mx-auto flex size-9 items-center justify-center rounded-md text-xs tabular-nums transition-colors",
                marked ? "hover:bg-accent" : "text-muted-foreground/40",
                today && "font-bold text-primary",
                selected && "bg-primary text-primary-foreground hover:bg-primary",
              )}
            >
              {date.getDate()}
              {marked && (
                <span
                  data-testid={`calendar-marker-${dateKey}`}
                  className={cn(
                    "absolute bottom-1 size-1 rounded-full",
                    selected ? "bg-primary-foreground" : "bg-primary",
                  )}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
